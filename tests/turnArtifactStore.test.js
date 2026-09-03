import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-turn-artifacts-'))
process.env.APP_DATA_DIR = tempDir
process.env.ARTIFACT_DIR = path.join(tempDir, 'artifacts')
process.env.YMA_TEST_DATA_ROOT = tempDir
process.env.YMA_TEST_DEFAULT_OUTPUT_DIR = path.join(tempDir, 'output')
fs.mkdirSync(process.env.YMA_TEST_DEFAULT_OUTPUT_DIR, { recursive: true })

const { closeDb, createUser } = await import('../server/db.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { getSessionSnapshot, upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnArtifact, getTurnArtifactByFilename, listTurnArtifacts } = await import('../server/services/turnArtifactStore.js')
const {
  persistLocalToolArtifacts,
  runToolsLoop,
  SERVER_TOOL_SPECS,
} = await import('../server/services/toolLoopRuntime.js')
const {
  localArtifactPublicationKey,
  persistLocalToolArtifactsAsync,
} = await import('../server/services/loop/heuristics/toolSelection.js')
const {
  clearArtifactValidatedMutationTargets,
  powerShellVerificationTargets,
} = await import('../server/services/loop/heuristics/mutationVerification.js')
const {
  createDocx,
  createImageArtifact,
  createLocalFileArtifactAsync,
  createPdf,
  createPptx,
  createXlsx,
} = await import('../server/services/artifactGen.js')
const {
  verifyPublishedArtifact,
} = await import('../server/services/artifactLocalPublicationStaging.js')
const { getSideEffectExecutionLedger } = await import('../server/services/sideEffectExecutionLedger.js')
const {
  isLocalMutationCall,
  isReadOnlyPowerShellVerificationCall,
} = await import('../server/services/toolLoopHeuristics.js')
const { createTestTurnEnginePersistence } = await import('./helpers/turnEnginePersistence.js')

function isPublicationMarkerLink(args) {
  return String(args[1] || '').includes(`${path.sep}.artifact-publications${path.sep}`)
}

function isPublicationLockLink(args) {
  const source = path.basename(String(args[0] || ''))
  const target = path.basename(String(args[1] || ''))
  return target.startsWith('.publish-')
    && target.endsWith('.lock')
    && source.startsWith(`.${target}-`)
    && source.endsWith('.tmp')
}

function isPublicationMetadataLink(args) {
  return isPublicationMarkerLink(args) || isPublicationLockLink(args)
}

function isPublicationLockTemporary(target, lockPath) {
  const targetPath = String(target || '')
  return path.dirname(targetPath) === path.dirname(lockPath)
    && path.basename(targetPath).startsWith(`.${path.basename(lockPath)}-`)
    && path.basename(targetPath).endsWith('.tmp')
}

function statWithFileIdentity(stat, identity) {
  return new Proxy(stat, {
    get(target, property) {
      if (property === 'dev' || property === 'ino') return identity[property]
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function errorChain(root) {
  const found = []
  const pending = [root]
  const visited = new Set()
  while (pending.length > 0) {
    const current = pending.shift()
    if (!current || visited.has(current)) continue
    visited.add(current)
    found.push(current)
    if (current.cause) pending.push(current.cause)
    if (current instanceof AggregateError) pending.push(...current.errors)
  }
  return found
}

function stablePublicationPaths(filename, publicationKey) {
  const digest = crypto.createHash('sha256').update(publicationKey).digest('hex')
  const parsed = path.parse(filename)
  const stableFilename = `${parsed.name}-${digest.slice(0, 20)}${parsed.ext}`
  return {
    artifactPath: path.join(process.env.ARTIFACT_DIR, stableFilename),
    lockPath: path.join(process.env.ARTIFACT_DIR, `.publish-${digest.slice(0, 32)}.lock`),
    markerPath: path.join(process.env.ARTIFACT_DIR, '.artifact-publications', `${digest}.json`),
  }
}

const artifactCrashPublisherPath = fileURLToPath(new URL('./fixtures/artifactCrashPublisher.mjs', import.meta.url))

function crashStablePublisher({ mode, sourcePath, filename, publicationKey }) {
  const childDataDirectory = path.join(tempDir, `crash-child-${crypto.randomBytes(8).toString('hex')}`)
  const result = spawnSync(process.execPath, [
    artifactCrashPublisherPath,
    mode,
    sourcePath,
    filename,
    publicationKey,
  ], {
    env: {
      ...process.env,
      APP_DATA_DIR: childDataDirectory,
      ARTIFACT_DIR: process.env.ARTIFACT_DIR,
      YMA_TEST_DATA_ROOT: childDataDirectory,
      YMA_TEST_DEFAULT_OUTPUT_DIR: path.join(childDataDirectory, 'output'),
    },
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(result.error, undefined, result.stderr || result.error?.message)
  assert.notEqual(result.status, 0, 'crash fixture unexpectedly completed publication')
  assert.notEqual(result.status, 70, result.stderr || 'crash fixture missed its injection point')
  return result
}

function publicationAttemptResidue(publicationKey) {
  const digest = crypto.createHash('sha256').update(publicationKey).digest('hex')
  const markerDirectory = path.join(process.env.ARTIFACT_DIR, '.artifact-publications')
  return {
    digest,
    lockPath: path.join(process.env.ARTIFACT_DIR, `.publish-${digest.slice(0, 32)}.lock`),
    stagingPaths: fs.readdirSync(process.env.ARTIFACT_DIR)
      .filter((name) => name.startsWith(`.publish-${digest.slice(0, 20)}-`) && name.endsWith('.tmp'))
      .map((name) => path.join(process.env.ARTIFACT_DIR, name)),
    attemptRecords: fs.readdirSync(markerDirectory)
      .filter((name) => name.startsWith(`.${digest}-`) && /\.(?:stage|destination)\.json$/u.test(name))
      .map((name) => path.join(markerDirectory, name)),
  }
}

function artifactCleanupClaims() {
  const directories = [
    process.env.ARTIFACT_DIR,
    path.join(process.env.ARTIFACT_DIR, '.artifact-publications'),
  ]
  return directories.flatMap((directory) => {
    if (!fs.existsSync(directory)) return []
    return fs.readdirSync(directory)
      .filter((name) => name.startsWith('.artifact-cleanup-') && name.endsWith('.tmp'))
      .map((name) => path.join(directory, name))
  })
}

function linkedRecordTemporaries(recordPath) {
  const directory = path.dirname(recordPath)
  if (!fs.existsSync(directory)) return []
  const prefix = `.${path.basename(recordPath)}-`
  return fs.readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
    .map((name) => path.join(directory, name))
}

function cleanupPublicationTestResidue(filename, publicationKey) {
  const { digest, lockPath, stagingPaths } = publicationAttemptResidue(publicationKey)
  const { artifactPath, markerPath } = stablePublicationPaths(filename, publicationKey)
  const markerDirectory = path.dirname(markerPath)
  const markerEntries = fs.readdirSync(markerDirectory)
    .filter((name) => name.includes(digest))
    .map((name) => path.join(markerDirectory, name))
  for (const target of [
    ...stagingPaths,
    ...markerEntries,
    ...linkedRecordTemporaries(lockPath),
    ...artifactCleanupClaims(),
    lockPath,
    artifactPath,
    `${artifactPath}.displaced`,
  ]) {
    try { fs.unlinkSync(target) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
}

createUser({ id: 'artifact-user', email: 'turn-artifact@example.com' })
setApprovalMode({ userId: 'artifact-user', mode: 'bypass' })
upsertSession({ id: 'artifact-session', userId: 'artifact-user', title: 'Artifacts' })

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('chat TurnEngine persists generated files without a jobs-table foreign key', async () => {
  let calls = 0
  const engine = new TurnEngine({
    persistence: createTestTurnEnginePersistence(),
    runModel: async () => {
      calls += 1
      return calls === 1
        ? {
            content: '',
            toolCalls: [{
              id: 'doc-call',
              function: { name: 'create_docx', arguments: JSON.stringify({ title: 'Turn Doc', paragraphs: [{ text: 'hello' }] }) },
            }],
          }
        : { content: '文档已生成。', toolCalls: [] }
    },
  })
  await engine.startTurn({
    userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'artifact-turn', content: '生成 Word 文档',
  })
  await engine.waitForTurn({ userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'artifact-turn' })
  const artifacts = listTurnArtifacts({ userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'artifact-turn' })
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].type, 'docx')
  assert.equal(getTurnArtifactByFilename(artifacts[0].filename).userId, 'artifact-user')
  assert.deepEqual(listTurnArtifacts({ userId: 'other-user', sessionId: 'artifact-session', turnId: 'artifact-turn' }), [])
  assert.equal(fs.existsSync(path.join(process.env.YMA_TEST_DEFAULT_OUTPUT_DIR, artifacts[0].filename)), true)
  const assistant = getSessionSnapshot({ userId: 'artifact-user', sessionId: 'artifact-session' })
    .messages.find((message) => message.id === 'artifact-turn:assistant')
  assert.deepEqual(assistant.artifacts.map(({ id, filename, type, url }) => ({ id, filename, type, url })), [{
    id: artifacts[0].id,
    filename: artifacts[0].filename,
    type: 'docx',
    url: artifacts[0].url,
  }])
})

test('/webpage creates a persisted self-contained HTML artifact for preview', async () => {
  let calls = 0
  const engine = new TurnEngine({
    persistence: createTestTurnEnginePersistence(),
    runModel: async () => {
      calls += 1
      return calls === 1
        ? {
            content: '',
            toolCalls: [{
              id: 'html-call',
              function: {
                name: 'create_html_app',
                arguments: JSON.stringify({
                  title: '本地模型介绍',
                  html: '<!doctype html><html lang="zh-CN"><head><style>body{font-family:sans-serif}</style></head><body><main>本地模型介绍</main></body></html>',
                }),
              },
            }],
          }
        : { content: '网页已生成。', toolCalls: [] }
    },
  })
  await engine.startTurn({
    userId: 'artifact-user',
    sessionId: 'artifact-session',
    turnId: 'webpage-artifact-turn',
    content: '/webpage 帮我生成一个网页来介绍本地模型',
    skillIds: ['webpage'],
  })
  await engine.waitForTurn({
    userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'webpage-artifact-turn',
  })

  const artifacts = listTurnArtifacts({
    userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'webpage-artifact-turn',
  })
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].type, 'html')
  assert.match(artifacts[0].filename, /\.html$/)
  const saved = fs.readFileSync(path.join(process.env.ARTIFACT_DIR, artifacts[0].filename), 'utf8')
  assert.match(saved, /<main>本地模型介绍<\/main>/)
})

test('archive_create publishes its ZIP as a downloadable turn artifact', async () => {
  const archivePath = path.join(tempDir, 'bundled-output.zip')
  fs.writeFileSync(archivePath, Buffer.from('PK\x03\x04test-archive'))
  const archiveCreate = SERVER_TOOL_SPECS.find((item) => (
    item?.function?.name === 'archive_create'
  ))
  const archiveList = SERVER_TOOL_SPECS.find((item) => (
    item?.function?.name === 'archive_list'
  ))
  const setDeliverables = SERVER_TOOL_SPECS.find((item) => (
    item?.function?.name === 'set_deliverables'
  ))
  assert.ok(archiveCreate)
  assert.ok(archiveList)
  assert.ok(setDeliverables)

  let modelCalls = 0
  let publishedResult = null
  const result = await runToolsLoop({
    job: {
      id: 'archive-artifact-turn',
      origin: 'chat',
      userId: 'artifact-user',
      sessionId: 'artifact-session',
      prompt: 'Create a ZIP archive from the requested files.',
    },
    step: { id: 'archive-artifact-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create a ZIP archive from the requested files.' }],
    intentMode: 'execute',
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    toolSpecs: [archiveCreate, archiveList, setDeliverables],
    maxIters: 4,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'archive-create-call',
            type: 'function',
            function: {
              name: 'archive_create',
              arguments: JSON.stringify({ inputs: ['source.txt'], output: archivePath }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        publishedResult = JSON.parse(messages.findLast((message) => message.role === 'tool').content)
        return {
          content: '',
          toolCalls: [{
            id: 'archive-list-call',
            type: 'function',
            function: {
              name: 'archive_list',
              arguments: JSON.stringify({ input: archivePath }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'select-archive-call',
            type: 'function',
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: [publishedResult.artifactId] }),
            },
          }],
        }
      }
      return { content: 'The ZIP archive is ready.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      if (name === 'archive_create') {
        assert.equal(args.output, archivePath)
        return { ok: true, output: archivePath, format: 'zip', entries: 1 }
      }
      assert.equal(name, 'archive_list')
      assert.equal(args.input, archivePath)
      return { ok: true, input: archivePath, format: 'zip', entryCount: 1, entries: [] }
    },
  })

  assert.equal(result.text, 'The ZIP archive is ready.')
  assert.equal(result.artifactIds.length, 1)
  assert.equal(publishedResult.artifactId, result.artifactIds[0])
  assert.match(publishedResult.filename, /^bundled-output-[a-f0-9]{20}\.zip$/)
  assert.equal(publishedResult.url, `/api/artifacts/${publishedResult.filename}`)
  const artifacts = listTurnArtifacts({
    userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'archive-artifact-turn',
  })
  assert.deepEqual(artifacts.map(({ id, filename, type, url }) => ({ id, filename, type, url })), [{
    id: result.artifactIds[0],
    filename: publishedResult.filename,
    type: 'zip',
    url: publishedResult.url,
  }])
})

test('local tool artifact publication is idempotent across committed-ledger checkpoint recovery', async () => {
  const turnId = 'local-artifact-ledger-recovery-turn'
  const callId = 'local-artifact-ledger-recovery-call'
  const sourcePath = path.join(tempDir, 'ledger-recovery-output.zip')
  fs.writeFileSync(sourcePath, Buffer.from('PK\x03\x04ledger-recovery'))
  const archiveCreate = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'archive_create')
  const setDeliverables = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'set_deliverables')
  assert.ok(archiveCreate)
  assert.ok(setDeliverables)

  let checkpoint = null
  let failCompletedCheckpoint = true
  let executeCalls = 0
  const saveCheckpoint = async (state) => {
    if (failCompletedCheckpoint
      && state?.toolCalls?.some((call) => call.id === callId && call.checkpointStatus === 'completed')) {
      failCompletedCheckpoint = false
      throw new Error('injected crash after local artifact publication')
    }
    checkpoint = structuredClone(state)
    return true
  }
  const common = {
    job: {
      id: turnId,
      origin: 'chat',
      userId: 'artifact-user',
      sessionId: 'artifact-session',
      prompt: 'Create the ZIP output.',
    },
    step: { id: `${turnId}-step`, kind: 'chat' },
    messages: [{ role: 'user', content: 'Create the ZIP output.' }],
    intentMode: 'execute',
    toolSpecs: [archiveCreate, setDeliverables],
    maxIters: 5,
    enableToolHooks: false,
    sideEffectLedger: getSideEffectExecutionLedger(),
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    saveCheckpoint,
    executeTool: async ({ name }) => {
      assert.equal(name, 'archive_create')
      executeCalls += 1
      return { ok: true, output: sourcePath, format: 'zip', entries: 1 }
    },
  }

  await assert.rejects(
    runToolsLoop({
      ...common,
      runModel: async () => ({
        content: '',
        toolCalls: [{
          id: callId,
          type: 'function',
          function: {
            name: 'archive_create',
            arguments: JSON.stringify({ inputs: ['source.txt'], output: sourcePath }),
          },
        }],
      }),
    }),
    (error) => error?.name === 'CheckpointFlushError'
      && /Checkpoint flush failed before side effect/.test(String(error?.message || '')),
  )
  assert.equal(checkpoint.toolCalls[0].checkpointStatus, 'executing')
  assert.equal(executeCalls, 1)
  const firstArtifacts = listTurnArtifacts({
    userId: 'artifact-user', sessionId: 'artifact-session', turnId,
  })
  assert.equal(firstArtifacts.length, 1)

  let resumedModelCalls = 0
  const resumed = await runToolsLoop({
    ...common,
    loadCheckpoint: async () => ({ state: checkpoint }),
    runModel: async () => {
      resumedModelCalls += 1
      if (resumedModelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: `${callId}-select`,
            type: 'function',
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: [firstArtifacts[0].id] }),
            },
          }],
        }
      }
      return { content: 'The recovered ZIP is ready.', toolCalls: [] }
    },
  })

  const recoveredArtifacts = listTurnArtifacts({
    userId: 'artifact-user', sessionId: 'artifact-session', turnId,
  })
  assert.ok(String(resumed.text || '').trim())
  assert.equal(executeCalls, 1, 'a committed side effect must be replayed only as a result')
  assert.deepEqual(recoveredArtifacts, firstArtifacts)
  assert.deepEqual(resumed.artifactIds, [firstArtifacts[0].id])
  assert.equal(
    fs.readdirSync(process.env.ARTIFACT_DIR)
      .filter((name) => /^ledger-recovery-output-[a-f0-9]{20}\.zip$/.test(name)).length,
    1,
  )
})

