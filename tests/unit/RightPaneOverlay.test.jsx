import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import RightPaneGrid from '../../src/pages/ChatSplit/rightPanes/RightPaneGrid.jsx'
import { resetRegionOpenForTests } from '../../src/lib/chatLayoutBudget.js'

async function mount(context, width = 390) {
  const dom = new JSDOM('<!doctype html><html><body><button id="launcher">Open tools</button><div data-chat-main-area><section data-chat-transcript><button>Draft control</button></section><div id="root"></div></div></body></html>', { url: 'http://localhost/#/chat' })
  for (const key of ['window', 'document', 'HTMLElement', 'SVGElement']) globalThis[key] = key === 'window' ? dom.window : dom.window[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: width })
  let measured = width === 1024 ? 744 : width - 60
  document.querySelector('[data-chat-main-area]').getBoundingClientRect = () => ({ width: measured })
  resetRegionOpenForTests()
  const launcher = document.getElementById('launcher')
  launcher.focus()
  let closes = 0
  function Harness() {
    const [open, setOpen] = useState(true)
    return <RightPaneGrid t={(key) => key} onClose={() => { closes += 1; setOpen(false) }}
      top={open ? <><button>Tool content</button><input aria-label="Test buffer" defaultValue="draft" /></> : null} />
  }
  const root = createRoot(document.getElementById('root'))
  context.after(async () => { await act(async () => root.unmount()); dom.window.close(); resetRegionOpenForTests() })
  await act(async () => root.render(<Harness />))
  return { dom, launcher, closes: () => closes, resize: async (viewport, area) => {
    measured = area
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: viewport })
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('resize')))
  } }
}

test('a narrow region overlays rather than taking chat space, traps focus and closes with Escape', async (context) => {
  const view = await mount(context)
  const dialog = document.querySelector('[role="dialog"]')
  assert.ok(dialog)
  assert.equal(dialog.getAttribute('aria-modal'), 'true')
  assert.ok(document.querySelector('[data-testid="right-region-overlay"]'))
  assert.ok(dialog.contains(document.querySelector('[data-testid="right-pane-grid"]')))
  assert.equal(document.querySelector('[data-testid="right-region-resize-handle"]'), null)
  assert.ok(dialog.contains(document.activeElement))
  assert.equal(Boolean(document.querySelector('[data-chat-transcript]').closest('[inert]')), true)
  await act(async () => document.activeElement.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  assert.equal(view.closes(), 1)
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.equal(Boolean(document.querySelector('[data-chat-transcript]').closest('[inert]')), false)
  await act(async () => { await new Promise((resolve) => view.dom.window.setTimeout(resolve, 0)) })
  assert.equal(document.activeElement, view.launcher)
})

test('resizing back to desktop restores the measured side-by-side budget and close remains available', async (context) => {
  const view = await mount(context, 1024)
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.equal(document.querySelector('[data-testid="right-pane-grid"]').style.width, '344px')
  const buffer = document.querySelector('[aria-label="Test buffer"]')
  buffer.value = 'keep this draft'
  await view.resize(640, 580)
  assert.ok(document.querySelector('[aria-label="Test buffer"]') === buffer, 'changing layout must not remount tools or terminal connections')
  assert.ok(document.querySelector('[role="dialog"]'))
  await view.resize(1024, 744)
  assert.ok(document.querySelector('[aria-label="Test buffer"]') === buffer)
  assert.equal(buffer.value, 'keep this draft')
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.equal(document.querySelector('[data-testid="right-pane-grid"]').style.width, '344px')
  await view.resize(390, 330)
  await act(async () => document.querySelector('[data-testid="right-region-overlay-close"]').click())
  assert.equal(view.closes(), 1)
  assert.equal(document.querySelector('[data-testid="right-pane-grid"]'), null)
})
