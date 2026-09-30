import { evaluateInDesktopPreview } from './desktopBrowserClient.js'
import { ELEMENT_PICKER_CANCEL_SCRIPT, elementPickerScript } from './previewPageScripts.js'

/**
 * Pick one element out of the preview page, the way a reader points at it.
 *
 * The picking happens inside the page — a script that follows the pointer and
 * reports the element under the click — because the page is a separate document
 * the app cannot overlay. What comes back is a selector the agent can use with
 * preview_inspect_dom, preview_click or preview_type, so the reader's "this one"
 * becomes something a tool call can name.
 */

const DEFAULT_TIMEOUT_MS = 60_000

/** The picked element as one line a reader can paste into a message. */
export function describePickedElement(picked) {
  if (!picked?.selector) return ''
  const size = picked.width && picked.height ? ` · ${picked.width}×${picked.height}` : ''
  const text = String(picked.text || '').trim().slice(0, 60)
  return `${picked.selector}（${picked.tag || 'element'}${size}${text ? ` “${text}”` : ''}）`
}

/**
 * The picker's colours, read from the theme the reader is in.
 *
 * The page it draws on is someone else's document with none of this app's
 * variables, so the values have to be carried across — and read here, where the
 * theme lives, rather than written into the script.
 */
export function previewPickerTheme(root = globalThis.document?.documentElement) {
  try {
    const style = globalThis.getComputedStyle(root)
    return {
      accentRgb: style.getPropertyValue('--color-accent-rgb').trim(),
      tooltipBg: style.getPropertyValue('--color-tip-bg').trim(),
      tooltipFg: style.getPropertyValue('--color-tip-fg').trim(),
    }
  } catch {
    return { accentRgb: '', tooltipBg: '', tooltipFg: '' }
  }
}

function startPicker(evaluate, theme) {
  return evaluate(elementPickerScript(theme))
}

function parseResult(result) {
  if (!result?.ok) return { ok: false, reason: result?.reason || 'evaluate-failed', message: result?.message }
  const raw = result.result
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty' }
  try {
    const picked = JSON.parse(raw)
    if (picked?.cancelled === true) return { ok: false, reason: 'cancelled' }
    if (!picked?.selector) return { ok: false, reason: 'empty' }
    return { ok: true, picked }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}

/**
 * Ask the page for one element.
 *
 * A reader who changes their mind presses Escape in the page or the button again;
 * a reader who wanders off is released by the timeout, and the picker is told to
 * take its overlay down either way so the page is left as it was found.
 */
export async function pickPreviewElement({
  evaluate = evaluateInDesktopPreview,
  theme = previewPickerTheme(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs)
  })
  try {
    const outcome = await Promise.race([startPicker(evaluate, theme).then(parseResult), timeout])
    if (outcome?.reason === 'timeout' || outcome?.reason === 'cancelled') {
      // Leaving the overlay behind would keep the page looking picked.
      await evaluate(ELEMENT_PICKER_CANCEL_SCRIPT).catch(() => null)
    }
    return outcome
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Take the picker down without picking anything. */
export function cancelPreviewElementPick({ evaluate = evaluateInDesktopPreview } = {}) {
  return evaluate(ELEMENT_PICKER_CANCEL_SCRIPT).catch(() => null)
}
