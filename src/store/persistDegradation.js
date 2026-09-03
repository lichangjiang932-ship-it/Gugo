// 把"逐步降级写入 localStorage"的策略独立到 .js 文件,便于 node:test 直接 import
// (jsx 文件 node 默认 loader 不认识).
// 调用方需要传入 STORAGE_KEY 和 setItem,默认 STORAGE_KEY 与 AppContext 保持一致.

import { sanitizeRetiredBrowserAccountFields } from './browserSnapshotSanitizer.js'

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
const OMITTED_FOR_STORAGE = '[OMITTED: local storage capacity]'
const BULKY_CACHE_KEYS = new Set([
  'base64',
  'binary',
  'bytes',
  'dataUrl',
  'data_url',
  'previewHtml',
  'raw',
  'rawData',
  'thumbnailDataUrl',
])

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

function compactCachePayload(value, depth = 0) {
  if (depth > 12 || value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((entry) => compactCachePayload(entry, depth + 1))
  const next = {}
  for (const [key, entry] of Object.entries(value)) {
    if (BULKY_CACHE_KEYS.has(key) && (typeof entry === 'string' ? entry.length > 1024 : entry != null)) {
      next[key] = OMITTED_FOR_STORAGE
    } else if (key === 'reasoning' && typeof entry === 'string' && entry.length > 8_000) {
      next[key] = `${entry.slice(0, 8_000)}\n${OMITTED_FOR_STORAGE}`
    } else if (key === 'result' && typeof entry === 'string' && entry.length > 16_000) {
      next[key] = `${entry.slice(0, 16_000)}\n${OMITTED_FOR_STORAGE}`
    } else {
      next[key] = compactCachePayload(entry, depth + 1)
    }
  }
  return next
}

export function compactSnapshotMetadata(snapshot) {
  // Session transcripts are removed by the persistence sanitizer. Compact
  // regenerable cache fields wherever they appear without recreating a
  // browser-owned `sessions` collection during quota fallback.
  return compactCachePayload(snapshot)
}

export function persistWithDegradation(snapshot, setItem, storageKey = DEFAULT_STORAGE_KEY) {
  // ★ #35: 入口先做一遍敏感字段 redact
  let payload = sanitizeForPersist(sanitizeRetiredBrowserAccountFields(snapshot, {
    preservePendingLegacySessions: true,
  }).payload)
  try {
    setItem(storageKey, JSON.stringify(payload))
    return { ok: true, level: 'full' }
  } catch (err) { if (!isQuotaError(err)) return { ok: false, level: 'error', error: err } }

  try {
    payload = compactSnapshotMetadata(payload)
    setItem(storageKey, JSON.stringify(payload))
    return { ok: true, level: 'compact-metadata', requiresUserAction: true }
  } catch (err) {
    if (!isQuotaError(err)) return { ok: false, level: 'error', error: err }
    // A failed setItem leaves the previous complete snapshot intact.
    return { ok: false, level: 'quota', error: err, requiresUserAction: true }
  }
}
