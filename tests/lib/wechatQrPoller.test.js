// ★ T2: 微信扫码轮询器单测
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPoller } from '../../src/lib/wechatQrPoller.js'

// 同步执行的 setTimeout/clearTimeout 替身：把 callback 收集到队列，flush() 一次性跑完。
// 这样不依赖 fake timer 库也能精确控制轮询节奏。
function makeFakeClock() {
  let queue = []
  let id = 0
  return {
    setTimeout: (fn) => {
      id += 1
      queue.push({ id, fn, cancelled: false })
      return id
    },
    clearTimeout: (cid) => {
      const item = queue.find((q) => q.id === cid)
      if (item) item.cancelled = true
    },
    async flush(maxTicks = 200) {
      let ticks = 0
      while (queue.length && ticks < maxTicks) {
        const next = queue.shift()
        if (next.cancelled) continue
        await next.fn()
        ticks += 1
      }
      if (ticks >= maxTicks) throw new Error('flush exceeded maxTicks — possible runaway')
    },
    get pending() { return queue.filter((q) => !q.cancelled).length },
  }
}

test('pending → pending → confirmed: onUpdate 被调 3 次 status + 1 次 done，终态 confirmed', async () => {
  const clock = makeFakeClock()
  const responses = [
    { status: 'pending' },
    { status: 'scanned' },
    { status: 'confirmed', integration: { id: 'int-1' } },
  ]
  let i = 0
  const events = []
  const poller = createPoller({
    fetch: async () => responses[i++],
    intervalMs: 1000,
    maxAttempts: 10,
    maxFailures: 3,
    onUpdate: (ev) => events.push(ev),
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  })
  poller.start()
  await clock.flush()

  const statusEvents = events.filter((e) => e.type === 'status')
  const doneEvents = events.filter((e) => e.type === 'done')
  const errorEvents = events.filter((e) => e.type === 'error')

  assert.equal(statusEvents.length, 3, 'status 应回调 3 次')
  assert.deepEqual(statusEvents.map((e) => e.status), ['pending', 'scanned', 'confirmed'])
  assert.equal(doneEvents.length, 1, 'done 应回调 1 次')
  assert.equal(doneEvents[0].status, 'confirmed')
  assert.equal(errorEvents.length, 0, '不应有 error')
  assert.equal(poller.isStopped, true, '终态后应已 stop')
  assert.equal(clock.pending, 0, '不应再有待执行的定时器')
})

test('连续 3 次网络 reject（无 status）→ 停轮询 + onUpdate kind=networkError', async () => {
  const clock = makeFakeClock()
  const events = []
  const poller = createPoller({
    fetch: async () => { throw new Error('ECONNREFUSED') }, // 无 .status
    intervalMs: 500,
    maxAttempts: 60,
    maxFailures: 3,
    onUpdate: (ev) => events.push(ev),
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  })
  poller.start()
  await clock.flush()

  const errorEvents = events.filter((e) => e.type === 'error')
  assert.equal(errorEvents.length, 1, '应只报一次 error')
  assert.equal(errorEvents[0].kind, 'networkError')
  assert.equal(errorEvents[0].attempts, 3, '应在第 3 次后停下')
  assert.equal(poller.isStopped, true)
  assert.equal(clock.pending, 0)
})

test('maxAttempts 满 → onUpdate kind=timeout', async () => {
  const clock = makeFakeClock()
  const events = []
  const poller = createPoller({
    fetch: async () => ({ status: 'pending' }),
    intervalMs: 100,
    maxAttempts: 5,
    maxFailures: 99,
    onUpdate: (ev) => events.push(ev),
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  })
  poller.start()
  await clock.flush()

  const statusEvents = events.filter((e) => e.type === 'status')
  const errorEvents = events.filter((e) => e.type === 'error')
  assert.equal(statusEvents.length, 5, '应轮询满 5 次')
  assert.equal(errorEvents.length, 1)
  assert.equal(errorEvents[0].kind, 'timeout')
  assert.equal(errorEvents[0].attempts, 5)
  assert.equal(poller.isStopped, true)
})

test('HTTP 4xx 立刻停 + kind=clientError，message 透传后端文案', async () => {
  const clock = makeFakeClock()
  const events = []
  const err = new Error('qrcode not found')
  err.status = 404
  const poller = createPoller({
    fetch: async () => { throw err },
    intervalMs: 100,
    maxAttempts: 10,
    maxFailures: 3,
    onUpdate: (ev) => events.push(ev),
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  })
  poller.start()
  await clock.flush()

  const errorEvents = events.filter((e) => e.type === 'error')
  assert.equal(errorEvents.length, 1)
  assert.equal(errorEvents[0].kind, 'clientError')
  assert.equal(errorEvents[0].httpStatus, 404)
  assert.equal(errorEvents[0].message, 'qrcode not found')
})

test('HTTP 5xx 立刻停 + kind=serverError', async () => {
  const clock = makeFakeClock()
  const events = []
  const err = new Error('internal')
  err.status = 502
  const poller = createPoller({
    fetch: async () => { throw err },
    intervalMs: 100,
    maxAttempts: 10,
    maxFailures: 3,
    onUpdate: (ev) => events.push(ev),
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  })
  poller.start()
  await clock.flush()

  const errorEvents = events.filter((e) => e.type === 'error')
  assert.equal(errorEvents.length, 1)
  assert.equal(errorEvents[0].kind, 'serverError')
  assert.equal(errorEvents[0].httpStatus, 502)
})

test('stop() 后不再触发 fetch / onUpdate', async () => {
  const clock = makeFakeClock()
  const events = []
  let fetchCount = 0
  const poller = createPoller({
    fetch: async () => { fetchCount += 1; return { status: 'pending' } },
    intervalMs: 100,
    maxAttempts: 10,
    maxFailures: 3,
    onUpdate: (ev) => events.push(ev),
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  })
  poller.start()
  poller.stop()
  await clock.flush()

  assert.equal(fetchCount, 0, '尚未触发就 stop，应不发出请求')
  assert.equal(events.length, 0)
  assert.equal(poller.isStopped, true)
})

test('onUpdate 内抛错不会击落轮询', async () => {
  const clock = makeFakeClock()
  const responses = [
    { status: 'pending' },
    { status: 'confirmed' },
  ]
  let i = 0
  const events = []
  const poller = createPoller({
    fetch: async () => responses[i++],
    intervalMs: 100,
    maxAttempts: 10,
    maxFailures: 3,
    onUpdate: (ev) => {
      events.push(ev)
      if (ev.type === 'status' && ev.status === 'pending') throw new Error('subscriber boom')
    },
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  })
  poller.start()
  await clock.flush()

  assert.equal(events.filter((e) => e.type === 'status').length, 2)
  assert.equal(events.filter((e) => e.type === 'done').length, 1)
})

test('参数校验：fetch / onUpdate 缺失 → 抛 TypeError', () => {
  assert.throws(() => createPoller({}), TypeError)
  assert.throws(() => createPoller({ fetch: async () => ({}) }), TypeError)
  assert.throws(() => createPoller({ onUpdate: () => {} }), TypeError)
})
