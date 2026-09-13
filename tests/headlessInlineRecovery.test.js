import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { existsSync } from 'node:fs'
import test from 'node:test'

process.env.GUGO_LOAD_DOTENV = '0'
const initialCwd = process.cwd()
process.chdir(process.env.APP_DATA_DIR)
const { runHeadlessTurn } = await import('../server/services/headlessTurnRuntime.js')
test.after(() => process.chdir(initialCwd))

const scope = { userId: 'inline-user', sessionId: 'inline-session', turnId: 'inline-turn' }
const directory = path.join(process.env.APP_DATA_DIR, 'directory')
const directoryPayload = { clarification: { request_type: 'directory', access_mode: 'read_only', suggested_path: directory, purpose: 'Read the fixture' } }
const unknownPayload = { code: 'SIDE_EFFECT_OUTCOME_UNKNOWN', recoveryKind: 'side_effect_outcome_unknown', requiresUserVerification: true, toolCallId: 'uncertain-write' }
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fakeRuntime({ type = 'turn.paused', payload = directoryPayload, remote = false, cancelGate = null } = {}) {
  const events = []
  const resumes = []
  let listener = () => {}
  let execution = Promise.resolve()
  let waits = 0
  let recoveries = 0
  const emit = (eventType, eventPayload = {}) => {
    const event = { ...scope, id: `inline-${events.length}`, sequence: events.length, type: eventType, payload: eventPayload, createdAt: events.length + 1 }
    events.push(event)
    listener(event)
    return event
  }
  const engine = {
    async startTurn(input) {
      assert.equal(input.turnId, scope.turnId)
      emit('turn.started')
      execution = Promise.resolve().then(() => emit(type, payload))
    },
    waitForTurn: () => execution,
    async resumeTurn(input) {
      resumes.push(input)
      emit('turn.resumed')
      execution = remote ? Promise.resolve() : Promise.resolve().then(() => emit('turn.completed', { text: 'continued in the same CLI' }))
      return { status: 'running' }
    },
    async recoverTurn() {
      recoveries += 1
      return { turn: { status: 'running' }, terminal: false, paused: false, locallyActive: !remote }
    },
    async cancelTurn() {
      if (cancelGate) await cancelGate.promise
      emit('turn.cancelled', { text: 'cancelled during confirmation' })
    },
  }
  const ports = {
    canonicalizeDirectory: ({ path: value }) => value,
    grantDirectory: () => ({ id: 'session:inline-directory', resourceType: 'directory', path: directory, accessMode: 'read_only', scope: 'session' }),
  }
  return { events, resumes, ports, emit, recoveries: () => recoveries, dependencies: {
    engine, configureWorkspace: () => process.env.APP_DATA_DIR,
    bootstrapAuth: async () => ({ authenticated: true, mode: 'local', user: { id: scope.userId } }),
    idFactory: (() => { const ids = [scope.turnId, scope.sessionId]; return () => ids.shift() })(),
    persistenceAdapter: { id: 'test.async-inline', eventLog: {} }, interactionPorts: ports,
    subscribeEvents: (_scope, deliver) => { listener = deliver; return () => { listener = () => {} } },
    listEvents: async ({ after }) => events.filter((event) => event.sequence > after),
    wait: async () => { waits += 1; if (remote && waits === 2) emit('turn.completed', { text: 'remote owner completed' }) },
  } }
}

test('interactive directory grant resumes the exact pause in the original CLI turn', async () => {
  const runtime = fakeRuntime()
  const result = await runHeadlessTurn({ prompt: 'read another directory', interactive: true,
    onDirectoryRequest: async () => ({ approved: true, path: directory, accessMode: 'read_only' }),
  }, runtime.dependencies)
  assert.equal(result.exitCode, 0)
  assert.equal(runtime.resumes.length, 1)
  const resumed = runtime.resumes[0]
  assert.equal(resumed.turnId, scope.turnId)
  assert.equal(resumed.sessionId, scope.sessionId)
  assert.equal(resumed.approvalMode, undefined)
  assert.equal(resumed.resolution.paused_sequence, 1)
  assert.equal(resumed.resolution.grant_id, 'session:inline-directory')
})

test('--resume displays an existing directory pause before invoking the engine continuation', async () => {
  const runtime = fakeRuntime()
  runtime.emit('turn.started')
  runtime.emit('turn.paused', directoryPayload)
  const resume = runtime.dependencies.engine.resumeTurn
  runtime.dependencies.engine.resumeTurn = (input) => {
    assert.equal(input.resolution?.type, 'directory_authorization', 'must not first resume without consent')
    return resume(input)
  }
  const result = await runHeadlessTurn({ resumeTurnId: scope.turnId, sessionId: scope.sessionId, interactive: true,
    onDirectoryRequest: async () => ({ approved: true, path: directory, accessMode: 'read_only' }),
  }, runtime.dependencies)
  assert.equal(result.exitCode, 0)
  assert.equal(runtime.resumes.length, 1)
})

