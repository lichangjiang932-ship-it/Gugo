/**
 * The scripts the preview runs inside the page it is showing.
 *
 * Built here, in the app, rather than sent as script text by the backend: the
 * agent asks for "the DOM" or "click that selector", and this module decides what
 * that means. A selector or a text value is JSON-encoded into the script, so a
 * value can never end a string and become code — the page is the reader's own
 * dev server, and it is still not allowed to be the thing that decides what the
 * app evaluates.
 */

/** A short, structured description of the page: enough to verify, not the whole DOM. */
export const DOM_SUMMARY_SCRIPT = `(() => {
  const root = document.body || document.documentElement
  const text = (node) => String(node && node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200)
  const visible = (node) => {
    if (!node || typeof node.getBoundingClientRect !== 'function') return false
    const rect = node.getBoundingClientRect()
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null
    return rect.width > 0 && rect.height > 0 && (!style || (style.visibility !== 'hidden' && style.display !== 'none'))
  }
  const describe = (node) => {
    const rect = node.getBoundingClientRect()
    return {
      tag: node.tagName.toLowerCase(),
      id: node.id || '',
      class: String(node.className || '').slice(0, 120),
      text: text(node),
      box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    }
  }
  const collect = (selector, limit) => [...document.querySelectorAll(selector)].slice(0, limit).map(describe)
  return {
    title: document.title,
    url: location.href,
    bodyTextLength: (root && root.textContent || '').length,
    bodyText: (root && root.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 600),
    headings: collect('h1, h2, h3', 12),
    buttons: collect('button, [role="button"], input[type="submit"]', 20),
    inputs: collect('input, textarea, select', 20),
    links: collect('a[href]', 20),
    images: collect('img', 20).map((image) => ({ ...image, src: '' })),
    emptyRoot: Boolean(root) && (root.textContent || '').trim().length === 0,
    hasVisibleContent: [...(root ? root.children : [])].some(visible),
  }
})()`

/** One element instead of the whole page, when a selector was given. */
export function domForSelectorScript(selector) {
  return `(() => {
  const selector = ${JSON.stringify(selector)}
  const node = document.querySelector(selector)
  if (!node) return { found: false, selector }
  const rect = node.getBoundingClientRect()
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null
  return {
    found: true,
    selector,
    tag: node.tagName.toLowerCase(),
    id: node.id || '',
    class: String(node.className || '').slice(0, 200),
    text: String(node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 600),
    value: 'value' in node ? String(node.value || '').slice(0, 300) : undefined,
    box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    visible: rect.width > 0 && rect.height > 0 && (!style || (style.visibility !== 'hidden' && style.display !== 'none')),
    style: style ? {
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontSize: style.fontSize,
      display: style.display,
    } : null,
    childCount: node.children.length,
  }
})()`
}

function selectorScript(selector, body) {
  return `(() => {
  const selector = ${JSON.stringify(selector)}
  const node = document.querySelector(selector)
  if (!node) return { ok: false, reason: 'not-found', selector }
  ${body}
})()`
}

export function clickPreviewScript(selector) {
  return selectorScript(selector, `
  node.scrollIntoView({ block: 'center', inline: 'center' })
  if (typeof node.focus === 'function') node.focus()
  node.click()
  return { ok: true, selector, tag: node.tagName.toLowerCase(), text: String(node.textContent || '').trim().slice(0, 120) }`)
}

export function typePreviewScript(selector, value) {
  return selectorScript(selector, `
  const value = ${JSON.stringify(value)}
  node.scrollIntoView({ block: 'center' })
  if (typeof node.focus === 'function') node.focus()
  // A framework reads the value it is told about, not the one set on the element,
  // so the same events a person's typing produces are dispatched here.
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter) setter.call(node, value)
  else node.value = value
  node.dispatchEvent(new Event('input', { bubbles: true }))
  node.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, selector, value: String(node.value || '').slice(0, 200) }`)
}

/**
 * Point at an element and have the page name it.
 *
 * Runs inside the page, because the page is a separate document the app cannot
 * overlay: an outline follows the pointer, Escape takes it down, and a click
 * answers with a selector — the shortest one that matches this element alone,
 * preferring an id, then the tag with its classes. The promise it returns is what
 * the app awaits, so the page's own answer is the result.
 */
