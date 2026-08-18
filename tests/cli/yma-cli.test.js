import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import assert from 'node:assert/strict'
import { cmdRun, parseRunArgs } from '../../bin/yma-cli.js'
import { runHeadlessTurn } from '../../server/services/headlessTurnRuntime.js'

const CLI = join(process.cwd(), 'bin', 'yma-cli.js')

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
