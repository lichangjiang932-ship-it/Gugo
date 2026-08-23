import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useCallback, useRef } from 'react'
import { createRoot } from 'react-dom/client'

import ModelProvidersPanel from '../../src/components/ModelProvidersPanel.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
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

function ProviderModalHarness({ onClose }) {
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
    <button ref={initialFocusRef} type="button">Close settings</button>
    <I18nProvider><ModelProvidersPanel /></I18nProvider>
  </div>
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><button data-settings-focus-return>Launcher</button><div id="root"></div></body></html>', {
    url: 'http://localhost/#/settings',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.HTMLInputElement = dom.window.HTMLInputElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
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

test('provider editor portal stays inside the settings dialog so model fields retain focus', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const originalFetch = globalThis.fetch
  let closeCount = 0
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, providers: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  try {
    await act(async () => root.render(<ProviderModalHarness onClose={() => { closeCount += 1 }} />))
    await act(async () => { await Promise.resolve() })
    const addButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '新增')
    await act(async () => addButton.click())
    const customButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '自定义接口')
    await act(async () => customButton.click())

    const dialog = rootElement.querySelector('[role="dialog"]')
    const baseUrlInput = document.querySelector('input[placeholder="https://api.example.com/v1"]')
    const apiKeyInput = document.querySelector('input[type="password"]')
    const modelsInput = [...document.querySelectorAll('textarea')]
      .find((input) => input.placeholder.includes('model-a'))
    assert.ok(dialog && baseUrlInput && apiKeyInput && modelsInput)
    assert.equal(dialog.contains(baseUrlInput), true)
    assert.equal(dialog.contains(apiKeyInput), true)
    assert.equal(dialog.contains(modelsInput), true)

    baseUrlInput.focus()
    assert.equal(document.activeElement, baseUrlInput)
    apiKeyInput.focus()
    assert.equal(document.activeElement, apiKeyInput)
    modelsInput.focus()
    assert.equal(document.activeElement, modelsInput)

    const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => modelsInput.dispatchEvent(escape))
    assert.equal(escape.defaultPrevented, true)
    assert.equal(closeCount, 0)
    assert.equal(rootElement.querySelector('[data-modal-layer="nested"]'), null)
    assert.ok(rootElement.querySelector('[role="dialog"]'))
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})