test('concurrent local publication reuses one artifact and stays isolated across users', async () => {
  const sourcePath = path.join(tempDir, 'parallel-local-output.bin')
  fs.writeFileSync(sourcePath, 'parallel-output')
  const call = { id: 'parallel-local-call', name: 'bash_exec', args: { cwd: tempDir } }
  const result = {
    ok: true,
    cwd: tempDir,
    verifiedOutputs: [{ path: sourcePath, declaredPath: sourcePath, scope: 'grant', type: 'file' }],
  }
  const job = {
    id: 'parallel-local-turn', origin: 'chat', userId: 'artifact-user', sessionId: 'artifact-session',
  }
  const [left, right] = await Promise.all([
    persistLocalToolArtifactsAsync({ call, result, job, step: null, toolCallId: call.id }),
    persistLocalToolArtifactsAsync({ call, result, job, step: null, toolCallId: call.id }),
  ])
  assert.equal(left.length, 1)
  assert.equal(right.length, 1)
  assert.equal(left[0].id, right[0].id)
  assert.equal(left[0].filename, right[0].filename)
  assert.equal(listTurnArtifacts({
    userId: job.userId, sessionId: job.sessionId, turnId: job.id,
  }).length, 1)

  createUser({ id: 'artifact-user-b', email: 'turn-artifact-b@example.com' })
  upsertSession({ id: 'artifact-session-b', userId: 'artifact-user-b', title: 'Artifacts B' })
  const otherJob = {
    ...job,
    userId: 'artifact-user-b',
    sessionId: 'artifact-session-b',
  }
  const [other] = await persistLocalToolArtifactsAsync({
    call, result, job: otherJob, step: null, toolCallId: call.id,
  })
  assert.notEqual(other.id, left[0].id)
  assert.notEqual(other.filename, left[0].filename)
  assert.equal(listTurnArtifacts({
    userId: otherJob.userId, sessionId: otherJob.sessionId, turnId: otherJob.id,
  }).length, 1)
  assert.deepEqual(listTurnArtifacts({
    userId: job.userId, sessionId: job.sessionId, turnId: job.id,
  }).map((artifact) => artifact.id), [left[0].id])
})

test('stable local artifact replay survives cleanup of the transient source file', async () => {
  const sourcePath = path.join(tempDir, 'cleaned-before-replay.zip')
  fs.writeFileSync(sourcePath, Buffer.from('PK\x03\x04durable-managed-copy'))
  const call = { id: 'cleaned-source-call', name: 'archive_create', args: { output: sourcePath } }
  const result = { ok: true, output: sourcePath, format: 'zip', entries: 1 }
  const job = {
    id: 'cleaned-source-turn', origin: 'chat', userId: 'artifact-user', sessionId: 'artifact-session',
  }

  const first = await persistLocalToolArtifactsAsync({
    call, result, job, step: null, toolCallId: call.id,
  })
  assert.equal(first.length, 1)
  const publishedPath = path.join(process.env.ARTIFACT_DIR, first[0].filename)
  assert.equal(fs.existsSync(publishedPath), true)
  fs.unlinkSync(sourcePath)

  const replayed = await persistLocalToolArtifactsAsync({
    call, result, job, step: null, toolCallId: call.id,
  })
  assert.equal(replayed.length, 1)
  assert.equal(replayed[0].id, first[0].id)
  assert.equal(replayed[0].filename, first[0].filename)
  assert.equal(fs.readFileSync(publishedPath, 'utf8'), 'PK\x03\x04durable-managed-copy')
  assert.deepEqual(replayed.publicationFailures, [])
  assert.equal(listTurnArtifacts({
    userId: job.userId, sessionId: job.sessionId, turnId: job.id,
  }).length, 1)
})

test('interrupted marker staging never exposes a partial ownership marker and retry succeeds', async () => {
  const filename = 'marker-staging-interruption.pdf'
  const publicationKey = 'marker-staging-interruption'
  const sourcePath = path.join(tempDir, filename)
  const { artifactPath, markerPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, '%PDF-1.4\nmarker-staging-interruption')

  const originalOpen = fs.promises.open
  let interrupted = false
  fs.promises.open = async (target, flags, ...args) => {
    const handle = await originalOpen(target, flags, ...args)
    const isMarkerStaging = flags === 'wx'
      && String(target).includes(`${path.sep}.artifact-publications${path.sep}`)
      && String(target).endsWith('.tmp')
    if (!isMarkerStaging || interrupted) return handle
    interrupted = true
    return {
      stat: (...statArgs) => handle.stat(...statArgs),
      writeFile: async (value, ...writeArgs) => {
        await handle.writeFile(String(value).slice(0, 12), ...writeArgs)
        throw new Error('injected marker staging interruption')
      },
      sync: (...syncArgs) => handle.sync(...syncArgs),
      close: (...closeArgs) => handle.close(...closeArgs),
    }
  }

  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      /injected marker staging interruption/,
    )
    assert.equal(interrupted, true)
    assert.equal(fs.existsSync(markerPath), false)
    assert.equal(fs.existsSync(artifactPath), false)
    assert.deepEqual(
      fs.readdirSync(path.dirname(markerPath)).filter((name) => name.endsWith('.tmp')),
      [],
    )
  } finally {
    fs.promises.open = originalOpen
  }

  const retried = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
  assert.equal(retried.fullPath, artifactPath)
  assert.equal(fs.existsSync(markerPath), true)
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), '%PDF-1.4\nmarker-staging-interruption')
})

test('failed old lock initialization never removes a replacement lock owner', async () => {
  const filename = 'lock-owner-aba.pdf'
  const publicationKey = 'lock-owner-aba'
  const sourcePath = path.join(tempDir, filename)
  const { lockPath } = stablePublicationPaths(filename, publicationKey)
  const successorLock = JSON.stringify({ owner: 'successor-lock' })
  fs.writeFileSync(sourcePath, '%PDF-1.4\nlock-owner-aba')

  const originalLink = fs.promises.link
  let injected = false
  fs.promises.link = async (source, target, ...args) => {
    if (String(target) !== lockPath || injected) return originalLink(source, target, ...args)
    await originalLink(source, target, ...args)
    fs.unlinkSync(lockPath)
    fs.writeFileSync(lockPath, successorLock, { flag: 'wx' })
    injected = true
    const error = new Error('injected lock initialization failure after replacement')
    error.code = 'EIO'
    throw error
  }
  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      /injected lock initialization failure after replacement/,
    )
    assert.equal(injected, true)
    assert.equal(fs.readFileSync(lockPath, 'utf8'), successorLock)
  } finally {
    fs.promises.link = originalLink
    fs.rmSync(lockPath, { force: true })
  }
})

test('failed old publication never removes a successor marker at the same path', async () => {
  const filename = 'marker-owner-aba.pdf'
  const publicationKey = 'marker-owner-aba'
  const sourcePath = path.join(tempDir, filename)
  const { artifactPath, markerPath } = stablePublicationPaths(filename, publicationKey)
  const successorMarker = JSON.stringify({ owner: 'successor-marker' })
  fs.writeFileSync(sourcePath, '%PDF-1.4\nmarker-owner-aba')

  const originalLink = fs.promises.link
  const originalLstat = fs.promises.lstat
  const originalRename = fs.promises.rename
  let markerReplacedBeforeCleanup = false
  let markerCleanupClaim = null
  let retiredIdentity = null
  fs.promises.link = async (source, target) => {
    if (String(target) !== artifactPath) return originalLink(source, target)
    fs.writeFileSync(artifactPath, 'concurrent-winner', { flag: 'wx' })
    const error = new Error('simulated concurrent artifact winner')
    error.code = 'EEXIST'
    throw error
  }
  fs.promises.rename = async (source, target) => {
    if (String(source) === markerPath && !markerReplacedBeforeCleanup) {
      markerCleanupClaim = String(target)
      retiredIdentity = await originalLstat(markerPath, { bigint: true })
      fs.unlinkSync(markerPath)
      fs.writeFileSync(markerPath, successorMarker, { flag: 'wx' })
      markerReplacedBeforeCleanup = true
    }
    return originalRename(source, target)
  }
  fs.promises.lstat = async (target, ...args) => {
    const stat = await originalLstat(target, ...args)
    return markerReplacedBeforeCleanup && retiredIdentity && String(target) === markerCleanupClaim
      ? statWithFileIdentity(stat, retiredIdentity)
      : stat
  }
  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      (error) => error?.code === 'ARTIFACT_PUBLICATION_OWNERSHIP_CONFLICT',
    )
    assert.equal(markerReplacedBeforeCleanup, true)
    assert.equal(fs.readFileSync(markerPath, 'utf8'), successorMarker)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'concurrent-winner')
  } finally {
    fs.promises.link = originalLink
    fs.promises.lstat = originalLstat
    fs.promises.rename = originalRename
    cleanupPublicationTestResidue(filename, publicationKey)
  }
})

test('legacy truncated ownership marker is safely recovered when no artifact target exists', async () => {
  const filename = 'legacy-truncated-marker.pdf'
  const publicationKey = 'legacy-truncated-marker'
  const sourcePath = path.join(tempDir, filename)
  const { artifactPath, markerPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, '%PDF-1.4\nlegacy-truncated-marker')

  const first = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
  const canonicalMarker = fs.readFileSync(markerPath, 'utf8')
  fs.unlinkSync(first.fullPath)
  fs.writeFileSync(markerPath, canonicalMarker.slice(0, Math.floor(canonicalMarker.length / 2)))

  const recovered = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
  assert.equal(recovered.fullPath, artifactPath)
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), '%PDF-1.4\nlegacy-truncated-marker')
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), JSON.parse(canonicalMarker))
})

test('stable publication fails closed when marker filesystem lacks atomic hard links', async () => {
  const filename = 'marker-atomic-unsupported.pdf'
  const publicationKey = 'marker-atomic-unsupported'
  const sourcePath = path.join(tempDir, filename)
  const { artifactPath, markerPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, '%PDF-1.4\nmarker-atomic-unsupported')

  const originalLink = fs.promises.link
  let markerLinkAttempts = 0
  fs.promises.link = async (...args) => {
    if (!isPublicationMarkerLink(args)) return originalLink(...args)
    markerLinkAttempts += 1
    const error = new Error('atomic marker hard links are unavailable')
    error.code = 'EPERM'
    throw error
  }
  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      (error) => error?.code === 'ARTIFACT_PUBLICATION_MARKER_ATOMIC_UNSUPPORTED',
    )
    assert.equal(markerLinkAttempts, 1)
    assert.equal(fs.existsSync(markerPath), false)
    assert.equal(fs.existsSync(artifactPath), false)
    assert.deepEqual(
      fs.readdirSync(path.dirname(markerPath)).filter((name) => name.endsWith('.tmp')),
      [],
    )
  } finally {
    fs.promises.link = originalLink
  }
})

test('stable publication falls back to exclusive copy when the artifact filesystem rejects hard links', async () => {
  const sourcePath = path.join(tempDir, 'hard-link-fallback.bin')
  fs.writeFileSync(sourcePath, 'fallback')
  const call = { id: 'hard-link-fallback-call', name: 'bash_exec', args: { cwd: tempDir } }
  const result = {
    ok: true,
    cwd: tempDir,
    verifiedOutputs: [{ path: sourcePath, declaredPath: sourcePath, scope: 'grant', type: 'file' }],
  }
  const job = {
    id: 'hard-link-fallback-turn', origin: 'chat', userId: 'artifact-user', sessionId: 'artifact-session',
  }
  const originalLink = fs.promises.link
  let linkAttempts = 0
  fs.promises.link = async (...args) => {
    if (isPublicationMetadataLink(args)) return originalLink(...args)
    linkAttempts += 1
    const error = new Error('hard links are unavailable on this test filesystem')
    error.code = 'EPERM'
    throw error
  }
  try {
    const artifacts = await persistLocalToolArtifactsAsync({
      call, result, job, step: null, toolCallId: call.id,
    })
    assert.equal(artifacts.length, 1)
    assert.equal(linkAttempts, 1)
    assert.deepEqual(artifacts.publicationFailures, [])
    assert.equal(
      fs.readFileSync(path.join(process.env.ARTIFACT_DIR, artifacts[0].filename), 'utf8'),
      'fallback',
    )
    assert.deepEqual(
      fs.readdirSync(process.env.ARTIFACT_DIR).filter((name) => /^\.publish-.*\.(?:lock|tmp)$/.test(name)),
      [],
    )
  } finally {
    fs.promises.link = originalLink
  }
})

