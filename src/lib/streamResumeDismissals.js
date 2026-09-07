export const STREAM_RESUME_DISMISSALS_KEY = 'gugo:stream-resume-dismissals:v1'
export const STREAM_RESUME_DISMISSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_STREAM_RESUME_DISMISSALS = 128
const MAX_STORAGE_LENGTH = 128 * 1024
const MAX_ID_LENGTH = 1024

function boundedString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

export function streamResumeOwnerScope(state) {
  const userId = state?.user?.id
  const backendId = state?.sessionCatalogSource?.backendInstanceId
  return state?.isLoggedIn === true && boundedString(userId) && boundedString(backendId)
    ? JSON.stringify([backendId, userId])
    : null
}

export function pruneStreamResumeDismissals(entries, now = Date.now()) {
  const unique = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!boundedString(entry?.scope) || !boundedString(entry?.key)
      || !Number.isFinite(entry?.expiresAt) || entry.expiresAt <= now
      || entry.expiresAt > now + STREAM_RESUME_DISMISSAL_TTL_MS) continue
    const identity = JSON.stringify([entry.scope, entry.key])
    if ((unique.get(identity)?.expiresAt || 0) <= entry.expiresAt) {
      unique.set(identity, { scope: entry.scope, key: entry.key, expiresAt: entry.expiresAt })
    }
  }
  return [...unique.values()].sort((a, b) => a.expiresAt - b.expiresAt)
    .slice(-MAX_STREAM_RESUME_DISMISSALS)
}

export function readStreamResumeDismissals(storage, now = Date.now()) {
  try {
    const raw = storage?.getItem(STREAM_RESUME_DISMISSALS_KEY)
    if (!raw || raw.length > MAX_STORAGE_LENGTH) return []
    const parsed = JSON.parse(raw)
    return parsed?.version === 1 ? pruneStreamResumeDismissals(parsed.entries, now) : []
  } catch {
    return []
  }
}

export function writeStreamResumeDismissal(storage, { scope, key }, now = Date.now()) {
  if (!boundedString(scope) || !boundedString(key)) return false
  try {
    if (!storage) return false
    const entries = pruneStreamResumeDismissals([
      ...readStreamResumeDismissals(storage, now),
      { scope, key, expiresAt: now + STREAM_RESUME_DISMISSAL_TTL_MS },
    ], now)
    storage.setItem(STREAM_RESUME_DISMISSALS_KEY, JSON.stringify({ version: 1, entries }))
    return true
  } catch {
    return false
  }
}
