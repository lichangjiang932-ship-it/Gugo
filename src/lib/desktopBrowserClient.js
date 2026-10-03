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

/**
 * Whether this host can report what the page shows. A host that only navigates
 * (an older shell, or the web build) cannot answer, and the preview says so
 * rather than pretending a screenshot arrived.
 */
export function isDesktopPageFactsAvailable() {
  const host = getDesktopBrowserHost()
  return typeof host?.capture === 'function' && typeof host?.evaluate === 'function'
}

export function captureDesktopPreview({ host = getDesktopBrowserHost() } = {}) {
  if (typeof host?.capture !== 'function') return Promise.resolve({ ok: false, reason: 'unsupported' })
  return host.capture()
}

export function evaluateInDesktopPreview(script, { host = getDesktopBrowserHost() } = {}) {
  if (typeof host?.evaluate !== 'function') return Promise.resolve({ ok: false, reason: 'unsupported' })
  return host.evaluate(script)
}

export function readDesktopPreviewConsole(options = {}, { host = getDesktopBrowserHost() } = {}) {
  if (typeof host?.consoleEntries !== 'function') return Promise.resolve({ ok: false, reason: 'unsupported' })
  return host.consoleEntries(options)
}
