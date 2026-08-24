import { estimatePersistedSnapshotBytes } from '../../store/indexedDbPersistence.js'

export function getLocalStorageBytes() {
  if (typeof window === 'undefined') return 0
  let total = 0
  try {
    for (const key of Object.keys(window.localStorage)) {
      const value = window.localStorage.getItem(key) || ''
      total += key.length + value.length
    }
  } catch (error) {
    console.warn('[SettingsView] localStorage unavailable:', error?.name || error)
    return 0
  }
  return total * 2
}

export async function getBrowserStorageEstimate() {
  const localStorageBytes = getLocalStorageBytes()
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate()
      if (Number.isFinite(estimate?.usage)) {
        return {
          usage: estimate.usage,
          quota: Number.isFinite(estimate.quota) ? estimate.quota : null,
        }
      }
    }
  } catch {
    // Fall back to application-owned storage below.
  }
  const indexedDb = await estimatePersistedSnapshotBytes()
  return {
    usage: localStorageBytes + (indexedDb.ok ? indexedDb.bytes : 0),
    quota: null,
  }
}
