import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import DockHost from '../../src/pages/ChatSplit/dock/DockHost.jsx'
import { openDock, resetDockForTests } from '../../src/pages/ChatSplit/dock/dockStore.js'
import { publishSessionChanges, resetSessionChangesForTests } from '../../src/lib/sessionChangesFeed.js'
test('freshly opened current-changes panel keeps its requested session scope instead of showing the whole worktree', async context => {
  const d = new JSDOM('<div id="root"></div>', { url: 'http://localhost/#/chat' })
  Object.assign(globalThis, { window: d.window, document: d.window.document, HTMLElement: d.window.HTMLElement, SVGElement: d.window.SVGElement, localStorage: d.window.localStorage, CustomEvent: d.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true })
  const requests = [], sent = []
  context.mock.method(globalThis, 'fetch', async url => { requests.push(String(url)); return Response.json({ files: [{ path: 'unrelated/whole-project.js' }] }) })
  resetDockForTests(); resetSessionChangesForTests()
  publishSessionChanges({ files: [{ path: 'src/session.js', additions: 1 }], diffs: { 'src/session.js': '@@ -1 +1 @@\n-before\n+session-only-change\n' } })
  openDock('session')
  const root = createRoot(document.getElementById('root'))
  context.after(async () => { await act(async () => root.unmount()); resetDockForTests(); resetSessionChangesForTests(); d.window.close() })
  await act(async () => root.render(<DockHost embedded workspacePath="/w" onSendMessage={text => sent.push(text)} t={(key, values) => key === 'diffReview.reviewPrompt' ? JSON.stringify(values) : key} />))
  assert.equal(document.querySelector('[data-testid=diff-review-panel]').dataset.targetMode, 'session')
  await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
  assert.match(document.querySelector('[data-testid=diff-viewer-pane]').textContent, /session-only-change/)
  assert.equal(requests.some(url => url.includes('/workbench/git/')), false)
  await act(async () => document.querySelector('[data-testid=diff-more]').click())
  await act(async () => document.querySelector('[data-testid=diff-review-code-item]').click())
  assert.equal(JSON.parse(sent[0]).files, 'src/session.js', 'review action uses the exact comparison set being read')
})
