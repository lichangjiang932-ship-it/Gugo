import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MAX_STREAM_RESUME_DISMISSALS,
  STREAM_RESUME_DISMISSALS_KEY,
  STREAM_RESUME_DISMISSAL_TTL_MS,
  readStreamResumeDismissals,
  writeStreamResumeDismissal,
} from '../../lib/streamResumeDismissals.js'

function browserStorage() {
  try { return globalThis.window?.localStorage } catch { return null }
}

export default function useStreamResumeDismissals(scope) {
  const fallbackRef = useRef({ scope: null, entries: new Map() })
  const [revision, setRevision] = useState(0)
  const memory = useCallback(() => {
    if (fallbackRef.current.scope !== scope) fallbackRef.current = { scope, entries: new Map() }
    const entries = fallbackRef.current.entries
    for (const [key, expiresAt] of entries) if (expiresAt <= Date.now()) entries.delete(key)
    return entries
  }, [scope])
  const readKeys = useCallback(() => new Set([
    ...memory().keys(),
    ...(scope ? readStreamResumeDismissals(browserStorage())
      .filter((entry) => entry.scope === scope).map((entry) => entry.key) : []),
  ]), [memory, scope])
  const remember = useCallback((key) => {
    if (!key) return
    const entries = memory()
    if (scope && writeStreamResumeDismissal(browserStorage(), { scope, key })) entries.delete(key)
    else {
      entries.delete(key)
      entries.set(key, Date.now() + STREAM_RESUME_DISMISSAL_TTL_MS)
      while (entries.size > MAX_STREAM_RESUME_DISMISSALS) entries.delete(entries.keys().next().value)
    }
    setRevision((current) => current + 1)
  }, [memory, scope])
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === null || event.key === STREAM_RESUME_DISMISSALS_KEY) {
        setRevision((current) => current + 1)
      }
    }
    globalThis.window?.addEventListener('storage', onStorage)
    return () => globalThis.window?.removeEventListener('storage', onStorage)
  }, [])
  useEffect(() => {
    const expirations = [
      ...memory().values(),
      ...(scope ? readStreamResumeDismissals(browserStorage())
        .filter((entry) => entry.scope === scope).map((entry) => entry.expiresAt) : []),
    ]
    if (!expirations.length) return undefined
    // Browser timers clamp delays above ~24 days; recheck in bounded slices
    // so a continuously open chat also honours the 30-day expiry.
    const delay = Math.min(2_147_483_647, Math.max(1, Math.min(...expirations) - Date.now() + 1))
    const timer = setTimeout(() => setRevision((current) => current + 1), delay)
    return () => clearTimeout(timer)
  }, [memory, revision, scope])
  return { readKeys, remember, revision }
}
