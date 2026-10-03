import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'

import { CliError } from '../../bin/cli/errors.js'
import { runInteractiveTurn } from '../../bin/cli/interactiveTurn.js'
import { startInteractiveSession } from '../../bin/cli/interactiveSession.js'

function capture() {
  const chunks = []
  const stream = new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done() } })
  return { stream, text: () => chunks.join('') }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(t, { timeoutMs = 100, signal = null } = {}) {
  const out = capture()
  const err = capture()
  const stdin = new Readable({ read() {} })
  stdin.isTTY = true
  err.stream.isTTY = true
  let controller = null
  let suspended = 0
  const state = { sessionId: 'timeout-session', mode: 'normal', cwd: process.cwd(), attachments: { take: () => [] } }
  t.after(() => { stdin.destroy(); out.stream.destroy(); err.stream.destroy() })
  return {
    out, err, stdin, state,
    controller: () => controller,
    suspended: () => suspended,
    run: (runtime) => runInteractiveTurn({
      parsed: { prompt: 'one fixture turn' }, state, runtime, stdin,
      stdout: out.stream, stderr: err.stream, env: {}, signal, timeoutMs,
      reader: { suspend() { suspended += 1 } }, setController: (next) => { controller = next },
    }),
  }
}

function assertDisposed(io, runtimeSignal) {
  assert.equal(io.controller(), null)
  for (const stream of [io.out.stream, io.err.stream]) {
    assert.equal(stream.listenerCount('error'), 0)
    assert.equal(stream.listenerCount('close'), 0)
  }
  assert.equal(getEventListeners(runtimeSignal, 'abort').length, 0)
}

for (const scenario of ['bare_success', 'conflicting_final_events', 'completed_then_cancelled', 'completed_then_deadline_error']) {
  test(`chat deadline diagnoses ${scenario} without confirming contradictory output`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const io = fixture(t)
    let runtimeSignal
    let calls = 0
    await assert.rejects(io.run(async (input) => {
      calls++
      runtimeSignal = input.signal
      const completed = { type: 'turn.completed', payload: { text: 'unconfirmed completion' } }
      if (scenario !== 'bare_success') await input.onEvent(completed)
      if (scenario === 'conflicting_final_events') await input.onEvent({ type: 'turn.failed', payload: { code: 'MODEL_REQUEST_RESULT_UNKNOWN' } })
      t.mock.timers.tick(100)
      if (scenario === 'completed_then_deadline_error') throw input.signal.reason
      return scenario === 'completed_then_cancelled' ? { status: 'cancelled', exitCode: 1 }
        : { status: 'completed', exitCode: 0, ...(scenario === 'conflicting_final_events' ? { lastEvent: completed } : {}) }
    }), { code: scenario === 'bare_success' ? 'CLI_RUN_TERMINAL_MISSING' : 'CLI_RUN_OUTCOME_CONFLICT' })
    assert.equal(calls, 1)
    assert.equal(io.out.text(), '')
    assert.doesNotMatch(io.err.text(), /preserving|\[turn timed out\]/u)
    assertDisposed(io, runtimeSignal)
  })
}

test('chat keeps a known unknown-result terminal over a later cooperative deadline exception', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const io = fixture(t)
  const result = await io.run(async (input) => {
    await input.onEvent({ type: 'turn.blocked', sessionId: 'persisted-session', payload: { code: 'MODEL_REQUEST_RESULT_UNKNOWN' } })
    t.mock.timers.tick(100)
    throw input.signal.reason
  })
  assert.equal(result.status, 'blocked')
  assert.equal(io.state.sessionId, 'persisted-session')
  assert.match(io.err.text(), /MODEL_REQUEST_RESULT_UNKNOWN/u)
  assert.doesNotMatch(io.err.text(), /\[turn timed out\]/u)
})

test('chat preserves a returned completed terminal without requiring its callback to be replayed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const io = fixture(t)
  const result = await io.run(async () => {
    t.mock.timers.tick(100)
    return { status: 'completed', exitCode: 0, lastEvent: { type: 'turn.completed', payload: { text: 'persisted answer' } } }
  })
  assert.equal(result.status, 'completed')
  assert.equal(io.out.text(), 'persisted answer\n')
})