test('a partially written private lock stage never exposes a partial canonical lock', async (t) => {
  const filename = 'partial-live-lock.pdf'
  const publicationKey = 'partial-live-lock'
  const sourcePath = path.join(tempDir, filename)
  const content = '%PDF-1.4\npartial-live-lock'
  const { artifactPath, lockPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  const originalOpen = fs.promises.open
  const originalLink = fs.promises.link
  let signalPartialWritten
  let allowLockWrite
  let signalCanonicalClaimed
  let allowCanonicalLinkReturn
  let signalContenderLinkAttempted
  const partialWritten = new Promise((resolve) => { signalPartialWritten = resolve })
  const lockWriteAllowed = new Promise((resolve) => { allowLockWrite = resolve })
  const canonicalClaimed = new Promise((resolve) => { signalCanonicalClaimed = resolve })
  const canonicalLinkReturnAllowed = new Promise((resolve) => { allowCanonicalLinkReturn = resolve })
  const contenderLinkAttempted = new Promise((resolve) => { signalContenderLinkAttempted = resolve })
  let firstLockWrapped = false
  let partialContents = null
  let privateLockPath = ''
  let canonicalLinkAttempts = 0
  let firstPublication = null
  let secondPublication = null

  fs.promises.open = async (target, flags, ...args) => {
    const handle = await originalOpen(target, flags, ...args)
    if (isPublicationLockTemporary(target, lockPath) && flags === 'wx' && !firstLockWrapped) {
      firstLockWrapped = true
      privateLockPath = String(target)
      return {
        stat: (...statArgs) => handle.stat(...statArgs),
        writeFile: async (value) => {
          const complete = Buffer.from(String(value), 'utf8')
          partialContents = complete.subarray(0, Math.max(1, Math.floor(complete.length / 3)))
          await handle.write(partialContents, 0, partialContents.length, 0)
          await handle.truncate(partialContents.length)
          signalPartialWritten()
          await lockWriteAllowed
          await handle.write(complete, 0, complete.length, 0)
          await handle.truncate(complete.length)
        },
        sync: (...syncArgs) => handle.sync(...syncArgs),
        close: (...closeArgs) => handle.close(...closeArgs),
      }
    }
    return handle
  }
  fs.promises.link = async (...args) => {
    if (String(args[1]) !== lockPath) return originalLink(...args)
    canonicalLinkAttempts += 1
    if (canonicalLinkAttempts === 1) {
      const linked = await originalLink(...args)
      signalCanonicalClaimed()
      await canonicalLinkReturnAllowed
      return linked
    }
    signalContenderLinkAttempted()
    return originalLink(...args)
  }

  try {
    firstPublication = createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
    await partialWritten
    assert.ok(privateLockPath)
    assert.deepEqual(fs.readFileSync(privateLockPath), partialContents)
    assert.equal(fs.existsSync(lockPath), false)

    secondPublication = createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
    await canonicalClaimed
    const canonicalOwner = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    assert.equal(canonicalOwner.publicationDigest.length, 64)
    assert.notDeepEqual(fs.readFileSync(lockPath), partialContents)
    assert.equal(fs.existsSync(artifactPath), false)

    allowLockWrite()
    await contenderLinkAttempted
    assert.equal(fs.existsSync(lockPath), true)
    assert.equal(fs.existsSync(artifactPath), false)

    allowCanonicalLinkReturn()
    const [first, second] = await Promise.all([firstPublication, secondPublication])
    assert.equal(first.fullPath, artifactPath)
    assert.equal(second.fullPath, artifactPath)
    assert.equal(first.publicationReconciled, true)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
  } finally {
    allowLockWrite()
    allowCanonicalLinkReturn()
    fs.promises.open = originalOpen
    fs.promises.link = originalLink
    await Promise.allSettled([firstPublication, secondPublication].filter(Boolean))
  }
})

test('a half-written failed lock initialization removes its inode and permits retry', async (t) => {
  const filename = 'partial-lock-eio.pdf'
  const publicationKey = 'partial-lock-eio'
  const sourcePath = path.join(tempDir, filename)
  const content = '%PDF-1.4\npartial-lock-eio'
  const { artifactPath, lockPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  const originalOpen = fs.promises.open
  const initializationError = Object.assign(
    new Error('injected half-written publication lock failure'),
    { code: 'EIO' },
  )
  let injected = false
  let privateLockPath = ''
  fs.promises.open = async (target, flags, ...args) => {
    const handle = await originalOpen(target, flags, ...args)
    if (!isPublicationLockTemporary(target, lockPath) || flags !== 'wx' || injected) return handle
    injected = true
    privateLockPath = String(target)
    return {
      stat: (...statArgs) => handle.stat(...statArgs),
      writeFile: async (value) => {
        const partial = Buffer.from(String(value), 'utf8').subarray(0, 13)
        await handle.write(partial, 0, partial.length, 0)
        await handle.truncate(partial.length)
        throw initializationError
      },
      sync: (...syncArgs) => handle.sync(...syncArgs),
      close: (...closeArgs) => handle.close(...closeArgs),
    }
  }

  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      (error) => errorChain(error).includes(initializationError),
    )
    assert.equal(injected, true)
    assert.ok(privateLockPath)
    assert.equal(fs.existsSync(privateLockPath), false)
    assert.equal(fs.existsSync(lockPath), false)

    const retried = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
    assert.equal(retried.fullPath, artifactPath)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
    assert.equal(fs.existsSync(lockPath), false)
  } finally {
    fs.promises.open = originalOpen
  }
})

test('a linked lock temporary survives one unlink failure and is reclaimed during release', async (t) => {
  const filename = 'partial-lock-cleanup-retry.pdf'
  const publicationKey = 'partial-lock-cleanup-retry'
  const sourcePath = path.join(tempDir, filename)
  const content = '%PDF-1.4\npartial-lock-cleanup-retry'
  const { artifactPath, lockPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  const originalUnlink = fs.promises.unlink
  let lockCleanupFailureInjected = false
  let retainedLockTemporary = ''
  fs.promises.unlink = async (target, ...args) => {
    if (!lockCleanupFailureInjected
      && isPublicationLockTemporary(target, lockPath)
      && fs.existsSync(lockPath)) {
      lockCleanupFailureInjected = true
      retainedLockTemporary = String(target)
      const error = new Error('injected linked lock temporary cleanup failure')
      error.code = 'EPERM'
      throw error
    }
    return originalUnlink(target, ...args)
  }

  try {
    const published = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
    assert.equal(lockCleanupFailureInjected, true)
    assert.ok(retainedLockTemporary)
    assert.equal(published.fullPath, artifactPath)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
    assert.equal(fs.existsSync(lockPath), false)
    assert.equal(fs.existsSync(retainedLockTemporary), false)
    assert.deepEqual(artifactCleanupClaims(), [])
    assert.deepEqual(publicationAttemptResidue(publicationKey).stagingPaths, [])
    assert.deepEqual(publicationAttemptResidue(publicationKey).attemptRecords, [])
  } finally {
    fs.promises.unlink = originalUnlink
  }
})

test('publication preserves a primary failure when release cleanup also fails', async (t) => {
  const filename = 'primary-and-cleanup-failure.pdf'
  const publicationKey = 'primary-and-cleanup-failure'
  const sourcePath = path.join(tempDir, filename)
  const { artifactPath, lockPath, markerPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, '%PDF-1.4\nprimary-and-cleanup-failure')
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  const originalLink = fs.promises.link
  const originalRename = fs.promises.rename
  const primaryError = Object.assign(new Error('injected primary publication failure'), {
    code: 'EINJECTED_PRIMARY',
  })
  let primaryInjected = false
  let cleanupInjected = false
  fs.promises.link = async (source, target, ...args) => {
    if (!primaryInjected && String(target) === markerPath) {
      primaryInjected = true
      throw primaryError
    }
    return originalLink(source, target, ...args)
  }
  fs.promises.rename = async (source, target, ...args) => {
    if (!cleanupInjected && String(source) === lockPath) {
      cleanupInjected = true
      const error = new Error('injected cleanup failure after primary failure')
      error.code = 'EPERM'
      throw error
    }
    return originalRename(source, target, ...args)
  }

  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      (error) => {
        const nested = errorChain(error)
        assert.ok(error === primaryError || error instanceof AggregateError)
        assert.ok(nested.includes(primaryError))
        assert.ok(nested.some((entry) => entry?.code === 'ARTIFACT_PUBLICATION_CLEANUP_FAILED'))
        return true
      },
    )
    assert.equal(primaryInjected, true)
    assert.equal(cleanupInjected, true)
    assert.equal(fs.existsSync(artifactPath), false)
    assert.equal(fs.existsSync(lockPath), true)

    const retried = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
    assert.equal(retried.fullPath, artifactPath)
    assert.equal(fs.existsSync(lockPath), false)
  } finally {
    fs.promises.link = originalLink
    fs.promises.rename = originalRename
  }
})

test('marker-conflict cleanup failure preserves the ownership error and retained lease', async (t) => {
  const filename = 'marker-conflict-cleanup-failure.pdf'
  const publicationKey = 'marker-conflict-cleanup-failure'
  const sourcePath = path.join(tempDir, filename)
  const content = '%PDF-1.4\nmarker-conflict-cleanup-failure'
  const competitor = '%PDF-1.4\nmarker-conflict-competitor'
  const { artifactPath, lockPath, markerPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  const originalLink = fs.promises.link
  const originalRename = fs.promises.rename
  const cleanupError = Object.assign(
    new Error('injected marker conflict cleanup failure'),
    { code: 'EPERM' },
  )
  let competitorInjected = false
  let cleanupFailureInjected = false
  fs.promises.link = async (...args) => {
    if (isPublicationMetadataLink(args)) return originalLink(...args)
    if (!competitorInjected && String(args[1]) === artifactPath) {
      competitorInjected = true
      fs.writeFileSync(artifactPath, competitor, { flag: 'wx' })
      const error = new Error('simulated non-cooperating artifact winner')
      error.code = 'EEXIST'
      throw error
    }
    return originalLink(...args)
  }
  fs.promises.rename = async (source, target, ...args) => {
    if (!cleanupFailureInjected && String(source) === markerPath) {
      cleanupFailureInjected = true
      throw cleanupError
    }
    return originalRename(source, target, ...args)
  }

  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      (error) => {
        const nested = errorChain(error)
        assert.equal(error?.code, 'ARTIFACT_PUBLICATION_OWNERSHIP_CONFLICT')
        assert.ok(nested.includes(cleanupError))
        assert.ok(nested.some((entry) => entry?.code === 'ARTIFACT_PUBLICATION_CLEANUP_FAILED'))
        return true
      },
    )
    assert.equal(competitorInjected, true)
    assert.equal(cleanupFailureInjected, true)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), competitor)
    assert.equal(fs.existsSync(markerPath), true)
    assert.equal(fs.existsSync(lockPath), true)
    assert.deepEqual(publicationAttemptResidue(publicationKey).stagingPaths, [])
    assert.deepEqual(publicationAttemptResidue(publicationKey).attemptRecords, [])

    fs.unlinkSync(artifactPath)
    const retried = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
    assert.equal(retried.fullPath, artifactPath)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
    assert.equal(fs.existsSync(lockPath), false)
  } finally {
    fs.promises.link = originalLink
    fs.promises.rename = originalRename
  }
})

test('stage-record read failure remains in the cleanup cause chain', async (t) => {
  const filename = 'stage-record-read-cleanup-failure.pdf'
  const publicationKey = 'stage-record-read-cleanup-failure'
  const sourcePath = path.join(tempDir, filename)
  const content = '%PDF-1.4\nstage-record-read-cleanup-failure'
  const { artifactPath, lockPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  const originalLink = fs.promises.link
  const originalOpen = fs.promises.open
  const primaryError = Object.assign(new Error('injected post-stage publication failure'), {
    code: 'EIO',
  })
  const cleanupReadError = Object.assign(new Error('injected stage-record read failure'), {
    code: 'EIO',
  })
  let primaryInjected = false
  let cleanupReadInjected = false
  fs.promises.link = async (...args) => {
    if (isPublicationMetadataLink(args)) return originalLink(...args)
    if (!primaryInjected && String(args[1]) === artifactPath) {
      primaryInjected = true
      throw primaryError
    }
    return originalLink(...args)
  }
  fs.promises.open = async (target, flags, ...args) => {
    if (primaryInjected
      && !cleanupReadInjected
      && String(target).endsWith('.stage.json')
      && flags === 'r') {
      cleanupReadInjected = true
      throw cleanupReadError
    }
    return originalOpen(target, flags, ...args)
  }

  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      (error) => {
        const nested = errorChain(error)
        assert.ok(nested.includes(primaryError))
        assert.ok(nested.includes(cleanupReadError))
        assert.ok(nested.some((entry) => entry?.code === 'ARTIFACT_PUBLICATION_CLEANUP_FAILED'))
        return true
      },
    )
    assert.equal(primaryInjected, true)
    assert.equal(cleanupReadInjected, true)
    assert.equal(fs.existsSync(artifactPath), false)
    assert.equal(fs.existsSync(lockPath), true)
    const retained = publicationAttemptResidue(publicationKey)
    assert.equal(retained.stagingPaths.length, 1)
    assert.equal(retained.attemptRecords.filter((entry) => entry.endsWith('.stage.json')).length, 1)

    const retried = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
    assert.equal(retried.fullPath, artifactPath)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
    assert.equal(fs.existsSync(lockPath), false)
    assert.deepEqual(publicationAttemptResidue(publicationKey).stagingPaths, [])
    assert.deepEqual(publicationAttemptResidue(publicationKey).attemptRecords, [])
  } finally {
    fs.promises.link = originalLink
    fs.promises.open = originalOpen
  }
})

