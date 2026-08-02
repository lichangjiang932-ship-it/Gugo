const CONTEXT_USAGE_STORAGE_KEY = 'yma:chat:context-usage-visible'

function readBoolean(key, fallback) {
  if (typeof window === 'undefined') return fallback
  try {
    const stored = window.localStorage.getItem(key)
    return stored == null ? fallback : stored === '1'
  } catch {
    return fallback
  }
}

function writeBoolean(key, value) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // Preferences remain usable when storage is unavailable.
  }
}

export function readContextUsageVisible() {
  return readBoolean(CONTEXT_USAGE_STORAGE_KEY, false)
}

export function writeContextUsageVisible(value) {
  writeBoolean(CONTEXT_USAGE_STORAGE_KEY, value)
}
