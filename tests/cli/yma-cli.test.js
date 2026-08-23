import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { cmdRun, parseRunArgs } from '../../bin/yma-cli.js'
import { runHeadlessTurn } from '../../server/services/headlessTurnRuntime.js'

const CLI = join(process.cwd(), 'bin', 'yma-cli.js')

function runCliProcess(args, {
  input = '',
  env = {},
  timeoutMs = 30_000,
  cwd = process.cwd(),
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`CLI timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (status, signal) => {
      clearTimeout(timeout)
      resolve({ status, signal, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

function parseJsonLines(output) {
  return String(output || '')
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve))
}

function cliE2eEnv({ dataDir, modelPort, homeDir }) {
  return {
    APP_DATA_DIR: dataDir,
    APP_DB_PATH: join(dataDir, 'app.db'),
    AUTH_MODE: 'local',
    SERVER_HOST: '127.0.0.1',
    MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
    MODEL_NAME: 'gpt-cli-e2e',
    MODEL_API_KEY: 'sk-cli-e2e',
    MODEL_PROVIDERS: '',
    TURN_EXECUTION_LEASE_MS: '1000',
    HOME: homeDir,
    USERPROFILE: homeDir,
  }
}

function seedCliProvider({ env, baseUrl, modelName }) {
  const authModuleUrl = pathToFileURL(join(
    process.cwd(),
    'server',
    'adapters',
    'authAccount.js',
  )).href
  const providerStoreModuleUrl = pathToFileURL(join(
    process.cwd(),
    'server',
    'services',
    'modelProviderStore.js',
  )).href
  const dbModuleUrl = pathToFileURL(join(process.cwd(), 'server', 'db.js')).href
  const script = `
    const { bootstrapAuth } = await import(${JSON.stringify(authModuleUrl)})
    const { upsertModelProvider, recordModelProviderReadiness } = await import(${JSON.stringify(providerStoreModuleUrl)})
    const { closeDb } = await import(${JSON.stringify(dbModuleUrl)})
    try {
      const auth = bootstrapAuth({ env: process.env })
      const modelName = process.env.GUGO_TEST_PROVIDER_MODEL
      const provider = upsertModelProvider({
        userId: auth.user.id,
        provider: {
          key: 'cli-persisted-provider',
          label: 'CLI persisted Provider',
          baseUrl: process.env.GUGO_TEST_PROVIDER_BASE_URL,
          apiKey: '',
          models: [modelName],
          defaultModel: modelName,
          enabled: true,
          isDefault: true,
        },
      })
      recordModelProviderReadiness({
        userId: auth.user.id,
        id: provider.id,
        modelName,
        expectedConfigRevision: provider.configRevision,
        readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
      })
      process.stdout.write(provider.id)
    } finally {
      closeDb()
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      GUGO_TEST_PROVIDER_BASE_URL: baseUrl,
      GUGO_TEST_PROVIDER_MODEL: modelName,
    },
  })
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return result.stdout.trim()
}

function sendModelCompletion(res, content) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    id: 'chatcmpl-cli-e2e',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  }))
}

