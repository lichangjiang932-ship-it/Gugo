import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-generated-delivery-'))
process.env.ARTIFACT_DIR = path.join(root, 'artifacts')
process.env.APP_DATA_DIR = path.join(root, 'data')

const { syncGeneratedArtifactToOutputDirectory } = await import('../server/services/generatedArtifactDelivery.js')
const {
  readArtifactSourceSnapshot,
  writeArtifactSourceSnapshot,
} = await import('../server/services/artifactSourceStore.js')
const { closeDb, createUser } = await import('../server/db.js')
const { setDefaultOutputDirectory } = await import('../server/services/localFileAccessService.js')

test.after(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

test('new generated artifacts use the default directory and revisions keep that exact path', () => {
  const artifactDirectory = path.join(root, 'artifacts')
  const outputDirectory = path.join(root, 'output')
  fs.mkdirSync(artifactDirectory, { recursive: true })
  const managedPath = path.join(artifactDirectory, 'report.pdf')
  fs.writeFileSync(managedPath, 'first version')

  const first = syncGeneratedArtifactToOutputDirectory({
    artifact: { id: 'delivery-artifact', filename: 'report.pdf', fullPath: managedPath },
    args: { title: 'Report', markdown: 'first version' },
    toolName: 'create_pdf',
    outputDirectory,
  })
  assert.equal(first.path, path.join(outputDirectory, 'report.pdf'))
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'first version')
  const firstSnapshot = readArtifactSourceSnapshot('delivery-artifact')
  assert.equal(firstSnapshot.snapshotVersion, 2)
  assert.equal(firstSnapshot.deliveryGeneration, 1)
  assert.equal(firstSnapshot.deliverySize, Buffer.byteLength('first version'))
  assert.equal(
    firstSnapshot.deliveryDigest,
    crypto.createHash('sha256').update('first version').digest('hex'),
  )

  fs.writeFileSync(managedPath, 'revised version')
  const revised = syncGeneratedArtifactToOutputDirectory({
    artifact: {
      id: 'delivery-artifact',
      filename: 'report.pdf',
      fullPath: managedPath,
      replaced: true,
    },
    args: { title: 'Report', markdown: 'revised version', replace_artifact_id: 'delivery-artifact' },
    toolName: 'create_pdf',
    outputDirectory: path.join(root, 'different-default'),
  })
  assert.equal(revised.path, first.path)
  assert.equal(fs.readFileSync(revised.path, 'utf8'), 'revised version')
  const revisedSnapshot = readArtifactSourceSnapshot('delivery-artifact')
  assert.equal(revisedSnapshot.deliveryGeneration, 2)
  assert.equal(
    revisedSnapshot.deliveryDigest,
    crypto.createHash('sha256').update('revised version').digest('hex'),
  )
})

test('an omitted destination uses the persisted default while later revisions stay in place', () => {
  const userId = 'persisted-default-output-user'
  const artifactDirectory = path.join(root, 'artifacts')
  const firstDefault = path.join(root, 'persisted-default-one')
  const laterDefault = path.join(root, 'persisted-default-two')
  const managedPath = path.join(artifactDirectory, 'persisted-report.pdf')
  createUser({ id: userId, email: 'persisted-default-output@example.com' })
  fs.mkdirSync(artifactDirectory, { recursive: true })
  fs.writeFileSync(managedPath, 'persisted first version')
  setDefaultOutputDirectory({ userId, rootPath: `"${firstDefault}"` })

  const first = syncGeneratedArtifactToOutputDirectory({
    artifact: { id: 'persisted-default-artifact', filename: 'persisted-report.pdf', fullPath: managedPath },
    args: { title: 'Persisted report', markdown: 'first version' },
    toolName: 'create_pdf',
    userId,
  })
  assert.equal(first.path, path.join(firstDefault, 'persisted-report.pdf'))

  setDefaultOutputDirectory({ userId, rootPath: laterDefault })
  fs.writeFileSync(managedPath, 'persisted revised version')
  const revised = syncGeneratedArtifactToOutputDirectory({
    artifact: {
      id: 'persisted-default-artifact',
      filename: 'persisted-report.pdf',
      fullPath: managedPath,
      replaced: true,
    },
    args: { title: 'Persisted report', markdown: 'revised version', replace_artifact_id: 'persisted-default-artifact' },
    toolName: 'create_pdf',
    userId,
  })

  assert.equal(revised.path, first.path)
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'persisted revised version')
  assert.deepEqual(fs.readdirSync(laterDefault), [])
})

