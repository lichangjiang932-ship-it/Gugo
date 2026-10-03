export const DEFAULT_WIDTH = 420
export const MIN_WIDTH = 320
export const WIDTH_STORAGE_KEY = 'yma:right-workbench-width'

export function clampWidth(value) {
  const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth
  const maxWidth = Math.max(MIN_WIDTH, Math.min(760, viewportWidth - 320))
  return Math.min(maxWidth, Math.max(MIN_WIDTH, Number(value) || DEFAULT_WIDTH))
}

export function readStoredWidth() {
  if (typeof window === 'undefined') return DEFAULT_WIDTH
  try {
    return clampWidth(window.localStorage.getItem(WIDTH_STORAGE_KEY))
  } catch {
    return DEFAULT_WIDTH
  }
}
