import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import FileWriteCard from '../../src/pages/ChatSplit/chatMessages/messageRow/FileWriteCard.jsx'

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

// The stub echoes keys with their parameters so assertions can see values.
const t = (key, params = {}) => {
  const short = String(key).replace(/^agentReport\./u, '')
  const values = Object.values(params)
  return values.length > 0 ? `${short} ${values.join(' ')}` : short
}

test('a file write is a card: what changed, by how much, detail one click away', async () => {
  setupDom()
  const root = createRoot(document.getElementById('root'))
  const call = {
    name: 'write_file',
    status: 'success',
    args: { path: 'probe-plan.md', content: 'hello' },
    result: { path: 'probe-plan.md', bytes: 5, changes: 1, sha256: 'b'.repeat(64) },
  }
  await act(async () => { root.render(<FileWriteCard call={call} t={t} />) })
  const head = document.querySelector('[data-testid="file-write-card-toggle"]')
  assert.ok(head, 'card head renders')
  assert.match(head.textContent, /probe-plan\.md/u)
  // The change count is a badge beside the path, not buried in prose.
  assert.match(document.querySelector('[data-testid="file-write-card-badge"]').textContent, /\+1/u)
  assert.equal(document.querySelector('[data-testid="file-write-card-body"]'), null)

  // One click opens the real metrics.
  await act(async () => { head.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const body = document.querySelector('[data-testid="file-write-card-body"]')
  assert.ok(body, 'detail opens')
  assert.match(body.textContent, /fileBytes 5/u)
  assert.match(body.textContent, /fileChanges 1/u)
  assert.match(body.textContent, /sha256 b{12}/u)
  await act(async () => root.unmount())
})

test('a multi-file patch names the file count and lists each file', async () => {
  setupDom()
  const root = createRoot(document.getElementById('root'))
  const call = {
    name: 'apply_patch',
    status: 'success',
    args: { patch: '@@ a\n+x' },
    result: {
      files: [
        { path: 'src/a.js', additions: 3, deletions: 1 },
        { path: 'src/b.js', additions: 2 },
      ],
    },
  }
  await act(async () => { root.render(<FileWriteCard call={call} t={t} />) })
  assert.match(document.querySelector('[data-testid="file-write-card-path"]').textContent, /fileMany 2/u)
  assert.match(document.querySelector('[data-testid="file-write-card-badge"]').textContent, /\+2/u)
  // No path and no metrics: nothing to say, so nothing renders.
  await act(async () => root.unmount())
  const empty = createRoot(document.getElementById('root'))
  await act(async () => { empty.render(<FileWriteCard call={{ name: 'run_command', args: {}, result: 'done' }} t={t} />) })
  assert.equal(document.querySelector('[data-testid="file-write-card"]'), null)
  await act(async () => empty.unmount())
})