test('chat does not hide an irreversible failure behind a returned paused outcome after deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const io = fixture(t)
  const result = await io.run(async (input) => {
    await input.onEvent({ type: 'turn.failed', payload: { code: 'TURN_PERSISTENCE_FAILED' } })
    t.mock.timers.tick(100)
    return { status: 'paused', exitCode: 1, lastEvent: { type: 'turn.paused', payload: { code: 'TURN_PAUSED' } } }
  })
  assert.equal(result.status, 'failed')
  assert.match(io.err.text(), /TURN_PERSISTENCE_FAILED/u)
  assert.doesNotMatch(io.err.text(), /\[turn paused/u)
})

test('chat rejects a mismatched completed session without adopting its identity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const io = fixture(t)
  await assert.rejects(io.run(async (input) => {
    await input.onEvent({ type: 'turn.completed', sessionId: 'timeout-session', payload: { text: 'wrong session result' } })
    t.mock.timers.tick(100)
    return { status: 'completed', exitCode: 0, sessionId: 'foreign-session' }
  }), { code: 'CLI_RUN_OUTCOME_CONFLICT' })
  assert.equal(io.state.sessionId, 'timeout-session')
  assert.equal(io.out.text(), '')
})

test('chat retains exact persistence and aggregate errors after observed completion without falsely confirming text', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const aggregate of [false, true]) {
    const io = fixture(t)
    let failure
    await assert.rejects(io.run(async (input) => {
      await input.onEvent({ type: 'turn.completed', payload: { text: 'must remain unconfirmed' } })
      t.mock.timers.tick(100)
      failure = aggregate
        ? new AggregateError([input.signal.reason, new Error('shutdown failed')], 'execution and cleanup failed')
        : Object.assign(new Error('persistence failed'), { code: 'TURN_PERSISTENCE_FAILED' })
      throw failure
    }), (error) => error === failure)
    assert.equal(io.out.text(), '')
    assert.doesNotMatch(io.err.text(), /preserving|\[turn timed out\]/u)
  }
})

test('chat timeout aborts a slow turn only at its deadline and waits for cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const io = fixture(t)
  const ready = deferred()
  const cleanup = deferred()
  let settled = false
  const execution = io.run(async (input) => {
    ready.resolve(input)
    await cleanup.promise
    if (input.signal.aborted) throw input.signal.reason
    return { status: 'completed', exitCode: 0 }
  }).then((result) => { settled = true; return result })
  const input = await ready.promise
  try {
    assert.equal('timeoutMs' in input, false, 'the deadline belongs to the CLI, not the model request')
    t.mock.timers.tick(99)
    assert.equal(input.signal.aborted, false)
    t.mock.timers.tick(1)
    assert.equal(input.signal.aborted, true)
    assert.equal(input.signal.reason.code, 'CLI_RUN_TIMEOUT')
    assert.equal(input.signal.reason.exitCode, 124)
    assert.equal(settled, false, 'no next turn before runtime cleanup')
    assert.match(io.err.text(), /timeout requested.*waiting for runtime cleanup/u)
    assert.doesNotMatch(io.err.text(), /turn timed out\]/u)
  } finally {
    cleanup.resolve()
    await execution
  }
  assert.match(io.err.text(), /CLI_RUN_TIMEOUT/u)
  assert.match(io.err.text(), /turn timed out/u)
  assert.doesNotMatch(io.err.text(), /\[turn cancelled\]/u)
  assert.equal(io.suspended(), 1)
  assertDisposed(io, input.signal)
})

test('a fast successful chat turn clears its timer before the next prompt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const io = fixture(t)
  let runtimeSignal
  const result = await io.run(async (input) => {
    runtimeSignal = input.signal
    await input.onEvent({ type: 'turn.completed', payload: { text: 'fixture complete' } })
    return { status: 'completed', exitCode: 0 }
  })
  t.mock.timers.tick(1000)
  assert.equal(result.status, 'completed')
  assert.equal(runtimeSignal.aborted, false, 'a finished turn cannot time out later')
  assert.match(io.out.text(), /fixture complete/u)
  assert.doesNotMatch(io.err.text(), /timeout/u)
  assertDisposed(io, runtimeSignal)
})