export function elementPickerScript({ accentRgb = '', tooltipBg = '', tooltipFg = '' } = {}) {
  // The colours travel in from the app's own theme: the page being pointed at is
  // someone else's document, and it has none of this app's variables.
  const accent = JSON.stringify(String(accentRgb).trim())
  const tipBg = JSON.stringify(String(tooltipBg).trim())
  const tipFg = JSON.stringify(String(tooltipFg).trim())
  return `(() => {
  const ACCENT = ${accent}
  const previous = window.__gugoPickerCancel
  if (typeof previous === 'function') previous()

  const outline = document.createElement('div')
  outline.setAttribute('data-gugo-picker', 'outline')
  Object.assign(outline.style, {
    position: 'fixed', zIndex: '2147483646', pointerEvents: 'none',
    border: '2px solid rgb(' + ACCENT + ')', background: 'rgb(' + ACCENT + ' / 0.12)',
    borderRadius: '2px', transition: 'all 60ms linear',
  })
  const label = document.createElement('div')
  label.setAttribute('data-gugo-picker', 'label')
  Object.assign(label.style, {
    position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
    background: ${tipBg}, color: ${tipFg}, font: '12px/1.4 ui-monospace, monospace',
    padding: '2px 6px', borderRadius: '4px', whiteSpace: 'nowrap',
  })
  document.body.appendChild(outline)
  document.body.appendChild(label)

  const escape = (value) => {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&')
  }

  const selectorFor = (element) => {
    if (element.id) {
      const byId = '#' + escape(element.id)
      if (document.querySelectorAll(byId).length === 1) return byId
    }
    const parts = []
    let node = element
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase()
      if (node.classList && node.classList.length) {
        part += [...node.classList].slice(0, 2).map((name) => '.' + escape(name)).join('')
      }
      const parent = node.parentElement
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === node.tagName)
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      const candidate = parts.join(' > ')
      if (document.querySelectorAll(candidate).length === 1) return candidate
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  const describe = (element) => {
    const rect = element.getBoundingClientRect()
    return {
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      id: element.id || '',
      text: String(element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
  }

  let done = false
  let resolvePick = () => {}
  const cleanup = () => {
    outline.remove()
    label.remove()
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKey, true)
    delete window.__gugoPickerCancel
  }
  const finish = (value) => {
    if (done) return
    done = true
    cleanup()
    resolvePick(value)
  }
  const onMove = (event) => {
    const element = event.target && event.target.nodeType === 1 ? event.target : null
    if (!element || element.hasAttribute('data-gugo-picker')) return
    const rect = element.getBoundingClientRect()
    Object.assign(outline.style, {
      top: rect.top + 'px', left: rect.left + 'px',
      width: rect.width + 'px', height: rect.height + 'px',
    })
    label.textContent = describe(element).selector
    label.style.top = Math.max(0, rect.top - 20) + 'px'
    label.style.left = rect.left + 'px'
  }
  const onClick = (event) => {
    const element = event.target && event.target.nodeType === 1 ? event.target : null
    if (!element || element.hasAttribute('data-gugo-picker')) return
    event.preventDefault()
    event.stopPropagation()
    finish({ picked: describe(element) })
  }
  const onKey = (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    finish({ cancelled: true })
  }
  window.__gugoPickerCancel = () => finish({ cancelled: true })
  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKey, true)
  return new Promise((resolve) => { resolvePick = resolve })
})()`
}

/** Take the picker down — used when the reader changes their mind from the app. */
export const ELEMENT_PICKER_CANCEL_SCRIPT = 'window.__gugoPickerCancel ? (window.__gugoPickerCancel(), true) : false'

/** What the panel does for one op the backend asked for. */
export function planFactsOperations(ops = []) {
  const plan = []
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== 'object') continue
    if (op.kind === 'screenshot' || op.kind === 'console') plan.push({ kind: op.kind })
    else if (op.kind === 'dom' && typeof op.selector === 'string' && op.selector.trim()) {
      plan.push({ kind: 'dom', script: domForSelectorScript(op.selector.trim()) })
    } else if (op.kind === 'dom') plan.push({ kind: 'dom', script: DOM_SUMMARY_SCRIPT })
    else if (op.kind === 'click' && typeof op.selector === 'string' && op.selector.trim()) {
      plan.push({ kind: 'click', script: clickPreviewScript(op.selector.trim()) })
    } else if (op.kind === 'type' && typeof op.selector === 'string' && op.selector.trim()) {
      plan.push({ kind: 'type', script: typePreviewScript(op.selector.trim(), String(op.text ?? '')) })
    } else if (op.kind === 'navigate' && typeof op.url === 'string' && op.url.trim()) {
      plan.push({ kind: 'navigate', url: op.url.trim() })
    }
  }
  return plan
}
