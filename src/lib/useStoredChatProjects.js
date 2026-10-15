import { useCallback, useSyncExternalStore } from 'react'
import { CHAT_PROJECTS_CHANGED_EVENT, CHAT_PROJECTS_STORAGE_KEY, readStoredChatProjects } from './chatWorkspaceSelection.js'

const EMPTY = Object.freeze([])
let cachedRaw = null
let cachedProjects = EMPTY

function snapshot() {
  let storage, raw
  try { storage = globalThis.window?.localStorage; raw = storage?.getItem(CHAT_PROJECTS_STORAGE_KEY) ?? null } catch { return EMPTY }
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cachedProjects = raw === null ? EMPTY : readStoredChatProjects(storage)
  }
  return cachedProjects
}

/** Legacy project storage is local-profile data, never a multi-user catalog or an authorization grant. */
export default function useStoredChatProjects(enabled) {
  const subscribe = useCallback((listener) => {
    if (!enabled || !globalThis.window) return () => {}
    const changed = (event) => { if (!event.key || event.key === CHAT_PROJECTS_STORAGE_KEY) listener() }
    window.addEventListener(CHAT_PROJECTS_CHANGED_EVENT, changed)
    window.addEventListener('storage', changed)
    return () => { window.removeEventListener(CHAT_PROJECTS_CHANGED_EVENT, changed); window.removeEventListener('storage', changed) }
  }, [enabled])
  return useSyncExternalStore(subscribe, () => enabled ? snapshot() : EMPTY, () => EMPTY)
}