test('failed staging write retains its record and lock until staging cleanup can be confirmed', async (t) => {
  const filename = 'staging-write-and-cleanup-failure.pdf'
  const publicationKey = 'staging-write-and-cleanup-failure'
  const sourcePath = path.join(tempDir, filename)
  const content = `%PDF-1.4\n${'staging-cleanup-recovery-'.repeat(64)}`
  const { artifactPath, lockPath } = stablePublicationPaths(filename, publicationKey)
  const publicationDigest = crypto.createHash('sha256').update(publicationKey).digest('hex')
  const stagingPrefix = path.join(
    process.env.ARTIFACT_DIR,
    `.publish-${publicationDigest.slice(0, 20)}-`,
  )
  const isAttemptStagingPath = (target) => String(target).startsWith(stagingPrefix)
    && String(target).endsWith('.tmp')
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  const originalOpen = fs.promises.open
  const originalRename = fs.promises.rename
  const primaryError = Object.assign(new Error('injected staging write failure'), {
    code: 'EINJECTED_STAGE_WRITE',
  })
  let primaryInjected = false
  let stagingCleanupBlocked = true
  let stagingCleanupAttempts = 0
  fs.promises.open = async (target, flags, ...args) => {
    const handle = await originalOpen(target, flags, ...args)
    if (primaryInjected || flags !== 'r+' || !isAttemptStagingPath(target)) return handle
    return {
      stat: (...statArgs) => handle.stat(...statArgs),
      read: (...readArgs) => handle.read(...readArgs),
      write: async (buffer, offset, length, position) => {
        const partialLength = Math.min(length, 17)
        await handle.write(buffer, offset, partialLength, position)
        primaryInjected = true
        throw primaryError
      },
      sync: (...syncArgs) => handle.sync(...syncArgs),
      close: (...closeArgs) => handle.close(...closeArgs),
    }
  }
  fs.promises.rename = async (source, target, ...args) => {
    if (stagingCleanupBlocked && isAttemptStagingPath(source)) {
      stagingCleanupAttempts += 1
      const error = new Error('injected staging inode cleanup failure')
      error.code = 'EPERM'
      throw error
    }
    return originalRename(source, target, ...args)
  }

  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      (error) => {
        const nested = errorChain(error)
        assert.ok(nested.includes(primaryError))
        assert.ok(nested.some((entry) => entry?.code === 'ARTIFACT_PUBLICATION_CLEANUP_FAILED'))
        return true
      },
    )
    assert.equal(primaryInjected, true)
    assert.ok(stagingCleanupAttempts >= 2)
    assert.equal(fs.existsSync(artifactPath), false)
    assert.equal(fs.existsSync(lockPath), true)
    const retained = publicationAttemptResidue(publicationKey)
    assert.equal(retained.stagingPaths.length, 1)
    assert.equal(retained.attemptRecords.filter((entry) => entry.endsWith('.stage.json')).length, 1)

    stagingCleanupBlocked = false
    const retried = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
    assert.equal(retried.fullPath, artifactPath)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
    const cleaned = publicationAttemptResidue(publicationKey)
    assert.equal(fs.existsSync(cleaned.lockPath), false)
    assert.deepEqual(cleaned.stagingPaths, [])
    assert.deepEqual(cleaned.attemptRecords, [])
  } finally {
    stagingCleanupBlocked = false
    fs.promises.open = originalOpen
    fs.promises.rename = originalRename
  }
})

test('failed exclusive-copy write retains its destination claim until cleanup can safely retry', async (t) => {
  const filename = 'destination-write-and-cleanup-failure.pdf'
  const publicationKey = 'destination-write-and-cleanup-failure'
  const sourcePath = path.join(tempDir, filename)
  const content = `%PDF-1.4\n${'destination-cleanup-recovery-'.repeat(64)}`
  const { artifactPath, lockPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  const originalLink = fs.promises.link
  const originalOpen = fs.promises.open
  const originalRename = fs.promises.rename
  const primaryError = Object.assign(new Error('injected destination write failure'), {
    code: 'EINJECTED_DESTINATION_WRITE',
  })
  let fallbackAttempts = 0
  let primaryInjected = false
  let destinationCleanupBlocked = true
  let destinationCleanupAttempts = 0
  fs.promises.link = async (...args) => {
    if (isPublicationMetadataLink(args)) return originalLink(...args)
    if (String(args[1]) === artifactPath) {
      fallbackAttempts += 1
      const error = new Error('force exclusive-copy destination cleanup recovery')
      error.code = 'EPERM'
      throw error
    }
    return originalLink(...args)
  }
  fs.promises.open = async (target, flags, ...args) => {
    const handle = await originalOpen(target, flags, ...args)
    if (primaryInjected || String(target) !== artifactPath || flags !== 'r+') return handle
    return {
      stat: (...statArgs) => handle.stat(...statArgs),
      read: (...readArgs) => handle.read(...readArgs),
      write: async (buffer, offset, length, position) => {
        const partialLength = Math.min(length, 19)
        await handle.write(buffer, offset, partialLength, position)
        primaryInjected = true
        throw primaryError
      },
      sync: (...syncArgs) => handle.sync(...syncArgs),
      close: (...closeArgs) => handle.close(...closeArgs),
    }
  }
  fs.promises.rename = async (source, target, ...args) => {
    if (destinationCleanupBlocked && String(source) === artifactPath) {
      destinationCleanupAttempts += 1
      const error = new Error('injected partial destination cleanup failure')
      error.code = 'EPERM'
      throw error
    }
    return originalRename(source, target, ...args)
  }

  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      (error) => {
        const nested = errorChain(error)
        assert.ok(nested.includes(primaryError))
        assert.ok(nested.some((entry) => entry?.code === 'ARTIFACT_PUBLICATION_CLEANUP_FAILED'))
        return true
      },
    )
    assert.equal(primaryInjected, true)
    assert.equal(fallbackAttempts, 1)
    assert.ok(destinationCleanupAttempts >= 2)
    assert.equal(fs.existsSync(lockPath), true)
    const partial = fs.readFileSync(artifactPath)
    assert.ok(partial.length > 0 && partial.length < Buffer.byteLength(content))
    assert.deepEqual(partial, Buffer.from(content).subarray(0, partial.length))
    const retained = publicationAttemptResidue(publicationKey)
    assert.equal(retained.stagingPaths.length, 1)
    assert.equal(retained.attemptRecords.filter((entry) => entry.endsWith('.stage.json')).length, 1)
    assert.equal(retained.attemptRecords.filter((entry) => entry.endsWith('.destination.json')).length, 1)

    destinationCleanupBlocked = false
    const retried = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
    assert.equal(retried.fullPath, artifactPath)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
    const cleaned = publicationAttemptResidue(publicationKey)
    assert.equal(fs.existsSync(cleaned.lockPath), false)
    assert.deepEqual(cleaned.stagingPaths, [])
    assert.deepEqual(cleaned.attemptRecords, [])
  } finally {
    destinationCleanupBlocked = false
    fs.promises.link = originalLink
    fs.promises.open = originalOpen
    fs.promises.rename = originalRename
  }
})

test('exclusive-copy rolls back its claimed destination when final verification fails', async (t) => {
  const filename = 'exclusive-copy-final-verify-failure.pdf'
  const publicationKey = 'exclusive-copy-final-verify-failure'
  const sourcePath = path.join(tempDir, filename)
  const content = `%PDF-1.4\n${'exclusive-copy-final-verify-'.repeat(64)}`
  const { artifactPath, lockPath, markerPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  const originalLink = fs.promises.link
  const originalOpen = fs.promises.open
  const verificationError = Object.assign(
    new Error('injected final exclusive-copy verification failure'),
    { code: 'EIO' },
  )
  let verificationFailureInjected = false
  fs.promises.link = async (...args) => {
    if (isPublicationMetadataLink(args)) return originalLink(...args)
    if (String(args[1]) === artifactPath) {
      const error = new Error('force exclusive-copy final verification failure')
      error.code = 'EPERM'
      throw error
    }
    return originalLink(...args)
  }
  fs.promises.open = async (target, flags, ...args) => {
    if (!verificationFailureInjected && String(target) === artifactPath && flags === 'r') {
      verificationFailureInjected = true
      throw verificationError
    }
    return originalOpen(target, flags, ...args)
  }

  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      (error) => errorChain(error).includes(verificationError),
    )
    assert.equal(verificationFailureInjected, true)
    assert.equal(fs.existsSync(artifactPath), false)
    assert.equal(fs.existsSync(lockPath), false)
    assert.equal(fs.existsSync(markerPath), true)
    assert.deepEqual(publicationAttemptResidue(publicationKey).stagingPaths, [])
    assert.deepEqual(publicationAttemptResidue(publicationKey).attemptRecords, [])

    const retried = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
    assert.equal(retried.fullPath, artifactPath)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
  } finally {
    fs.promises.link = originalLink
    fs.promises.open = originalOpen
  }
})

test('destination-record read failure remains in the cleanup cause chain', async (t) => {
  const filename = 'destination-record-read-cleanup-failure.pdf'
  const publicationKey = 'destination-record-read-cleanup-failure'
  const sourcePath = path.join(tempDir, filename)
  const content = `%PDF-1.4\n${'destination-record-read-cleanup-'.repeat(32)}`
  const { artifactPath, lockPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  const originalLink = fs.promises.link
  const originalOpen = fs.promises.open
  const verificationError = Object.assign(
    new Error('injected final verification failure before destination cleanup'),
    { code: 'EIO' },
  )
  const cleanupReadError = Object.assign(
    new Error('injected destination-record read failure'),
    { code: 'EIO' },
  )
  let verificationFailureInjected = false
  let cleanupReadInjected = false
  fs.promises.link = async (...args) => {
    if (isPublicationMetadataLink(args)) return originalLink(...args)
    if (String(args[1]) === artifactPath) {
      const error = new Error('force exclusive-copy destination-record cleanup')
      error.code = 'EPERM'
      throw error
    }
    return originalLink(...args)
  }
  fs.promises.open = async (target, flags, ...args) => {
    if (!verificationFailureInjected && String(target) === artifactPath && flags === 'r') {
      verificationFailureInjected = true
      throw verificationError
    }
    if (verificationFailureInjected
      && !cleanupReadInjected
      && String(target).endsWith('.destination.json')
      && flags === 'r') {
      cleanupReadInjected = true
      throw cleanupReadError
    }
    return originalOpen(target, flags, ...args)
  }

  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      (error) => {
        const nested = errorChain(error)
        assert.ok(nested.includes(verificationError))
        assert.ok(nested.includes(cleanupReadError))
        assert.ok(nested.some((entry) => entry?.code === 'ARTIFACT_PUBLICATION_CLEANUP_FAILED'))
        return true
      },
    )
    assert.equal(verificationFailureInjected, true)
    assert.equal(cleanupReadInjected, true)
    assert.equal(fs.existsSync(artifactPath), true)
    assert.equal(fs.existsSync(lockPath), true)
    const retained = publicationAttemptResidue(publicationKey)
    assert.equal(retained.stagingPaths.length, 1)
    assert.equal(retained.attemptRecords.filter((entry) => entry.endsWith('.stage.json')).length, 1)
    assert.equal(
      retained.attemptRecords.filter((entry) => entry.endsWith('.destination.json')).length,
      1,
    )

    const retried = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
    assert.equal(retried.fullPath, artifactPath)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
    assert.equal(fs.existsSync(lockPath), false)
    assert.deepEqual(publicationAttemptResidue(publicationKey).stagingPaths, [])
    assert.deepEqual(publicationAttemptResidue(publicationKey).attemptRecords, [])
  } finally {
    fs.promises.link = originalLink
    fs.promises.open = originalOpen
  }
})

test('exclusive-copy source disappearance rolls back its claimed target before retry', async (t) => {
  const filename = 'exclusive-copy-source-disappearance.pdf'
  const publicationKey = 'exclusive-copy-source-disappearance'
  const sourcePath = path.join(tempDir, filename)
  const content = `%PDF-1.4\n${'exclusive-copy-source-'.repeat(64)}`
  const { artifactPath, lockPath, markerPath } = stablePublicationPaths(filename, publicationKey)
  const publicationDigest = crypto.createHash('sha256').update(publicationKey).digest('hex')
  const stagingPrefix = `.publish-${publicationDigest.slice(0, 20)}-`
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  const originalLink = fs.promises.link
  const originalOpen = fs.promises.open
  let sourceFailureInjected = false
  fs.promises.link = async (...args) => {
    if (isPublicationMetadataLink(args)) return originalLink(...args)
    if (String(args[1]) === artifactPath) {
      const error = new Error('force exclusive-copy source disappearance')
      error.code = 'EPERM'
      throw error
    }
    return originalLink(...args)
  }
  fs.promises.open = async (target, flags, ...args) => {
    const targetPath = String(target)
    const stagedSource = path.dirname(targetPath) === process.env.ARTIFACT_DIR
      && path.basename(targetPath).startsWith(stagingPrefix)
      && targetPath.endsWith('.tmp')
    if (!sourceFailureInjected && stagedSource && flags === 'r') {
      sourceFailureInjected = true
      const error = new Error('injected staged source disappearance')
      error.code = 'ENOENT'
      throw error
    }
    return originalOpen(target, flags, ...args)
  }

  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      (error) => error?.code === 'ARTIFACT_PUBLICATION_SOURCE_DRIFT',
    )
    assert.equal(sourceFailureInjected, true)
    assert.equal(fs.existsSync(artifactPath), false)
    assert.equal(fs.existsSync(lockPath), false)
    assert.equal(fs.existsSync(markerPath), true)
    assert.deepEqual(publicationAttemptResidue(publicationKey).stagingPaths, [])
    assert.deepEqual(publicationAttemptResidue(publicationKey).attemptRecords, [])

    const retried = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
    assert.equal(retried.fullPath, artifactPath)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
    assert.equal(fs.existsSync(lockPath), false)
  } finally {
    fs.promises.link = originalLink
    fs.promises.open = originalOpen
  }
})

test('retry removes a staging cleanup claim left by an interrupted unlink', async (t) => {
  const filename = 'staging-cleanup-claim-retry.pdf'
  const publicationKey = 'staging-cleanup-claim-retry'
  const sourcePath = path.join(tempDir, filename)
  const content = '%PDF-1.4\nstaging-cleanup-claim-retry'
  const { artifactPath, lockPath } = stablePublicationPaths(filename, publicationKey)
  const publicationDigest = crypto.createHash('sha256').update(publicationKey).digest('hex')
  const stagingPrefix = path.join(
    process.env.ARTIFACT_DIR,
    `.publish-${publicationDigest.slice(0, 20)}-`,
  )
  const isAttemptStagingPath = (target) => String(target).startsWith(stagingPrefix)
    && String(target).endsWith('.tmp')
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  const originalRename = fs.promises.rename
  const originalUnlink = fs.promises.unlink
  let stagingCleanupClaim = null
  let cleanupClaimUnlinkFailureInjected = false
  fs.promises.rename = async (source, target, ...args) => {
    const cleanupClaim = path.dirname(String(target)) === process.env.ARTIFACT_DIR
      && path.basename(String(target)).startsWith('.artifact-cleanup-')
    if (!stagingCleanupClaim && isAttemptStagingPath(source) && cleanupClaim) {
      stagingCleanupClaim = String(target)
    }
    return originalRename(source, target, ...args)
  }
  fs.promises.unlink = async (target, ...args) => {
    if (!cleanupClaimUnlinkFailureInjected && String(target) === stagingCleanupClaim) {
      cleanupClaimUnlinkFailureInjected = true
      const error = new Error('injected staging cleanup claim unlink failure')
      error.code = 'EPERM'
      throw error
    }
    return originalUnlink(target, ...args)
  }

  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      (error) => error?.code === 'ARTIFACT_PUBLICATION_CLEANUP_FAILED',
    )
    assert.equal(cleanupClaimUnlinkFailureInjected, true)
    assert.ok(stagingCleanupClaim)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
    assert.equal(fs.existsSync(lockPath), true)
    assert.equal(
      publicationAttemptResidue(publicationKey).attemptRecords
        .filter((entry) => entry.endsWith('.stage.json')).length,
      1,
    )

    const retried = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
    assert.equal(retried.fullPath, artifactPath)
    assert.equal(retried.publicationReconciled, true)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
    assert.equal(fs.existsSync(lockPath), false)
    assert.deepEqual(artifactCleanupClaims(), [])
    assert.deepEqual(publicationAttemptResidue(publicationKey).stagingPaths, [])
    assert.deepEqual(publicationAttemptResidue(publicationKey).attemptRecords, [])
  } finally {
    fs.promises.rename = originalRename
    fs.promises.unlink = originalUnlink
  }
})

