/**
 * Policy for the docked browser view, kept separate from the Electron wiring so
 * it can be verified without an Electron runtime.
 *
 * Everything here is enforced in the main process. The renderer validates the
 * address bar too, but that check is a convenience for the reader — a compromised
 * page could ask for anything, so the main process decides again on its own.
 */
export const BROWSER_VIEW_PARTITION = 'persist:gugo-browser'
export const MAX_BROWSER_URL_LENGTH = 2_048

/**
 * The web preferences for the docked view.
 *
 * This is a view of the open internet, so it gets none of the app's privileges:
 * its own storage partition means it cannot read the app's session, and node is
 * off with the sandbox on, exactly as for the app window itself.
 */
export const BROWSER_VIEW_WEB_PREFERENCES = Object.freeze({
  partition: BROWSER_VIEW_PARTITION,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
})

/**
 * Accept only a plain HTTP(S) address with no embedded credentials.
 *
 * A URL carrying a username or password is refused rather than stripped: the
 * reader would otherwise believe they were browsing the address they typed while
 * the view was actually somewhere else.
 */
export function isAllowedBrowserUrl(value) {
  const input = String(value ?? '').trim()
  if (!input || input.length > MAX_BROWSER_URL_LENGTH) return false
  if (Array.from(input).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false
  let url
  try {
    url = new URL(input)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  return true
}

/**
 * The rectangle to dock the view onto, or null when it must stay hidden.
 *
 * A view docked onto a zero-area or off-window rectangle would still paint, and
 * because it is a native surface above the page it would paint over whatever the
 * reader is actually looking at. Refusing those rectangles is what makes hiding
 * the view on a tab switch reliable.
 */
export function clampBrowserBounds(rect, { contentWidth, contentHeight } = {}) {
  if (!rect || typeof rect !== 'object') return null
  const width = Math.round(Number(rect.width))
  const height = Math.round(Number(rect.height))
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null
  const maxWidth = Math.round(Number(contentWidth))
  const maxHeight = Math.round(Number(contentHeight))
  if (!Number.isFinite(maxWidth) || !Number.isFinite(maxHeight) || maxWidth < 1 || maxHeight < 1) return null

  const x = Math.max(0, Math.round(Number(rect.x) || 0))
  const y = Math.max(0, Math.round(Number(rect.y) || 0))
  const boundedWidth = Math.min(width, Math.max(0, maxWidth - x))
  const boundedHeight = Math.min(height, Math.max(0, maxHeight - y))
  if (boundedWidth < 1 || boundedHeight < 1) return null
  return { x, y, width: boundedWidth, height: boundedHeight }
}