test('chat has no deadline when timeoutMs is unset or zero', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const timeoutMs of [undefined, 0]) {
    const io = fixture(t, { timeoutMs: timeoutMs ?? null })
    await io.run(async (input) => {
      t.mock.timers.tick(2_147_483_647)
      assert.equal(input.signal.aborted, false)
      return { status: 'completed', exitCode: 0 }
    })
    assert.doesNotMatch(io.err.text(), /timeout/u)
  }
})

test('user Ctrl-C wins over a later chat deadline and clears the timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const io = fixture(t)
  const reason = new CliError('CLI_INTERACTIVE_CANCELLED', 'cancelled by user', 130)
  let runtimeSignal
  const result = await io.run(async (input) => {
    runtimeSignal = input.signal
    io.controller().abort(reason)
    t.mock.timers.tick(100)
    throw input.signal.reason
  })
  assert.equal(result, null)
  assert.equal(runtimeSignal.reason, reason)
  assert.match(io.err.text(), /\[turn cancelled\]/u)
  assert.doesNotMatch(io.err.text(), /timeout/u)
  assertDisposed(io, runtimeSignal)
})

test('external session cancellation wins over a later deadline and is never swallowed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const parent = new AbortController()
  const io = fixture(t, { signal: parent.signal })
  const reason = new CliError('CLI_SESSION_CANCELLED', 'session stopped', 143)
  let runtimeSignal
  await assert.rejects(io.run(async (input) => {
    runtimeSignal = input.signal
    parent.abort(reason)
    t.mock.timers.tick(100)
    throw input.signal.reason
  }), (error) => error === reason)
  assert.equal(runtimeSignal.reason, reason)
  assert.doesNotMatch(io.err.text(), /timeout|\[turn cancelled\]/u)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
  assertDisposed(io, runtimeSignal)
})

test('chat timeout identifies a cooperative cancelled terminal without claiming success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const io = fixture(t)
  await io.run(async (input) => {
    t.mock.timers.tick(100)
    await input.onEvent({ type: 'turn.cancelled', payload: { text: 'partial result' } })
    return { status: 'cancelled', exitCode: 1, sessionId: 'persisted-session' }
  })
  assert.match(io.err.text(), /CLI_RUN_TIMEOUT/u)
  assert.match(io.err.text(), /turn timed out/u)
  assert.doesNotMatch(io.err.text(), /turn cancelled in/u)
  assert.doesNotMatch(io.out.text(), /partial result/u)
  assert.equal(io.state.sessionId, 'persisted-session')
})

test('a success returned after the chat deadline is preserved and announced', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const io = fixture(t)
  const result = await io.run(async (input) => {
    t.mock.timers.tick(100)
    await input.onEvent({ type: 'turn.completed', payload: { text: 'completed despite the deadline' } })
    return { status: 'completed', exitCode: 0 }
  })
  assert.equal(result.status, 'completed')
  // The runtime state machine owns terminal semantics: a finished turn is more
  // specific than the local clock, so its text stays published.
  assert.match(io.out.text(), /completed despite the deadline/u)
  assert.match(io.err.text(), /deadline elapsed; preserving the turn outcome/u)
  assert.match(io.err.text(), /turn completed in/u)
  assert.doesNotMatch(io.err.text(), /turn timed out\]/u)
})

test('chat timeout preserves unrelated, unknown-effect, persistence, and aggregate failures', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const failures = [
    new CliError('SIDE_EFFECT_UNKNOWN', 'inspect the target before resuming'),
    new CliError('TURN_PERSISTENCE_FAILED', 'terminal persistence failed'),
    new CliError('HEADLESS_RUNTIME_SHUTDOWN_FAILED', 'shutdown failed'),
    Object.assign(new Error('unrelated abort'), { name: 'AbortError' }),
    new Error('uncoded cleanup failure'),
  ]
  for (const failure of failures) {
    const io = fixture(t)
    let runtimeSignal
    await assert.rejects(io.run(async (input) => {
      runtimeSignal = input.signal
      t.mock.timers.tick(100)
      throw failure
    }), (error) => error === failure)
    assert.doesNotMatch(io.err.text(), /\[turn cancelled\]|turn timed out\]/u)
    assertDisposed(io, runtimeSignal)
  }
  const io = fixture(t)
  let failure
  await assert.rejects(io.run(async (input) => {
    t.mock.timers.tick(100)
    failure = new AggregateError([input.signal.reason, new Error('shutdown failed')], 'execution and shutdown failed')
    throw failure
  }), (error) => error === failure)
})