test('new artifacts never overwrite an unrelated same-named file', () => {
  const artifactDirectory = path.join(root, 'artifacts')
  const outputDirectory = path.join(root, 'collision-output')
  fs.mkdirSync(artifactDirectory, { recursive: true })
  fs.mkdirSync(outputDirectory, { recursive: true })
  const managedPath = path.join(artifactDirectory, 'slides.pptx')
  fs.writeFileSync(managedPath, 'generated')
  fs.writeFileSync(path.join(outputDirectory, 'slides.pptx'), 'keep me')

  const delivered = syncGeneratedArtifactToOutputDirectory({
    artifact: { id: 'collision-artifact', filename: 'slides.pptx', fullPath: managedPath },
    args: { title: 'Slides', slides: [] },
    toolName: 'create_pptx',
    outputDirectory,
  })
  assert.equal(delivered.path, path.join(outputDirectory, 'slides-2.pptx'))
  assert.equal(fs.readFileSync(path.join(outputDirectory, 'slides.pptx'), 'utf8'), 'keep me')
})

test('a failed non-HTML revision copy leaves the existing delivered file intact', () => {
  const artifactDirectory = path.join(root, 'artifacts')
  const outputDirectory = path.join(root, 'atomic-revision-output')
  fs.mkdirSync(artifactDirectory, { recursive: true })
  const managedPath = path.join(artifactDirectory, 'atomic-report.docx')
  fs.writeFileSync(managedPath, 'first managed version')

  const first = syncGeneratedArtifactToOutputDirectory({
    artifact: { id: 'atomic-revision-artifact', filename: 'atomic-report.docx', fullPath: managedPath },
    args: { title: 'Atomic report', paragraphs: [{ text: 'first' }] },
    toolName: 'create_docx',
    outputDirectory,
  })
  const originalDelivery = fs.readFileSync(first.path)
  fs.writeFileSync(managedPath, 'revised managed version')

  const originalCopyFileSync = fs.copyFileSync
  fs.copyFileSync = (source, destination, flags) => {
    if (source === managedPath && String(destination).includes('.gugo-') && String(destination).endsWith('.tmp')) {
      fs.writeFileSync(destination, 'partial replacement', { flag: 'wx' })
      const error = new Error('simulated revision copy failure')
      error.code = 'EIO'
      throw error
    }
    return originalCopyFileSync(source, destination, flags)
  }
  try {
    assert.throws(
      () => syncGeneratedArtifactToOutputDirectory({
        artifact: {
          id: 'atomic-revision-artifact',
          filename: 'atomic-report.docx',
          fullPath: managedPath,
          replaced: true,
        },
        args: {
          title: 'Atomic report',
          paragraphs: [{ text: 'revised' }],
          replace_artifact_id: 'atomic-revision-artifact',
        },
        toolName: 'create_docx',
        outputDirectory,
      }),
      /simulated revision copy failure/,
    )
  } finally {
    fs.copyFileSync = originalCopyFileSync
  }

  assert.deepEqual(fs.readFileSync(first.path), originalDelivery)
  assert.deepEqual(
    fs.readdirSync(outputDirectory).sort(),
    [path.basename(first.path)],
  )
})

test('a revision fails closed when the user changed or removed the delivered file', () => {
  const artifactDirectory = path.join(root, 'artifacts')
  const outputDirectory = path.join(root, 'user-owned-revision-output')
  fs.mkdirSync(artifactDirectory, { recursive: true })
  const managedPath = path.join(artifactDirectory, 'user-owned.docx')
  fs.writeFileSync(managedPath, 'managed first version')

  const first = syncGeneratedArtifactToOutputDirectory({
    artifact: { id: 'user-owned-artifact', filename: 'user-owned.docx', fullPath: managedPath },
    args: { title: 'User owned', paragraphs: [{ text: 'first' }] },
    toolName: 'create_docx',
    outputDirectory,
  })
  const firstSnapshot = readArtifactSourceSnapshot('user-owned-artifact')
  fs.writeFileSync(first.path, 'user edited this file')
  fs.writeFileSync(managedPath, 'managed revision')

  assert.throws(
    () => syncGeneratedArtifactToOutputDirectory({
      artifact: {
        id: 'user-owned-artifact',
        filename: 'user-owned.docx',
        fullPath: managedPath,
        replaced: true,
      },
      args: { title: 'User owned', paragraphs: [{ text: 'revision' }] },
      toolName: 'create_docx',
      outputDirectory,
    }),
    (error) => error?.code === 'ARTIFACT_DELIVERY_REVISION_CONFLICT',
  )
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'user edited this file')
  assert.deepEqual(readArtifactSourceSnapshot('user-owned-artifact'), firstSnapshot)

  fs.rmSync(first.path)
  assert.throws(
    () => syncGeneratedArtifactToOutputDirectory({
      artifact: {
        id: 'user-owned-artifact',
        filename: 'user-owned.docx',
        fullPath: managedPath,
        replaced: true,
      },
      args: { title: 'User owned', paragraphs: [{ text: 'revision' }] },
      toolName: 'create_docx',
      outputDirectory,
    }),
    (error) => error?.code === 'ARTIFACT_DELIVERY_REVISION_CONFLICT',
  )
  assert.equal(fs.existsSync(first.path), false)
  assert.deepEqual(readArtifactSourceSnapshot('user-owned-artifact'), firstSnapshot)
})

