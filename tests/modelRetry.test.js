import test from 'node:test'
import assert from 'node:assert/strict'

import {
  backoffDelayMs,
  isRetryableError,
  parseRetryAfterMs,
  parseRetryDelayMs,
  withRetry,
} from '../server/utils/modelRetry.js'

// 测试里不真的睡,注入一个记账用的假 sleep
function makeSleepSpy() {
  const delays = []
  return {
    delays,
    sleepImpl: async (ms) => { delays.push(ms) },
  }
}

test('限流 / 5xx / 网络错误判定为可重试', () => {
  for (const status of [408, 409, 425, 429, 500, 502, 503, 504, 529]) {
    assert.ok(isRetryableError({ status }), `${status} 应可重试`)
  }
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET']) {
    assert.ok(isRetryableError({ code }), `${code} 应可重试`)
  }
  // fetch 的网络失败是裸 TypeError,错误码在 cause 上
  assert.ok(isRetryableError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })))
})

test('4xx 业务错误与主动取消不重试', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryableError({ status }), false, `${status} 重试无意义`)
  }
  // AbortError = 用户/上层取消,绝不能重试
  assert.equal(isRetryableError(Object.assign(new Error('x'), { name: 'AbortError' })), false)
  assert.equal(isRetryableError(null), false)
  assert.equal(isRetryableError(undefined), false)
})

test('没有状态码的上游瞬时错误也可恢复，但普通业务错误不会误重试', () => {
  for (const message of ['fetch failed', 'provider is overloaded', 'resource exhausted', 'socket connection was closed']) {
    assert.equal(isRetryableError(new Error(message)), true, message)
  }
  assert.equal(isRetryableError(new Error('model not found')), false)
})

test('退避是指数增长且带抖动,并封顶', () => {
  // rand 固定为 1 时取到该轮上界
  const upper = (attempt) => backoffDelayMs(attempt, { baseMs: 500, maxMs: 8000, rand: () => 1 })
  assert.equal(upper(0), 500)
  assert.equal(upper(1), 1000)
  assert.equal(upper(2), 2000)
  assert.equal(upper(5), 8000, '应被 maxMs 封顶')

  // 抖动:rand=0 时为 0,保证不同调用者不会齐步重试
  assert.equal(backoffDelayMs(3, { baseMs: 500, maxMs: 8000, rand: () => 0 }), 0)
})

test('parseRetryAfterMs 支持秒数与 HTTP-date', () => {
  assert.equal(parseRetryAfterMs('30'), 30_000)
  assert.equal(parseRetryAfterMs('0'), 0)
  const now = Date.parse('2026-01-01T00:00:00Z')
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', now), 10_000)
  // 过去的时间不应变成负数
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:00 GMT', now + 5000), 0)
  for (const bad of [null, undefined, '', '  ', 'not-a-date']) {
    assert.equal(parseRetryAfterMs(bad), null)
  }
})

test('retry-after-ms 优先于 retry-after 秒数', () => {
  assert.equal(parseRetryDelayMs({ retryAfterMs: '1250', retryAfter: '9' }), 1250)
  assert.equal(parseRetryDelayMs({ headers: { get: (name) => name === 'retry-after-ms' ? '750' : '4' } }), 750)
})

test('withRetry 在瞬时故障后成功 —— 一个 429 不该杀掉整个 job', async () => {
  const { delays, sleepImpl } = makeSleepSpy()
  let attempts = 0
  const result = await withRetry(async () => {
    attempts += 1
    if (attempts < 3) throw Object.assign(new Error('rate limited'), { status: 429 })
    return 'ok'
  }, { sleepImpl, rand: () => 1, baseMs: 100, maxMs: 1000 })

  assert.equal(result, 'ok')
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [100, 200], '两次退避应指数增长')
})

test('withRetry 遇 4xx 立即抛出,不浪费配额', async () => {
  const { delays, sleepImpl } = makeSleepSpy()
  let attempts = 0
  await assert.rejects(
    () => withRetry(async () => {
      attempts += 1
      throw Object.assign(new Error('bad key'), { status: 401 })
    }, { sleepImpl }),
    /bad key/,
  )
  assert.equal(attempts, 1, '401 不该重试')
  assert.equal(delays.length, 0)
})

test('withRetry 用尽次数后抛出最后一个错误', async () => {
  const { sleepImpl } = makeSleepSpy()
  let attempts = 0
  await assert.rejects(
    () => withRetry(async () => {
      attempts += 1
      throw Object.assign(new Error(`boom ${attempts}`), { status: 503 })
    }, { maxAttempts: 3, sleepImpl, rand: () => 0 }),
    /boom 3/,
  )
  assert.equal(attempts, 3)
})

test('withRetry 尊重上游 Retry-After,优先于自算退避', async () => {
  const { delays, sleepImpl } = makeSleepSpy()
  let attempts = 0
  await withRetry(async () => {
    attempts += 1
    if (attempts === 1) throw Object.assign(new Error('slow down'), { status: 429, retryAfter: '2' })
    return 'ok'
  }, { sleepImpl, baseMs: 100, maxMs: 10_000, rand: () => 1 })
  assert.deepEqual(delays, [2000], '应等上游要求的 2 秒,而不是自算的 100ms')
})

test('withRetry 在 signal 已中止时不再重试', async () => {
  const { sleepImpl } = makeSleepSpy()
  const controller = new AbortController()
  let attempts = 0
  await assert.rejects(
    () => withRetry(async () => {
      attempts += 1
      controller.abort()
      throw Object.assign(new Error('transient'), { status: 503 })
    }, { signal: controller.signal, sleepImpl }),
    /transient/,
  )
  assert.equal(attempts, 1, '已中止就不该再试')
})

test('onRetry 回调抛错不影响重试本身', async () => {
  const { sleepImpl } = makeSleepSpy()
  let attempts = 0
  const result = await withRetry(async () => {
    attempts += 1
    if (attempts < 2) throw Object.assign(new Error('x'), { status: 500 })
    return 'ok'
  }, {
    sleepImpl,
    onRetry: () => { throw new Error('观测钩子炸了') },
  })
  assert.equal(result, 'ok')
})

test('结果未知的模型请求绝不自动重试', async () => {
  const { delays, sleepImpl } = makeSleepSpy()
  let attempts = 0
  await assert.rejects(
    () => withRetry(async () => {
      attempts += 1
      throw Object.assign(new Error('upstream may already be processing'), {
        code: 'MODEL_REQUEST_OUTCOME_UNKNOWN',
        status: 503,
        unsafeToReplay: true,
      })
    }, { maxAttempts: 3, sleepImpl }),
    (error) => error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN',
  )
  assert.equal(attempts, 1)
  assert.deepEqual(delays, [])
})
