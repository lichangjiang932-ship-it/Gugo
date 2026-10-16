import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import Modal from '../../src/components/Modal.jsx'
async function mount(context, consumeEscape = false) {
  const d = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(globalThis, { window: d.window, document: d.window.document, HTMLElement: d.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  let closed = 0
  const root = createRoot(document.getElementById('root'))
  await act(async () => root.render(<Modal ariaLabel="Test outer dialog" onClose={() => { closed += 1 }}>
    <input data-inner-menu onKeyDown={event => {
      if (consumeEscape && event.key === 'Escape') { event.preventDefault(); event.stopPropagation() }
    }} />
  </Modal>))
  context.after(async () => { await act(async () => root.unmount()); d.window.close() })
  return { get closed() { return closed }, input: document.querySelector('[data-inner-menu]') }
}
test('a child menu consumes Escape before its containing dialog, without changing the Tab trap', async context => {
  const f = await mount(context, true)
  await act(async () => f.input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  assert.equal(f.closed, 0)
})
test('composition Escape and legacy key 229 do not close the containing dialog', async context => {
  const f = await mount(context)
  await act(async () => {
    f.input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
    f.input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true }))
  })
  assert.equal(f.closed, 0)
  await act(async () => f.input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  assert.equal(f.closed, 1, 'unhandled non-composition Escape still closes the outer dialog')
})