function run(args, env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'yma-cli-test-'))
  try {
    return {
      ...spawnSync('node', [CLI, ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
      }),
      home,
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('--help prints usage and exits 0', () => {
  const r = run(['--help'])
  assert.equal(r.status, 0)
  assert.ok(r.stdout.length > 0)
  assert.match(r.stdout, /yma-cli/)
  assert.match(r.stdout, /session list/)
  assert.match(r.stdout, /agent list/)
  assert.match(r.stdout, /skill list/)
  assert.match(r.stdout, /gugo run/)
})

test('no args prints help', () => {
  const r = run([])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Usage:/)
})

test('session list without token exits non-zero with login hint', () => {
  const r = run(['session', 'list'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /login/i)
})

test('agent list without token exits non-zero', () => {
  const r = run(['agent', 'list'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /login/i)
})

test('unknown command exits non-zero', () => {
  const r = run(['nope'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /Unknown command/)
})

test('login without --email exits non-zero', () => {
  const r = run(['login'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /email/i)
})

test('run parser supports prompt, model, Provider, mode, cwd, session and resume', () => {
  const parsed = parseRunArgs([
    'inspect', 'this', '--model', 'local-model', '--provider', 'provider-1', '--mode=acceptEdits',
    '--cwd', '.', '--session-id', 'session-1',
  ])
  assert.equal(parsed.prompt, 'inspect this')
  assert.equal(parsed.model, 'local-model')
  assert.equal(parsed.modelProviderId, 'provider-1')
  assert.equal(parsed.mode, 'acceptEdits')
  assert.equal(parsed.sessionId, 'session-1')
  assert.equal(parseRunArgs(['plain prompt']).mode, 'normal')
  assert.throws(() => parseRunArgs(['prompt', '--resume', 'turn-1']), /cannot be combined/)
  const resumed = parseRunArgs(['--resume', 'turn-1'])
  assert.equal(resumed.resumeTurnId, 'turn-1')
  assert.equal(resumed.mode, null)
  assert.throws(
    () => parseRunArgs(['prompt', '--mode', 'unsafe']),
    (error) => error?.code === 'CLI_MODE_INVALID' && error?.exitCode === 2,
  )
  assert.throws(
    () => parseRunArgs(['--resume', 'turn-1', '--mode', 'bypass']),
    (error) => error?.code === 'CLI_RESUME_MODE_CONFLICT' && error?.exitCode === 2,
  )
  assert.throws(
    () => parseRunArgs(['--resume', 'turn-1', '--provider', 'provider-1']),
    (error) => error?.code === 'CLI_RESUME_PROVIDER_CONFLICT' && error?.exitCode === 2,
  )
  assert.throws(
    () => parseRunArgs(['--resume', 'turn-1', '--model', 'local-model']),
    (error) => error?.code === 'CLI_RESUME_MODEL_CONFLICT' && error?.exitCode === 2,
  )
})

test('run parser rejects blank model selections and duplicate single-value options', () => {
  for (const option of ['model', 'provider']) {
    assert.throws(
      () => parseRunArgs(['prompt', `--${option}`, '   ']),
      (error) => error?.code === 'CLI_OPTION_VALUE_REQUIRED' && error?.exitCode === 2,
    )
  }

  const duplicateOptions = [
    ['model', 'model-a', 'model-b'],
    ['provider', 'provider-a', 'provider-b'],
    ['mode', 'normal', 'plan'],
    ['cwd', '.', '..'],
    ['session-id', 'session-a', 'session-b'],
    ['resume', 'turn-a', 'turn-b'],
  ]
  for (const [option, first, second] of duplicateOptions) {
    assert.throws(
      () => parseRunArgs([`--${option}`, first, `--${option}=${second}`]),
      (error) => error?.code === 'CLI_OPTION_DUPLICATE' && error?.exitCode === 2,
    )
  }
})

test('run reads a piped prompt and keeps stdout JSONL-only', async () => {
  const stdin = Readable.from(['prompt ', 'from pipe\n'])
  const stdoutChunks = []
  const stderrChunks = []
  const stdout = new Writable({ write(chunk, _encoding, done) { stdoutChunks.push(String(chunk)); done() } })
  const stderr = new Writable({ write(chunk, _encoding, done) { stderrChunks.push(String(chunk)); done() } })
  let request
  const exitCode = await cmdRun(['--mode', 'plan'], {
    stdin,
    stdout,
    stderr,
    runTurn: async (options) => {
      request = options
      options.onEvent({ type: 'turn.completed', sequence: 1, payload: { text: 'done' } })
      return { exitCode: 0 }
    },
  })
  assert.equal(exitCode, 0)
  assert.equal(request.prompt, 'prompt from pipe')
  assert.equal(request.mode, 'plan')
  assert.equal(request.interactive, false)
  assert.equal(stderrChunks.join(''), '')
  assert.deepEqual(JSON.parse(stdoutChunks.join('').trim()), {
    type: 'turn.completed', sequence: 1, payload: { text: 'done' },
  })
})

test('run --cwd cannot relocate runtime capability bindings into the workspace', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'gugo-cli-runtime-root-'))
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'gugo-cli-workspace-root-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-workspace-home-'))
  const hostileConfig = JSON.stringify({
    env: {},
    capabilityBindings: { loop: 'workspace.missing-loop' },
  })
  const env = {
    APP_DATA_DIR: join(runtimeRoot, 'runtime-data'),
    APP_DB_PATH: join(runtimeRoot, 'runtime-data', 'app.db'),
    AUTH_MODE: 'local',
    GUGO_LOAD_DOTENV: '0',
    HOME: homeDir,
    USERPROFILE: homeDir,
  }
  try {
    mkdirSync(join(workspaceRoot, '.gugo'), { recursive: true })
    writeFileSync(join(workspaceRoot, '.gugo', 'runtime.json'), hostileConfig, 'utf8')

    const workspaceAttempt = await runCliProcess([
      'run', 'verify workspace isolation', '--cwd', workspaceRoot,
    ], { cwd: runtimeRoot, env, timeoutMs: 60_000 })
    assert.notEqual(workspaceAttempt.status, 0)
    assert.doesNotMatch(workspaceAttempt.stdout, /RUNTIME_CAPABILITY_BINDING_MISSING/)
    assert.doesNotMatch(workspaceAttempt.stderr, /workspace\.missing-loop/)

    mkdirSync(join(runtimeRoot, '.gugo'), { recursive: true })
    writeFileSync(join(runtimeRoot, '.gugo', 'runtime.json'), hostileConfig, 'utf8')
    const runtimeAttempt = await runCliProcess([
      'run', 'verify runtime binding', '--cwd', workspaceRoot,
    ], { cwd: runtimeRoot, env, timeoutMs: 60_000 })
    assert.equal(runtimeAttempt.status, 1)
    const runtimeError = parseJsonLines(runtimeAttempt.stdout)
      .find((event) => event.type === 'cli.error')
    assert.equal(runtimeError?.error?.code, 'RUNTIME_CAPABILITY_BINDING_MISSING')
    assert.match(runtimeError?.error?.message || '', /workspace\.missing-loop/)
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('real CLI never executes a persistence module selected by project dotenv', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'gugo-cli-dotenv-untrusted-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-dotenv-home-'))
  const dataDir = join(runtimeRoot, 'runtime-data')
  const markerPath = join(runtimeRoot, 'persistence-module-executed')
  try {
    mkdirSync(join(runtimeRoot, '.gugo'), { recursive: true })
    writeFileSync(
      join(runtimeRoot, 'untrusted-persistence.mjs'),
      `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(markerPath)}, 'executed')\nexport default {}\n`,
      'utf8',
    )
    writeFileSync(
      join(runtimeRoot, '.env'),
      'GUGO_TURN_PERSISTENCE_MODULE=untrusted-persistence.mjs\n',
      'utf8',
    )
    writeFileSync(join(runtimeRoot, '.gugo', 'runtime.json'), JSON.stringify({
      env: {},
      capabilityBindings: { loop: 'runtime.missing-loop' },
    }), 'utf8')

    const result = await runCliProcess(['run', 'verify dotenv isolation'], {
      cwd: runtimeRoot,
      env: {
        APP_DATA_DIR: dataDir,
        APP_DB_PATH: join(dataDir, 'app.db'),
        AUTH_MODE: 'local',
        GUGO_LOAD_DOTENV: '1',
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
      timeoutMs: 60_000,
    })

    assert.equal(result.status, 1)
    const cliError = parseJsonLines(result.stdout).find((event) => event.type === 'cli.error')
    assert.equal(cliError?.error?.code, 'RUNTIME_CAPABILITY_BINDING_MISSING')
    assert.equal(existsSync(markerPath), false)
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('bundled SQLite persistence authorizes the CLI resume lookup', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'gugo-cli-builtin-persistence-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-builtin-persistence-home-'))
  const dataDir = join(runtimeRoot, 'runtime-data')
  try {
    const result = await runCliProcess(['run', '--resume', 'missing-turn'], {
      cwd: runtimeRoot,
      env: {
        APP_DATA_DIR: dataDir,
        APP_DB_PATH: join(dataDir, 'app.db'),
        AUTH_MODE: 'local',
        GUGO_LOAD_DOTENV: '0',
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
      timeoutMs: 60_000,
    })

    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    const cliError = parseJsonLines(result.stdout).find((event) => event.type === 'cli.error')
    assert.equal(cliError?.error?.code, 'TURN_NOT_FOUND')
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('trusted module re-exporting the built-in adapter keeps its own resume lookup capability', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'gugo-cli-custom-persistence-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-custom-persistence-home-'))
  const dataDir = join(runtimeRoot, 'runtime-data')
  const modulePath = join(runtimeRoot, 'custom-persistence.mjs')
  const sqliteAdapterUrl = new URL(
    '../../server/adapters/sqliteTurnPersistenceAdapter.js',
    import.meta.url,
  ).href
  try {
    writeFileSync(
      modulePath,
      `export { SQLITE_TURN_PERSISTENCE_ADAPTER as turnPersistenceAdapter } from ${JSON.stringify(sqliteAdapterUrl)}\n`,
      'utf8',
    )

    const result = await runCliProcess(['run', '--resume', 'missing-turn'], {
      cwd: runtimeRoot,
      env: {
        APP_DATA_DIR: dataDir,
        APP_DB_PATH: join(dataDir, 'app.db'),
        AUTH_MODE: 'local',
        GUGO_LOAD_DOTENV: '0',
        GUGO_TURN_PERSISTENCE_MODULE: modulePath,
        GUGO_TURN_PERSISTENCE_TRUST_ROOT: runtimeRoot,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
      timeoutMs: 60_000,
    })

    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    const cliError = parseJsonLines(result.stdout).find((event) => event.type === 'cli.error')
    assert.equal(cliError?.error?.code, 'TURN_NOT_FOUND')
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('real CLI subprocess pipes stdin through TurnEngine and emits JSONL', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gugo-cli-e2e-data-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-e2e-home-'))
  const requestBodies = []
  const modelServer = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requestBodies.push(JSON.parse(body))
      sendModelCompletion(res, 'real pipe completed')
    })
  })
  const modelPort = await listen(modelServer)

  try {
    const result = await runCliProcess(['run', '--mode', 'plan'], {
      input: 'real prompt from stdin\n',
      env: cliE2eEnv({ dataDir, modelPort, homeDir }),
    })
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    const events = parseJsonLines(result.stdout)
    assert.ok(events.some((event) => event.type === 'turn.started'))
    const completed = events.find((event) => event.type === 'turn.completed')
    assert.equal(completed?.payload?.text, 'real pipe completed')
    assert.equal(events.some((event) => event.type === 'cli.error'), false)
    assert.ok(requestBodies.length >= 1)
    assert.ok(requestBodies.some((body) => /real prompt from stdin/.test(JSON.stringify(body.messages))))
  } finally {
    await closeServer(modelServer)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('real CLI persists the selected Provider UUID in turn.started', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gugo-cli-provider-e2e-data-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-provider-e2e-home-'))
  const modelName = 'gpt-cli-provider-e2e'
  const modelServer = createServer((req, res) => {
    req.resume()
    req.on('end', () => sendModelCompletion(res, 'persisted Provider completed'))
  })
  const modelPort = await listen(modelServer)
  const env = {
    ...cliE2eEnv({ dataDir, modelPort, homeDir }),
    GUGO_LOAD_DOTENV: '0',
    MODEL_BASE_URL: '',
    MODEL_NAME: '',
    MODEL_API_KEY: '',
    MODEL_PROVIDERS: '',
  }

  try {
    const providerId = seedCliProvider({
      env,
      baseUrl: `http://127.0.0.1:${modelPort}/v1`,
      modelName,
    })
    const result = await runCliProcess([
      'run',
      'use the persisted Provider UUID',
      '--mode',
      'plan',
      '--provider',
      providerId,
      '--model',
      modelName,
    ], { env })
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    const events = parseJsonLines(result.stdout)
    const started = events.find((event) => event.type === 'turn.started')
    assert.equal(started?.payload?.modelProviderId, providerId)
    assert.equal(started?.payload?.modelName, modelName)
    assert.equal(
      events.find((event) => event.type === 'turn.completed')?.payload?.text,
      'persisted Provider completed',
    )
  } finally {
    await closeServer(modelServer)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('real CLI subprocess preserves outcome-unknown safety after a durable in-flight checkpoint', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gugo-cli-resume-data-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-resume-home-'))
  let modelRequests = 0
  let allowCompletion = false
  let notifyModelRequestStarted = null
  const modelServer = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      modelRequests += 1
      notifyModelRequestStarted?.()
      if (!allowCompletion) return
      sendModelCompletion(res, 'resumed from checkpoint')
    })
  })
  const modelPort = await listen(modelServer)
  const env = cliE2eEnv({ dataDir, modelPort, homeDir })
  let firstChild = null

  try {
    firstChild = spawn(process.execPath, [
      CLI,
      'run',
      '--mode',
      'plan',
      'create durable interruption',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    firstChild.stdin.end()
    firstChild.stdout.setEncoding('utf8')
    firstChild.stderr.setEncoding('utf8')
    let firstStdout = ''
    let firstStderr = ''
    let stdoutBuffer = ''
    const firstExit = new Promise((resolve, reject) => {
      firstChild.once('error', reject)
      firstChild.once('close', (status, signal) => resolve({ status, signal }))
    })
    const checkpoint = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`checkpoint event timed out\nstdout:\n${firstStdout}\nstderr:\n${firstStderr}`))
      }, 15_000)
      firstChild.stderr.on('data', (chunk) => { firstStderr += chunk })
      firstChild.stdout.on('data', (chunk) => {
        firstStdout += chunk
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split(/\r?\n/u)
        stdoutBuffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line)
          if (event.type === 'turn.checkpoint') {
            clearTimeout(timeout)
            resolve(event)
            return
          }
        }
      })
      firstChild.once('close', (status, signal) => {
        clearTimeout(timeout)
        reject(new Error(`CLI exited before checkpoint (${status ?? signal})\n${firstStdout}\n${firstStderr}`))
      })
    })

    // A turn can write checkpoints before it crosses the Provider side-effect
    // boundary. Killing on the first generic checkpoint makes this test race
    // between a legitimately replayable not-sent request and an in-flight one.
    // Wait until the Provider has received the request; the runtime guarantees
    // that its in-flight checkpoint is durable before this can happen.
    await new Promise((resolve, reject) => {
      if (modelRequests >= 1) {
        resolve()
        return
      }
      const timeout = setTimeout(() => {
        notifyModelRequestStarted = null
        reject(new Error(`model request timed out after checkpoint\nstdout:\n${firstStdout}\nstderr:\n${firstStderr}`))
      }, 15_000)
      notifyModelRequestStarted = () => {
        clearTimeout(timeout)
        notifyModelRequestStarted = null
        resolve()
      }
    })

    assert.equal(firstChild.kill('SIGKILL'), true)
    const killed = await firstExit
    assert.notEqual(killed.status, 0)
    assert.equal(parseJsonLines(firstStdout).some((event) => event.type.startsWith('turn.') && ['turn.completed', 'turn.failed', 'turn.blocked', 'turn.cancelled'].includes(event.type)), false)
    allowCompletion = true

    const resumedRun = await runCliProcess([
      'run', '--resume', checkpoint.turnId, '--session-id', checkpoint.sessionId,
    ], { env })
    assert.equal(resumedRun.status, 1, `stdout:\n${resumedRun.stdout}\nstderr:\n${resumedRun.stderr}`)
    const resumedEvents = parseJsonLines(resumedRun.stdout)
    assert.ok(resumedEvents.some((event) => (
      event.turnId === checkpoint.turnId
      && event.sessionId === checkpoint.sessionId
      && event.type === 'model.phase'
      && event.sequence > checkpoint.sequence
    )))
    const blocked = resumedEvents.find((event) => event.type === 'turn.blocked')
    assert.equal(blocked?.payload?.code, 'MODEL_REQUEST_OUTCOME_UNKNOWN')
    assert.equal(blocked?.payload?.requiresUserVerification, true)
    assert.equal(blocked?.payload?.recoveryKind, 'model_request_outcome_unknown')
    assert.equal(resumedEvents.some((event) => event.type === 'turn.completed'), false)
    assert.equal(modelRequests, 1, 'recovery must not issue a second provider request')
  } finally {
    if (firstChild && firstChild.exitCode === null) firstChild.kill('SIGKILL')
    await closeServer(modelServer)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('run reports runtime/model failures as stable JSONL and diagnostics', async () => {
  const stdoutChunks = []
  const stderrChunks = []
  const stdout = new Writable({ write(chunk, _encoding, done) { stdoutChunks.push(String(chunk)); done() } })
  const stderr = new Writable({ write(chunk, _encoding, done) { stderrChunks.push(String(chunk)); done() } })
  const error = Object.assign(new Error('no configured model'), {
    code: 'MODEL_CONFIG_MISSING',
    action: 'configure_model',
  })
  const exitCode = await cmdRun(['hello'], {
    stdin: Readable.from([]), stdout, stderr,
    runTurn: async () => { throw error },
  })
  assert.equal(exitCode, 1)
  assert.deepEqual(JSON.parse(stdoutChunks.join('').trim()), {
    type: 'cli.error',
    error: {
      code: 'MODEL_CONFIG_MISSING',
      message: 'no configured model',
      action: 'configure_model',
    },
  })
  assert.match(stderrChunks.join(''), /MODEL_CONFIG_MISSING/)
})

function fakeRuntime({ initialEvents = [], onStart, onRecover } = {}) {
  const events = [...initialEvents]
  let listener = () => {}
  let finish
  const completed = new Promise((resolve) => { finish = resolve })
  const emit = (type, payload = {}) => {
    const event = { id: `event-${events.length}`, sessionId: 'session-1', turnId: 'turn-1', sequence: events.length, type, payload, createdAt: events.length + 1 }
    events.push(event)
    listener(event)
    if (['turn.completed', 'turn.failed', 'turn.blocked', 'turn.cancelled', 'turn.paused', 'turn.interrupted'].includes(type)) finish()
    return event
  }
  return {
    events,
    emit,
    dependencies: {
      configureWorkspace: (value) => value,
      bootstrapAuth: async () => ({ authenticated: true, mode: 'local', user: { id: 'user-1' } }),
      idFactory: (() => { const ids = ['turn-1', 'session-1']; return () => ids.shift() })(),
      subscribeEvents: (_scope, callback) => { listener = callback; return () => { listener = () => {} } },
      listEvents: ({ after }) => events.filter((event) => event.sequence > after),
      engine: {
        startTurn: async (scope) => onStart?.(scope, emit),
        recoverTurn: async (scope) => onRecover?.(scope, emit),
        waitForTurn: async () => completed,
      },
    },
  }
}

test('headless runtime forwards each validated mode as a per-turn permission override', async () => {
  for (const mode of ['normal', 'acceptEdits', 'plan', 'bypass']) {
    let startedScope = null
    const fake = fakeRuntime({
      onStart: (scope, emit) => {
        startedScope = scope
        emit('turn.started', { approvalMode: scope.approvalMode })
        emit('turn.completed', { text: 'done' })
      },
    })
    const result = await runHeadlessTurn({ prompt: 'run safely', mode }, fake.dependencies)
    assert.equal(result.status, 'completed')
    assert.equal(startedScope.approvalMode, mode)
    assert.equal(startedScope.intentMode, mode === 'plan' ? 'answer' : 'auto')
  }
})

test('headless runtime binds a new turn to the explicitly selected model Provider', async () => {
  let startedScope = null
  const fake = fakeRuntime({
    onStart: (scope, emit) => {
      startedScope = scope
      emit('turn.started')
      emit('turn.completed', { text: 'done' })
    },
  })

  const result = await runHeadlessTurn({
    prompt: 'use the selected Provider',
    model: 'shared-model',
    modelProviderId: 'provider-1',
  }, fake.dependencies)

  assert.equal(result.status, 'completed')
  assert.equal(startedScope.modelName, 'shared-model')
  assert.equal(startedScope.modelProviderId, 'provider-1')
})

test('headless runtime fails closed for invalid or resume-time permission overrides', async () => {
  const fresh = fakeRuntime()
  await assert.rejects(
    runHeadlessTurn({ prompt: 'do not run', mode: 'unsafe' }, fresh.dependencies),
    (error) => error?.code === 'CLI_MODE_INVALID' && error?.exitCode === 2,
  )

  let recoveryCalls = 0
  const resumed = fakeRuntime({
    onRecover: () => { recoveryCalls += 1 },
  })
  await assert.rejects(
    runHeadlessTurn({ resumeTurnId: 'turn-1', mode: 'bypass' }, resumed.dependencies),
    (error) => error?.code === 'CLI_RESUME_MODE_CONFLICT' && error?.exitCode === 2,
  )
  assert.equal(recoveryCalls, 0)

  await assert.rejects(
    runHeadlessTurn({
      resumeTurnId: 'turn-1',
      modelProviderId: 'provider-1',
    }, resumed.dependencies),
    (error) => error?.code === 'CLI_RESUME_PROVIDER_CONFLICT' && error?.exitCode === 2,
  )
  assert.equal(recoveryCalls, 0)

  await assert.rejects(
    runHeadlessTurn({
      resumeTurnId: 'turn-1',
      model: 'local-model',
    }, resumed.dependencies),
    (error) => error?.code === 'CLI_RESUME_MODEL_CONFLICT' && error?.exitCode === 2,
  )
  assert.equal(recoveryCalls, 0)
})

test('headless runtime rejects blank model and Provider selections before starting a turn', async () => {
  for (const options of [
    { model: '   ' },
    { modelProviderId: '\t' },
  ]) {
    let startCalls = 0
    const fake = fakeRuntime({
      onStart: () => { startCalls += 1 },
    })
    await assert.rejects(
      runHeadlessTurn({ prompt: 'do not start', ...options }, fake.dependencies),
      (error) => error?.code === 'CLI_OPTION_VALUE_REQUIRED' && error?.exitCode === 2,
    )
    assert.equal(startCalls, 0)
  }
})

test('headless runtime denies dangerous approval without a TTY', async () => {
  let decision
  const fake = fakeRuntime({
    onStart: (_scope, emit) => {
      emit('turn.started')
      emit('approval.required', { approvalId: 'approval-1', toolName: 'bash_exec', args: { command: 'rm file' } })
    },
  })
  fake.dependencies.decideApproval = (value) => {
    decision = value.decision
    fake.emit('approval.resolved', { approvalId: value.id, proceed: false, edited: false, args: null, reason: 'denied' })
    fake.emit('turn.completed', { text: 'dangerous operation denied' })
  }
  fake.dependencies.releaseApproval = () => {}
  const result = await runHeadlessTurn({
    prompt: 'dangerous task', interactive: false,
    onApproval: async () => ({ decision: 'approve' }),
  }, fake.dependencies)
  assert.equal(decision, 'deny')
  assert.equal(result.exitCode, 0)
})

test('headless runtime resolves session and recovers an interrupted turn', async () => {
  const initialEvents = [
    { id: 'event-0', sessionId: 'session-1', turnId: 'turn-1', sequence: 0, type: 'turn.started', payload: {}, createdAt: 1 },
    { id: 'event-1', sessionId: 'session-1', turnId: 'turn-1', sequence: 1, type: 'turn.interrupted', payload: {}, createdAt: 2 },
  ]
  let recovered
  const fake = fakeRuntime({
    initialEvents,
    onRecover: (scope, emit) => {
      recovered = scope
      emit('turn.resumed')
      emit('turn.completed', { text: 'resumed' })
    },
  })
  fake.dependencies.persistenceAdapter = {
    id: 'test.cli-resume',
    eventLog: {
      resolveTurnSession: async ({ userId, turnId }) => {
        assert.equal(userId, 'user-1')
        assert.equal(turnId, 'turn-1')
        return Object.freeze({ status: 'found', sessionId: 'session-1' })
      },
    },
  }
  const output = []
  const result = await runHeadlessTurn({
    resumeTurnId: 'turn-1',
    onEvent: (event) => output.push(event.type),
  }, fake.dependencies)
  assert.equal(recovered.sessionId, 'session-1')
  assert.equal(recovered.turnId, 'turn-1')
  assert.equal(result.status, 'completed')
  assert.deepEqual(output, ['turn.started', 'turn.interrupted', 'turn.resumed', 'turn.completed'])
})
