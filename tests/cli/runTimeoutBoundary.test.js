import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import { cmdRun } from '../../bin/yma-cli.js'

const completed = (text = 'verified final answer') => ({ type: 'turn.completed', payload: { text } })
const failed = () => ({ type: 'turn.failed', payload: { code: 'MODEL_REQUEST_RESULT_UNKNOWN' } })

async function timedRun(t, format, runtime, { signal } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const stdout = capture()
  const stderr = capture()
  let calls = 0
  const code = await cmdRun(['fixture', '--timeout=100', `--output=${format}`], {
    env: {}, signal, stdin: Object.assign(Readable.from([]), { isTTY: true }), stdout: stdout.stream, stderr: stderr.stream,
    runTurn: async (input) => { calls++; return runtime(input, () => t.mock.timers.tick(100)) },
  })
  for (const stream of [stdout.stream, stderr.stream]) {
    assert.equal(stream.listenerCount('error'), 0)
    assert.equal(stream.listenerCount('close'), 0)
  }
  assert.equal(calls, 1, 'the CLI must neither retry nor invoke a model to reconcile outcomes')
  return { code, stdout: stdout.text(), stderr: stderr.text(),
    events: format === 'jsonl' ? stdout.text().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [] }
}

for (const format of ['text', 'jsonl']) {
  for (const field of ['sessionId', 'turnId']) {
    test(`run ${format} rejects an explicit result ${field} that disagrees with its completed event`, async (t) => {
      const result = await timedRun(t, format, async ({ onEvent }, expire) => {
        await onEvent({ ...completed(), sessionId: 'event-session', turnId: 'event-turn' })
        expire()
        return { status: 'completed', exitCode: 0, [field]: 'different-identity' }
      })
      assert.equal(result.code, 1)
      assert.match(result.stderr, /CLI_RUN_OUTCOME_CONFLICT/u)
      if (format === 'text') assert.equal(result.stdout, '')
      else assert.equal(result.events.at(-1).error.code, 'CLI_RUN_OUTCOME_CONFLICT')
    })
  }

  test(`run ${format} retains legacy bare-status success when no deadline is configured`, async () => {
    const stdout = capture()
    const stderr = capture()
    const code = await cmdRun(['fixture', `--output=${format}`], {
      env: {}, stdin: Object.assign(Readable.from([]), { isTTY: true }), stdout: stdout.stream, stderr: stderr.stream,
      runTurn: async () => ({ status: 'completed', exitCode: 0 }),
    })
    assert.equal(code, 0)
    assert.equal(stdout.text(), '')
    assert.equal(stderr.text(), '')
  })

  test(`run ${format} preserves complete matching success after a late deadline`, async (t) => {
    const result = await timedRun(t, format, async ({ onEvent }, expire) => {
      const lastEvent = completed()
      await onEvent(lastEvent)
      expire()
      return { status: 'completed', exitCode: 0, lastEvent }
    })
    assert.equal(result.code, 0)
    if (format === 'text') assert.equal(result.stdout, 'verified final answer\n')
    else assert.deepEqual(result.events, [completed()])
    assert.doesNotMatch(result.stderr, /Error \[CLI_RUN_TIMEOUT\]/u)
  })

  test(`run ${format} publishes a verified returned terminal once when no terminal callback was observed`, async (t) => {
    const result = await timedRun(t, format, async (_input, expire) => {
      expire()
      return { status: 'completed', exitCode: 0, lastEvent: completed() }
    })
    assert.equal(result.code, 0)
    if (format === 'text') assert.equal(result.stdout, 'verified final answer\n')
    else assert.deepEqual(result.events, [completed()])
  })

  test(`run ${format} refuses a bare completed status as proof after the deadline`, async (t) => {
    const result = await timedRun(t, format, async (_input, expire) => {
      expire()
      return { status: 'completed', exitCode: 0 }
    })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /CLI_RUN_TERMINAL_MISSING/u)
    assert.doesNotMatch(result.stderr, /preserving/u)
    if (format === 'text') assert.equal(result.stdout, '')
    else assert.equal(result.events.at(-1).error.code, 'CLI_RUN_TERMINAL_MISSING')
  })

  for (const scenario of ['conflicting_final_events', 'conflicting_emitted_final_events', 'completed_then_cancelled', 'completed_then_deadline_error']) {
    test(`run ${format} diagnoses ${scenario} instead of claiming preservation or success`, async (t) => {
      const result = await timedRun(t, format, async ({ onEvent, signal }, expire) => {
        await onEvent(scenario.startsWith('conflicting_') ? failed() : completed())
        if (scenario === 'conflicting_emitted_final_events') await onEvent(completed())
        expire()
        if (scenario === 'completed_then_deadline_error') throw signal.reason
        return scenario === 'completed_then_cancelled'
          ? { status: 'cancelled', exitCode: 1, lastEvent: { type: 'turn.cancelled', payload: {} } }
          : { status: 'completed', exitCode: 0, lastEvent: completed() }
      })
      assert.equal(result.code, 1)
      assert.match(result.stderr, /CLI_RUN_OUTCOME_CONFLICT/u)
      assert.doesNotMatch(result.stderr, /preserving/u)
      if (format === 'text') assert.equal(result.stdout, '')
      else assert.equal(result.events.at(-1).error.code, 'CLI_RUN_OUTCOME_CONFLICT')
    })
  }

  test(`run ${format} permits genuine recovery boundaries and does not confuse an interrupted observation with final failure`, async (t) => {
    const result = await timedRun(t, format, async ({ onEvent }, expire) => {
      await onEvent(failed())
      await onEvent({ type: 'turn.attempt', payload: { resetStreaming: true } })
      await onEvent({ type: 'turn.interrupted', payload: {} })
      await onEvent(completed())
      expire()
      return { status: 'completed', exitCode: 0, lastEvent: completed() }
    })
    assert.equal(result.code, 0)
    assert.doesNotMatch(result.stderr, /CLI_RUN_OUTCOME_CONFLICT/u)
    if (format === 'text') assert.equal(result.stdout, 'verified final answer\n')
  })

  test(`run ${format} retains an observed specific failure over an exact deadline rejection`, async (t) => {
    const result = await timedRun(t, format, async ({ onEvent, signal }, expire) => {
      await onEvent(failed())
      expire()
      throw signal.reason
    })
    assert.equal(result.code, 1)
    if (format === 'text') assert.match(result.stderr, /MODEL_REQUEST_RESULT_UNKNOWN/u)
    else assert.deepEqual(result.events, [failed()])
    assert.doesNotMatch(result.stderr, /Error \[CLI_RUN_TIMEOUT\]/u)
  })

  for (const status of ['blocked', 'paused']) {
    test(`run ${format} cannot replace an observed irreversible failure with returned ${status}`, async (t) => {
      const result = await timedRun(t, format, async ({ onEvent }, expire) => {
        await onEvent(failed())
        expire()
        return { status, exitCode: 1, lastEvent: { type: `turn.${status}`, payload: { code: 'LESS_SPECIFIC_STATE' } } }
      })
      assert.equal(result.code, 1)
      if (format === 'text') assert.match(result.stderr, /MODEL_REQUEST_RESULT_UNKNOWN/u)
      else assert.deepEqual(result.events, [failed()])
      assert.doesNotMatch(result.stderr, /LESS_SPECIFIC_STATE/u)
    })
  }

  for (const failureCode of ['TURN_PERSISTENCE_FAILED', 'SIDE_EFFECT_UNKNOWN', 'HEADLESS_TURN_AND_SHUTDOWN_FAILED']) {
    test(`run ${format} preserves ${failureCode} after completion instead of rewriting it as a deadline conflict`, async (t) => {
      const result = await timedRun(t, format, async ({ onEvent, signal }, expire) => {
        await onEvent(completed())
        expire()
        const failure = failureCode === 'HEADLESS_TURN_AND_SHUTDOWN_FAILED'
          ? new AggregateError([signal.reason, new Error('cleanup failed')], 'execution and cleanup failed')
          : new Error('specific runtime failure')
        throw Object.assign(failure, { code: failureCode })
      })
      assert.equal(result.code, 1)
      assert.match(result.stderr, new RegExp(failureCode, 'u'))
      assert.doesNotMatch(result.stderr, /CLI_RUN_OUTCOME_CONFLICT|Error \[CLI_RUN_TIMEOUT\]/u)
      if (format === 'text') assert.equal(result.stdout, '')
      else assert.equal(result.events.at(-1).error.code, failureCode)
    })
  }

  test(`run ${format} never replaces an earlier external cancellation with its local deadline`, async (t) => {
    const controller = new AbortController()
    const reason = Object.assign(new Error('external cancellation'), { code: 'CLI_INTERRUPTED', exitCode: 130 })
    const result = await timedRun(t, format, async (_input, expire) => {
      controller.abort(reason)
      expire()
      throw reason
    }, { signal: controller.signal })
    assert.equal(result.code, 130)
    assert.match(result.stderr, /CLI_INTERRUPTED/u)
    assert.doesNotMatch(result.stderr, /CLI_RUN_TIMEOUT|CLI_RUN_OUTCOME_CONFLICT/u)
  })

  test(`run ${format} handles a null cancelled payload without masking the timeout with TypeError`, async (t) => {
    const result = await timedRun(t, format, async ({ onEvent }, expire) => {
      await onEvent({ type: 'turn.cancelled', payload: null })
      expire()
      return { status: 'cancelled', exitCode: 1 }
    })
    assert.equal(result.code, 124)
    assert.match(result.stderr, /CLI_RUN_TIMEOUT/u)
  })

  test(`run ${format} treats awaiting approval as nonfinal when the deadline cancels it`, async (t) => {
    const result = await timedRun(t, format, async ({ onEvent }, expire) => {
      await onEvent({ type: 'turn.awaiting_approval', payload: {} })
      expire()
      return { status: 'cancelled', exitCode: 1 }
    })
    assert.equal(result.code, 124)
    assert.match(result.stderr, /CLI_RUN_TIMEOUT/u)
  })

  test(`run ${format} does not turn explicitly incomplete completion into success`, async (t) => {
    const result = await timedRun(t, format, async ({ onEvent }, expire) => {
      const lastEvent = { type: 'turn.completed', payload: { text: 'unverified answer', incomplete: true } }
      await onEvent(lastEvent)
      expire()
      return { status: 'completed', exitCode: 0, incomplete: true, lastEvent }
    })
    assert.equal(result.code, 1)
    if (format === 'text') {
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /TURN_INCOMPLETE/u)
    } else assert.equal(result.events.at(-1).payload.incomplete, true)
  })
}

