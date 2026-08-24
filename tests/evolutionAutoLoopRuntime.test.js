import assert from 'node:assert/strict'
import test from 'node:test'

import { createEvolutionAutoLoopRuntime } from '../server/services/evolutionAutoLoopRuntime.js'

function fakeTimers() {
  const scheduled = []
  return {
    scheduled,
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} }
      scheduled.push(timer)
      return timer
    },
    clearTimer(timer) {
      const index = scheduled.indexOf(timer)
      if (index >= 0) scheduled.splice(index, 1)
    },
  }
}

test('automatic evolution runtime scans immediately, stays single-flight, and reschedules', async () => {
  const timers = fakeTimers()
  const inputs = []
  let finish
  const pending = new Promise((resolve) => { finish = resolve })
  const runtime = createEvolutionAutoLoopRuntime({
    intervalMs: 5_000,
    env: { TEST_ENV: 'yes' },
    now: () => 123,
    readSession: () => null,
    scan: (input) => {
      inputs.push(input)
      return pending
    },
    ...timers,
  })

  runtime.start()
  await Promise.resolve()
  const sameScan = runtime.scan()
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].now, 123)
  assert.equal(inputs[0].env.TEST_ENV, 'yes')
  assert.equal(inputs[0].signal.aborted, false)
  finish({ scannedAt: 123, results: [] })
  await sameScan
  assert.equal(timers.scheduled.length, 1)
  assert.equal(timers.scheduled[0].delay, 5_000)
  await runtime.stop()
})

test('automatic evolution runtime aborts and drains an in-flight scan on stop', async () => {
  const timers = fakeTimers()
  let observedSignal
  const runtime = createEvolutionAutoLoopRuntime({
    scan: ({ signal }) => new Promise((resolve) => {
      observedSignal = signal
      signal.addEventListener('abort', () => resolve(null), { once: true })
    }),
    ...timers,
  })

  runtime.start()
  await Promise.resolve()
  const stopped = runtime.stop()
  assert.equal(observedSignal.aborted, true)
  await stopped
  assert.equal(timers.scheduled.length, 0)
  assert.equal(runtime.state().closed, true)
})
