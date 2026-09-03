import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachSessionCatalogRefreshLifecycle,
  createSessionCatalogRefreshScheduler,
} from '../src/store/sessionCatalogRefresh.js'

function createFakeClock() {
  let time = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => time,
    setTimeout(fn, delay) {
      const id = nextId++
      timers.set(id, { at: time + delay, fn })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    advance(duration) {
      const target = time + duration
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0]
        if (!due) break
        const [id, timer] = due
        timers.delete(id)
        time = timer.at
        timer.fn()
      }
      time = target
    },
    pending: () => timers.size,
  }
}

function createEventTarget() {
  const listeners = new Map()
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    emit(type) { for (const listener of listeners.get(type) || []) listener() },
  }
}

const flushPromises = async () => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

test('catalog refresh coalesces focus signals and observes the cooldown', async () => {
  const clock = createFakeClock()
  let calls = 0
  const scheduler = createSessionCatalogRefreshScheduler({
    task: async () => { calls += 1 },
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  })

  scheduler.schedule()
  scheduler.schedule()
  assert.equal(clock.pending(), 1)
  clock.advance(199)
  assert.equal(calls, 0)
  clock.advance(1)
  await flushPromises()
  assert.equal(calls, 1)

  scheduler.schedule()
  clock.advance(4_999)
  assert.equal(calls, 1)
  clock.advance(1)
  await flushPromises()
  assert.equal(calls, 2)
})

test('catalog refresh queues at most one follow-up while a request is running', async () => {
  const clock = createFakeClock()
  let resolveFirst
  let calls = 0
  const scheduler = createSessionCatalogRefreshScheduler({
    task: () => {
      calls += 1
      if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve })
      return Promise.resolve()
    },
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  })

  const first = scheduler.run()
  await flushPromises()
  scheduler.schedule()
  scheduler.schedule()
  scheduler.schedule()
  resolveFirst()
  await first
  assert.equal(clock.pending(), 1)

  clock.advance(5_000)
  await flushPromises()
  assert.equal(calls, 2)
  assert.equal(clock.pending(), 0)
})

test('catalog lifecycle refreshes only while visible and detaches cleanly', () => {
  const windowTarget = createEventTarget()
  const documentTarget = { ...createEventTarget(), visibilityState: 'hidden' }
  let intervalCallback
  let clearedInterval = false
  let schedules = 0
  let stopped = false
  const detach = attachSessionCatalogRefreshLifecycle({
    scheduler: {
      schedule() { schedules += 1 },
      stop() { stopped = true },
    },
    windowTarget,
    documentTarget,
    setIntervalFn(callback) { intervalCallback = callback; return 41 },
    clearIntervalFn(id) { assert.equal(id, 41); clearedInterval = true },
  })

  windowTarget.emit('focus')
  intervalCallback()
  assert.equal(schedules, 0)

  documentTarget.visibilityState = 'visible'
  documentTarget.emit('visibilitychange')
  windowTarget.emit('focus')
  intervalCallback()
  assert.equal(schedules, 3)

  detach()
  windowTarget.emit('focus')
  documentTarget.emit('visibilitychange')
  assert.equal(schedules, 3)
  assert.equal(stopped, true)
  assert.equal(clearedInterval, true)
})

test('stopping catalog refresh cancels pending work', () => {
  const clock = createFakeClock()
  let calls = 0
  const scheduler = createSessionCatalogRefreshScheduler({
    task: async () => { calls += 1 },
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  })
  scheduler.schedule()
  scheduler.stop()
  clock.advance(30_000)
  assert.equal(calls, 0)
  assert.equal(clock.pending(), 0)
})
