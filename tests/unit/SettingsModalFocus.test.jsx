import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useCallback, useRef } from 'react'
import { createRoot } from 'react-dom/client'

import useModalFocusTrap from '../../src/lib/useModalFocusTrap.js'

function ModalHarness({ onClose }) {
  const dialogRef = useRef(null)
  const initialFocusRef = useRef(null)
  const close = useCallback(() => onClose(), [onClose])
  useModalFocusTrap({
    dialogRef,
    initialFocusRef,
    onClose: close,
    restoreFocusSelector: '[data-settings-focus-return]',
  })
  return <div ref={dialogRef} role="dialog" tabIndex={-1}>
    <button ref={initialFocusRef} type="button">Close</button>
    <input aria-label="Setting" />
    <button type="button">Last</button>
  </div>
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><button data-settings-focus-return>Launcher</button><div id="root"></div></body></html>', {
    url: 'http://localhost/#/settings',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

test('settings modal traps keyboard focus, closes with Escape, and restores its launcher', async () => {
  const dom = setupDom()
  const launcher = document.querySelector('[data-settings-focus-return]')
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  let closeCount = 0
  launcher.focus()

  try {
    await act(async () => root.render(<ModalHarness onClose={() => { closeCount += 1 }} />))
    const [first, , last] = rootElement.querySelectorAll('button, input')
    assert.equal(document.activeElement, first)
    assert.equal(document.body.style.overflow, 'hidden')
    assert.equal(launcher.hasAttribute('inert'), true)

    launcher.focus()
    assert.equal(document.activeElement, first)

    last.focus()
    const forwardTab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    last.dispatchEvent(forwardTab)
    assert.equal(forwardTab.defaultPrevented, true)
    assert.equal(document.activeElement, first)

    const backwardTab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    first.dispatchEvent(backwardTab)
    assert.equal(backwardTab.defaultPrevented, true)
    assert.equal(document.activeElement, last)

    const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    last.dispatchEvent(escape)
    assert.equal(escape.defaultPrevented, true)
    assert.equal(closeCount, 1)

    await act(async () => root.unmount())
    await new Promise((resolve) => dom.window.setTimeout(resolve, 5))
    assert.equal(document.activeElement, launcher)
    assert.equal(document.body.style.overflow, '')
    assert.equal(launcher.hasAttribute('inert'), false)
  } finally {
    if (rootElement.hasChildNodes()) await act(async () => root.unmount())
    dom.window.close()
  }
})