test('retry clears a retained stage record after its staging inode was already removed', async (t) => {
  const filename = 'stage-record-after-inode-cleanup.pdf'
  const publicationKey = 'stage-record-after-inode-cleanup'
  const sourcePath = path.join(tempDir, filename)
  const content = '%PDF-1.4\nstage-record-after-inode-cleanup'
  const { artifactPath, lockPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  const originalRename = fs.promises.rename
  let stageRecordCleanupInjected = false
  fs.promises.rename = async (source, target, ...args) => {
    if (!stageRecordCleanupInjected && String(source).endsWith('.stage.json')) {
      stageRecordCleanupInjected = true
      const error = new Error('injected stage record cleanup failure')
      error.code = 'EPERM'
      throw error
    }
    return originalRename(source, target, ...args)
  }

  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      (error) => error?.code === 'ARTIFACT_PUBLICATION_CLEANUP_FAILED',
    )
    assert.equal(stageRecordCleanupInjected, true)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
    assert.equal(fs.existsSync(lockPath), true)
    const retained = publicationAttemptResidue(publicationKey)
    assert.deepEqual(retained.stagingPaths, [])
    assert.equal(retained.attemptRecords.filter((entry) => entry.endsWith('.stage.json')).length, 1)

    const retried = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
    assert.equal(retried.fullPath, artifactPath)
    assert.equal(retried.publicationReconciled, true)
    const cleaned = publicationAttemptResidue(publicationKey)
    assert.equal(fs.existsSync(cleaned.lockPath), false)
    assert.deepEqual(cleaned.stagingPaths, [])
    assert.deepEqual(cleaned.attemptRecords, [])
  } finally {
    fs.promises.rename = originalRename
  }
})

test('stable publication reports lock cleanup failure and reclaims the ended local attempt', async (t) => {
  const filename = 'lock-cleanup-retry.pdf'
  const publicationKey = 'lock-cleanup-retry'
  const sourcePath = path.join(tempDir, filename)
  const content = '%PDF-1.4\nlock-cleanup-retry'
  const { artifactPath, lockPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  const originalRename = fs.promises.rename
  let cleanupFailureInjected = false
  fs.promises.rename = async (source, target) => {
    if (!cleanupFailureInjected && String(source) === lockPath) {
      cleanupFailureInjected = true
      const error = new Error('injected publication lock cleanup failure')
      error.code = 'EPERM'
      throw error
    }
    return originalRename(source, target)
  }
  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
      (error) => error?.code === 'ARTIFACT_PUBLICATION_CLEANUP_FAILED',
    )
    assert.equal(cleanupFailureInjected, true)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
    assert.equal(fs.existsSync(lockPath), true)

    const retried = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
    assert.equal(retried.fullPath, artifactPath)
    assert.equal(retried.publicationReconciled, true)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
    assert.equal(fs.existsSync(lockPath), false)
    assert.deepEqual(publicationAttemptResidue(publicationKey).stagingPaths, [])
    assert.deepEqual(publicationAttemptResidue(publicationKey).attemptRecords, [])
  } finally {
    fs.promises.rename = originalRename
  }
})

test('a crashed pre-marker owner is reclaimed when the source intent changes', async (t) => {
  const filename = 'lock-before-marker-crash.pdf'
  const publicationKey = 'lock-before-marker-crash'
  const sourcePath = path.join(tempDir, filename)
  const crashedContent = '%PDF-1.4\nlock-before-marker-crash'
  const recoveredContent = '%PDF-1.4\nlock-before-marker-crash-with-new-content'
  const { artifactPath, markerPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, crashedContent)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  crashStablePublisher({ mode: 'lock_after_acquire', sourcePath, filename, publicationKey })
  const crashed = publicationAttemptResidue(publicationKey)
  assert.equal(fs.existsSync(crashed.lockPath), true)
  assert.equal(fs.existsSync(markerPath), false)
  assert.equal(fs.existsSync(artifactPath), false)
  assert.deepEqual(crashed.stagingPaths, [])
  assert.deepEqual(crashed.attemptRecords, [])
  const lockTemporaries = linkedRecordTemporaries(crashed.lockPath)
  assert.equal(lockTemporaries.length, 1)
  const lockIdentity = fs.lstatSync(crashed.lockPath, { bigint: true })
  const lockTemporaryIdentity = fs.lstatSync(lockTemporaries[0], { bigint: true })
  assert.equal(lockTemporaryIdentity.dev, lockIdentity.dev)
  assert.equal(lockTemporaryIdentity.ino, lockIdentity.ino)

  fs.writeFileSync(sourcePath, recoveredContent)
  const recoveryStartedAt = Date.now()
  const recovered = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
  const recoveryElapsedMs = Date.now() - recoveryStartedAt
  assert.ok(recoveryElapsedMs < 1_500, `stale pre-marker lock recovery took ${recoveryElapsedMs}ms`)
  assert.equal(recovered.fullPath, artifactPath)
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), recoveredContent)
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
  assert.equal(marker.size, Buffer.byteLength(recoveredContent))
  assert.equal(
    marker.contentSha256,
    crypto.createHash('sha256').update(recoveredContent).digest('hex'),
  )
  const cleaned = publicationAttemptResidue(publicationKey)
  assert.equal(fs.existsSync(cleaned.lockPath), false)
  assert.deepEqual(linkedRecordTemporaries(cleaned.lockPath), [])
  assert.deepEqual(cleaned.stagingPaths, [])
  assert.deepEqual(cleaned.attemptRecords, [])
})

test('retry removes a marker temporary left after its atomic link was published', async (t) => {
  const filename = 'marker-linked-temp-crash.pdf'
  const publicationKey = 'marker-linked-temp-crash'
  const sourcePath = path.join(tempDir, filename)
  const content = '%PDF-1.4\nmarker-linked-temp-crash'
  const { artifactPath, markerPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  crashStablePublisher({ mode: 'publication_marker_after_link', sourcePath, filename, publicationKey })
  assert.equal(fs.existsSync(markerPath), true)
  const markerTemporaries = linkedRecordTemporaries(markerPath)
  assert.equal(markerTemporaries.length, 1)
  const markerIdentity = fs.lstatSync(markerPath, { bigint: true })
  const markerTemporaryIdentity = fs.lstatSync(markerTemporaries[0], { bigint: true })
  assert.equal(markerTemporaryIdentity.dev, markerIdentity.dev)
  assert.equal(markerTemporaryIdentity.ino, markerIdentity.ino)

  const recovered = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
  assert.equal(recovered.fullPath, artifactPath)
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
  assert.deepEqual(linkedRecordTemporaries(markerPath), [])
})

test('retry removes an attempt-record temporary left after its atomic link was published', async (t) => {
  const filename = 'stage-record-linked-temp-crash.pdf'
  const publicationKey = 'stage-record-linked-temp-crash'
  const sourcePath = path.join(tempDir, filename)
  const content = `%PDF-1.4\n${'stage-record-linked-temp-'.repeat(32)}`
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  crashStablePublisher({ mode: 'stage_record_after_link', sourcePath, filename, publicationKey })
  const crashed = publicationAttemptResidue(publicationKey)
  const stageRecords = crashed.attemptRecords.filter((entry) => entry.endsWith('.stage.json'))
  assert.equal(stageRecords.length, 1)
  const recordTemporaries = linkedRecordTemporaries(stageRecords[0])
  assert.equal(recordTemporaries.length, 1)
  const recordIdentity = fs.lstatSync(stageRecords[0], { bigint: true })
  const recordTemporaryIdentity = fs.lstatSync(recordTemporaries[0], { bigint: true })
  assert.equal(recordTemporaryIdentity.dev, recordIdentity.dev)
  assert.equal(recordTemporaryIdentity.ino, recordIdentity.ino)

  const recovered = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
  assert.equal(fs.readFileSync(recovered.fullPath, 'utf8'), content)
  assert.deepEqual(linkedRecordTemporaries(stageRecords[0]), [])
  assert.deepEqual(publicationAttemptResidue(publicationKey).attemptRecords, [])
})

test('a crashed release resumes after staging cleanup but before stage-record cleanup', async (t) => {
  const filename = 'release-stage-record-crash.pdf'
  const publicationKey = 'release-stage-record-crash'
  const sourcePath = path.join(tempDir, filename)
  const content = '%PDF-1.4\nrelease-stage-record-crash'
  const { artifactPath, markerPath } = stablePublicationPaths(filename, publicationKey)
  fs.writeFileSync(sourcePath, content)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  crashStablePublisher({
    mode: 'release_after_staging_inode_cleanup',
    sourcePath,
    filename,
    publicationKey,
  })
  const crashed = publicationAttemptResidue(publicationKey)
  assert.equal(fs.existsSync(crashed.lockPath), true)
  assert.equal(fs.existsSync(markerPath), true)
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
  assert.deepEqual(crashed.stagingPaths, [])
  assert.equal(crashed.attemptRecords.filter((entry) => entry.endsWith('.stage.json')).length, 1)

  const recovered = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
  assert.equal(recovered.fullPath, artifactPath)
  assert.equal(recovered.publicationReconciled, true)
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
  const cleaned = publicationAttemptResidue(publicationKey)
  assert.equal(fs.existsSync(cleaned.lockPath), false)
  assert.deepEqual(cleaned.stagingPaths, [])
  assert.deepEqual(cleaned.attemptRecords, [])
})

test('stale claimed staging is completed and collected after a real process crash', async () => {
  const filename = 'stale-staging-crash.pdf'
  const publicationKey = 'stale-staging-crash'
  const sourcePath = path.join(tempDir, filename)
  const content = `%PDF-1.4\n${'staging-recovery-'.repeat(256)}`
  fs.writeFileSync(sourcePath, content)

  crashStablePublisher({ mode: 'stage_after_claim', sourcePath, filename, publicationKey })
  const before = publicationAttemptResidue(publicationKey)
  const { artifactPath } = stablePublicationPaths(filename, publicationKey)
  assert.equal(fs.existsSync(before.lockPath), true)
  assert.equal(before.stagingPaths.length, 1)
  assert.equal(before.attemptRecords.some((entry) => entry.endsWith('.stage.json')), true)
  assert.equal(fs.existsSync(artifactPath), false)

  const recovered = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
  assert.equal(recovered.fullPath, artifactPath)
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
  const after = publicationAttemptResidue(publicationKey)
  assert.equal(fs.existsSync(after.lockPath), false)
  assert.deepEqual(after.stagingPaths, [])
  assert.deepEqual(after.attemptRecords, [])
})

test('exclusive-copy fallback resumes a claimed exact prefix after a real process crash', async () => {
  const filename = 'fallback-half-write-crash.pdf'
  const publicationKey = 'fallback-half-write-crash'
  const sourcePath = path.join(tempDir, filename)
  const content = `%PDF-1.4\n${'fallback-recovery-'.repeat(256)}`
  fs.writeFileSync(sourcePath, content)

  crashStablePublisher({ mode: 'destination_after_claim', sourcePath, filename, publicationKey })
  const before = publicationAttemptResidue(publicationKey)
  const { artifactPath } = stablePublicationPaths(filename, publicationKey)
  const partial = fs.readFileSync(artifactPath)
  assert.ok(partial.length > 0 && partial.length < Buffer.byteLength(content))
  assert.deepEqual(partial, Buffer.from(content).subarray(0, partial.length))
  assert.equal(before.stagingPaths.length, 1)
  assert.equal(before.attemptRecords.some((entry) => entry.endsWith('.destination.json')), true)
  fs.unlinkSync(sourcePath)

  const recovered = await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
  assert.equal(recovered.fullPath, artifactPath)
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), content)
  const after = publicationAttemptResidue(publicationKey)
  assert.equal(fs.existsSync(after.lockPath), false)
  assert.deepEqual(after.stagingPaths, [])
  assert.deepEqual(after.attemptRecords, [])
})

test('staging crash before its durable identity claim fails closed without deleting the empty inode', async (t) => {
  const filename = 'staging-before-claim.pdf'
  const publicationKey = 'staging-before-claim'
  const sourcePath = path.join(tempDir, filename)
  fs.writeFileSync(sourcePath, `%PDF-1.4\n${'before-stage-claim-'.repeat(64)}`)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  crashStablePublisher({ mode: 'stage_before_claim', sourcePath, filename, publicationKey })
  const residue = publicationAttemptResidue(publicationKey)
  assert.equal(residue.stagingPaths.length, 1)
  assert.equal(residue.attemptRecords.some((entry) => entry.endsWith('.stage.json')), false)
  const stagingPath = residue.stagingPaths[0]
  const beforeIdentity = fs.lstatSync(stagingPath, { bigint: true })
  assert.equal(beforeIdentity.size, 0n)

  await assert.rejects(
    () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
    (error) => error?.code === 'ARTIFACT_PUBLICATION_BUSY',
  )
  const afterIdentity = fs.lstatSync(stagingPath, { bigint: true })
  assert.equal(afterIdentity.dev, beforeIdentity.dev)
  assert.equal(afterIdentity.ino, beforeIdentity.ino)
  assert.equal(afterIdentity.size, 0n)
})

test('fallback crash before destination claim fails closed without adopting or deleting the empty target', async (t) => {
  const filename = 'destination-before-claim.pdf'
  const publicationKey = 'destination-before-claim'
  const sourcePath = path.join(tempDir, filename)
  fs.writeFileSync(sourcePath, `%PDF-1.4\n${'before-destination-claim-'.repeat(64)}`)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  crashStablePublisher({ mode: 'destination_before_claim', sourcePath, filename, publicationKey })
  const { artifactPath } = stablePublicationPaths(filename, publicationKey)
  const residue = publicationAttemptResidue(publicationKey)
  assert.equal(residue.attemptRecords.some((entry) => entry.endsWith('.destination.json')), false)
  const beforeIdentity = fs.lstatSync(artifactPath, { bigint: true })
  assert.equal(beforeIdentity.size, 0n)

  await assert.rejects(
    () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
    (error) => error?.code === 'ARTIFACT_PUBLICATION_BUSY',
  )
  const afterIdentity = fs.lstatSync(artifactPath, { bigint: true })
  assert.equal(afterIdentity.dev, beforeIdentity.dev)
  assert.equal(afterIdentity.ino, beforeIdentity.ino)
  assert.equal(afterIdentity.size, 0n)
})

