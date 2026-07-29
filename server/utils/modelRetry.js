/**
 * 上游模型调用的重试/退避 —— 纯函数 + 一个通用 withRetry 包装。
 *
 * 背景:后台任务(job / subagent)对上游只发一次请求,遇到 429 限流或
 * 502/503 这类瞬时故障就直接把整个 job 判失败。真实链路上这类抖动很常见,
 * 一次退避重试就能救回来,不重试等于把可恢复错误当成终局错误。
 *
 * 只重试「可恢复」的:限流、5xx、网络层错误。
 * 4xx 业务错误(401 鉴权 / 400 参数 / 404 模型不存在)立即失败 —— 重试无意义且浪费配额。
 */

/** 会重试的 HTTP 状态码。408 请求超时、409 冲突、429 限流,以及全部 5xx。 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

/** 会重试的 Node/undici 网络错误码。 */
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
])

export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_BASE_DELAY_MS = 500
export const DEFAULT_MAX_DELAY_MS = 8_000

export function isRetryableError(err) {
  if (!err) return false
  // 用户/上层主动取消,绝不重试
  if (err.name === 'AbortError') return false
  if (Number.isFinite(err.status) && RETRYABLE_STATUS.has(err.status)) return true
  if (err.code && RETRYABLE_CODES.has(err.code)) return true
  // fetch 的网络层失败通常是裸 TypeError('fetch failed'),带 cause
  if (err.cause?.code && RETRYABLE_CODES.has(err.cause.code)) return true
  return false
}

/**
 * 指数退避 + 抖动。抖动是必须的:多个 job 同时撞限流时,
 * 无抖动会让它们在同一时刻齐步重试,把限流again 打满。
 *
 * @param {number} attempt 从 0 开始
 * @param {() => number} [rand] 注入随机源,便于测试
 */
export function backoffDelayMs(attempt, {
  baseMs = DEFAULT_BASE_DELAY_MS,
  maxMs = DEFAULT_MAX_DELAY_MS,
  rand = Math.random,
} = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt))
  // full jitter: [0, exp]
  return Math.floor(rand() * exp)
}

/**
 * 上游返回的 Retry-After 优先于我们自己算的退避(秒 或 HTTP-date)。
 * 拿不到就返回 null。
 */
export function parseRetryAfterMs(headerValue, now = Date.now()) {
  if (headerValue == null) return null
  const raw = String(headerValue).trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw)
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null
  }
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  const timer = setTimeout(() => {
    if (signal) signal.removeEventListener('abort', onAbort)
    resolve()
  }, ms)
  function onAbort() {
    clearTimeout(timer)
    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  }
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
})

/**
 * 通用重试包装。
 *
 * @param {() => Promise<any>} fn 每次尝试都重新调用
 * @param {object} [options]
 * @param {number} [options.maxAttempts] 总尝试次数(含首次)
 * @param {AbortSignal} [options.signal] 取消时立刻停止,不再重试
 * @param {(info:{attempt:number,delayMs:number,error:Error}) => void} [options.onRetry] 观测钩子
 */
export async function withRetry(fn, {
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseMs = DEFAULT_BASE_DELAY_MS,
  maxMs = DEFAULT_MAX_DELAY_MS,
  signal = null,
  rand = Math.random,
  onRetry = null,
  sleepImpl = sleep,
} = {}) {
  const attempts = Math.max(1, Math.floor(maxAttempts) || 1)
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const isLast = attempt === attempts - 1
      if (isLast || !isRetryableError(err) || signal?.aborted) throw err
      const retryAfter = parseRetryAfterMs(err.retryAfter ?? err.headers?.get?.('retry-after'))
      const delayMs = retryAfter != null
        ? Math.min(retryAfter, maxMs)
        : backoffDelayMs(attempt, { baseMs, maxMs, rand })
      if (typeof onRetry === 'function') {
        try {
          onRetry({ attempt: attempt + 1, delayMs, error: err })
        } catch {
          /* 观测失败不影响重试本身 */
        }
      }
      await sleepImpl(delayMs, signal)
    }
  }
  throw lastError
}
