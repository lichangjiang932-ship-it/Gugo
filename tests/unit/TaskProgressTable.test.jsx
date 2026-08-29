import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import TaskProgressTable from '../../src/pages/ChatSplit/chatMessages/messageRow/TaskProgressTable.jsx'
import { hasStructuredProgress } from '../../src/pages/ChatSplit/chatMessages/messageRow/taskProgressPresentation.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

async function renderProgress(rootElement, progress) {
  const root = createRoot(rootElement)
  await act(async () => {
    root.render(<TaskProgressTable progress={progress} />)
  })
  return root
}

test('renders one structured row per present progress field', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  let root
  try {
    root = await renderProgress(rootElement, {
      phase: 'research',
      completed: 3,
      total: 8,
      iteration: 2,
      filesChanged: 4,
      additions: 120,
      deletions: 30,
    })

    const table = rootElement.querySelector('[data-testid="task-progress-table"]')
    assert.ok(table, 'progress table missing')
    for (const key of ['phase', 'steps', 'iteration', 'files', 'changes']) {
      assert.ok(table.querySelector(`[data-testid="task-progress-row-${key}"]`), `row ${key} missing`)
    }
    assert.match(table.textContent, /research/)
    assert.match(table.textContent, /3\/8/)
    assert.match(table.textContent, /120/)
    assert.match(table.textContent, /30/)
  } finally {
    if (root) await act(async () => root.unmount())
    dom.window.close()
  }
})

test('omits rows whose fields are absent and prefers combined step counter', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  let root
  try {
    root = await renderProgress(rootElement, { completed: 5 })
    const table = rootElement.querySelector('[data-testid="task-progress-table"]')
    assert.ok(table)
    assert.equal(table.querySelector('[data-testid="task-progress-row-steps"]'), null)
    assert.ok(table.querySelector('[data-testid="task-progress-row-completed"]'))
    assert.equal(table.querySelector('[data-testid="task-progress-row-phase"]'), null)
  } finally {
    if (root) await act(async () => root.unmount())
    dom.window.close()
  }
})

test('renders nothing without structured progress data', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  let root
  try {
    for (const progress of [null, undefined, {}, { phase: undefined }]) {
      assert.equal(hasStructuredProgress(progress), false)
      root = await renderProgress(rootElement, progress)
      assert.equal(rootElement.querySelector('[data-testid="task-progress-table"]'), null)
      rootElement.innerHTML = '<div id="root"></div>'
    }
  } finally {
    if (root) await act(async () => root.unmount())
    dom.window.close()
  }
})
