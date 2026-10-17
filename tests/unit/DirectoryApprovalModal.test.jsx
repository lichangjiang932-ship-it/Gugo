import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import DirectoryApprovalModal from '../../src/components/DirectoryApprovalModal.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  return dom
}

test('directory approval keeps composition keys and body-level Escape away from its decisions', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const authorized = []
  const rejected = []
  try {
    await act(async () => root.render(
      <I18nProvider>
        <DirectoryApprovalModal
          open
          request={{ path: 'C:/workspace/project' }}
          busy={false}
          error=""
          onAuthorize={(value) => authorized.push(value)}
          onReject={() => rejected.push('reject')}
        />
      </I18nProvider>,
    ))
    const card = document.querySelector('[data-testid="directory-approval-card"]')
    const input = document.querySelector('#directory-approval-path')
    assert.ok(card && input)

    input.focus()
    await act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Enter', isComposing: true, bubbles: true, cancelable: true,
      }))
    })
    assert.equal(authorized.length, 0, 'an IME confirm does not authorize')

    await act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape', isComposing: true, bubbles: true, cancelable: true,
      }))
    })
    assert.equal(rejected.length, 0, 'an IME cancel does not reject the request')

    // There is no window-level Escape handler now: the card owns Escape only
    // while focus is inside it.
    await act(async () => {
      document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }))
    })
    assert.equal(rejected.length, 0)

    await act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }))
    })
    assert.deepEqual(rejected, ['reject'])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