test('crash recovery never removes a pathname competitor that replaced the claimed destination', async (t) => {
  const filename = 'destination-replaced-after-crash.pdf'
  const publicationKey = 'destination-replaced-after-crash'
  const sourcePath = path.join(tempDir, filename)
  fs.writeFileSync(sourcePath, `%PDF-1.4\n${'replacement-guard-'.repeat(64)}`)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  crashStablePublisher({ mode: 'destination_after_claim', sourcePath, filename, publicationKey })
  const { artifactPath } = stablePublicationPaths(filename, publicationKey)
  const displacedPath = `${artifactPath}.displaced`
  fs.renameSync(artifactPath, displacedPath)
  const competitor = '%PDF-1.4\nnon-cooperating-replacement'
  fs.writeFileSync(artifactPath, competitor)

  await assert.rejects(
    () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
    (error) => error?.code === 'ARTIFACT_PUBLICATION_BUSY',
  )
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), competitor)
  assert.equal(fs.existsSync(displacedPath), true)
})

test('crash recovery preserves in-place tampering that is not an exact trusted prefix', async (t) => {
  const filename = 'destination-tampered-after-crash.pdf'
  const publicationKey = 'destination-tampered-after-crash'
  const sourcePath = path.join(tempDir, filename)
  fs.writeFileSync(sourcePath, `%PDF-1.4\n${'tamper-guard-'.repeat(64)}`)
  t.after(() => cleanupPublicationTestResidue(filename, publicationKey))

  crashStablePublisher({ mode: 'destination_after_claim', sourcePath, filename, publicationKey })
  const { artifactPath } = stablePublicationPaths(filename, publicationKey)
  const beforeIdentity = fs.lstatSync(artifactPath, { bigint: true })
  const tampered = Buffer.from('not-an-exact-prefix-of-the-trusted-stage')
  const handle = fs.openSync(artifactPath, 'r+')
  try {
    fs.ftruncateSync(handle, 0)
    fs.writeSync(handle, tampered, 0, tampered.length, 0)
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  const tamperedIdentity = fs.lstatSync(artifactPath, { bigint: true })
  assert.equal(tamperedIdentity.dev, beforeIdentity.dev)
  assert.equal(tamperedIdentity.ino, beforeIdentity.ino)

  await assert.rejects(
    () => createLocalFileArtifactAsync({ sourcePath, filename, publicationKey }),
    (error) => error?.code === 'ARTIFACT_PUBLICATION_BUSY',
  )
  assert.deepEqual(fs.readFileSync(artifactPath), tampered)
})

test('stable publication serializes hard-link and exclusive-copy publishers without clobbering', async () => {
  const firstSource = path.join(tempDir, 'publication-lock-first.pdf')
  const secondSource = path.join(tempDir, 'publication-lock-second.pdf')
  fs.writeFileSync(firstSource, '%PDF-1.4\nfirst-writer')
  fs.writeFileSync(secondSource, '%PDF-1.4\nfirst-writer')

  const originalLink = fs.promises.link
  const originalOpen = fs.promises.open
  let linkAttempts = 0
  let signalFallbackEntered
  let releaseFallback
  let signalSecondLink
  const fallbackEntered = new Promise((resolve) => { signalFallbackEntered = resolve })
  const fallbackRelease = new Promise((resolve) => { releaseFallback = resolve })
  const secondLinkAttempted = new Promise((resolve) => { signalSecondLink = resolve })
  let firstPublication = null
  let secondPublication = null

  fs.promises.link = async (...args) => {
    if (isPublicationMetadataLink(args)) return originalLink(...args)
    linkAttempts += 1
    if (linkAttempts === 1) {
      const error = new Error('force the first publisher through the exclusive-copy fallback')
      error.code = 'EPERM'
      throw error
    }
    signalSecondLink()
    return originalLink(...args)
  }
  fs.promises.open = async (target, flags, ...args) => {
    const isFinalClaim = flags === 'wx'
      && !String(target).endsWith('.lock')
      && !String(target).endsWith('.tmp')
      && !String(target).endsWith('.json')
    if (isFinalClaim) {
      signalFallbackEntered()
      await fallbackRelease
    }
    return originalOpen(target, flags, ...args)
  }

  try {
    const options = {
      filename: 'publication-lock-race.pdf',
      publicationKey: 'publication-lock-race',
    }
    firstPublication = createLocalFileArtifactAsync({ ...options, sourcePath: firstSource })
    await fallbackEntered
    secondPublication = createLocalFileArtifactAsync({ ...options, sourcePath: secondSource })

    const bypassedLock = await Promise.race([
      secondLinkAttempted.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ])
    assert.equal(bypassedLock, false, 'a hard-link publisher must wait for the fallback publication lock')

    releaseFallback()
    const [first, second] = await Promise.all([firstPublication, secondPublication])
    assert.equal(first.fullPath, second.fullPath)
    assert.equal(linkAttempts, 1)
    assert.equal(fs.readFileSync(first.fullPath, 'utf8'), '%PDF-1.4\nfirst-writer')
    assert.deepEqual(
      fs.readdirSync(process.env.ARTIFACT_DIR).filter((name) => /^\.publish-.*\.(?:lock|tmp)$/.test(name)),
      [],
    )
  } finally {
    releaseFallback()
    await Promise.allSettled([firstPublication, secondPublication].filter(Boolean))
    fs.promises.link = originalLink
    fs.promises.open = originalOpen
  }
})

test('exclusive-copy fallback never overwrites a non-cooperating pathname winner', async () => {
  const sourcePath = path.join(tempDir, 'non-cooperating-source.pdf')
  fs.writeFileSync(sourcePath, '%PDF-1.4\nmanaged-source')
  const originalLink = fs.promises.link
  const originalOpen = fs.promises.open
  let winnerPath = ''
  let injected = false

  fs.promises.link = async (...args) => {
    if (isPublicationMetadataLink(args)) return originalLink(...args)
    const error = new Error('hard links are unavailable on this test filesystem')
    error.code = 'EPERM'
    throw error
  }
  fs.promises.open = async (target, flags, ...args) => {
    const isFinalClaim = flags === 'wx'
      && !String(target).endsWith('.lock')
      && !String(target).endsWith('.tmp')
      && !String(target).endsWith('.json')
    if (isFinalClaim && !injected) {
      injected = true
      winnerPath = String(target)
      const competitor = await originalOpen(target, 'wx')
      await competitor.writeFile('%PDF-1.4\nnon-cooperating-winner')
      await competitor.sync()
      await competitor.close()
    }
    return originalOpen(target, flags, ...args)
  }

  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({
        sourcePath,
        filename: 'non-cooperating-race.pdf',
        publicationKey: 'non-cooperating-race',
      }),
      (error) => error?.code === 'ARTIFACT_PUBLICATION_OWNERSHIP_CONFLICT',
    )
    assert.equal(injected, true)
    assert.equal(fs.readFileSync(winnerPath, 'utf8'), '%PDF-1.4\nnon-cooperating-winner')
  } finally {
    fs.promises.link = originalLink
    fs.promises.open = originalOpen
  }
})

test('published artifact verification rejects a same-content pathname replacement', async (t) => {
  const fullPath = path.join(tempDir, 'publication-verification-pathname-swap.pdf')
  const displacedPath = `${fullPath}.displaced`
  const content = Buffer.from('%PDF-1.4\npathname-swap')
  const marker = {
    size: content.length,
    contentSha256: crypto.createHash('sha256').update(content).digest('hex'),
  }
  fs.writeFileSync(fullPath, content)
  t.after(() => {
    fs.rmSync(fullPath, { force: true })
    fs.rmSync(displacedPath, { force: true })
  })

  const originalLstat = fs.promises.lstat
  let pathnameSwapped = false
  fs.promises.lstat = async (target, ...args) => {
    const stat = await originalLstat(target, ...args)
    if (!pathnameSwapped && String(target) === fullPath) {
      pathnameSwapped = true
      fs.renameSync(fullPath, displacedPath)
      fs.writeFileSync(fullPath, content)
    }
    return stat
  }

  try {
    await assert.rejects(
      () => verifyPublishedArtifact({ fullPath, marker }),
      (error) => error?.code === 'ARTIFACT_PUBLICATION_CONTENT_DRIFT',
    )
    assert.equal(pathnameSwapped, true)
    assert.deepEqual(fs.readFileSync(fullPath), content)
  } finally {
    fs.promises.lstat = originalLstat
  }
})

test('stable publication rejects source drift for the same execution identity', async () => {
  const firstSource = path.join(tempDir, 'publication-drift-first.pdf')
  const secondSource = path.join(tempDir, 'publication-drift-second.pdf')
  fs.writeFileSync(firstSource, '%PDF-1.4\noriginal')
  fs.writeFileSync(secondSource, '%PDF-1.4\nchanged')
  const options = {
    filename: 'publication-drift.pdf',
    publicationKey: 'publication-drift-identity',
  }
  const first = await createLocalFileArtifactAsync({ ...options, sourcePath: firstSource })

  await assert.rejects(
    () => createLocalFileArtifactAsync({ ...options, sourcePath: secondSource }),
    (error) => error?.code === 'ARTIFACT_PUBLICATION_CONTENT_DRIFT',
  )
  assert.equal(fs.readFileSync(first.fullPath, 'utf8'), '%PDF-1.4\noriginal')
})

test('stable publication never adopts an existing target after its ownership marker is removed', async () => {
  const sourcePath = path.join(tempDir, 'publication-owner-source.pdf')
  fs.writeFileSync(sourcePath, '%PDF-1.4\nowned')
  const options = {
    sourcePath,
    filename: 'publication-owner.pdf',
    publicationKey: 'publication-owner-identity',
  }
  const first = await createLocalFileArtifactAsync(options)
  const digest = first.id.slice('local-'.length)
  fs.unlinkSync(path.join(process.env.ARTIFACT_DIR, '.artifact-publications', `${digest}.json`))

  await assert.rejects(
    () => createLocalFileArtifactAsync(options),
    (error) => error?.code === 'ARTIFACT_PUBLICATION_OWNERSHIP_CONFLICT',
  )
  assert.equal(fs.readFileSync(first.fullPath, 'utf8'), '%PDF-1.4\nowned')
})

test('stable publication detects managed artifact tampering during crash reconciliation', async () => {
  const sourcePath = path.join(tempDir, 'publication-tamper-source.pdf')
  fs.writeFileSync(sourcePath, '%PDF-1.4\ntrusted')
  const options = {
    sourcePath,
    filename: 'publication-tamper.pdf',
    publicationKey: 'publication-tamper-identity',
  }
  const first = await createLocalFileArtifactAsync(options)
  fs.writeFileSync(first.fullPath, '%PDF-1.4\ntampered')
  fs.unlinkSync(sourcePath)

  await assert.rejects(
    () => createLocalFileArtifactAsync(options),
    (error) => error?.code === 'ARTIFACT_PUBLICATION_CONTENT_DRIFT',
  )
})

test('exclusive-copy fallback removes only its own incomplete destination after failure', async () => {
  const sourcePath = path.join(tempDir, 'exclusive-copy-failure.pdf')
  fs.writeFileSync(sourcePath, '%PDF-1.4\ncopy-failure')
  const originalLink = fs.promises.link
  const originalOpen = fs.promises.open
  let failedPath = ''

  fs.promises.link = async (...args) => {
    if (isPublicationMetadataLink(args)) return originalLink(...args)
    const error = new Error('hard links are unavailable on this test filesystem')
    error.code = 'EPERM'
    throw error
  }
  fs.promises.open = async (target, flags, ...args) => {
    const handle = await originalOpen(target, flags, ...args)
    const isFinalClaim = flags === 'wx'
      && !String(target).endsWith('.lock')
      && !String(target).endsWith('.tmp')
      && !String(target).endsWith('.json')
    if (isFinalClaim) failedPath = String(target)
    if (flags !== 'r+' || String(target) !== failedPath) return handle
    return {
      stat: (...statArgs) => handle.stat(...statArgs),
      read: (...readArgs) => handle.read(...readArgs),
      write: async () => { throw new Error('injected exclusive copy failure') },
      sync: (...syncArgs) => handle.sync(...syncArgs),
      close: (...closeArgs) => handle.close(...closeArgs),
    }
  }

  try {
    await assert.rejects(
      () => createLocalFileArtifactAsync({
        sourcePath,
        filename: 'exclusive-copy-failure.pdf',
        publicationKey: 'exclusive-copy-failure',
      }),
      /injected exclusive copy failure/,
    )
    assert.ok(failedPath)
    assert.equal(fs.existsSync(failedPath), false)
    assert.deepEqual(
      fs.readdirSync(process.env.ARTIFACT_DIR).filter((name) => /^\.publish-.*\.(?:lock|tmp)$/.test(name)),
      [],
    )
  } finally {
    fs.promises.link = originalLink
    fs.promises.open = originalOpen
  }
})

test('stable publication uses short staging names for a maximum-length artifact filename', async () => {
  const sourcePath = path.join(tempDir, 'short-source.pdf')
  fs.writeFileSync(sourcePath, '%PDF-1.4\nlong-name')
  const requestedFilename = `${'a'.repeat(236)}.pdf`
  assert.equal(requestedFilename.length, 240)

  const artifact = await createLocalFileArtifactAsync({
    sourcePath,
    filename: requestedFilename,
    publicationKey: 'maximum-length-artifact-publication',
  })
  assert.ok(artifact.filename.length <= 240)
  assert.ok(Buffer.byteLength(artifact.filename, 'utf8') <= 240)
  assert.equal(fs.readFileSync(artifact.fullPath, 'utf8'), '%PDF-1.4\nlong-name')
  assert.deepEqual(
    fs.readdirSync(process.env.ARTIFACT_DIR).filter((name) => /^\.publish-.*\.tmp$/.test(name)),
    [],
  )
})

test('background artifact idempotency requires a step identity', () => {
  const call = { id: 'reused-call-id', name: 'bash_exec' }
  const job = { id: 'background-job', origin: 'job', userId: 'artifact-user' }
  assert.equal(localArtifactPublicationKey({ call, job, step: null, toolCallId: call.id }), '')
  assert.notEqual(localArtifactPublicationKey({
    call,
    job,
    step: { id: 'background-step' },
    toolCallId: call.id,
  }), '')
})

test('local artifact publication failures remain observable without changing source-tool success', async () => {
  const missingPath = path.join(tempDir, 'output-removed-before-publication.pdf')
  const artifacts = await persistLocalToolArtifactsAsync({
    call: { id: 'missing-output-call', name: 'bash_exec', args: { cwd: tempDir } },
    result: {
      ok: true,
      cwd: tempDir,
      verifiedOutputs: [{ path: missingPath, declaredPath: missingPath, scope: 'grant', type: 'file' }],
    },
    job: {
      id: 'missing-output-turn', origin: 'chat', userId: 'artifact-user', sessionId: 'artifact-session',
    },
    step: null,
    toolCallId: 'missing-output-call',
  })
  assert.deepEqual(artifacts, [])
  assert.deepEqual(artifacts.publicationFailures, [{
    code: 'artifact_publication_failed',
    phase: 'publication',
    causeCode: 'ENOENT',
    candidateIndex: 0,
    filename: 'output-removed-before-publication.pdf',
    retryable: false,
    message: 'The local output disappeared before its downloadable copy could be published. Do not rerun the source tool automatically.',
  }])
})

