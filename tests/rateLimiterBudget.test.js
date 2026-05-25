import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from '../server/utils/rateLimiter.js'
import { createJobBudget } from '../server/utils/jobBudget.js'

/* rateLimiter */

test('rateLimiter: 容量内允许,超限拒绝', () => {
  let t = 1_000_000
  const l = createRateLimiter({ capacity: 3, refillPerMin: 60, now: () => t })
  assert.equal(l.tryConsume('u1'), true)
  assert.equal(l.tryConsume('u1'), true)
  assert.equal(l.tryConsume('u1'), true)
  assert.equal(l.tryConsume('u1'), false, '第 4 次应拒绝')
})

test('rateLimiter: 时间推进后补充 token', () => {
  let t = 1_000_000
  const l = createRateLimiter({ capacity: 3, refillPerMin: 60, now: () => t })
  l.tryConsume('u1'); l.tryConsume('u1'); l.tryConsume('u1')
  assert.equal(l.tryConsume('u1'), false)
  // 60/min = 1/s,推 1.1s 应补 1 个
  t += 1_100
  assert.equal(l.tryConsume('u1'), true)
  assert.equal(l.tryConsume('u1'), false, '只补了 1 个')
})

test('rateLimiter: 桶按 (user, key) 隔离', () => {
  const l = createRateLimiter({ capacity: 1, refillPerMin: 1 })
  assert.equal(l.tryConsume('u1', 'bash'), true)
  assert.equal(l.tryConsume('u1', 'bash'), false)
  assert.equal(l.tryConsume('u1', 'patch'), true, '不同 key 不互通')
  assert.equal(l.tryConsume('u2', 'bash'), true, '不同 user 不互通')
})

test('rateLimiter: anonymous (无 userId) 不限流', () => {
  const l = createRateLimiter({ capacity: 1, refillPerMin: 1 })
  for (let i = 0; i < 100; i++) assert.equal(l.tryConsume(null), true)
})

test('rateLimiter: peek 返回当前 token', () => {
  let t = 1_000_000
  const l = createRateLimiter({ capacity: 5, refillPerMin: 60, now: () => t })
  l.tryConsume('u1'); l.tryConsume('u1')
  const p = l.peek('u1')
  assert.equal(p.capacity, 5)
  assert.ok(p.tokens >= 2.9 && p.tokens <= 3.1)
})

test('rateLimiter: reset 清桶', () => {
  const l = createRateLimiter({ capacity: 1, refillPerMin: 1 })
  l.tryConsume('u1', 'k')
  assert.equal(l.tryConsume('u1', 'k'), false)
  l.reset('u1', 'k')
  assert.equal(l.tryConsume('u1', 'k'), true)
})

test('rateLimiter: sweep 清过期桶', () => {
  let t = 1_000_000
  const l = createRateLimiter({ capacity: 5, refillPerMin: 5, now: () => t, ttlMs: 1000 })
  l.tryConsume('u1')
  t += 5000
  l.sweep()
  // sweep 后该桶应被清,新 tryConsume 应是满容量
  const p = l.peek('u1')
  assert.equal(p.tokens, 5)
})

/* jobBudget */

test('jobBudget: tool 调用计数超限拒绝', () => {
  const b = createJobBudget({ maxTotalCalls: 3, maxWallMs: 1_000_000 })
  assert.equal(b.consume().ok, true)
  assert.equal(b.consume().ok, true)
  assert.equal(b.consume().ok, true)
  const r = b.consume()
  assert.equal(r.ok, false)
  assert.match(r.reason, /tool call budget/)
})

test('jobBudget: 挂钟超限拒绝', () => {
  let t = 1_000_000
  const b = createJobBudget({ maxTotalCalls: 1_000, maxWallMs: 500, now: () => t })
  assert.equal(b.consume().ok, true)
  t += 600
  const r = b.consume()
  assert.equal(r.ok, false)
  assert.match(r.reason, /wall-clock/)
})

test('jobBudget: snapshot 报当前用量', () => {
  let t = 1_000_000
  const b = createJobBudget({ maxTotalCalls: 10, maxWallMs: 5_000, now: () => t })
  b.consume(); b.consume(); b.consume()
  t += 1_500
  const s = b.snapshot()
  assert.equal(s.used, 3)
  assert.equal(s.maxTotalCalls, 10)
  assert.equal(s.elapsed, 1500)
  assert.equal(s.maxWallMs, 5000)
})

test('jobBudget: cost 参数支持(贵的工具占多 token)', () => {
  const b = createJobBudget({ maxTotalCalls: 5, maxWallMs: 1_000_000 })
  assert.equal(b.consume(3).ok, true)
  const r = b.consume(3)
  assert.equal(r.ok, false, '3+3=6 > 5')
})

import { attachJobBudget, getJobBudget } from '../server/utils/jobBudget.js'

test('jobBudget: WeakMap 持有,job 上没有可枚举属性可被 delete 绕过', () => {
  const job = { id: 'j1', userId: 'u' }
  attachJobBudget(job, { maxTotalCalls: 2, maxWallMs: 60_000 })
  // 模型/工具能看到的 job.* 不应有 __budget
  assert.equal(Object.prototype.hasOwnProperty.call(job, '__budget'), false)
  assert.equal(Object.keys(job).some((k) => k.includes('budget')), false)
  // 但 getJobBudget 还能拿到
  const b = getJobBudget(job)
  assert.ok(b)
  assert.equal(b.consume().ok, true)
  assert.equal(b.consume().ok, true)
  assert.equal(b.consume().ok, false)
})

test('rateLimiter: burstCap 限制瞬时打满', () => {
  let t = 1_000_000
  const l = createRateLimiter({ capacity: 30, refillPerMin: 30, burstCap: 5, now: () => t })
  // 初始只有 5 个 token,不是 30
  for (let i = 0; i < 5; i++) assert.equal(l.tryConsume('u'), true)
  assert.equal(l.tryConsume('u'), false, '第 6 次应被 burst 挡住')
})

test('rateLimiter: NODE_ENV=test 时 singleton 不起 sweepTimer (防泄露)', async () => {
  // 重新 import 一次,看看是否会有 active timer
  const before = process.getActiveResourcesInfo?.() || []
  await import('../server/utils/rateLimiter.js?cachebust=' + Date.now())
  const after = process.getActiveResourcesInfo?.() || []
  // active 计数不应因 import 新增 timeout(允许 ±0)
  const beforeT = before.filter((x) => x === 'Timeout').length
  const afterT = after.filter((x) => x === 'Timeout').length
  assert.ok(afterT - beforeT <= 0, `sweep 不应起 timer:before=${beforeT} after=${afterT}`)
})
