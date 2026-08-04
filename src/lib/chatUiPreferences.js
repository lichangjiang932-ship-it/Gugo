const CONTEXT_USAGE_STORAGE_KEY = 'yma:chat:context-usage-visible'
const WORKBENCH_OPEN_STORAGE_KEY = 'yma:chat:workbench-open'
const DESKTOP_PET_VISIBLE_STORAGE_KEY = 'yma:chat:desktop-pet-visible'

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

export function readWorkbenchOpen() {
  return readBoolean(WORKBENCH_OPEN_STORAGE_KEY, false)
}

export function writeWorkbenchOpen(value) {
  writeBoolean(WORKBENCH_OPEN_STORAGE_KEY, value)
}

export function readDesktopPetVisible() {
  return readBoolean(DESKTOP_PET_VISIBLE_STORAGE_KEY, false)
}

export function writeDesktopPetVisible(value) {
  writeBoolean(DESKTOP_PET_VISIBLE_STORAGE_KEY, value)
}
