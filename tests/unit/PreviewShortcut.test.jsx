import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import useWorkbenchShortcuts from '../../src/pages/ChatSplit/useWorkbenchShortcuts.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function Probe({ onOpenPreview, onSelectTool }) {
  useWorkbenchShortcuts({ onOpenPreview, onSelectTool })
  return <p>probe</p>
}

/** The key that opens the preview must reach the same callback the button calls. */
test('the preview key is bound, and only the preview key opens the preview', async (t2) => {
  const dom = setupDom()
  const root = createRoot(dom.window.document.getElementById('root'))
  const opened = []
  const tools = []
  t2.after(async () => { await act(async () => root.unmount()); dom.window.close() })

  await act(async () => {
    root.render(<Probe onOpenPreview={() => opened.push('preview')} onSelectTool={(tool) => tools.push(tool)} />)
  })

  const press = async (init) => {
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    })
  }

  await press({ key: 'p', ctrlKey: true, shiftKey: true })
  assert.deepEqual(opened, ['preview'], 'Ctrl+Shift+P opens the preview')
  assert.deepEqual(tools, [], 'and does not also pick a tool')

  // Near misses stay misses: the modifiers are part of the key.
  await press({ key: 'p', ctrlKey: true })
  await press({ key: 'p', ctrlKey: true, shiftKey: true, altKey: true })
  await press({ key: 'p' })
  assert.deepEqual(opened, ['preview'], 'nothing else opens it')

  // The tool keys still work alongside it.
  await press({ key: 't', ctrlKey: true })
  assert.deepEqual(tools, ['browser'])
  assert.deepEqual(opened, ['preview'])
})