function capture() {
  const chunks = []
  return { chunks, stream: new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done() } }),
    text: () => chunks.join('') }
}

async function waitForAbort(signal) {
  if (signal.aborted) return
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
}

test('run deadline does not replace a persistence failure after cancellation', { timeout: 5000 }, async () => {
  const stdout = capture()
  const stderr = capture()
  const failure = Object.assign(new Error('checkpoint could not be persisted'), { code: 'SQLITE_IOERR' })
  const code = await cmdRun(['fixture', '--timeout', '10'], {
    env: {}, stdin: Readable.from([]), stdout: stdout.stream, stderr: stderr.stream,
    runTurn: async ({ signal }) => { await waitForAbort(signal); throw failure },
  })
  assert.equal(code, 1)
  assert.equal(JSON.parse(stdout.text()).error.code, 'SQLITE_IOERR')
  assert.doesNotMatch(stderr.text(), /CLI_RUN_TIMEOUT/u)
})

test('run retains a known non-success terminal instead of turning uncertainty into a timeout', { timeout: 5000 }, async () => {
  const stdout = capture()
  const stderr = capture()
  const code = await cmdRun(['fixture', '--timeout', '10'], {
    env: {}, stdin: Readable.from([]), stdout: stdout.stream, stderr: stderr.stream,
    runTurn: async ({ signal, onEvent }) => {
      await waitForAbort(signal)
      await onEvent({ type: 'turn.blocked', payload: { code: 'MODEL_REQUEST_RESULT_UNKNOWN', reason: 'request_result_unknown' } })
      return { status: 'blocked', exitCode: 2 }
    },
  })
  assert.equal(code, 2)
  const events = stdout.text().trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(events.at(-1).type, 'turn.blocked')
  assert.equal(events.at(-1).payload.code, 'MODEL_REQUEST_RESULT_UNKNOWN')
  assert.equal(events.some((event) => event.type === 'cli.error'), false)
})

