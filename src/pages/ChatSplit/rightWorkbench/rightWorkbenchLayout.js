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

export function normalizeBrowserUrl(value) {
  const input = String(value || '').trim()
  if (!input || input.includes('\\') || isLocalWorkbenchPath(input)) return ''
  if (Array.from(input).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return ''
  const explicitHttp = /^https?:\/\//i.test(input)
  const hostWithPort = /^(?:localhost|[a-z\d.-]+\.[a-z\d.-]+):\d+(?:[/?#]|$)/i.test(input)
  if (!explicitHttp && /^[a-z][a-z\d+.-]*:/i.test(input) && !hostWithPort) return ''
  try {
    const url = new URL(explicitHttp ? input : `https://${input}`)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}

export function isLocalWorkbenchPath(value) {
  return /^(?:file:|[a-z]:|[\\/]|\.{1,2}[\\/]|~[\\/])/i.test(String(value || '').trim())
}
