import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import Modal from '../../src/components/Modal.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><button id="launcher">Open</button><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function ModalHarness({ closeOnBackdrop = true, onClose }) {
  const [open, setOpen] = useState(true)
  const initialFocusRef = useRef(null)
  const close = () => {
    setOpen(false)
    onClose()
  }
  return (
    <Modal
      open={open}
      onClose={close}
      closeOnBackdrop={closeOnBackdrop}
      initialFocusRef={initialFocusRef}
      ariaLabel="Test dialog"
      testId="test-modal-overlay"
    >
      <button ref={initialFocusRef} type="button">First</button>
      <button type="button">Last</button>
    </Modal>
  )
}

function NestedModalHarness({ onInnerClose, onOuterClose }) {
  const [outerOpen, setOuterOpen] = useState(true)
  const [innerOpen, setInnerOpen] = useState(true)
  const [innerPortalTarget, setInnerPortalTarget] = useState(null)

  return (
    <Modal
      open={outerOpen}
      onClose={() => {
        setOuterOpen(false)
        onOuterClose()
      }}
      ariaLabel="Outer dialog"
    >
      <div ref={setInnerPortalTarget}>
        <button type="button">Outer action</button>
        {innerOpen && innerPortalTarget && (
          <Modal
            onClose={() => {
              setInnerOpen(false)
              onInnerClose()
            }}
            ariaLabel="Inner dialog"
            dataModalLayer="nested"
            portalTarget={innerPortalTarget}
          >
            <button type="button">Inner action</button>
          </Modal>
        )}
      </div>
    </Modal>
  )
}

test('Modal portals to body, traps focus, closes with Escape, and restores focus', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const launcher = document.getElementById('launcher')
  const root = createRoot(rootElement)
  let closes = 0
  launcher.focus()

  try {
    await act(async () => root.render(<ModalHarness onClose={() => { closes += 1 }} />))
    const dialog = document.querySelector('[role="dialog"]')
    const buttons = dialog.querySelectorAll('button')
    assert.ok(dialog)
    assert.equal(dialog.parentElement.parentElement, document.body)
    assert.equal(dialog.getAttribute('aria-modal'), 'true')
    assert.equal(dialog.getAttribute('aria-label'), 'Test dialog')
    assert.equal(document.activeElement, buttons[0])
    assert.equal(document.body.style.overflow, 'hidden')

    buttons[1].focus()
    const tab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    buttons[1].dispatchEvent(tab)
    assert.equal(tab.defaultPrevented, true)
    assert.equal(document.activeElement, buttons[0])

    const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => buttons[0].dispatchEvent(escape))
    assert.equal(escape.defaultPrevented, true)
    assert.equal(closes, 1)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await new Promise((resolve) => dom.window.setTimeout(resolve, 5))
    assert.equal(document.activeElement, launcher)
    assert.equal(document.body.style.overflow, '')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('Modal backdrop closing is configurable', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  let closes = 0

  try {
    await act(async () => root.render(
      <ModalHarness closeOnBackdrop={false} onClose={() => { closes += 1 }} />,
    ))
    const overlay = document.querySelector('[data-testid="test-modal-overlay"]')
    await act(async () => overlay.dispatchEvent(new dom.window.MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    })))
    assert.equal(closes, 0)
    assert.ok(document.querySelector('[role="dialog"]'))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('nested Modal closes only the active layer and preserves the outer focus trap', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const launcher = document.getElementById('launcher')
  let innerCloses = 0
  let outerCloses = 0
  launcher.focus()

  try {
    await act(async () => root.render(
      <NestedModalHarness
        onInnerClose={() => { innerCloses += 1 }}
        onOuterClose={() => { outerCloses += 1 }}
      />,
    ))

    const dialogs = document.querySelectorAll('[role="dialog"]')
    assert.equal(dialogs.length, 2)
    const outerButton = [...dialogs[0].querySelectorAll('button')]
      .find((button) => button.textContent === 'Outer action')
    const innerButton = [...dialogs[1].querySelectorAll('button')]
      .find((button) => button.textContent === 'Inner action')
    assert.equal(document.activeElement, innerButton)

    const closeInner = new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    await act(async () => innerButton.dispatchEvent(closeInner))
    await new Promise((resolve) => dom.window.setTimeout(resolve, 5))
    assert.equal(innerCloses, 1)
    assert.equal(outerCloses, 0)
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
    assert.equal(document.activeElement, outerButton)
    assert.equal(document.body.style.overflow, 'hidden')

    const closeOuter = new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    await act(async () => outerButton.dispatchEvent(closeOuter))
    await new Promise((resolve) => dom.window.setTimeout(resolve, 5))
    assert.equal(outerCloses, 1)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(document.activeElement, launcher)
    assert.equal(document.body.style.overflow, '')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