test('tool runtime exposes artifact publication failure in the durable tool result', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  assert.ok(bashExec)
  const missingPath = path.join(tempDir, 'runtime-publication-missing.txt')
  let modelCalls = 0
  let completedResult = null
  let durableToolResult = null
  await runToolsLoop({
    job: {
      id: 'runtime-publication-failure-turn',
      origin: 'chat',
      userId: 'artifact-user',
      sessionId: 'artifact-session',
      prompt: 'Run the requested local command.',
    },
    step: { id: 'runtime-publication-failure-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Run the requested local command.' }],
    intentMode: 'execute',
    toolSpecs: [bashExec],
    maxIters: 3,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'runtime-publication-failure-call',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({ command: 'produce-output', cwd: tempDir }),
            },
          }],
        }
      }
      const toolMessage = messages.findLast((message) => message.role === 'tool')
      durableToolResult = toolMessage ? JSON.parse(toolMessage.content) : null
      return { content: 'The command ran, but its downloadable copy was unavailable.', toolCalls: [] }
    },
    executeTool: async () => ({
      ok: true,
      cwd: tempDir,
      stdout: 'source command completed',
      verifiedOutputs: [{
        path: missingPath,
        declaredPath: missingPath,
        scope: 'grant',
        type: 'file',
      }],
    }),
    onToolCompleted: async (outcome) => {
      if (outcome.call?.id === 'runtime-publication-failure-call') {
        completedResult = structuredClone(outcome.result)
      }
    },
  })

  for (const observed of [completedResult, durableToolResult]) {
    assert.equal(observed?.ok, true)
    assert.equal(observed?.artifactPublication?.ok, false)
    assert.equal(observed?.artifactPublication?.status, 'failed')
    assert.equal(observed?.artifactPublication?.retryable, false)
    assert.match(observed?.artifactPublication?.guidance || '', /Do not rerun/u)
    assert.equal(observed?.artifactPublication?.failures?.[0]?.causeCode, 'ENOENT')
  }
})

test('verified write_file and bash_exec outputs keep Windows Unicode filenames as turn artifacts', () => {
  const outputDir = path.join(tempDir, '本地 输出')
  fs.mkdirSync(outputDir, { recursive: true })
  const textPath = path.join(outputDir, '授权结果.txt')
  const pdfPath = path.join(outputDir, '填写后 答题卡.pdf')
  const pngPath = path.join(outputDir, '第 1 页.png')
  fs.writeFileSync(textPath, 'INLINE_AUTH_RESUMED')
  fs.writeFileSync(pdfPath, '%PDF-1.4\nlocal output')
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  const job = {
    id: 'local-output-turn',
    origin: 'chat',
    userId: 'artifact-user',
    sessionId: 'artifact-session',
  }
  const written = persistLocalToolArtifacts({
    call: { name: 'write_file', args: { path: textPath } },
    result: { ok: true, path: textPath, scope: 'grant' },
    job,
    step: null,
  })
  const executed = persistLocalToolArtifacts({
    call: { name: 'bash_exec', args: { cwd: outputDir } },
    result: {
      ok: true,
      cwd: outputDir,
      verifiedOutputs: [
        { path: pdfPath, declaredPath: pdfPath, scope: 'grant', type: 'file', status: 'created' },
        { path: pngPath, declaredPath: pngPath, scope: 'grant', type: 'file', status: 'created' },
      ],
    },
    job,
    step: null,
  })

  assert.deepEqual(written.map((artifact) => artifact.filename), ['授权结果.txt'])
  assert.deepEqual(executed.map((artifact) => artifact.filename), ['填写后 答题卡.pdf', '第 1 页.png'])
  const artifacts = listTurnArtifacts({
    userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'local-output-turn',
  })
  assert.deepEqual(artifacts.map((artifact) => artifact.filename), [
    '授权结果.txt', '填写后 答题卡.pdf', '第 1 页.png',
  ])
  for (const artifact of artifacts) {
    assert.match(artifact.url, /^\/api\/artifacts\//)
    assert.equal(fs.existsSync(path.join(process.env.ARTIFACT_DIR, artifact.filename)), true)
  }
})

test('set_deliverables strictly scopes artifact ids, replaces selections, and preserves explicit empty delivery on resume', async () => {
  const currentTurnId = 'deliverable-selection-turn'
  const draftId = 'deliverable-draft'
  const finalId = 'deliverable-final'
  const crossTurnId = 'deliverable-cross-turn'
  const crossSessionId = 'deliverable-cross-session'
  const crossUserId = 'deliverable-cross-user'
  const append = ({ id, userId = 'artifact-user', sessionId = 'artifact-session', turnId = currentTurnId }) => (
    appendTurnArtifact({
      id,
      userId,
      sessionId,
      turnId,
      type: 'pdf',
      title: id,
      filename: `${id}.pdf`,
      url: `/api/artifacts/${id}.pdf`,
    })
  )

  upsertSession({ id: 'deliverable-other-session', userId: 'artifact-user', title: 'Other session' })
  createUser({ id: 'deliverable-other-user', email: 'deliverable-other@example.com' })
  upsertSession({ id: 'deliverable-other-user-session', userId: 'deliverable-other-user', title: 'Other user' })
  append({ id: draftId })
  append({ id: finalId })
  append({ id: crossTurnId, turnId: 'another-turn' })
  append({ id: crossSessionId, sessionId: 'deliverable-other-session' })
  append({
    id: crossUserId,
    userId: 'deliverable-other-user',
    sessionId: 'deliverable-other-user-session',
  })

  const setDeliverablesSpec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'set_deliverables')
  const readFileSpec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  assert.ok(setDeliverablesSpec)
  assert.ok(readFileSpec)

  const selections = []
  const checkpoints = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: currentTurnId,
      origin: 'chat',
      userId: 'artifact-user',
      sessionId: 'artifact-session',
      prompt: 'Review the completed files and select the final deliverables.',
    },
    step: { id: currentTurnId, kind: 'chat' },
    messages: [{ role: 'user', content: 'Review the completed files and select the final deliverables.' }],
    intentMode: 'execute',
    toolSpecs: [readFileSpec, setDeliverablesSpec],
    maxIters: 8,
    enableToolHooks: false,
    requestToolApproval: async () => assert.fail('set_deliverables must not require approval'),
    loadCheckpoint: async () => ({
      state: { artifactIds: [draftId, finalId], iterations: 0 },
    }),
    saveCheckpoint: async (state) => {
      checkpoints.push(structuredClone(state))
      return true
    },
    runModel: async () => {
      modelCalls += 1
      const calls = {
        1: ['read-evidence', 'read_file', { path: 'README.md' }],
        2: ['reject-foreign', 'set_deliverables', { artifact_ids: [crossTurnId, crossSessionId, crossUserId] }],
        3: ['select-draft', 'set_deliverables', { artifact_ids: [draftId] }],
        4: ['replace-with-final', 'set_deliverables', { artifact_ids: [finalId] }],
        5: ['clear-delivery', 'set_deliverables', { artifact_ids: [] }],
      }
      const entry = calls[modelCalls]
      if (!entry) return { content: 'No files are intentionally delivered.', toolCalls: [] }
      return {
        content: '',
        toolCalls: [{
          id: entry[0],
          type: 'function',
          function: { name: entry[1], arguments: JSON.stringify(entry[2]) },
        }],
      }
    },
    executeTool: async ({ name }) => {
      assert.equal(name, 'read_file', 'set_deliverables must be handled by the scoped runtime control path')
      return { ok: true, path: 'README.md', content: 'evidence' }
    },
    onToolCompleted: async (outcome) => {
      if (outcome.call.name === 'set_deliverables') selections.push(outcome.result)
    },
  })

  assert.equal(selections[0].code, 'deliverable_artifact_scope_mismatch')
  assert.deepEqual(selections[0].invalidArtifactIds, [crossTurnId, crossSessionId, crossUserId])
  assert.deepEqual(selections.slice(1).map((selection) => selection.deliveryArtifactIds), [
    [draftId],
    [finalId],
    [],
  ])
  assert.deepEqual(result.artifactIds, [draftId, finalId])
  assert.ok(Object.hasOwn(result, 'deliveryArtifactIds'))
  assert.deepEqual(result.deliveryArtifactIds, [])
  assert.ok(checkpoints.some((state) => JSON.stringify(state.deliveryArtifactIds) === JSON.stringify([draftId])))
  assert.ok(checkpoints.some((state) => JSON.stringify(state.deliveryArtifactIds) === JSON.stringify([finalId])))
  assert.deepEqual(checkpoints.at(-1).deliveryArtifactIds, [])
})

test('created chat artifacts require an explicit set_deliverables call before normal completion', async () => {
  const turnId = 'deliverable-required-turn'
  const artifactId = 'deliverable-required-final'
  appendTurnArtifact({
    id: artifactId,
    userId: 'artifact-user',
    sessionId: 'artifact-session',
    turnId,
    type: 'pdf',
    title: 'Final report',
    filename: 'final-report.pdf',
    url: '/api/artifacts/final-report.pdf',
  })
  const setDeliverables = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'set_deliverables')
  let modelCalls = 0
  let guardObserved = false
  const result = await runToolsLoop({
    job: {
      id: turnId,
      origin: 'chat',
      userId: 'artifact-user',
      sessionId: 'artifact-session',
      prompt: 'What is the status of the generated report?',
    },
    step: { id: turnId, kind: 'chat' },
    messages: [{ role: 'user', content: 'What is the status of the generated report?' }],
    intentMode: 'auto',
    toolSpecs: [setDeliverables],
    toolsConfig: { disabled: ['set_deliverables'] },
    maxIters: 6,
    enableToolHooks: false,
    loadCheckpoint: async () => ({ state: { artifactIds: [artifactId], iterations: 0 } }),
    saveCheckpoint: async () => true,
    runModel: async ({ messages, toolChoice }) => {
      modelCalls += 1
      if (modelCalls <= 2) {
        assert.equal(toolChoice?.function?.name, 'set_deliverables')
      } else {
        assert.equal(toolChoice, undefined)
      }
      if (modelCalls === 1) return { content: 'The report is ready.', toolCalls: [] }
      if (modelCalls === 2) {
        guardObserved = messages.some((message) => String(message?.content || '').includes('[FINAL DELIVERABLE SELECTION REQUIRED]'))
        return {
          content: '',
          toolCalls: [{
            id: 'select-final-report',
            type: 'function',
            function: { name: 'set_deliverables', arguments: JSON.stringify({ artifact_ids: [artifactId] }) },
          }],
        }
      }
      return { content: 'The report is ready.', toolCalls: [] }
    },
  })

  assert.equal(guardObserved, true)
  assert.deepEqual(result.deliveryArtifactIds, [artifactId])
  assert.equal(result.incomplete, undefined)
})

test('PowerShell readback does not revive workspace verification after final deliverables are selected', async () => {
  const turnId = 'powershell-readback-terminal-turn'
  const artifactId = 'powershell-readback-terminal-artifact'
  const outputPath = 'D:\\destok\\Gugo\\output\\execution-check.txt'
  const normalizedOutputPath = outputPath.replaceAll('\\', '/')
  appendTurnArtifact({
    id: artifactId,
    userId: 'artifact-user',
    sessionId: 'artifact-session',
    turnId,
    type: 'txt',
    title: 'Execution check',
    filename: 'execution-check.txt',
    url: '/api/artifacts/execution-check.txt',
  })
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const setDeliverables = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'set_deliverables')
  const runProjectCheck = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'run_project_check')
  const calls = [
    ['write-output', 'bash_exec', {
      command: `powershell -NoProfile -Command "Set-Content -Path '${outputPath}' -Value 'EXECUTION_OK'"`,
      expected_outputs: [outputPath],
    }],
    ['powershell-readback', 'bash_exec', {
      command: `powershell -NoProfile -Command "Get-Content -Path '${outputPath}' -Raw"`,
      expected_outputs: [],
    }],
    ['powershell-hash', 'bash_exec', {
      command: `powershell -NoProfile -Command "(Get-FileHash -Path '${outputPath}' -Algorithm SHA256).Hash"`,
      expected_outputs: [],
    }],
    ['readback-file', 'read_file', { path: outputPath, offset: 0, limit: 0 }],
    ['select-output', 'set_deliverables', { artifact_ids: [artifactId] }],
  ]
  const checkpoints = []
  const executed = []
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: turnId,
      origin: 'chat',
      userId: 'artifact-user',
      sessionId: 'artifact-session',
      prompt: 'Write, verify, and deliver the execution check file.',
      userPrompt: 'Write, verify, and deliver the execution check file.',
    },
    step: { id: turnId, kind: 'chat' },
    messages: [{ role: 'user', content: 'Write, verify, and deliver the execution check file.' }],
    intentMode: 'execute',
    toolSpecs: [bashExec, readFile, setDeliverables, runProjectCheck],
    maxIters: 10,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      checkpoints.push(structuredClone(state))
      return true
    },
    runModel: async () => {
      modelCalls += 1
      const entry = calls[modelCalls - 1]
      if (!entry) {
        assert.equal(modelCalls, 6, 'the turn must stop on the first final answer after set_deliverables')
        return { content: '验收完成，最终文件已交付。', toolCalls: [] }
      }
      return {
        content: '',
        toolCalls: [{
          id: entry[0],
          type: 'function',
          function: { name: entry[1], arguments: JSON.stringify(entry[2]) },
        }],
      }
    },
    executeTool: async ({ name, args }) => {
      executed.push([name, args.command || args.path || ''])
      assert.notEqual(name, 'run_project_check', 'ordinary file readback must not require a project check')
      if (name === 'read_file') return { ok: true, path: outputPath, content: 'EXECUTION_OK' }
      if (String(args.command).includes('Set-Content')) {
        return {
          ok: true,
          exitCode: 0,
          cwd: 'D:\\destok\\Gugo',
          verifiedOutputs: [{ path: outputPath, status: 'created', type: 'file' }],
          changedPaths: [outputPath],
          artifactId,
          filename: 'execution-check.txt',
          url: '/api/artifacts/execution-check.txt',
        }
      }
      if (String(args.command).includes('Get-Content')) {
        return { ok: true, exitCode: 0, cwd: 'D:\\destok\\Gugo', stdout: 'EXECUTION_OK\r\n' }
      }
      return { ok: true, exitCode: 0, cwd: 'D:\\destok\\Gugo', stdout: 'ABC123\r\n' }
    },
  })

  assert.equal(modelCalls, 6)
  assert.equal(result.text, '验收完成，最终文件已交付。')
  assert.equal(result.incomplete, undefined)
  assert.deepEqual(result.deliveryArtifactIds, [artifactId])
  assert.equal(executed.some(([name]) => name === 'run_project_check'), false)
  assert.equal(checkpoints.some((state) => (
    state.completionGuards?.pendingMutationTargets?.includes('<workspace>')
  )), false)
  assert.deepEqual(checkpoints.at(-1)?.completionGuards?.pendingMutationTargets, [])
  assert.ok(checkpoints.some((state) => (
    state.completionGuards?.pendingMutationTargets?.includes(normalizedOutputPath)
  )))
})