test('an exact cooperative deadline rejection still exits 124 without replay', { timeout: 5000 }, async () => {
  const stdout = capture()
  const stderr = capture()
  let calls = 0
  const code = await cmdRun(['fixture', '--timeout', '10'], {
    env: {}, stdin: Readable.from([]), stdout: stdout.stream, stderr: stderr.stream,
    runTurn: async ({ signal }) => { calls++; await waitForAbort(signal); throw signal.reason },
  })
  assert.equal(code, 124)
  assert.equal(calls, 1)
  assert.equal(JSON.parse(stdout.text()).error.code, 'CLI_RUN_TIMEOUT')
})

test('run deadline cannot replace a more specific observed terminal even if the returned status is contradictory', { timeout: 5000 }, async () => {
  const stdout = capture()
  const stderr = capture()
  const code = await cmdRun(['fixture', '--timeout', '10'], {
    env: {}, stdin: Readable.from([]), stdout: stdout.stream, stderr: stderr.stream,
    runTurn: async ({ signal, onEvent }) => {
      await waitForAbort(signal)
      await onEvent({ type: 'turn.failed', payload: { code: 'MODEL_REQUEST_RESULT_UNKNOWN', reason: 'request_result_unknown' } })
      return { status: 'completed', exitCode: 0 }
    },
  })
  assert.equal(code, 1)
  assert.equal(JSON.parse(stdout.text()).type, 'turn.failed')
})

test('run disposes output listeners on success and failure for embedders reusing streams', async () => {
  const stdout = capture()
  const stderr = capture()
  for (const failed of [false, true]) {
    await cmdRun(['fixture'], {
      env: {}, stdin: Readable.from([]), stdout: stdout.stream, stderr: stderr.stream,
      runTurn: async () => {
        if (failed) throw new Error('expected fixture failure')
        return { status: 'completed', exitCode: 0 }
      },
    })
    for (const stream of [stdout.stream, stderr.stream]) {
      assert.equal(stream.listenerCount('error'), 0)
      assert.equal(stream.listenerCount('close'), 0)
    }
  }
})
