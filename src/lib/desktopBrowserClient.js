/**
 * The desktop shell can host a real Chromium view docked beside the page, which
 * is the only way to show sites that refuse to be embedded in a frame. The web
 * build has no such host, so callers must ask rather than assume, and the panel
 * falls back to an iframe with the honest limitation that comes with it.
 */
export function getDesktopBrowserHost() {
  const host = globalThis.window?.gugoDesktop?.browser
  return host && typeof host.navigate === 'function' ? host : null
}

export function isDesktopBrowserAvailable() {
  return getDesktopBrowserHost() !== null
}
