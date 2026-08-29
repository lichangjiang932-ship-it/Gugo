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
  burstCap = null, // ★ Lens-2: 突发上限,默认 = capacity;调小可挡瞬时打满 30 次的攻击
  now = () => Date.now(),
  sweepIntervalMs = DEFAULT_SWEEP_MS,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  if (!Number.isFinite(capacity) || capacity <= 0) throw new Error('capacity 必须 > 0')
  if (!Number.isFinite(refillPerMin) || refillPerMin <= 0) throw new Error('refillPerMin 必须 > 0')
  const effectiveBurst = Number.isFinite(burstCap) && burstCap > 0 ? Math.min(burstCap, capacity) : capacity
  const refillPerMs = refillPerMin / 60_000
  const buckets = new Map() // userId → Map<key, bucket>
  let sweepTimer = null

  function getBucket(userId, key) {
    let userMap = buckets.get(userId)
    if (!userMap) { userMap = new Map(); buckets.set(userId, userMap) }
    let b = userMap.get(key)
    if (!b) { b = { tokens: effectiveBurst, lastRefillMs: now() }; userMap.set(key, b) }
    return b
  }

  function refill(b) {
    const t = now()
    const delta = (t - b.lastRefillMs) * refillPerMs
    if (delta > 0) {
      // ★ Lens-2: 突发上限 ≤ capacity,防瞬时打满
      b.tokens = Math.min(effectiveBurst, b.tokens + delta)
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
    if (!userId) return { tokens: effectiveBurst, capacity: effectiveBurst }
    const b = getBucket(userId, key)
    refill(b)
    return { tokens: b.tokens, capacity: effectiveBurst }
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

/* ─── 全局单例(服务进程级) ───
 *
 * ⚠ Lens-2:这是【单进程内存桶】。
 *   - 多 worker(PM2 cluster / fork)各持独立桶,实际上限 = N × 声明上限
 *   - 进程重启会重置所有桶
 *   生产部署若用 cluster,应把限流上移到 nginx/网关层,或换 Redis 桶
 *   现阶段(单进程 server)足够,文档已标。
 *
 * ⚠ Lens-4:错误文案在 fsShellTools / applyPatch 内已明示 "30 次/分钟",
 *   新人不会困惑为什么 429。
 */

export const bashLimiter = createRateLimiter({ capacity: 30, refillPerMin: 30, burstCap: 8 })
export const codeModeLimiter = createRateLimiter({ capacity: 30, refillPerMin: 30, burstCap: 8 })
export const codexAppServerLimiter = createRateLimiter({ capacity: 12, refillPerMin: 12, burstCap: 3 })
export const patchLimiter = createRateLimiter({ capacity: 60, refillPerMin: 60, burstCap: 15 })
export const writeLimiter = createRateLimiter({ capacity: 120, refillPerMin: 120, burstCap: 30 })

// ★ Lens-3:测试环境(NODE_ENV=test 或 jest worker)不起 sweepTimer
//   避免 import 多次时 timer 泄露 / 阻塞 process.exit
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST && !process.env.NODE_TEST_CONTEXT) {
  bashLimiter.startSweep()
  codeModeLimiter.startSweep()
  codexAppServerLimiter.startSweep()
  patchLimiter.startSweep()
  writeLimiter.startSweep()
}

export function stopAllSweeps() {
  bashLimiter.stopSweep()
  codeModeLimiter.stopSweep()
  codexAppServerLimiter.stopSweep()
  patchLimiter.stopSweep()
  writeLimiter.stopSweep()
}
