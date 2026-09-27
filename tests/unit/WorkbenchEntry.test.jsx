import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import WorkbenchEntry from '../../src/pages/ChatSplit/rightWorkbench/WorkbenchEntry.jsx'
import { HashRouter } from '../../src/lib/router.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

const t = (key) => key

test('the entry page lists every tool with the key that reaches it', async () => {
  setupDom()
  const root = createRoot(document.getElementById('root'))
  const picked = []
  await act(async () => {
    root.render(<HashRouter><WorkbenchEntry onTabChange={(tool) => picked.push(tool)} t={t} /></HashRouter>)
  })
  const rows = [...document.querySelectorAll('[data-testid="workbench-entry-row"]')]
  assert.deepEqual(rows.map((row) => row.dataset.tool), ['chat', 'browser', 'terminal'])
  // Each row shows its own shortcut, from the same definitions the key handler uses.
  const chips = [...document.querySelectorAll('[data-testid="workbench-entry-shortcut"]')]
    .map((chip) => chip.textContent)
  assert.equal(chips.length, 3)
  assert.match(chips[0], /Alt\+S$/u)
  assert.match(chips[1], /T$/u)
  // One click on a row picks that tool.
  await act(async () => {
    rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.deepEqual(picked, ['browser'])
  // Git is not a panel tab: its row navigates to the full Git workbench page.
  const gitRow = document.querySelector('[data-testid="workbench-entry-git"]')
  assert.ok(gitRow)
  await act(async () => {
    gitRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.equal(window.location.hash, '#/git')
  await act(async () => root.unmount())
})
