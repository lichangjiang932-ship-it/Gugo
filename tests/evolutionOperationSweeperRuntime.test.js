import assert from 'node:assert/strict'
import test from 'node:test'

import {
  closeEvolutionOperationSweeperRuntime,
  createEvolutionOperationSweeperRuntime,
  setEvolutionOperationSweeperRuntimeForTesting,
} from '../server/services/evolutionOperationSweeperRuntime.js'

function fakeTimers() {
  const scheduled = []
  const cleared = []
  return {
    scheduled,
    cleared,
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} }
      scheduled.push(timer)
      return timer
    },
    clearTimer(timer) {
      cleared.push(timer)
      const index = scheduled.indexOf(timer)
      if (index >= 0) scheduled.splice(index, 1)
    },
  }
}

test('startup scans once, drains hasMore batches immediately, then uses the fixed interval', async () => {
  const timers = fakeTimers()
  const inputs = []
  const runtime = createEvolutionOperationSweeperRuntime({
    intervalMs: 5_000,
    batchSize: 7,
    now: () => 123,
    monotonicNow: () => 456,
    sweep: (input) => {
      inputs.push(input)
      return { frozen: 1, hasMore: inputs.length === 1 }
    },
    ...timers,
  })

  runtime.start()
  assert.equal(inputs.length, 0, 'startup must not synchronously block lifecycle assembly')
  await runtime.scan()
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].limit, 7)
  assert.equal(inputs[0].now, 123)
  assert.equal(inputs[0].monotonicNow(), 456)
  assert.equal(timers.scheduled.length, 1)
  assert.equal(timers.scheduled[0].delay, 0)

  const continuation = timers.scheduled.shift()
  continuation.callback()
  await runtime.scan()
  assert.equal(inputs.length, 2)
  assert.equal(timers.scheduled.length, 1)
  assert.equal(timers.scheduled[0].delay, 5_000)
  await runtime.stop()
})

test('SQLite busy schedules a bounded retry without rejecting startup', async () => {
  const timers = fakeTimers()
  const errors = []
  let attempts = 0
  const runtime = createEvolutionOperationSweeperRuntime({
    intervalMs: 10_000,
    retryDelayMs: 250,
    sweep: () => {
      attempts += 1
      if (attempts === 1) {
        throw Object.assign(new Error('database is busy'), {
          code: 'EVOLUTION_OPERATION_SWEEP_BUSY',
        })
      }
      return { frozen: 0, hasMore: false }
    },
    onError: (error) => errors.push(error.code),
    ...timers,
  })

  runtime.start()
  assert.equal(await runtime.scan(), null)
  assert.deepEqual(errors, ['EVOLUTION_OPERATION_SWEEP_BUSY'])
  assert.equal(timers.scheduled[0].delay, 250)

  const retry = timers.scheduled.shift()
  retry.callback()
  await runtime.scan()
  assert.equal(attempts, 2)
  assert.equal(timers.scheduled[0].delay, 10_000)
  await runtime.stop()
})

test('a permanent failure cannot inherit an earlier hasMore continuation', async () => {
  const timers = fakeTimers()
  let attempts = 0
  const runtime = createEvolutionOperationSweeperRuntime({
    intervalMs: 8_000,
    sweep: () => {
      attempts += 1
      if (attempts === 1) return { frozen: 1, hasMore: true }
      throw Object.assign(new Error('permanent failure'), { code: 'PERMANENT_FAILURE' })
    },
    onError: () => {},
    ...timers,
  })

  runtime.start()
  await runtime.scan()
  assert.equal(timers.scheduled[0].delay, 0)
  const continuation = timers.scheduled.shift()
  continuation.callback()
  await runtime.scan()
  assert.equal(attempts, 2)
  assert.equal(timers.scheduled[0].delay, 8_000)
  await runtime.stop()
})

test('diagnostics never retain or emit an arbitrary rejection payload', async () => {
  const timers = fakeTimers()
  const diagnostics = []
  const runtime = createEvolutionOperationSweeperRuntime({
    sweep: () => Promise.reject({
      payload: { apiKey: 'must-not-leak' },
      request: { prompt: 'private prompt' },
    }),
    onError: (diagnostic) => diagnostics.push(diagnostic),
    ...timers,
  })

  runtime.start()
  assert.equal(await runtime.scan(), null)
  assert.deepEqual(diagnostics, [{ message: 'evolution operation sweep failed' }])
  assert.deepEqual(runtime.state().lastError, {
    message: 'evolution operation sweep failed',
  })
  assert.equal(JSON.stringify(diagnostics).includes('must-not-leak'), false)
  assert.equal(JSON.stringify(runtime.state()).includes('private prompt'), false)
  await runtime.stop()
})

test('stop is idempotent, clears timers, and awaits an in-flight scan without rescheduling', async () => {
  const timers = fakeTimers()
  let finishSweep
  const sweepPending = new Promise((resolve) => { finishSweep = resolve })
  const runtime = createEvolutionOperationSweeperRuntime({
    sweep: () => sweepPending,
    ...timers,
  })

  runtime.start()
  await Promise.resolve()
  const firstClose = runtime.stop()
  const secondClose = runtime.stop()
  assert.strictEqual(secondClose, firstClose)
  let closed = false
  void firstClose.then(() => { closed = true })
  await Promise.resolve()
  assert.equal(closed, false)

  finishSweep({ frozen: 0, hasMore: false })
  await firstClose
  assert.equal(closed, true)
  assert.equal(timers.scheduled.length, 0)
  assert.equal(runtime.state().closed, true)
})

test('singleton close waits for the injected runtime and remains idempotent', async () => {
  let finishClose
  const pendingClose = new Promise((resolve) => { finishClose = resolve })
  let closes = 0
  setEvolutionOperationSweeperRuntimeForTesting({
    stop() {
      closes += 1
      return pendingClose
    },
  })

  const first = closeEvolutionOperationSweeperRuntime()
  const second = closeEvolutionOperationSweeperRuntime()
  assert.strictEqual(second, first)
  assert.equal(closes, 1)
  finishClose()
  await first
  assert.equal(closes, 1)
  await closeEvolutionOperationSweeperRuntime()
})
