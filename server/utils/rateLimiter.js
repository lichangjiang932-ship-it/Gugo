/**
 * 限流器(M3.5)。
 *
 * 防止模型失控时单用户对同一类工具狂打(typical:bash_exec / apply_patch 写循环).
 * 滑窗 token bucket,内存级、按 (userId, bucketKey) 分桶,无 DB 依赖.
 *
 * 用法:
 *   const limiter = createRateLimiter({ capacity: 30, refillPerMin: 30 })
 *   const ok = limiter.tryConsume(userId, 'bash_exec')
 *   if (!ok) throw 429
 *
 * 容量/速率推荐:
 *   - bash_exec: 30 / 分钟 — 正常开发跑测试/lint 够用,失控立挡
 *   - apply_patch: 60 / 分钟 — 改 patch 比 shell 快
 *   - 单用户总写工具(write_file/edit_file/multi_edit/apply_patch): 120 / 分钟
 *
 * 数据结构:Map<userId, Map<bucketKey, { tokens, lastRefillMs }>>
 * 过期清理:每 5 分钟扫一次,删 lastRefillMs 早于 10 分钟前的桶
 */

const DEFAULT_SWEEP_MS = 5 * 60 * 1000
const DEFAULT_TTL_MS = 10 * 60 * 1000

export function createRateLimiter({
  capacity = 30,
  refillPerMin = 30,
  now = () => Date.now(),
  sweepIntervalMs = DEFAULT_SWEEP_MS,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  if (!Number.isFinite(capacity) || capacity <= 0) throw new Error('capacity 必须 > 0')
  if (!Number.isFinite(refillPerMin) || refillPerMin <= 0) throw new Error('refillPerMin 必须 > 0')
  const refillPerMs = refillPerMin / 60_000
  const buckets = new Map() // userId → Map<key, bucket>
  let sweepTimer = null

  function getBucket(userId, key) {
    let userMap = buckets.get(userId)
    if (!userMap) { userMap = new Map(); buckets.set(userId, userMap) }
    let b = userMap.get(key)
    if (!b) { b = { tokens: capacity, lastRefillMs: now() }; userMap.set(key, b) }
    return b
  }

  function refill(b) {
    const t = now()
    const delta = (t - b.lastRefillMs) * refillPerMs
    if (delta > 0) {
      b.tokens = Math.min(capacity, b.tokens + delta)
      b.lastRefillMs = t
    }
  }

  function tryConsume(userId, key = 'default', cost = 1) {
    if (!userId) return true // 匿名/系统调用不限流,本系统也不开放匿名
    const b = getBucket(userId, key)
    refill(b)
    if (b.tokens < cost) return false
    b.tokens -= cost
    return true
  }

  function peek(userId, key = 'default') {
    if (!userId) return { tokens: capacity, capacity }
    const b = getBucket(userId, key)
    refill(b)
    return { tokens: b.tokens, capacity }
  }

  function reset(userId, key) {
    if (!userId) return
    const userMap = buckets.get(userId)
    if (!userMap) return
    if (key) userMap.delete(key)
    else buckets.delete(userId)
  }

  function sweep() {
    const cutoff = now() - ttlMs
    for (const [uid, userMap] of buckets) {
      for (const [k, b] of userMap) {
        if (b.lastRefillMs < cutoff) userMap.delete(k)
      }
      if (userMap.size === 0) buckets.delete(uid)
    }
  }

  function startSweep() {
    if (sweepTimer) return
    sweepTimer = setInterval(sweep, sweepIntervalMs)
    sweepTimer.unref?.() // 不阻塞 Node 退出
  }
  function stopSweep() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
  }

  return { tryConsume, peek, reset, sweep, startSweep, stopSweep }
}

/* ─── 全局单例(服务进程级) ─── */

export const bashLimiter = createRateLimiter({ capacity: 30, refillPerMin: 30 })
export const patchLimiter = createRateLimiter({ capacity: 60, refillPerMin: 60 })
export const writeLimiter = createRateLimiter({ capacity: 120, refillPerMin: 120 })

bashLimiter.startSweep()
patchLimiter.startSweep()
writeLimiter.startSweep()
