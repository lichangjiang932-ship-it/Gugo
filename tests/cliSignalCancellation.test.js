import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function runModuleScript(script, { env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`signal cancellation child timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (status, signal) => {
      clearTimeout(timeout)
      resolve({ status, signal, stdout, stderr })
    })
  })
}

function parseJsonLines(output) {
  return String(output || '')
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

test('subprocess SIGTERM target cancels one durable turn and cleans up before exit 143', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'gugo-cli-signal-data-'))
  const homeDir = mkdtempSync(path.join(tmpdir(), 'gugo-cli-signal-home-'))
  const cliUrl = pathToFileURL(path.join(REPO_ROOT, 'bin', 'yma-cli.js')).href
  const hostUrl = pathToFileURL(path.join(
    REPO_ROOT,
    'server',
    'adapters',
    'headlessTurnHost.js',
  )).href
  const persistenceUrl = pathToFileURL(path.join(
    REPO_ROOT,
    'server',
    'adapters',
    'sqliteTurnPersistenceAdapter.js',
  )).href
  const loopUrl = pathToFileURL(path.join(
    REPO_ROOT,
    'server',
    'core',
    'toolLoopAdapter.js',
  )).href
  const script = `
    import assert from 'node:assert/strict'
    import { EventEmitter } from 'node:events'
    const { cmdRun, createRunShutdownController } = await import(${JSON.stringify(cliUrl)})
    const { runBuiltinHeadlessTurn } = await import(${JSON.stringify(hostUrl)})
    const { SQLITE_TURN_PERSISTENCE_ADAPTER } = await import(${JSON.stringify(persistenceUrl)})
    const { BUILTIN_TOOL_LOOP_ADAPTER } = await import(${JSON.stringify(loopUrl)})

    const userId = 'signal-user'
    const sessionId = 'signal-session'
    const turnId = 'signal-turn'
    const events = []
    let subscriber = () => {}
    let finishTurn
    const completed = new Promise((resolve) => { finishTurn = resolve })
    const signalTarget = new EventEmitter()
    signalTarget.exitCode = null
    let cancelCalls = 0
    let cancelledScope = null
    let unsubscribeCalls = 0
    let stopCalls = 0
    let releaseCalls = 0

    const emit = (type, payload = {}) => {
      const event = {
        id: turnId + ':' + events.length,
        userId,
        sessionId,
        turnId,
        sequence: events.length,
        type,
        payload,
        createdAt: events.length + 1,
      }
      events.push(event)
      subscriber(event)
    }
    const engine = {
      startTurn: async () => {
        emit('turn.started')
        setImmediate(() => signalTarget.emit('SIGTERM'))
      },
      recoverTurn: async () => ({ terminal: false }),
      cancelTurn: async (scope) => {
        cancelCalls += 1
        cancelledScope = scope
        emit('turn.cancelled', { reason: 'Cancelled by user' })
        finishTurn()
      },
      waitForTurn: async () => completed,
      listEvents: ({ after }) => events.filter((event) => event.sequence > after),
    }
    const snapshot = Object.freeze({
      get(type) {
        if (type === 'persistence') return SQLITE_TURN_PERSISTENCE_ADAPTER
        if (type === 'loop') return BUILTIN_TOOL_LOOP_ADAPTER
        return null
      },
    })
    const dependencies = {
      toolLoopAdapter: BUILTIN_TOOL_LOOP_ADAPTER,
      acquireHostTurnPersistenceCapability: (adapter) => Object.freeze({
        adapter,
        release() {
          releaseCalls += 1
          return true
        },
      }),
      prepareRuntimeCapabilitySnapshot: async () => snapshot,
      createSqliteSubagentRunPersistenceAdapter: () => Object.freeze({ id: 'signal-subagent' }),
      createCompactionArchiveAdapter: () => ({}),
      createCompactionArchivePortController: () => ({}),
      createManagedAttachmentRuntimeAdapter: () => ({}),
      createManagedAttachmentRuntimePortController: () => ({}),
      createHeadlessLifecycleCapabilities: () => [],
      createLifecycleRuntime: () => ({
        start: () => ({ ready: Promise.resolve({ failures: [] }) }),
        stop: async () => {
          stopCalls += 1
          return { exitCode: 0 }
        },
      }),
      configureWorkspace: (value) => value,
      bootstrapAuth: async () => ({ authenticated: true, mode: 'local', user: { id: userId } }),
      idFactory: (() => {
        const ids = [turnId, sessionId]
        return () => ids.shift()
      })(),
      subscribeEvents: (_scope, callback) => {
        subscriber = callback
        return () => {
          unsubscribeCalls += 1
          subscriber = () => {}
        }
      },
      listEvents: ({ after }) => events.filter((event) => event.sequence > after),
      engine,
    }
    const shutdown = createRunShutdownController({
      target: signalTarget,
      diagnostics: process.stderr,
      timeoutMs: 5_000,
      forceExit: (exitCode) => { process.exitCode = exitCode },
    })
    let runExitCode
    try {
      runExitCode = await cmdRun(['blocking signal turn', '--mode', 'plan'], {
        signal: shutdown.signal,
        runTurn: (options) => runBuiltinHeadlessTurn({
          ...options,
          runtimeEnv: { GUGO_LOAD_DOTENV: '0' },
          turnPersistenceAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
        }, dependencies),
      })
    } finally {
      shutdown.dispose()
    }

    assert.equal(runExitCode, 1)
    assert.equal(shutdown.exitCode, 143)
    assert.equal(cancelCalls, 1)
    assert.deepEqual(cancelledScope, { userId, sessionId, turnId, authMode: 'local' })
    assert.equal(stopCalls, 1)
    assert.equal(releaseCalls, 1)
    assert.equal(unsubscribeCalls, 1)
    assert.equal(signalTarget.listenerCount('SIGINT'), 0)
    assert.equal(signalTarget.listenerCount('SIGTERM'), 0)
    assert.deepEqual(
      events.filter((event) => event.type.startsWith('turn.')
        && ['turn.completed', 'turn.failed', 'turn.blocked', 'turn.cancelled'].includes(event.type))
        .map((event) => event.type),
      ['turn.cancelled'],
    )
    process.exitCode = shutdown.exitCode
  `

  try {
    const result = await runModuleScript(script, {
      env: {
        APP_DATA_DIR: dataDir,
        APP_DB_PATH: path.join(dataDir, 'app.db'),
        AUTH_MODE: 'local',
        GUGO_LOAD_DOTENV: '0',
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
    })
    assert.equal(result.signal, null)
    assert.equal(result.status, 143, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.match(result.stderr, /Received SIGTERM; cancelling the active turn/u)
    const events = parseJsonLines(result.stdout)
    assert.deepEqual(
      events.filter((event) => event.type.startsWith('turn.')
        && ['turn.completed', 'turn.failed', 'turn.blocked', 'turn.cancelled'].includes(event.type))
        .map((event) => event.type),
      ['turn.cancelled'],
    )
    assert.equal(events.some((event) => event.type === 'cli.error'), false)
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
