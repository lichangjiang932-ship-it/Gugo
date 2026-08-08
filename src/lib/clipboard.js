export async function copyTextToClipboard(value, options = {}) {
  const text = String(value ?? '')
  const navigatorObject = options.navigatorObject ?? globalThis.navigator
  const documentObject = options.documentObject ?? globalThis.document
  const desktopBridge = options.desktopBridge ?? globalThis.window?.gugoDesktop
  const clipboard = navigatorObject?.clipboard

  if (typeof desktopBridge?.writeClipboardText === 'function') {
    try {
      await desktopBridge.writeClipboardText(text)
      return true
    } catch {
      // Continue through browser fallbacks if the desktop bridge is stale.
    }
  }

  if (typeof clipboard?.writeText === 'function') {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Browsers and embedded webviews may expose Clipboard API while denying
      // it at runtime. Keep the same user gesture and fall back to selection.
    }
  }

  if (!documentObject?.body || typeof documentObject.createElement !== 'function') {
    throw new Error('Clipboard is unavailable')
  }

  const textarea = documentObject.createElement('textarea')
  const activeElement = documentObject.activeElement
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  Object.assign(textarea.style, {
    position: 'fixed',
    inset: '0 auto auto -9999px',
    opacity: '0',
    pointerEvents: 'none',
  })
  documentObject.body.appendChild(textarea)

  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange?.(0, text.length)
    if (documentObject.execCommand?.('copy') !== true) throw new Error('Clipboard copy failed')
    return true
  } finally {
    textarea.remove()
    try {
      activeElement?.focus?.({ preventScroll: true })
    } catch {
      activeElement?.focus?.()
    }
  }
}