test('a revision of a legacy delivery snapshot without content identity fails closed', () => {
  const artifactDirectory = path.join(root, 'artifacts')
  const outputDirectory = path.join(root, 'legacy-revision-output')
  fs.mkdirSync(artifactDirectory, { recursive: true })
  fs.mkdirSync(outputDirectory, { recursive: true })
  const managedPath = path.join(artifactDirectory, 'legacy.pdf')
  const deliveryPath = path.join(outputDirectory, 'legacy.pdf')
  fs.writeFileSync(managedPath, 'managed revision')
  fs.writeFileSync(deliveryPath, 'legacy delivery')
  const artifactId = 'legacy-delivery-artifact'
  const sourceDirectory = path.join(process.env.ARTIFACT_DIR, '.artifact-sources')
  const snapshotPath = path.join(
    sourceDirectory,
    `${crypto.createHash('sha256').update(artifactId).digest('hex')}.json`,
  )
  fs.mkdirSync(sourceDirectory, { recursive: true })
  fs.writeFileSync(snapshotPath, JSON.stringify({
    version: 1,
    artifactId,
    toolName: 'create_pdf',
    sourceFormat: 'artifact_tool_arguments_json',
    source: JSON.stringify({ title: 'Legacy' }),
    deliveryPath,
    deliveryRoot: outputDirectory,
    updatedAt: Date.now(),
  }))
  assert.equal(readArtifactSourceSnapshot(artifactId).snapshotVersion, 1)

  assert.throws(
    () => syncGeneratedArtifactToOutputDirectory({
      artifact: {
        id: 'legacy-delivery-artifact',
        filename: 'legacy.pdf',
        fullPath: managedPath,
        replaced: true,
      },
      args: { title: 'Legacy revision' },
      toolName: 'create_pdf',
      outputDirectory,
    }),
    (error) => error?.code === 'ARTIFACT_DELIVERY_REVISION_CONFLICT',
  )
  assert.equal(fs.readFileSync(deliveryPath, 'utf8'), 'legacy delivery')
})

test('rollback never removes a concurrent target created after the old delivery was backed up', () => {
  const artifactDirectory = path.join(root, 'artifacts')
  const outputDirectory = path.join(root, 'backup-race-output')
  fs.mkdirSync(artifactDirectory, { recursive: true })
  const managedPath = path.join(artifactDirectory, 'backup-race.docx')
  fs.writeFileSync(managedPath, 'first version')
  const first = syncGeneratedArtifactToOutputDirectory({
    artifact: { id: 'backup-race-artifact', filename: 'backup-race.docx', fullPath: managedPath },
    args: { title: 'Backup race', paragraphs: [{ text: 'first' }] },
    toolName: 'create_docx',
    outputDirectory,
  })
  const firstSnapshot = readArtifactSourceSnapshot('backup-race-artifact')
  fs.writeFileSync(managedPath, 'generated revision')

  const originalLinkSync = fs.linkSync
  let injectedConcurrentTarget = false
  fs.linkSync = (existingPath, newPath) => {
    if (newPath === first.path && String(existingPath).includes('.gugo-') && String(existingPath).endsWith('.tmp')) {
      injectedConcurrentTarget = true
      fs.writeFileSync(newPath, 'concurrent newer target', { flag: 'wx' })
      const error = new Error('simulated concurrent target')
      error.code = 'EEXIST'
      throw error
    }
    return originalLinkSync(existingPath, newPath)
  }
  try {
    assert.throws(
      () => syncGeneratedArtifactToOutputDirectory({
        artifact: {
          id: 'backup-race-artifact',
          filename: 'backup-race.docx',
          fullPath: managedPath,
          replaced: true,
        },
        args: { title: 'Backup race', paragraphs: [{ text: 'revision' }] },
        toolName: 'create_docx',
        outputDirectory,
      }),
      (error) => error?.code === 'ARTIFACT_DELIVERY_REVISION_CONFLICT',
    )
  } finally {
    fs.linkSync = originalLinkSync
  }

  assert.equal(injectedConcurrentTarget, true)
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'concurrent newer target')
  assert.deepEqual(readArtifactSourceSnapshot('backup-race-artifact'), firstSnapshot)
})

