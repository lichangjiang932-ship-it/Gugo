import { test } from 'node:test'
import assert from 'node:assert/strict'
import { logWarn, logError, withLogContext, getLogContext, newTraceId } from '../server/utils/logger.js'

test('logWarn emits a structured warn line including scope and message', () => {
  const calls = []
  const sink = { warn: (m) => calls.push(m), error: () => {} }
  logWarn('memory.inject', 'failed to inject', { userId: 'u1' }, sink)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /memory\.inject/)
  assert.match(calls[0], /failed to inject/)
  assert.match(calls[0], /u1/)
})

test('logError emits a structured error line and serializes Error objects', () => {
  const calls = []
  const sink = { warn: () => {}, error: (m) => calls.push(m) }
  logError('agent.inject', new Error('boom'), { jobId: 'j2' }, sink)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /agent\.inject/)
  assert.match(calls[0], /boom/)
  assert.match(calls[0], /j2/)
})

test('logWarn always emits regardless of NODE_ENV (production observability)', () => {
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const calls = []
    const sink = { warn: (m) => calls.push(m), error: () => {} }
    logWarn('x', 'y', {}, sink)
    assert.equal(calls.length, 1, 'must log in production too')
  } finally {
    process.env.NODE_ENV = prev
  }
})

test('withLogContext threads correlation ids into structured logs and explicit meta wins', async () => {
  const calls = []
  const sink = { warn: (m) => calls.push(m), error: () => {} }
  const traceId = newTraceId()
  assert.equal(typeof traceId, 'string')
  assert.equal(traceId.length, 16)

  await withLogContext({ requestId: 'req-1', userId: 'u1', traceId }, async () => {
    assert.equal(getLogContext().requestId, 'req-1')
    logWarn('model.retry', 'retrying', {}, sink)
    logWarn('model.retry', 'retrying', { userId: 'explicit-user' }, sink)
  })

  // 上下文在 run 结束后自动清空，不会泄漏到下一次调用。
  assert.equal(getLogContext().requestId, undefined)

  assert.match(calls[0], /requestId=req-1/)
  assert.match(calls[0], /userId=u1/)
  assert.match(calls[0], new RegExp(`traceId=${traceId}`))
  // 显式 meta 优先于上下文。
  assert.match(calls[1], /userId=explicit-user/)
  assert.doesNotMatch(calls[1], /userId=u1/)
})
