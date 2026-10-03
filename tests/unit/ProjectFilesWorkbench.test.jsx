import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import useProjectFilesWorkbench from '../../src/pages/ChatSplit/useProjectFilesWorkbench.js'

function Probe({ setWorkbenchOpen, setWorkbenchTab }) {
  const { workbenchMessage, setWorkbenchMessage } = useProjectFilesWorkbench({ setWorkbenchOpen, setWorkbenchTab })
  return <>
    <output>{workbenchMessage}</output>
    <button onClick={() => setWorkbenchMessage('First notice')}>First</button>
    <button onClick={() => setWorkbenchMessage('New notice')}>New</button>
  </>
}

function mount() {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>')
  const previous = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const container = dom.window.document.getElementById('root')
  const root = createRoot(container)
  const calls = []
  act(() => root.render(<Probe setWorkbenchOpen={(value) => calls.push(['open', value])}
    setWorkbenchTab={(value) => calls.push(['tab', value])} />))
  return {
    dom, container, calls,
    close() {
      act(() => root.unmount())
      dom.window.close()
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      }
    },
  }
}

// The `chat-workbench:open-files` navigation (project expansion opening a
// files tool) was removed together with the files tool itself, at both ends:
// neither the dispatcher nor the listener exists any more. What the hook
// still owns is the workbench's status notice, asserted below.
test('workbench feedback replaces its timer and clears only after the newest notice has been visible for five seconds', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = mount()
  try {
    const [first, next] = h.container.querySelectorAll('button')
    act(() => first.click())
    act(() => t.mock.timers.tick(4000))
    assert.equal(h.container.querySelector('output').textContent, 'First notice')
    act(() => next.click())
    act(() => t.mock.timers.tick(1000))
    assert.equal(h.container.querySelector('output').textContent, 'New notice')
    act(() => t.mock.timers.tick(4000))
    assert.equal(h.container.querySelector('output').textContent, '')
  } finally { h.close() }
})
