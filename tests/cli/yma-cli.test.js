import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import assert from 'node:assert/strict'
import { cmdRun, parseRunArgs } from '../../bin/yma-cli.js'
import { runHeadlessTurn } from '../../server/services/headlessTurnRuntime.js'

const CLI = join(process.cwd(), 'bin', 'yma-cli.js')

function runCliProcess(args, { input = '', env = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: process.cwd(),
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

test('run parser supports prompt, model, mode, cwd, session and resume', () => {
  const parsed = parseRunArgs([
    'inspect', 'this', '--model', 'local-model', '--mode=acceptEdits',
    '--cwd', '.', '--session-id', 'session-1',
  ])
  assert.equal(parsed.prompt, 'inspect this')
  assert.equal(parsed.model, 'local-model')
  assert.equal(parsed.mode, 'acceptEdits')
  assert.equal(parsed.sessionId, 'session-1')
  assert.throws(() => parseRunArgs(['prompt', '--resume', 'turn-1']), /cannot be combined/)
  assert.equal(parseRunArgs(['--resume', 'turn-1']).resumeTurnId, 'turn-1')
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

test('real CLI subprocess resumes after the process is killed past a durable checkpoint', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gugo-cli-resume-data-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-resume-home-'))
  let modelRequests = 0
  let allowCompletion = false
  const modelServer = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      modelRequests += 1
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

    assert.equal(firstChild.kill('SIGKILL'), true)
    const killed = await firstExit
    assert.notEqual(killed.status, 0)
    assert.equal(parseJsonLines(firstStdout).some((event) => event.type.startsWith('turn.') && ['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)), false)
    allowCompletion = true

    const resumedRun = await runCliProcess([
      'run', '--resume', checkpoint.turnId, '--session-id', checkpoint.sessionId,
    ], { env })
    assert.equal(resumedRun.status, 0, `stdout:\n${resumedRun.stdout}\nstderr:\n${resumedRun.stderr}`)
    const resumedEvents = parseJsonLines(resumedRun.stdout)
    assert.ok(resumedEvents.some((event) => (
      event.turnId === checkpoint.turnId
      && event.sessionId === checkpoint.sessionId
      && event.type === 'model.phase'
      && event.sequence > checkpoint.sequence
    )))
    assert.equal(
      resumedEvents.find((event) => event.type === 'turn.completed')?.payload?.text,
      'resumed from checkpoint',
    )
    assert.ok(modelRequests >= 1)
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
  const error = Object.assign(new Error('no configured model'), { code: 'MODEL_CONFIG_MISSING' })
  const exitCode = await cmdRun(['hello'], {
    stdin: Readable.from([]), stdout, stderr,
    runTurn: async () => { throw error },
  })
  assert.equal(exitCode, 1)
  assert.deepEqual(JSON.parse(stdoutChunks.join('').trim()), {
    type: 'cli.error',
    error: { code: 'MODEL_CONFIG_MISSING', message: 'no configured model' },
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
    if (['turn.completed', 'turn.failed', 'turn.cancelled', 'turn.paused', 'turn.interrupted'].includes(type)) finish()
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
  fake.dependencies.findResumeSession = async () => 'session-1'
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
