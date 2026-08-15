import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import DirectoryApprovalModal from '../../src/components/DirectoryApprovalModal.jsx'
import {
  buildLocalPathPreflight,
  resolveLocalPathToolNames,
} from '../../src/lib/localPathPreflight.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  return dom
}

test('local-file chat wording renders an in-app grant dialog and enables read tools', async () => {
  const request = buildLocalPathPreflight('\u4f60\u80fd\u9605\u8bfb"D:\\destok\\money"\u8fd9\u4e2a\u9879\u76ee\u5417')
  assert.deepEqual(request, { paths: ['D:\\destok\\money'], accessMode: 'read_only' })

  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const decisions = []
  try {
    await act(async () => {
      root.render(
        <DirectoryApprovalModal
          open
          request={{
            path: request.paths[0],
            suggestGrantPath: request.paths[0],
            requiredAccessMode: request.accessMode,
          }}
          busy={false}
          error=""
          onAuthorize={(decision) => decisions.push(decision)}
          onReject={() => {}}
        />,
      )
    })

    const modal = rootElement.querySelector('[data-testid="directory-approval-modal"]')
    const card = rootElement.querySelector('[data-testid="directory-approval-card"]')
    const pathInput = rootElement.querySelector('#directory-approval-path')
    const modeSelect = rootElement.querySelector('#directory-approval-mode')
    assert.ok(modal)
    assert.ok(card)
    assert.equal(card.getAttribute('role'), 'dialog')
    assert.equal(card.getAttribute('aria-modal'), 'true')
    assert.equal(pathInput.value, 'D:\\destok\\money')
    assert.equal(modeSelect.value, 'read_only')

    const authorizeButton = [...rootElement.querySelectorAll('button')].at(-1)
    await act(async () => {
      authorizeButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.deepEqual(decisions, [{
      path: 'D:\\destok\\money', accessMode: 'read_only', usePicker: false, trustWorkspaceConfig: false,
    }])
    assert.deepEqual(resolveLocalPathToolNames([], request), ['list_directory', 'read_file'])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('picker and grant authorization keep an explicit cancellation control while busy', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  let rejected = 0
  const renderModal = (busy) => (
    <DirectoryApprovalModal
      open
      request={{ path: 'D:\\destok\\money', requiredAccessMode: 'read_write' }}
      busy={busy}
      error=""
      onAuthorize={() => {}}
      onReject={() => { rejected += 1 }}
    />
  )
  try {
    await act(async () => {
      root.render(renderModal('grant'))
    })

    const modal = rootElement.querySelector('[data-testid="directory-approval-modal"]')
    const card = rootElement.querySelector('[data-testid="directory-approval-card"]')
    const cancelButton = rootElement.querySelector('[data-testid="directory-approval-cancel"]')
    const pickerButton = rootElement.querySelector('[data-testid="directory-approval-picker"]')
    const authorizeButton = rootElement.querySelector('[data-testid="directory-approval-authorize"]')
    assert.equal(card.getAttribute('aria-busy'), 'true')
    assert.ok(cancelButton)
    assert.equal(cancelButton.disabled, false)
    assert.equal(pickerButton.disabled, true)
    assert.equal(authorizeButton.disabled, true)

    await act(async () => {
      cancelButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(rejected, 1)

    await act(async () => {
      root.render(renderModal('picker'))
    })
    assert.equal(rootElement.querySelector('[data-testid="directory-approval-cancel"]').disabled, false)
    assert.equal(rootElement.querySelector('[data-testid="directory-approval-picker"]').disabled, true)
    assert.equal(rootElement.querySelector('[data-testid="directory-approval-authorize"]').disabled, true)

    await act(async () => {
      rootElement.querySelector('[data-testid="directory-approval-cancel"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(rejected, 2)

    await act(async () => {
      modal.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    })
    assert.equal(rejected, 3)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