test('--resume never clears or retries a pending unknown operation before the current confirmation', async () => {
  const runtime = fakeRuntime()
  runtime.emit('turn.started')
  runtime.emit('turn.blocked', unknownPayload)
  runtime.dependencies.engine.resumeTurn = () => assert.fail('deferring must not schedule recovery')
  runtime.ports.readUnknownSideEffect = () => ({ scopeKind: 'turn',
    scopeKey: JSON.stringify(['turn', scope.sessionId, scope.turnId]), ...scope,
    toolCallId: 'uncertain-write', status: 'unknown', argsDigest: 'd'.repeat(64),
  })
  runtime.ports.resolveUnknownSideEffect = () => assert.fail('deferring must not write a confirmation')
  let prompts = 0
  const result = await runHeadlessTurn({ resumeTurnId: scope.turnId, sessionId: scope.sessionId, interactive: true,
    onSideEffectRecovery: async () => { prompts += 1; return { resolution: 'defer' } },
  }, runtime.dependencies)
  assert.equal(result.status, 'blocked')
  assert.equal(prompts, 1)
  assert.equal(runtime.events.length, 2)
})

test('--resume does not mistake a historical interrupted event for a remote-owner outcome', async () => {
  const runtime = fakeRuntime({ remote: true })
  runtime.emit('turn.started')
  runtime.emit('turn.interrupted')
  runtime.dependencies.engine.resumeTurn = async () => ({ status: 'running' })
  const result = await runHeadlessTurn({ resumeTurnId: scope.turnId, sessionId: scope.sessionId }, runtime.dependencies)
  assert.equal(result.status, 'completed')
  assert.ok(runtime.recoveries() >= 1)
})

test('noninteractive directory pause returns structured failure without granting or prompting', async () => {
  const runtime = fakeRuntime()
  runtime.ports.grantDirectory = () => assert.fail('no grant without interactive consent')
  const result = await runHeadlessTurn({ prompt: 'read directory', interactive: false,
    onDirectoryRequest: () => assert.fail('noninteractive must not prompt'),
  }, runtime.dependencies)
  assert.equal(result.exitCode, 1)
  assert.equal(result.status, 'paused')
  assert.deepEqual(runtime.resumes, [])
})

test('custom async adapter without recovery ports never falls back to the process SQLite store', async () => {
  const runtime = fakeRuntime()
  delete runtime.dependencies.interactionPorts
  const existedBefore = existsSync(process.env.APP_DB_PATH)
  await assert.rejects(runHeadlessTurn({ prompt: 'read directory', interactive: true,
    onDirectoryRequest: () => assert.fail('unsupported capability must be detected first'),
  }, runtime.dependencies), (error) => error.code === 'CLI_INTERACTIVE_RECOVERY_UNSUPPORTED')
  assert.equal(existsSync(process.env.APP_DB_PATH), existedBefore)
  assert.equal(runtime.resumes.length, 0)
})

test('prompt-period cancellation is committed and delivered before the CLI returns or closes', async () => {
  const cancelGate = deferred()
  const promptEntered = deferred()
  const abort = new AbortController()
  const runtime = fakeRuntime({ cancelGate })
  const delivered = []
  let settled = false
  const run = runHeadlessTurn({ prompt: 'read directory', interactive: true, signal: abort.signal,
    onEvent: (event) => delivered.push(event.type),
    onDirectoryRequest: async () => { abort.abort(); promptEntered.resolve(); return { approved: false } },
  }, runtime.dependencies).then((result) => { settled = true; return result })
  await promptEntered.promise
  await Promise.resolve()
  assert.equal(settled, false, 'must await the outstanding cancellation write')
  cancelGate.resolve()
  const result = await run
  assert.equal(result.status, 'cancelled')
  assert.equal(result.exitCode, 1)
  assert.equal(delivered.at(-1), 'turn.cancelled')
  assert.equal(runtime.resumes.length, 0)
})

test('a remote owner acquired during an interactive fresh-turn resume is polled, not treated as missing', async () => {
  const runtime = fakeRuntime({ remote: true })
  const result = await runHeadlessTurn({ prompt: 'read directory', interactive: true,
    onDirectoryRequest: async () => ({ approved: true, path: directory, accessMode: 'read_only' }),
  }, runtime.dependencies)
  assert.equal(result.exitCode, 0)
  assert.ok(runtime.recoveries() >= 1)
  assert.equal(runtime.resumes.length, 1)
})

test('verified unknown outcome uses a separate exact recovery port and resumes the same turn in bypass', async () => {
  for (const resolution of ['committed', 'failed']) {
    const runtime = fakeRuntime({ type: 'turn.blocked', payload: unknownPayload })
    const record = { scopeKind: 'turn', scopeKey: JSON.stringify(['turn', scope.sessionId, scope.turnId]),
      sessionId: scope.sessionId, turnId: scope.turnId, toolCallId: 'uncertain-write', toolName: 'write_file',
      status: 'unknown', argsDigest: 'c'.repeat(64), evidence: {} }
    let resolved
    runtime.ports.readUnknownSideEffect = async () => record
    runtime.ports.resolveUnknownSideEffect = async (value) => {
      resolved = value
      return { record: { ...record, status: resolution }, resume: { kind: 'turn', sessionId: scope.sessionId, turnId: scope.turnId, toolCallId: record.toolCallId } }
    }
    const result = await runHeadlessTurn({ prompt: 'perform operation', mode: 'bypass', interactive: true,
      onApproval: () => assert.fail('ordinary approval must not handle an unknown outcome'),
      onSideEffectRecovery: async () => ({ resolution, verificationConfirmed: true, confirmToolCallId: record.toolCallId }),
    }, runtime.dependencies)
    assert.equal(result.exitCode, 0)
    assert.equal(resolved.userId, scope.userId)
    assert.equal(resolved.argsDigest, record.argsDigest)
    assert.equal(resolved.boundary.sequence, 1)
    assert.equal(runtime.resumes[0].retryRecovery, true)
    assert.equal(runtime.resumes[0].turnId, scope.turnId)
  }
})
