import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import SessionList from '../src/components/leftRail/SessionList.jsx'

test('compact session history keeps fork in the context menu without an inline branch row', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const session = { id: 'branch-1', title: 'Simple history row', parentSessionId: 'parent-1', branchLabel: 'Experiment' }
  let forked = null

  try {
    await act(async () => root.render(<SessionList
      sessions={[session]}
      activeSessionId="branch-1"
      openMenuId="branch-1"
      onMenuOpen={() => {}}
      onMenuToggle={() => {}}
      onMenuClose={() => {}}
      onSearch={() => {}}
      onOpen={() => {}}
      onFork={(value) => { forked = value }}
      onPinToggle={() => {}}
      onArchiveToggle={() => {}}
      onDelete={() => {}}
      t={(key) => key}
    />))

    const row = rootElement.querySelector('[data-session-open]')
    assert.equal(row.textContent, 'Simple history row')
    assert.equal(row.querySelector('svg'), null)
    const forkButton = [...rootElement.querySelectorAll('[role="menuitem"]')]
      .find((button) => button.textContent.includes('nav.forkSession'))
    assert.ok(forkButton)
    await act(async () => forkButton.click())
    assert.equal(forked, session)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
