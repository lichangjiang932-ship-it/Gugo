// 把"逐步降级写入 localStorage"的策略独立到 .js 文件,便于 node:test 直接 import
// (jsx 文件 node 默认 loader 不认识).
// 调用方需要传入 STORAGE_KEY 和 setItem,默认 STORAGE_KEY 与 AppContext 保持一致.

export const DEFAULT_STORAGE_KEY = 'your-model-atelier:state:v1'

const isQuotaError = (err) =>
  err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014 || /quota/i.test(err.message || ''))

export function persistWithDegradation(snapshot, setItem, storageKey = DEFAULT_STORAGE_KEY) {
  let payload = { ...snapshot }
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