test('PowerShell verification classification rejects mixed read and write scripts', () => {
  const readOnly = {
    name: 'bash_exec',
    args: { command: "powershell -NoProfile -Command \"Get-Content -Path 'result.txt' -Raw\"" },
  }
  const mixed = {
    name: 'bash_exec',
    args: { command: "powershell -NoProfile -Command \"Get-Content -Path 'result.txt'; Set-Content -Path 'result.txt' -Value changed\"" },
  }
  const aliasMutation = {
    name: 'bash_exec',
    args: { command: "powershell -NoProfile -Command \"Get-Content -Path 'result.txt' | sc 'copy.txt'\"" },
  }
  assert.equal(isReadOnlyPowerShellVerificationCall(readOnly), true)
  assert.equal(isLocalMutationCall(readOnly), false)
  assert.equal(isReadOnlyPowerShellVerificationCall(mixed), false)
  assert.equal(isLocalMutationCall(mixed), true)
  assert.equal(isReadOnlyPowerShellVerificationCall(aliasMutation), false)
  assert.equal(isLocalMutationCall(aliasMutation), true)
})

test('generic PowerShell metadata and unbound hashes cannot verify a mutation', () => {
  const target = path.join(tempDir, 'binary-output.docx')
  for (const command of [
    `powershell -NoProfile -Command "Get-Item -LiteralPath '${target}'"`,
    `powershell -NoProfile -Command "(Get-FileHash -LiteralPath '${target}' -Algorithm SHA256).Hash"`,
    `powershell -NoProfile -Command "Get-Content -LiteralPath '${target}' -Raw"`,
  ]) {
    assert.deepEqual(
      [...powerShellVerificationTargets({ name: 'bash_exec', args: { command } }, {
        ok: true,
        exitCode: 0,
        stdout: 'attacker-controlled-or-unbound-output',
      })],
      [],
    )
  }
  const textTarget = path.join(tempDir, 'text-output.txt')
  assert.deepEqual([...powerShellVerificationTargets({
    name: 'bash_exec',
    args: { command: `powershell -NoProfile -Command "Get-Content -LiteralPath '${textTarget}' -Raw"` },
  }, { ok: true, exitCode: 0, path: textTarget, stdout: 'verified text' })], [
    textTarget.replaceAll('\\', '/'),
  ])
})

test('binary structure receipts require digest, path, user, session, and turn binding', () => {
  const sourcePath = path.join(tempDir, 'bound-output.pdf')
  const artifactPath = path.join(process.env.ARTIFACT_DIR, 'bound-output.pdf')
  const binding = { userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'bound-turn' }
  const receipt = {
    artifactId: 'bound-artifact',
    verified: true,
    verifier: 'bounded_structure_parser',
    verifierVersion: 1,
    format: 'pdf',
    byteLength: 128,
    sha256: 'a'.repeat(64),
    path: sourcePath,
    sourcePath,
    artifactPath,
    ...binding,
  }

  for (const invalid of [
    { ...receipt, sha256: null },
    { ...receipt, userId: 'other-user' },
    { ...receipt, sessionId: 'other-session' },
    { ...receipt, turnId: 'other-turn' },
    { ...receipt, sourcePath: 'relative.pdf' },
    { ...receipt, artifactPath: 'relative.pdf' },
  ]) {
    const pending = new Set([sourcePath])
    assert.equal(clearArtifactValidatedMutationTargets(pending, [invalid], binding), false)
    assert.deepEqual([...pending], [sourcePath])
  }

  const pending = new Set([sourcePath])
  assert.equal(clearArtifactValidatedMutationTargets(pending, [receipt], binding), true)
  assert.deepEqual([...pending], [])
})

test('DOCX PPTX XLSX PDF and image publications emit exact turn-bound digest receipts', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  const generated = [
    await createDocx({ title: 'Receipt DOCX', paragraphs: [{ text: 'verified' }] }),
    await createPptx({ title: 'Receipt PPTX', slides: [{ title: 'Verified', bullets: ['body'] }] }),
    await createXlsx({ title: 'Receipt XLSX', sheets: [{ name: 'Data', rows: [['verified']] }] }),
    await createPdf({ title: 'Receipt PDF', blocks: [{ type: 'paragraph', text: 'verified' }] }),
    createImageArtifact({ title: 'Receipt PNG', buffer: png, mimeType: 'image/png' }),
  ]

  for (const [index, generatedArtifact] of generated.entries()) {
    const sourcePath = path.join(tempDir, `receipt-source-${index}${path.extname(generatedArtifact.filename)}`)
    fs.copyFileSync(generatedArtifact.fullPath, sourcePath)
    const turnId = `binary-receipt-turn-${index}`
    const call = {
      id: `binary-receipt-call-${index}`,
      name: 'bash_exec',
      args: { cwd: tempDir, expected_outputs: [sourcePath] },
    }
    const artifacts = await persistLocalToolArtifactsAsync({
      call,
      result: {
        ok: true,
        cwd: tempDir,
        verifiedOutputs: [{
          path: sourcePath,
          declaredPath: sourcePath,
          scope: 'grant',
          type: 'file',
        }],
      },
      job: {
        id: turnId,
        origin: 'chat',
        userId: 'artifact-user',
        sessionId: 'artifact-session',
      },
      step: null,
      toolCallId: call.id,
    })
    assert.equal(artifacts.length, 1, generatedArtifact.filename)
    assert.equal(artifacts.verificationReceipts.length, 1, generatedArtifact.filename)
    const receipt = artifacts.verificationReceipts[0]
    const managedBytes = fs.readFileSync(receipt.artifactPath)
    assert.equal(receipt.sha256, crypto.createHash('sha256').update(managedBytes).digest('hex'))
    assert.equal(receipt.byteLength, managedBytes.byteLength)
    assert.equal(receipt.userId, 'artifact-user')
    assert.equal(receipt.sessionId, 'artifact-session')
    assert.equal(receipt.turnId, turnId)
    assert.equal(receipt.toolCallId, call.id)
    assert.equal(path.isAbsolute(receipt.sourcePath), true)
    assert.equal(path.isAbsolute(receipt.artifactPath), true)
  }
})

test('creating another artifact after selection invalidates it and requires reconfirmation', async () => {
  const turnId = 'deliverable-dirty-turn'
  const draftId = 'deliverable-dirty-draft'
  const finalId = 'deliverable-dirty-final'
  appendTurnArtifact({
    id: draftId,
    userId: 'artifact-user',
    sessionId: 'artifact-session',
    turnId,
    type: 'docx',
    title: 'Draft',
    filename: 'draft.docx',
    url: '/api/artifacts/draft.docx',
  })
  const createDocx = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'create_docx')
  const setDeliverables = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'set_deliverables')
  let modelCalls = 0
  let guardObserved = false
  const checkpoints = []
  const result = await runToolsLoop({
    job: {
      id: turnId,
      origin: 'chat',
      userId: 'artifact-user',
      sessionId: 'artifact-session',
      prompt: 'Create the final Word document.',
      userPrompt: 'Create the final Word document.',
    },
    step: { id: turnId, kind: 'chat' },
    messages: [{ role: 'user', content: 'Create the final Word document.' }],
    intentMode: 'execute',
    toolSpecs: [createDocx, setDeliverables],
    maxIters: 8,
    enableToolHooks: false,
    loadCheckpoint: async () => ({ state: { artifactIds: [draftId], iterations: 0 } }),
    saveCheckpoint: async (state) => {
      checkpoints.push(structuredClone(state))
      return true
    },
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async ({ name }) => {
      assert.equal(name, 'create_docx')
      appendTurnArtifact({
        id: finalId,
        userId: 'artifact-user',
        sessionId: 'artifact-session',
        turnId,
        type: 'docx',
        title: 'Final',
        filename: 'final.docx',
        url: '/api/artifacts/final.docx',
      })
      return { ok: true, artifactId: finalId, filename: 'final.docx', url: '/api/artifacts/final.docx' }
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      const calls = {
        1: ['select-draft-first', 'set_deliverables', { artifact_ids: [draftId] }],
        2: ['create-final-doc', 'create_docx', { title: 'Final', paragraphs: [{ text: 'done' }] }],
        4: ['reselect-final-doc', 'set_deliverables', { artifact_ids: [finalId] }],
      }
      if (modelCalls === 3) return { content: 'The final document is ready.', toolCalls: [] }
      if (modelCalls === 4) {
        guardObserved = messages.some((message) => String(message?.content || '').includes('[FINAL DELIVERABLE SELECTION REQUIRED]'))
      }
      const entry = calls[modelCalls]
      if (!entry) return { content: 'The final document is ready.', toolCalls: [] }
      return {
        content: '',
        toolCalls: [{
          id: entry[0],
          type: 'function',
          function: { name: entry[1], arguments: JSON.stringify(entry[2]) },
        }],
      }
    },
  })

  assert.equal(guardObserved, true)
  assert.deepEqual(result.artifactIds, [draftId, finalId])
  assert.deepEqual(result.deliveryArtifactIds, [finalId])
  const invalidatedCheckpoint = checkpoints.find((state) => (
    JSON.stringify(state.artifactIds) === JSON.stringify([draftId, finalId])
    && state.completionGuards?.deliveryArtifactSelectionArtifactIds?.length === 0
  ))
  assert.ok(invalidatedCheckpoint, 'the invalidated selection must be checkpointed before reselection')
  assert.ok(Object.hasOwn(invalidatedCheckpoint, 'deliveryArtifactIds'))
  assert.deepEqual(invalidatedCheckpoint.deliveryArtifactIds, [])
})

test('same-id delivery failure revokes verified provenance and the previous deliverable selection', async () => {
  const turnId = 'same-id-delivery-downgrade-turn'
  const artifactId = 'same-id-delivery-downgrade-artifact'
  const createHtml = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'create_html_app')
  const setDeliverables = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'set_deliverables')
  const checkpoints = []
  let modelCalls = 0
  let generatorCalls = 0

  const result = await runToolsLoop({
    job: {
      id: turnId,
      origin: 'chat',
      userId: 'artifact-user',
      sessionId: 'artifact-session',
      prompt: '/webpage Create a webpage and save it to D:\\destok\\exports.',
      userPrompt: '/webpage Create a webpage and save it to D:\\destok\\exports.',
    },
    step: { id: turnId, kind: 'chat' },
    messages: [{ role: 'user', content: '/webpage Create a webpage and save it to D:\\destok\\exports.' }],
    skillId: 'webpage',
    intentMode: 'execute',
    toolSpecs: [createHtml, setDeliverables],
    maxIters: 3,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    saveCheckpoint: async (state) => {
      checkpoints.push(structuredClone(state))
      return true
    },
    executeTool: async ({ name }) => {
      assert.equal(name, 'create_html_app')
      generatorCalls += 1
      if (generatorCalls === 1) {
        appendTurnArtifact({
          id: artifactId,
          userId: 'artifact-user',
          sessionId: 'artifact-session',
          turnId,
          type: 'html',
          title: 'Delivered page',
          filename: 'same-id-delivered.html',
          url: '/api/artifacts/same-id-delivered.html',
        })
        return {
          ok: true,
          artifactId,
          filename: 'same-id-delivered.html',
          url: '/api/artifacts/same-id-delivered.html',
          deliveryStatus: 'delivered',
        }
      }
      return {
        ok: false,
        artifactId,
        filename: 'same-id-delivered.html',
        url: '/api/artifacts/same-id-delivered.html',
        deliveryStatus: 'managed_only',
        code: 'ARTIFACT_DEFAULT_DELIVERY_FAILED',
        error: 'simulated local replacement sync failure',
        retryable: false,
      }
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'same-id-initial-success',
            type: 'function',
            function: { name: 'create_html_app', arguments: JSON.stringify({ title: 'Page', html: '<!doctype html><html><body><main>v1</main></body></html>' }) },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'same-id-select-success',
            type: 'function',
            function: { name: 'set_deliverables', arguments: JSON.stringify({ artifact_ids: [artifactId] }) },
          }],
        }
      }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'same-id-replacement-failure',
            type: 'function',
            function: { name: 'create_html_app', arguments: JSON.stringify({ title: 'Page', html: '<!doctype html><html><body><main>v2</main></body></html>' }) },
          }],
        }
      }
      return { content: 'The replacement is complete.', toolCalls: [] }
    },
  })

  assert.equal(generatorCalls, 2)
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'artifact_delivery_not_converged')
  assert.deepEqual(result.artifactIds, [artifactId])
  assert.deepEqual(result.deliveryArtifactIds, [])
  const downgraded = checkpoints.find((state) => (
    state.toolCalls?.some((call) => call.id === 'same-id-replacement-failure' && call.checkpointStatus === 'completed')
  ))
  assert.ok(downgraded)
  assert.deepEqual(downgraded.deliveryArtifactIds, [])
  assert.deepEqual(downgraded.completionGuards?.deliveredArtifactTools, [])
  assert.deepEqual(downgraded.completionGuards?.artifactProvenance, [{
    artifactId,
    toolName: 'create_html_app',
    verified: false,
  }])
})

test('refusing final artifact selection ends incomplete with explicit empty delivery', async () => {
  const turnId = 'deliverable-refused-turn'
  const artifactId = 'deliverable-refused-artifact'
  appendTurnArtifact({
    id: artifactId,
    userId: 'artifact-user',
    sessionId: 'artifact-session',
    turnId,
    type: 'png',
    title: 'Preview',
    filename: 'preview.png',
    url: '/api/artifacts/preview.png',
  })
  const setDeliverables = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'set_deliverables')
  const result = await runToolsLoop({
    job: {
      id: turnId,
      origin: 'chat',
      userId: 'artifact-user',
      sessionId: 'artifact-session',
      prompt: 'What is the status of the generated preview?',
    },
    step: { id: turnId, kind: 'chat' },
    messages: [{ role: 'user', content: 'What is the status of the generated preview?' }],
    intentMode: 'auto',
    toolSpecs: [setDeliverables],
    maxIters: 1,
    enableToolHooks: false,
    loadCheckpoint: async () => ({ state: { artifactIds: [artifactId], iterations: 0 } }),
    saveCheckpoint: async () => true,
    runModel: async () => ({ content: 'Done.', toolCalls: [] }),
  })

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'deliverable_selection_missing')
  assert.deepEqual(result.deliveryArtifactIds, [])
  assert.deepEqual(result.artifactIds, [artifactId])
})
