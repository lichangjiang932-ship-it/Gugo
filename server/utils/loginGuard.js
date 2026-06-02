/**
 * 登录限流加固 (C-P2.5)。
 *
 * 两个问题:
 *   1. clientId 取 x-forwarded-for(客户端可伪造)→ 撞库/枚举可绕过 IP 限流。
 *      改为:默认只信 socket.remoteAddress;仅当显式配置 TRUST_PROXY=1(站在可信反代后)
 *      才采信 XFF 链最左侧(client 端)的 IP。
 *   2. 密码登录与发码共用同一窗口 → 改密码可能误伤正常发码,且失败计数混在一起。
 *      改为:密码登录失败按【账号(email)维度】单独计数,N 次失败锁定 M 分钟,与发码限流分离。
 *
 * 进程内存级(与 rateLimiter 一致;多 worker 需上 Redis)。
 */

const MAX_PASSWORD_FAILURES = 5
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000

// email → { count, firstAt }
const failures = new Map()

/**
 * 解析可信 client IP。
 * 默认不信 x-forwarded-for(可伪造)。只有 TRUST_PROXY=1 时才采信 XFF 最左侧 hop。
 */
export function resolveClientId(req, env = process.env) {
  const trustProxy = String(env.TRUST_PROXY || '').toLowerCase() === '1' ||
    String(env.TRUST_PROXY || '').toLowerCase() === 'true'
  if (trustProxy) {
    const xff = req.headers?.['x-forwarded-for']
    if (xff) {
      const first = String(xff).split(',')[0].trim()
      if (first) return first
    }
  }
  return req.socket?.remoteAddress || 'unknown'
}

function prune(entry, now) {
  if (entry && now() - entry.firstAt >= LOCKOUT_WINDOW_MS) return null
  return entry
}

export function recordPasswordFailure(email, { now = Date.now } = {}) {
  const key = String(email || '').trim().toLowerCase()
  if (!key) return
  let entry = prune(failures.get(key), now)
  if (!entry) entry = { count: 0, firstAt: now() }
  entry.count += 1
  failures.set(key, entry)
}

export function isAccountLocked(email, { now = Date.now } = {}) {
  const key = String(email || '').trim().toLowerCase()
  if (!key) return false
  const entry = prune(failures.get(key), now)
  if (!entry) {
    failures.delete(key)
    return false
  }
  return entry.count >= MAX_PASSWORD_FAILURES
}

export function clearPasswordFailures(email) {
  const key = String(email || '').trim().toLowerCase()
  if (key) failures.delete(key)
}

// 测试用
export function _resetLoginGuard() {
  failures.clear()
}