test('an external rewrite after no-clobber install is preserved instead of rolled back', () => {
  const artifactDirectory = path.join(root, 'artifacts')
  const outputDirectory = path.join(root, 'post-install-race-output')
  fs.mkdirSync(artifactDirectory, { recursive: true })
  const managedPath = path.join(artifactDirectory, 'post-install.docx')
  fs.writeFileSync(managedPath, 'first version')
  const first = syncGeneratedArtifactToOutputDirectory({
    artifact: { id: 'post-install-race-artifact', filename: 'post-install.docx', fullPath: managedPath },
    args: { title: 'Race', paragraphs: [{ text: 'first' }] },
    toolName: 'create_docx',
    outputDirectory,
  })
  const firstSnapshot = readArtifactSourceSnapshot('post-install-race-artifact')
  fs.writeFileSync(managedPath, 'generated revision')

  const originalLinkSync = fs.linkSync
  let injectedExternalRewrite = false
  fs.linkSync = (existingPath, newPath) => {
    const result = originalLinkSync(existingPath, newPath)
    if (newPath === first.path && String(existingPath).includes('.gugo-') && String(existingPath).endsWith('.tmp')) {
      injectedExternalRewrite = true
      fs.writeFileSync(newPath, 'external version after install')
    }
    return result
  }
  try {
    assert.throws(
      () => syncGeneratedArtifactToOutputDirectory({
        artifact: {
          id: 'post-install-race-artifact',
          filename: 'post-install.docx',
          fullPath: managedPath,
          replaced: true,
        },
        args: { title: 'Race', paragraphs: [{ text: 'revision' }] },
        toolName: 'create_docx',
        outputDirectory,
      }),
      (error) => error?.code === 'ARTIFACT_DELIVERY_REVISION_CONFLICT',
    )
  } finally {
    fs.linkSync = originalLinkSync
  }

  assert.equal(injectedExternalRewrite, true)
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'external version after install')
  assert.deepEqual(readArtifactSourceSnapshot('post-install-race-artifact'), firstSnapshot)
})

test('artifact source delivery metadata rejects a stale expected generation', () => {
  const outputDirectory = path.join(root, 'snapshot-generation-output')
  const deliveryPath = path.join(outputDirectory, 'generation.pdf')
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.writeFileSync(deliveryPath, 'generation one')
  const firstDigest = crypto.createHash('sha256').update('generation one').digest('hex')
  writeArtifactSourceSnapshot({
    artifactId: 'snapshot-generation-artifact',
    toolName: 'create_pdf',
    args: { title: 'Generation one' },
    deliveryPath,
    deliveryRoot: outputDirectory,
    deliveryDigest: firstDigest,
    deliverySize: Buffer.byteLength('generation one'),
    expectedDeliveryGeneration: 0,
  })
  const committed = readArtifactSourceSnapshot('snapshot-generation-artifact')

  assert.throws(
    () => writeArtifactSourceSnapshot({
      artifactId: 'snapshot-generation-artifact',
      toolName: 'create_pdf',
      args: { title: 'Stale writer' },
      deliveryPath,
      deliveryRoot: outputDirectory,
      deliveryDigest: crypto.createHash('sha256').update('stale').digest('hex'),
      deliverySize: Buffer.byteLength('stale'),
      expectedDeliveryGeneration: 0,
    }),
    (error) => error?.code === 'artifact_source_snapshot_conflict',
  )
  assert.deepEqual(readArtifactSourceSnapshot('snapshot-generation-artifact'), committed)
})

test('a revision rejects delivery metadata that escapes its recorded root', () => {
  const artifactDirectory = path.join(root, 'artifacts')
  const outputDirectory = path.join(root, 'safe-output')
  const outsideDirectory = path.join(root, 'outside-output')
  fs.mkdirSync(artifactDirectory, { recursive: true })
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.mkdirSync(outsideDirectory, { recursive: true })
  const managedPath = path.join(artifactDirectory, 'safe.docx')
  const outsidePath = path.join(outsideDirectory, 'safe.docx')
  fs.writeFileSync(managedPath, 'managed revision')
  fs.writeFileSync(outsidePath, 'outside original')
  writeArtifactSourceSnapshot({
    artifactId: 'unsafe-delivery-artifact',
    toolName: 'create_docx',
    args: { title: 'Safe', paragraphs: [{ text: 'source' }] },
    deliveryPath: outsidePath,
    deliveryRoot: outputDirectory,
  })

  assert.throws(
    () => syncGeneratedArtifactToOutputDirectory({
      artifact: {
        id: 'unsafe-delivery-artifact',
        filename: 'safe.docx',
        fullPath: managedPath,
        replaced: true,
      },
      args: { title: 'Safe', paragraphs: [{ text: 'revision' }] },
      toolName: 'create_docx',
      outputDirectory,
    }),
    (error) => error?.code === 'ARTIFACT_DELIVERY_PATH_INVALID',
  )
  assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'outside original')
})
