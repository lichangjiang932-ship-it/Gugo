/**
 * Page facts for previews whose content lives in this app's own document.
 *
 * The docked desktop view can be scripted through the shell. A browser build has
 * no such host, and most previews put their document behind a sandbox — an HTML
 * file, a Word layout, an artifact — where nothing outside may reach it. But a
 * PPTX slide, an image and rendered Markdown are drawn into this app's own tree,
 * so for those the content is right here: the picker and the screenshot act on
 * it directly, with no host and without loosening any frame's sandbox.
 *
 * A frame-based preview is deliberately out of scope. Pointing at a frame would
 * name the frame rather than what the reader sees, so those report unavailable
 * and the toolbar keeps saying so instead of pretending.
 */

const PREVIEW_ROOT_SELECTOR = '.chat-direct-file-content'

/** The element holding in-app-rendered preview content, or null when the
 *  current preview is frame-based or nothing is open. */
export function inAppPreviewRoot(root = globalThis.document) {
  const element = root?.querySelector?.(PREVIEW_ROOT_SELECTOR)
  if (!element) return null
  // An iframe here means the preview keeps its document elsewhere — an opaque
  // origin we cannot read, and a frame is not the thing the reader pointed at.
  if (element.querySelector('iframe')) return null
  return element
}

export function isInAppPreviewAvailable(root = globalThis.document) {
  return inAppPreviewRoot(root) !== null
}

const escapeSelector = (value) => {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

/**
 * The shortest selector that matches this element alone, preferring an id, then
 * the tag with its classes — the same answer the page-side picker gives, so a
 * reader pasting either into a message gets the same shape.
 */
export function selectorForElement(element, document_ = globalThis.document) {
  if (element.id) {
    const byId = `#${escapeSelector(element.id)}`
    if (document_.querySelectorAll(byId).length === 1) return byId
  }
  const parts = []
  let node = element
  while (node && node.nodeType === 1 && parts.length < 4) {
    let part = node.tagName.toLowerCase()
    if (node.classList?.length) {
      part += [...node.classList].slice(0, 2).map((name) => `.${escapeSelector(name)}`).join('')
    }
    const parent = node.parentElement
    if (parent) {
      const siblings = [...parent.children].filter((child) => child.tagName === node.tagName)
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`
    }
    parts.unshift(part)
    const candidate = parts.join(' > ')
    if (document_.querySelectorAll(candidate).length === 1) return candidate
    node = node.parentElement
  }
  return parts.join(' > ')
}

export function describeElement(element, document_ = globalThis.document) {
  const rect = element.getBoundingClientRect()
  return {
    selector: selectorForElement(element, document_),
    tag: element.tagName.toLowerCase(),
    id: element.id || '',
    text: String(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

/** The app-side picker, so a mid-pick unmount or a second press can take it down. */
let cancelActivePicker = null

export function cancelInAppPreviewElementPick() {
  cancelActivePicker?.()
  return true
}

/**
 * Point at preview content and have the app name it.
 *
 * The listeners are on the app's own document in the capture phase, so the click
 * reaches us before the element's own handlers — and anything outside the
 * preview root is ignored, so the reader cannot pick this app's chrome.
 */
export function pickInAppPreviewElement({
  root = inAppPreviewRoot(),
  document_ = globalThis.document,
  theme = {},
  timeoutMs = 60_000,
} = {}) {
  if (!root) return Promise.resolve({ ok: false, reason: 'unsupported' })
  const { accentRgb = '', tooltipBg = '', tooltipFg = '' } = theme

  const outline = document_.createElement('div')
  outline.setAttribute('data-gugo-picker', 'outline')
  Object.assign(outline.style, {
    position: 'fixed', zIndex: '2147483646', pointerEvents: 'none',
    border: `2px solid rgb(${accentRgb})`, background: `rgb(${accentRgb} / 0.12)`,
    borderRadius: '2px', transition: 'all 60ms linear', display: 'none',
  })
  const label = document_.createElement('div')
  label.setAttribute('data-gugo-picker', 'label')
  Object.assign(label.style, {
    position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
    background: tooltipBg, color: tooltipFg, font: '12px/1.4 ui-monospace, monospace',
    padding: '2px 6px', borderRadius: '4px', whiteSpace: 'nowrap', display: 'none',
  })
  document_.body.appendChild(outline)
  document_.body.appendChild(label)

  return new Promise((resolve) => {
    let done = false
    let timer = null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      outline.remove()
      label.remove()
      document_.removeEventListener('mousemove', onMove, true)
      document_.removeEventListener('click', onClick, true)
      document_.removeEventListener('keydown', onKey, true)
      cancelActivePicker = null
    }
    const finish = (value) => {
      if (done) return
      done = true
      cleanup()
      resolve(value)
    }
    // A reader who wanders off is released by the timeout; the overlay comes down
    // either way so the preview is left as it was found.
    timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs)
    cancelActivePicker = () => finish({ ok: false, reason: 'cancelled' })

    const inside = (node) => node && node !== root && root.contains(node)
    const onMove = (event) => {
      const element = event.target
      if (!inside(element)) {
        outline.style.display = 'none'
        label.style.display = 'none'
        return
      }
      const rect = element.getBoundingClientRect()
      Object.assign(outline.style, {
        display: 'block',
        top: `${rect.top}px`, left: `${rect.left}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
      })
      label.textContent = selectorForElement(element, document_)
      label.style.display = 'block'
      label.style.top = `${Math.max(0, rect.top - 20)}px`
      label.style.left = `${rect.left}px`
    }
    const onClick = (event) => {
      const element = event.target
      if (!inside(element)) return
      event.preventDefault()
      event.stopPropagation()
      finish({ ok: true, picked: describeElement(element, document_) })
    }
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      finish({ ok: false, reason: 'cancelled' })
    }
    document_.addEventListener('mousemove', onMove, true)
    document_.addEventListener('click', onClick, true)
    document_.addEventListener('keydown', onKey, true)
  })
}

/**
 * Save what an in-app preview is showing, from this app's own tree.
 *
 * `html-to-image` serialises the element as it is drawn, which is how the deck
 * export already captures slides; reaching for the same tool keeps one answer
 * for "a picture of this element" rather than two.
 */
export async function captureInAppPreview({ root = inAppPreviewRoot(), backgroundColor = '' } = {}) {
  if (!root) return { ok: false, reason: 'unsupported' }
  try {
    const { toPng } = await import('html-to-image')
    const rect = root.getBoundingClientRect()
    const dataUrl = await toPng(root, {
      pixelRatio: globalThis.devicePixelRatio || 1,
      ...(backgroundColor ? { backgroundColor } : {}),
    })
    return { ok: true, dataUrl, width: Math.round(rect.width), height: Math.round(rect.height) }
  } catch (error) {
    return { ok: false, reason: 'capture-failed', message: String(error?.message || error) }
  }
}
