import { useEffect, useSyncExternalStore } from 'react'
const records = new Map(), listeners = new Set()
const notify = () => { for (const listener of listeners) listener() }
export function browserOutputKey(ownerScope, sessionId, msg) {
  const startedAt = msg?.meta?.modelTiming?.startedAt
  return msg?.role === 'assistant' && Number.isFinite(startedAt) && startedAt > 0
    ? JSON.stringify([ownerScope ?? null, sessionId ?? null, msg.id, msg.meta.modelRequestId ?? null, msg.meta.modelPhysicalAttempt ?? null, startedAt]) : null
}
export function observeBrowserOutput(key, phase, now) {
  if (!key || !Number.isFinite(now) || now < 0) return
  const current = records.get(key)
  if (phase === 'start' && !current) records.set(key, { startedAt: now, paintOpportunityMs: null })
  else if (phase === 'paint' && current && current.paintOpportunityMs === null && now >= current.startedAt) {
    records.set(key, { ...current, paintOpportunityMs: now - current.startedAt })
  } else return
  while (records.size > 128) records.delete(records.keys().next().value)
  notify()
}
export const readBrowserOutput = key => records.get(key) ?? null
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
export function useBrowserOutputTiming(key) {
  return useSyncExternalStore(subscribe, () => readBrowserOutput(key), () => null)
}

/** Visible DOM + two RAFs measure a paint opportunity, not physical screen presentation. */
export function useRecordBrowserOutput(ref, msg, streaming, ownerScope, sessionId) {
  const key = browserOutputKey(ownerScope, sessionId, msg)
  const publicAt = msg?.meta?.modelTiming?.firstPublicAt
  useEffect(() => {
    if (!key || typeof window.requestAnimationFrame !== 'function' || document.visibilityState === 'hidden') return undefined
    if (streaming && !publicAt) observeBrowserOutput(key, 'start', performance.now())
    if (!publicAt || !records.has(key)) return undefined
    let first, second
    first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        const root = ref.current, output = root?.querySelector('.chat-markdown')
        if (!output?.textContent?.trim() || !output.isConnected || root.closest('[inert],[aria-hidden="true"]') || document.visibilityState === 'hidden') return
        const rect = output.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= window.innerHeight) return
        const top = document.elementFromPoint?.(Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2)), Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2)))
        if (top && !root.contains(top)) return
        observeBrowserOutput(key, 'paint', performance.now())
      })
    })
    return () => { window.cancelAnimationFrame(first); if (second !== undefined) window.cancelAnimationFrame(second) }
  }, [key, publicAt, ref, streaming])
}
