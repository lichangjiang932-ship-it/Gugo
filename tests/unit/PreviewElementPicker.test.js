import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cancelPreviewElementPick,
  describePickedElement,
  pickPreviewElement,
} from '../../src/lib/previewElementPicker.js'
import { ELEMENT_PICKER_CANCEL_SCRIPT, elementPickerScript } from '../../src/lib/previewPageScripts.js'

/** Stands in for the page: it answers with whatever the test staged. */
function fakePage(result, { onEvaluate = null } = {}) {
  const calls = []
  const evaluate = async (script) => {
    calls.push(script)
    onEvaluate?.(script)
    return result
  }
  return { calls, evaluate }
}

const PICKED = { selector: '.card > button.primary', tag: 'button', text: '  Save now ', width: 120, height: 32 }

test('a picked element reads as one line a reader can paste', () => {
  assert.equal(
    describePickedElement(PICKED),
    '.card > button.primary（button · 120×32 “Save now”）',
  )
  // Without a box or text it still names the element.
  assert.equal(describePickedElement({ selector: '#app', tag: 'div' }), '#app（div）')
  assert.equal(describePickedElement(null), '')
  assert.equal(describePickedElement({ selector: '' }), '')
})

test('picking carries the app theme into the page and returns what it answered', async () => {
  const page = fakePage({ ok: true, result: JSON.stringify(PICKED) })
  const outcome = await pickPreviewElement({
    evaluate: page.evaluate,
    theme: { accentRgb: '22 163 74', tooltipBg: '#1E1E1E', tooltipFg: '#FFFFFF' },
  })
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.picked, PICKED)
  assert.equal(page.calls.length, 1, 'the picker script is what the page is asked to run')
  // The page gets the theme's values, not a palette of the app's own.
  assert.match(page.calls[0], /const ACCENT = "22 163 74"/)
  assert.match(page.calls[0], /background: "#1E1E1E", color: "#FFFFFF"/)
})

test('Escape in the page cancels, and the overlay is taken down', async () => {
  const page = fakePage({ ok: true, result: JSON.stringify({ cancelled: true }) })
  const outcome = await pickPreviewElement({ evaluate: page.evaluate })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'cancelled')
  assert.equal(page.calls.length, 2)
  assert.equal(page.calls[1], ELEMENT_PICKER_CANCEL_SCRIPT)
})

test('a reader who never clicks is released by the timeout, with the page left clean', async () => {
  // Never resolves: the reader is still pointing at something.
  const calls = []
  const evaluate = async (script) => {
    calls.push(script)
    if (script === ELEMENT_PICKER_CANCEL_SCRIPT) return { ok: true, result: 'true' }
    return new Promise(() => {})
  }
  const outcome = await pickPreviewElement({ evaluate, theme: {}, timeoutMs: 30 })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'timeout')
  assert.deepEqual(calls, [elementPickerScript({}), ELEMENT_PICKER_CANCEL_SCRIPT])
})

test('an answer the app cannot read is reported rather than guessed at', async () => {
  for (const [result, reason] of [
    [{ ok: false, reason: 'no-view' }, 'no-view'],
    [{ ok: true, result: '' }, 'empty'],
    [{ ok: true, result: 'not json' }, 'unreadable'],
    [{ ok: true, result: JSON.stringify({ tag: 'div' }) }, 'empty'],
  ]) {
    const page = fakePage(result)
    const outcome = await pickPreviewElement({ evaluate: page.evaluate })
    assert.equal(outcome.ok, false, JSON.stringify(result))
    assert.equal(outcome.reason, reason)
  }
})

test('the picker can be taken down from the app, and says so when nothing was up', async () => {
  const page = fakePage({ ok: true, result: 'true' })
  await cancelPreviewElementPick({ evaluate: page.evaluate })
  assert.deepEqual(page.calls, [ELEMENT_PICKER_CANCEL_SCRIPT])

  // A page that never had a picker running is not an error.
  const empty = fakePage({ ok: true, result: 'false' })
  assert.deepEqual(await cancelPreviewElementPick({ evaluate: empty.evaluate }), { ok: true, result: 'false' })
})
