import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import DockLayout from '../../src/pages/ChatSplit/dock/DockLayout.jsx'
import DockHeader from '../../src/pages/ChatSplit/dock/DockHeader.jsx'
import { DOCK_WIDTH_STORAGE_KEY, readStoredDockWidth, useDockWidth } from '../../src/pages/ChatSplit/dock/useDockWidth.js'

/** The host owns the width; DockLayout renders what it is given. */
function Harness({ children, onClose }) {
  const dock = useDockWidth()
  return <DockLayout dock={dock} onClose={onClose} t={t}>{children}</DockLayout>
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

const t = (key) => key

test('the dock is a real panel: full height, an edge to drag, and a close button', async (t2) => {
  const dom = setupDom()
  const root = createRoot(dom.window.document.getElementById('root'))
  let closed = 0
  t2.after(async () => { await act(async () => root.unmount()); dom.window.close() })

  await act(async () => {
    root.render(<Harness onClose={() => { closed += 1 }}><p>panel body</p></Harness>)
  })
  const panel = dom.window.document.querySelector('[data-testid="dock-panel"]')
  assert.ok(panel, 'the panel renders')
  assert.match(panel.textContent, /panel body/)
  const handle = dom.window.document.querySelector('[data-testid="dock-resize-handle"]')
  assert.equal(handle.getAttribute('role'), 'separator')
  assert.equal(handle.getAttribute('aria-orientation'), 'vertical')

  // Keyboard resizing moves the width and remembers it.
  const before = Number.parseInt(panel.style.width, 10)
  await act(async () => {
    handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  })
  const wider = Number.parseInt(dom.window.document.querySelector('[data-testid="dock-panel"]').style.width, 10)
  assert.equal(wider, before + 24)
  assert.equal(dom.window.localStorage.getItem(DOCK_WIDTH_STORAGE_KEY), String(wider))
  // Home restores the default width.
  await act(async () => {
    handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  })
  assert.equal(readStoredDockWidth(), Number.parseInt(dom.window.document.querySelector('[data-testid="dock-panel"]').style.width, 10))

  await act(async () => {
    dom.window.document.querySelector('[data-testid="dock-close"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(closed, 1)
})

test('the shared header only shows controls that have a job', async (t2) => {
  const dom = setupDom()
  const root = createRoot(dom.window.document.getElementById('root'))
  t2.after(async () => { await act(async () => root.unmount()); dom.window.close() })

  await act(async () => {
    root.render(<DockHeader t={t}>title</DockHeader>)
  })
  // No window bridge and no close handler: neither control is rendered.
  assert.equal(dom.window.document.querySelector('[data-testid="dock-open-window"]'), null)
  assert.equal(dom.window.document.querySelector('[data-testid="dock-close"]'), null)
  assert.ok(dom.window.document.querySelector('[data-testid="dock-expand"]'), 'expand is always available')

  let opened = 0
  await act(async () => {
    root.render(<DockHeader onClose={() => {}} onOpenWindow={() => { opened += 1 }} t={t}>title</DockHeader>)
  })
  await act(async () => {
    dom.window.document.querySelector('[data-testid="dock-open-window"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(opened, 1)
  assert.ok(dom.window.document.querySelector('[data-testid="dock-close"]'))
})
