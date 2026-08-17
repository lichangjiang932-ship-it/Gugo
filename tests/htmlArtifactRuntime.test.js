import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-html-runtime-'))
process.env.APP_DATA_DIR = path.join(root, 'data')
process.env.ARTIFACT_DIR = path.join(root, 'artifacts')

const { closeDb, createUser } = await import('../server/db.js')
const { readArtifactSourceSnapshot } = await import('../server/services/artifactSourceStore.js')
const { getArtifactDir } = await import('../server/services/artifactGen.js')
const { getHtmlArtifactAsset } = await import('../server/services/htmlArtifactAssets.js')
const { setAllFilesAccess, setDefaultOutputDirectory } = await import('../server/services/localFileAccessService.js')
const { executeServerTool, requestedArtifactOutputDirectory } = await import('../server/services/toolLoopHeuristics.js')
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
  const portrait = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#334155' },
  }).jpeg().toBuffer()
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

test('a complete JPG directory is fully bundled, delivered to the explicit directory, and fails closed when one image is omitted', async () => {
  const userId = 'html-complete-gallery-user'
  const sessionId = 'html-complete-gallery-session'
  const sourceDirectory = path.join(root, '完整 人物图库')
  const defaultOutputDirectory = path.join(root, 'unused-default-output')
  const explicitOutputDirectory = path.join(root, 'explicit-output')
  fs.mkdirSync(sourceDirectory, { recursive: true })
  const jpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 34, g: 120, b: 200 } },
  }).jpeg().toBuffer()
  const files = [
    path.join(sourceDirectory, '人物 01.jpg'),
    path.join(sourceDirectory, '人物-二.JPG'),
    path.join(sourceDirectory, '角色三.jpeg'),
  ]
  for (const file of files) fs.writeFileSync(file, jpeg)
  fs.writeFileSync(path.join(sourceDirectory, 'not-requested.png'), await sharp(jpeg).png().toBuffer())

  createUser({ id: userId, email: 'html-complete-gallery@example.com' })
  upsertSession({ id: sessionId, userId, title: 'Complete gallery' })
  setDefaultOutputDirectory({ userId, rootPath: defaultOutputDirectory })
  setAllFilesAccess({ userId, enabled: true, confirmation: 'ALLOW_ALL_LOCAL_FILES' })

  const ids = ['portrait_1', 'portrait_2', 'portrait_3']
  const html = `<!doctype html><html><body>${ids.map((id) => `<img src="gugo-asset://${id}" alt="${id}">`).join('')}</body></html>`
  const result = await executeServerTool({
    name: 'create_html_app',
    args: {
      title: '完整人物画廊',
      html,
      output_directory: explicitOutputDirectory,
      asset_collection: { directory: sourceDirectory, extensions: ['jpg', 'jpeg'], recursive: true },
      assets: files.map((file, index) => ({ id: ids[index], path: file })),
    },
    job: {
      id: 'html-complete-gallery-turn', userId, sessionId, origin: 'chat',
      prompt: `确保 ${sourceDirectory} 下所有 JPG 都被使用，生成网站并保存到指定目录`,
      userPrompt: `确保 ${sourceDirectory} 下所有 JPG 都被使用，生成网站并保存到指定目录`,
    },
    step: { id: 'html-complete-gallery-step', kind: 'chat' },
    allowedArtifactTools: new Set(['create_html_app']),
    requiresLocalArtifactDelivery: true,
  })

  assert.equal(result.ok, true)
  assert.equal(result.deliveryStatus, 'delivered')
  assert.equal(result.mediaAssetCount, 3)
  assert.equal(path.dirname(result.path), fs.realpathSync(explicitOutputDirectory))
  assert.notEqual(path.dirname(result.path), fs.realpathSync(defaultOutputDirectory))
  const delivered = fs.readFileSync(result.path, 'utf8')
  assert.equal((delivered.match(/data:image\/jpeg;base64,/g) || []).length, 3)
  assert.doesNotMatch(delivered, /gugo-asset:|file:\/\/\//i)
  const snapshot = readArtifactSourceSnapshot(result.artifactId)
  assert.doesNotMatch(snapshot.source, new RegExp(sourceDirectory.replaceAll('\\', '\\\\'), 'i'))
  assert.doesNotMatch(snapshot.source, new RegExp(explicitOutputDirectory.replaceAll('\\', '\\\\'), 'i'))

  const runtimePriorityOutput = path.join(root, 'runtime-priority-output')
  const runtimePriorityPrompt = `“${sourceDirectory}”有很多人物 JPG，用这些图片写一个网站，确保该文件下的所有 JPG 都被使用，写到 ${runtimePriorityOutput}，完成后验证`
  const runtimePriorityResult = await executeServerTool({
    name: 'create_html_app',
    args: {
      title: '显式保存位置优先',
      html,
      // Simulate a model copying the configured default into its call. The
      // runtime must still obey the explicit destination in the user turn.
      output_directory: defaultOutputDirectory,
      asset_collection: { directory: sourceDirectory, extensions: ['jpg', 'jpeg'], recursive: true },
      assets: files.map((file, index) => ({ id: ids[index], path: file })),
    },
    job: {
      id: 'html-runtime-output-priority-turn', userId, sessionId, origin: 'chat',
      prompt: runtimePriorityPrompt,
      userPrompt: runtimePriorityPrompt,
    },
    step: { id: 'html-runtime-output-priority-step', kind: 'chat' },
    allowedArtifactTools: new Set(['create_html_app']),
    requiresLocalArtifactDelivery: true,
  })

  assert.equal(runtimePriorityResult.ok, true)
  assert.equal(path.dirname(runtimePriorityResult.path), fs.realpathSync(runtimePriorityOutput))
  assert.notEqual(path.dirname(runtimePriorityResult.path), fs.realpathSync(defaultOutputDirectory))

  const defaultDirectiveResult = await executeServerTool({
    name: 'create_html_app',
    args: {
      title: '否定显式目录后使用默认目录',
      html,
      output_directory: runtimePriorityOutput,
      asset_collection: { directory: sourceDirectory, extensions: ['jpg', 'jpeg'], recursive: true },
      assets: files.map((file, index) => ({ id: ids[index], path: file })),
    },
    job: {
      id: 'html-default-output-directive-turn', userId, sessionId, origin: 'chat',
      prompt: `不要写到 ${runtimePriorityOutput}，使用默认目录`,
      userPrompt: `不要写到 ${runtimePriorityOutput}，使用默认目录`,
    },
    step: { id: 'html-default-output-directive-step', kind: 'chat' },
    allowedArtifactTools: new Set(['create_html_app']),
    requiresLocalArtifactDelivery: true,
  })

  assert.equal(defaultDirectiveResult.ok, true)
  assert.equal(path.dirname(defaultDirectiveResult.path), fs.realpathSync(defaultOutputDirectory))
  assert.notEqual(path.dirname(defaultDirectiveResult.path), fs.realpathSync(runtimePriorityOutput))

  await assert.rejects(() => executeServerTool({
    name: 'create_html_app',
    args: {
      title: '漏图画廊',
      html: `<!doctype html><html><body>${ids.slice(0, 2).map((id) => `<img src="gugo-asset://${id}">`).join('')}</body></html>`,
      output_directory: explicitOutputDirectory,
      asset_collection: { directory: sourceDirectory, extensions: ['jpg', 'jpeg'] },
      assets: files.slice(0, 2).map((file, index) => ({ id: ids[index], path: file })),
    },
    job: {
      id: 'html-incomplete-gallery-turn', userId, sessionId, origin: 'chat',
      prompt: `确保 ${sourceDirectory} 下所有 JPG 都被使用`,
      userPrompt: `确保 ${sourceDirectory} 下所有 JPG 都被使用`,
    },
    step: { id: 'html-incomplete-gallery-step', kind: 'chat' },
    allowedArtifactTools: new Set(['create_html_app']),
    requiresLocalArtifactDelivery: true,
  }), (error) => error?.code === 'HTML_MEDIA_COLLECTION_INCOMPLETE' && error?.missingCount === 1)

  await assert.rejects(() => executeServerTool({
    name: 'create_html_app',
    args: {
      title: '隐藏图片画廊',
      html: `<!doctype html><html><body>${ids.slice(0, 2).map((id) => `<img src="gugo-asset://${id}">`).join('')}<img hidden src="gugo-asset://${ids[2]}"></body></html>`,
      output_directory: explicitOutputDirectory,
      asset_collection: { directory: sourceDirectory, extensions: ['jpg', 'jpeg'] },
      assets: files.map((file, index) => ({ id: ids[index], path: file })),
    },
    job: {
      id: 'html-hidden-gallery-turn', userId, sessionId, origin: 'chat',
      prompt: `确保 ${sourceDirectory} 下所有 JPG 都被使用`,
      userPrompt: `确保 ${sourceDirectory} 下所有 JPG 都被使用`,
    },
    step: { id: 'html-hidden-gallery-step', kind: 'chat' },
    allowedArtifactTools: new Set(['create_html_app']),
    requiresLocalArtifactDelivery: true,
  }), (error) => error?.code === 'HTML_MEDIA_COLLECTION_NOT_VISIBLE' && error?.hiddenCount === 1)

  assert.equal(requestedArtifactOutputDirectory('把网页写到E盘'), `E:${path.sep}`)
  assert.equal(requestedArtifactOutputDirectory(
    '"E:\\果"这个地方有很多人物图片，用这些人物图片你来写一个网站，确保该文件下的所有内容都被使用，写到E盘',
  ), `E:${path.sep}`)
  assert.equal(
    requestedArtifactOutputDirectory('读取 E:\\果 中全部 JPG，生成网站，写到 E:\\网页输出，完成后验证'),
    path.normalize('E:\\网页输出'),
  )
  assert.equal(
    requestedArtifactOutputDirectory('保存到 "E:\\网页 输出"'),
    path.normalize('E:\\网页 输出'),
  )
  assert.equal(
    requestedArtifactOutputDirectory('不要保存到 D:\\默认目录，纠正：写到 E 盘'),
    `E:${path.sep}`,
  )
  assert.equal(
    requestedArtifactOutputDirectory('把网站保存到 E:\\网页输出\\gallery.html，完成后告诉我'),
    path.normalize('E:\\网页输出'),
  )
  assert.equal(
    requestedArtifactOutputDirectory('读取 E:\\果 中全部 JPG 并生成网站'),
    '',
    'a source path without a destination connector must not replace the configured output directory',
  )
  for (const sourceOnly of [
    '生成网站，读取 E 盘图片',
    '生成网页，扫描 E 盘全部 JPG',
    '制作图片网站，使用 E 盘现有图片',
  ]) {
    assert.equal(requestedArtifactOutputDirectory(sourceOnly), '', sourceOnly)
  }
  assert.equal(
    requestedArtifactOutputDirectory('不要写到 E 盘，使用默认目录'),
    '',
    'a negated drive destination must not override the configured default directory',
  )
  assert.equal(
    requestedArtifactOutputDirectory('不要使用默认目录，改为写到 E 盘'),
    `E:${path.sep}`,
  )
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