test('chat keeps failed, blocked, interrupted, and unknown terminals after timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const status of ['failed', 'blocked', 'interrupted', 'unknown']) {
    const io = fixture(t)
    const result = await io.run(async (input) => {
      t.mock.timers.tick(100)
      const lastEvent = { type: `turn.${status}`, payload: { code: 'SIDE_EFFECT_UNKNOWN', text: 'unconfirmed text' } }
      await input.onEvent(lastEvent)
      return { status, exitCode: 1, lastEvent }
    })
    assert.equal(result.status, status)
    assert.match(io.err.text(), new RegExp(`turn ${status} in`, 'u'))
    assert.doesNotMatch(io.err.text(), /turn timed out\]/u)
    assert.doesNotMatch(io.out.text(), /unconfirmed text/u)
    if (status !== 'unknown') assert.match(io.err.text(), /SIDE_EFFECT_UNKNOWN/u)
  }
})

test('approval, directory authorization, and side-effect recovery share the chat deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const requests = [
    ['onApproval', { payload: { toolName: 'write_file' } }, { decision: 'deny' }],
    ['onDirectoryRequest', { request: {}, workspace: process.cwd(), canonicalizeDirectory: (value) => value }, { approved: false }],
    ['onSideEffectRecovery', { record: { toolName: 'write_file', toolCallId: 'unknown-call' } }, { resolution: 'defer' }],
  ]
  for (const [port, request, expected] of requests) {
    const io = fixture(t)
    let decision
    let runtimeSignal
    const baseline = io.stdin.listenerCount('keypress')
    await io.run(async (input) => {
      runtimeSignal = input.signal
      const answer = input[port](request)
      t.mock.timers.tick(100)
      // A missing deadline must fail an assertion, not leave a pending readline
      // promise that cancels every subsequent test during the red phase.
      if (!input.signal.aborted) io.controller().abort(new Error('fixture: missing deadline'))
      decision = await answer
      throw input.signal.reason
    })
    assert.deepEqual(decision, expected)
    assert.equal(io.stdin.listenerCount('keypress'), baseline)
    assert.equal(io.stdin.listenerCount('end'), 0)
    assert.match(io.err.text(), /CLI_RUN_TIMEOUT/u)
    assertDisposed(io, runtimeSignal)
  }
})

test('chat forwards its timeout to every turn and can continue after cooperative cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const out = capture()
  const err = capture()
  const signals = []
  const prompts = []
  let cleanedUp = false
  const listenersBefore = process.listenerCount('SIGINT')
  const result = await startInteractiveSession({
    options: { sessionId: 'deadline-session', cwd: process.cwd(), timeoutMs: 100 },
    env: {}, lines: ['slow prompt', 'next prompt', '/exit'], stdout: out.stream, stderr: err.stream,
    resolveUserId: async () => 'fixture-user', readModelProviders: async () => [],
    runTurn: async (input) => {
      signals.push(input.signal)
      prompts.push(input.prompt)
      if (input.prompt === 'slow prompt') {
        t.mock.timers.tick(100)
        cleanedUp = true
        if (input.signal.aborted) throw input.signal.reason
        return { status: 'completed', exitCode: 0 }
      }
      assert.equal(cleanedUp, true)
      assert.equal(input.signal.aborted, false)
      await input.onEvent({ type: 'turn.completed', payload: { text: 'second turn succeeded' } })
      return { status: 'completed', exitCode: 0 }
    },
  })
  t.mock.timers.tick(1000)
  assert.equal(result, 0, 'an explicitly exited interactive session remains a successful CLI session')
  assert.deepEqual(prompts, ['slow prompt', 'next prompt'])
  assert.equal(signals[0].reason?.code, 'CLI_RUN_TIMEOUT')
  assert.equal(signals[1].aborted, false)
  assert.match(err.text(), /CLI_RUN_TIMEOUT/u)
  assert.match(out.text(), /second turn succeeded/u)
  assert.equal(process.listenerCount('SIGINT'), listenersBefore)
})
