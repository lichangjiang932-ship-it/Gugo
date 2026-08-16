import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-html-runtime-'))
process.env.APP_DATA_DIR = path.join(root, 'data')
process.env.ARTIFACT_DIR = path.join(root, 'artifacts')

const { closeDb, createUser } = await import('../server/db.js')
const { readArtifactSourceSnapshot } = await import('../server/services/artifactSourceStore.js')
const { getArtifactDir } = await import('../server/services/artifactGen.js')
const { getHtmlArtifactAsset } = await import('../server/services/htmlArtifactAssets.js')
const { setDefaultOutputDirectory } = await import('../server/services/localFileAccessService.js')
const { executeServerTool } = await import('../server/services/toolLoopHeuristics.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { getTurnArtifactById, listSessionTurnArtifacts } = await import('../server/services/turnArtifactStore.js')

test.after(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

test('create_html_app bundles authorized media, delivers offline, and retains it during revision', async () => {
  const userId = 'html-runtime-user'
  const sessionId = 'html-runtime-session'
  const outputDirectory = path.join(root, 'output')
  const sourceDirectory = path.join(root, 'source')
  const portraitPath = path.join(sourceDirectory, 'portrait.jpg')
  const portrait = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4])
  fs.mkdirSync(sourceDirectory, { recursive: true })
  fs.writeFileSync(portraitPath, portrait)
  createUser({ id: userId, email: 'html-runtime@example.com' })
  upsertSession({ id: sessionId, userId, title: 'HTML runtime' })
  setDefaultOutputDirectory({ userId, rootPath: outputDirectory })

  const firstHtml = '<!doctype html><html><body><img src="gugo-asset://portrait"><main>First</main></body></html>'
  const first = await executeServerTool({
    name: 'create_html_app',
    args: {
      title: 'Runtime gallery',
      html: firstHtml,
      assets: [{ id: 'portrait', path: portraitPath }],
    },
    job: {
      id: 'html-runtime-turn-1',
      userId,
      sessionId,
      origin: 'chat',
      prompt: '用已有图片创建网页',
      userPrompt: '用已有图片创建网页',
    },
    step: { id: 'html-runtime-step-1', kind: 'chat' },
    allowedArtifactTools: new Set(['create_html_app']),
  })

  assert.equal(first.ok, true)
  assert.equal(first.deliveryStatus, 'delivered')
  const artifact = getTurnArtifactById({ id: first.artifactId, userId, sessionId })
  assert.ok(artifact)
  const managedPath = path.join(getArtifactDir(), artifact.filename)
  assert.equal(fs.readFileSync(managedPath, 'utf8'), firstHtml)
  assert.deepEqual(
    fs.readFileSync(getHtmlArtifactAsset({
      artifactDirectory: getArtifactDir(),
      artifactId: artifact.id,
      assetId: 'portrait',
    }).fullPath),
    portrait,
  )
  const deliveredFirst = fs.readFileSync(first.path, 'utf8')
  assert.match(deliveredFirst, /data:image\/jpeg;base64,/)
  assert.doesNotMatch(deliveredFirst, /gugo-asset:\/\//)

  const snapshot = readArtifactSourceSnapshot(artifact.id)
  assert.ok(snapshot)
  assert.doesNotMatch(snapshot.source, new RegExp(root.replaceAll('\\', '\\\\'), 'i'))
  assert.deepEqual(JSON.parse(snapshot.source).assets, [{ id: 'portrait' }])

  const revisedHtml = '<!doctype html><html><body><header>Revised</header><img src="gugo-asset://portrait"><main>Second</main></body></html>'
  const revised = await executeServerTool({
    name: 'create_html_app',
    args: {
      title: 'Runtime gallery',
      html: revisedHtml,
      assets: [{ id: 'portrait' }],
      replace_artifact_id: artifact.id,
    },
    job: {
      id: 'html-runtime-turn-2',
      userId,
      sessionId,
      origin: 'chat',
      prompt: '修改原版网页的布局并保留图片',
      userPrompt: '修改原版网页的布局并保留图片',
    },
    step: { id: 'html-runtime-step-2', kind: 'chat' },
    allowedArtifactTools: new Set(['create_html_app']),
  })

  assert.equal(revised.ok, true)
  assert.equal(revised.replaced, true)
  assert.equal(revised.artifactId, artifact.id)
  assert.equal(revised.path, first.path)
  assert.equal(fs.readFileSync(managedPath, 'utf8'), revisedHtml)
  const deliveredRevision = fs.readFileSync(revised.path, 'utf8')
  assert.match(deliveredRevision, /Revised/)
  assert.match(deliveredRevision, /data:image\/jpeg;base64,/)
  assert.deepEqual(
    fs.readFileSync(getHtmlArtifactAsset({
      artifactDirectory: getArtifactDir(),
      artifactId: artifact.id,
      assetId: 'portrait',
    }).fullPath),
    portrait,
  )
  assert.equal(listSessionTurnArtifacts({ userId, sessionId }).length, 1)
})

test('a failed replacement cannot corrupt the current HTML or media bundle', async () => {
  const userId = 'html-runtime-user'
  const sessionId = 'html-runtime-session'
  const [artifact] = listSessionTurnArtifacts({ userId, sessionId })
  const managedPath = path.join(getArtifactDir(), artifact.filename)
  const beforeHtml = fs.readFileSync(managedPath, 'utf8')
  const beforeAsset = fs.readFileSync(getHtmlArtifactAsset({
    artifactDirectory: getArtifactDir(), artifactId: artifact.id, assetId: 'portrait',
  }).fullPath)

  await assert.rejects(() => executeServerTool({
    name: 'create_html_app',
    args: {
      title: 'Broken revision',
      html: '<!doctype html><html><body><img src="gugo-asset://missing"><main>Broken</main></body></html>',
      assets: [{ id: 'missing' }],
      replace_artifact_id: artifact.id,
    },
    job: {
      id: 'html-runtime-turn-3', userId, sessionId, origin: 'chat',
      prompt: '修改原版网页', userPrompt: '修改原版网页',
    },
    step: { id: 'html-runtime-step-3', kind: 'chat' },
    allowedArtifactTools: new Set(['create_html_app']),
  }), /unavailable managed asset/)

  assert.equal(fs.readFileSync(managedPath, 'utf8'), beforeHtml)
  assert.deepEqual(fs.readFileSync(getHtmlArtifactAsset({
    artifactDirectory: getArtifactDir(), artifactId: artifact.id, assetId: 'portrait',
  }).fullPath), beforeAsset)
})

test('replacement rollback keeps the previous source snapshot when backup cleanup fails', async () => {
  const userId = 'html-runtime-user'
  const sessionId = 'html-runtime-session'
  const [artifact] = listSessionTurnArtifacts({ userId, sessionId })
  const managedPath = path.join(getArtifactDir(), artifact.filename)
  const beforeHtml = fs.readFileSync(managedPath, 'utf8')
  const beforeSnapshot = readArtifactSourceSnapshot(artifact.id)
  const beforeAsset = fs.readFileSync(getHtmlArtifactAsset({
    artifactDirectory: getArtifactDir(), artifactId: artifact.id, assetId: 'portrait',
  }).fullPath)
  const originalRmSync = fs.rmSync
  let interceptedBackupCleanup = false
  fs.rmSync = (target, options) => {
    const normalizedTarget = String(target).replaceAll('\\', '/')
    if (/\.replace-[^/]+\.bak$/i.test(normalizedTarget)) {
      interceptedBackupCleanup = true
      const error = new Error('simulated locked replacement backup')
      error.code = 'EBUSY'
      throw error
    }
    return originalRmSync(target, options)
  }

  try {
    await assert.rejects(() => executeServerTool({
      name: 'create_html_app',
      args: {
        title: 'Revision that must roll back',
        html: '<!doctype html><html><body><img src="gugo-asset://portrait"><main>Must roll back</main></body></html>',
        assets: [{ id: 'portrait' }],
        replace_artifact_id: artifact.id,
      },
      job: {
        id: 'html-runtime-turn-4', userId, sessionId, origin: 'chat',
        prompt: '修改原版网页', userPrompt: '修改原版网页',
      },
      step: { id: 'html-runtime-step-4', kind: 'chat' },
      allowedArtifactTools: new Set(['create_html_app']),
    }), /simulated locked replacement backup/)
  } finally {
    fs.rmSync = originalRmSync
  }

  assert.equal(interceptedBackupCleanup, true)
  assert.equal(fs.readFileSync(managedPath, 'utf8'), beforeHtml)
  assert.deepEqual(readArtifactSourceSnapshot(artifact.id), beforeSnapshot)
  assert.deepEqual(fs.readFileSync(getHtmlArtifactAsset({
    artifactDirectory: getArtifactDir(), artifactId: artifact.id, assetId: 'portrait',
  }).fullPath), beforeAsset)
})

test('a required local delivery cannot report a managed-only HTML artifact as success', async () => {
  const userId = 'html-required-delivery-user'
  const sessionId = 'html-required-delivery-session'
  const blockedOutput = path.join(root, 'blocked-required-output')
  createUser({ id: userId, email: 'html-required-delivery@example.com' })
  upsertSession({ id: sessionId, userId, title: 'Required HTML delivery' })
  setDefaultOutputDirectory({ userId, rootPath: blockedOutput })
  fs.rmSync(blockedOutput, { recursive: true, force: true })
  fs.writeFileSync(blockedOutput, 'this file blocks directory creation')

  const result = await executeServerTool({
    name: 'create_html_app',
    args: {
      title: 'Required delivery failure',
      html: '<!doctype html><html><body><main>Managed copy only</main></body></html>',
    },
    job: {
      id: 'html-required-delivery-turn', userId, sessionId, origin: 'chat',
      prompt: '生成网页并保存到默认目录', userPrompt: '生成网页并保存到默认目录',
    },
    step: { id: 'html-required-delivery-step', kind: 'chat' },
    allowedArtifactTools: new Set(['create_html_app']),
    requiresLocalArtifactDelivery: true,
  })

  assert.equal(result.ok, false)
  assert.equal(result.deliveryStatus, 'managed_only')
  assert.equal(result.code, result.deliveryError.code)
  assert.match(result.error, /EEXIST|exist|directory/i)
})

test('a pure managed HTML artifact may retain managed-only success', async () => {
  const userId = 'html-managed-only-user'
  const sessionId = 'html-managed-only-session'
  const blockedOutput = path.join(root, 'blocked-managed-output')
  createUser({ id: userId, email: 'html-managed-only@example.com' })
  upsertSession({ id: sessionId, userId, title: 'Managed-only HTML' })
  setDefaultOutputDirectory({ userId, rootPath: blockedOutput })
  fs.rmSync(blockedOutput, { recursive: true, force: true })
  fs.writeFileSync(blockedOutput, 'this file blocks directory creation')

  const result = await executeServerTool({
    name: 'create_html_app',
    args: {
      title: 'Managed-only fallback',
      html: '<!doctype html><html><body><main>Managed preview</main></body></html>',
    },
    job: {
      id: 'html-managed-only-turn', userId, sessionId, origin: 'chat',
      prompt: '只创建 Gugo 托管网页', userPrompt: '只创建 Gugo 托管网页',
    },
    step: { id: 'html-managed-only-step', kind: 'chat' },
    allowedArtifactTools: new Set(['create_html_app']),
    requiresLocalArtifactDelivery: false,
  })

  assert.equal(result.ok, true)
  assert.equal(result.deliveryStatus, 'managed_only')
  assert.ok(result.artifactId)
})
