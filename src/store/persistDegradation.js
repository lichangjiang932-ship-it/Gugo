// 把"逐步降级写入 localStorage"的策略独立到 .js 文件,便于 node:test 直接 import
// (jsx 文件 node 默认 loader 不认识).
// 调用方需要传入 STORAGE_KEY 和 setItem,默认 STORAGE_KEY 与 AppContext 保持一致.

export const DEFAULT_STORAGE_KEY = 'your-model-atelier:state:v1'

// ★ #35 敏感字段黑名单:任何对象层级里出现这些 key 名,序列化前替换为 '[REDACTED]'
//    用来防御性兜底:即便上游 toolCall result / 第三方 API 响应不小心带进了 token,
//    也不会被同步到 localStorage 里被另一个会话/账号读到.
//    用户密码 / API Key 不在 state 里(token 走独立键 your-model-atelier:auth-token),
//    这里覆盖的是"未来字段不小心漏进 PERSIST 树"的回归风险.
const SENSITIVE_KEY_PATTERNS = [
  /^authorization$/i,
  /^auth[-_]?token$/i,
  /^access[-_]?token$/i,
  /^refresh[-_]?token$/i,
  /^password$/i,
  /^passwd$/i,
  /^secret$/i,
  /^api[-_]?key$/i,
  /^private[-_]?key$/i,
  /^client[-_]?secret$/i,
  /^session[-_]?key$/i,
  /^cookie$/i,
  /^set[-_]?cookie$/i,
]

const REDACTED = '[REDACTED]'

export function sanitizeForPersist(value, depth = 0) {
  // 防御性深度限制,避免环引用 / 异常深结构爆栈
  if (depth > 12) return value
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => sanitizeForPersist(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERNS.some((re) => re.test(k))) {
      out[k] = REDACTED
    } else {
      out[k] = sanitizeForPersist(v, depth + 1)
    }
  }
  return out
}

const isQuotaError = (err) =>
  err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014 || /quota/i.test(err.message || ''))

export function persistWithDegradation(snapshot, setItem, storageKey = DEFAULT_STORAGE_KEY) {
  // ★ #35: 入口先做一遍敏感字段 redact
  let payload = sanitizeForPersist(snapshot)
  try {
    setItem(storageKey, JSON.stringify(payload))
    return { ok: true, level: 'full' }
  } catch (err) { if (!isQuotaError(err)) return { ok: false, level: 'error', error: err } }

  try {
    payload = {
      ...payload,
      sessions: (payload.sessions || []).map((s) => ({
        ...s,
        messages: Array.isArray(s.messages) && s.messages.length > 50 ? s.messages.slice(-50) : s.messages,
      })),
    }
    setItem(storageKey, JSON.stringify(payload))
    return { ok: true, level: 'truncated-messages' }
  } catch (err) { if (!isQuotaError(err)) return { ok: false, level: 'error', error: err } }

  try {
    const sessions = (payload.sessions || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 5)
    payload = { ...payload, sessions }
    setItem(storageKey, JSON.stringify(payload))
    return { ok: true, level: 'recent-sessions-only' }
  } catch (err) { if (!isQuotaError(err)) return { ok: false, level: 'error', error: err } }

  try {
    payload = { ...payload, history: [] }
    setItem(storageKey, JSON.stringify(payload))
    return { ok: true, level: 'no-history' }
  } catch (err) { if (!isQuotaError(err)) return { ok: false, level: 'error', error: err } }

  try {
    const minimal = { ...payload, sessions: [], history: [], tasks: [] }
    setItem(storageKey, JSON.stringify(minimal))
    return { ok: true, level: 'minimal' }
  } catch (err) {
    return { ok: false, level: 'error', error: err }
  }
}
