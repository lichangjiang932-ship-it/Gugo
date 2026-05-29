// ★ T2: 微信扫码轮询器 —— 纯模块（无 React / DOM 依赖）
//
// 设计要点：
// - 注入式 fetch（async () => result），便于单测；result 形如 { status, ...rest }
//   失败时 throw Error，可带 err.status （HTTP code）以便区分 4xx / 5xx / 网络错。
// - 连续 maxFailures 次网络错（无 HTTP status 的 reject）→ 报 networkError 并停。
// - HTTP 4xx → 报 clientError，message 用后端返回的 error.message。
// - HTTP 5xx → 报 serverError。
// - 攒到 maxAttempts → 报 timeout。
// - 拿到终态（confirmed / expired / failed）→ 报 done。
//
// 状态回调 onUpdate({ type, ... }) 类型：
//   { type: 'status', status, data, attempts }     —— 每次成功轮询
//   { type: 'done', status, data, attempts }       —— 终态，已 stop
//   { type: 'error', kind, message?, httpStatus?, attempts } —— 已 stop
//     kind ∈ 'networkError' | 'clientError' | 'serverError' | 'timeout'

const TERMINAL_STATUSES = new Set(['confirmed', 'expired', 'failed'])

export function createPoller({
  fetch,
  intervalMs = 2000,
  maxAttempts = 60,
  maxFailures = 3,
  onUpdate,
  setTimeoutFn,
  clearTimeoutFn,
} = {}) {
  if (typeof fetch !== 'function') {
    throw new TypeError('createPoller: fetch must be a function')
  }
  if (typeof onUpdate !== 'function') {
    throw new TypeError('createPoller: onUpdate must be a function')
  }
  const setT = typeof setTimeoutFn === 'function'
    ? setTimeoutFn
    : (typeof setTimeout === 'function' ? setTimeout : null)
  const clearT = typeof clearTimeoutFn === 'function'
    ? clearTimeoutFn
    : (typeof clearTimeout === 'function' ? clearTimeout : null)
  if (!setT) throw new TypeError('createPoller: setTimeout unavailable')

  let timer = null
  let attempts = 0
  let failuresInRow = 0
  let stopped = false
  let started = false

  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer && clearT) clearT(timer)
    timer = null
  }

  const schedule = () => {
    if (stopped) return
    timer = setT(tick, intervalMs)
  }

  const safeEmit = (payload) => {
    try { onUpdate(payload) } catch { /* 调用方异常吞掉 —— 轮询不被监听者击落 */ }
  }

  async function tick() {
    if (stopped) return
    attempts += 1
    try {
      const result = await fetch()
      if (stopped) return
      failuresInRow = 0
      const status = (result && typeof result === 'object' && result.status) || 'pending'
      safeEmit({ type: 'status', status, data: result, attempts })
      if (TERMINAL_STATUSES.has(status)) {
        stop()
        safeEmit({ type: 'done', status, data: result, attempts })
        return
      }
      if (attempts >= maxAttempts) {
        stop()
        safeEmit({ type: 'error', kind: 'timeout', attempts })
        return
      }
      schedule()
    } catch (err) {
      if (stopped) return
      const httpStatus = Number(err && err.status) || 0
      if (httpStatus >= 400 && httpStatus < 500) {
        stop()
        safeEmit({
          type: 'error',
          kind: 'clientError',
          message: (err && err.message) || '',
          httpStatus,
          attempts,
        })
        return
      }
      if (httpStatus >= 500 && httpStatus < 600) {
        stop()
        safeEmit({
          type: 'error',
          kind: 'serverError',
          message: (err && err.message) || '',
          httpStatus,
          attempts,
        })
        return
      }
      failuresInRow += 1
      if (failuresInRow >= maxFailures) {
        stop()
        safeEmit({
          type: 'error',
          kind: 'networkError',
          message: (err && err.message) || '',
          attempts,
        })
        return
      }
      if (attempts >= maxAttempts) {
        stop()
        safeEmit({ type: 'error', kind: 'timeout', attempts })
        return
      }
      schedule()
    }
  }

  const start = () => {
    if (started || stopped) return
    started = true
    schedule()
  }

  return {
    start,
    stop,
    get isStopped() { return stopped },
    get attempts() { return attempts },
  }
}

export const __testing__ = { TERMINAL_STATUSES }
