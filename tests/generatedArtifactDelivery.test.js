import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-generated-delivery-'))
process.env.ARTIFACT_DIR = path.join(root, 'artifacts')
process.env.APP_DATA_DIR = path.join(root, 'data')

const { syncGeneratedArtifactToOutputDirectory } = await import('../server/services/generatedArtifactDelivery.js')
const { writeArtifactSourceSnapshot } = await import('../server/services/artifactSourceStore.js')
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
