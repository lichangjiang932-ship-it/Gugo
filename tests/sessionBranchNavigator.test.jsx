import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import SessionBranchNavigator from '../src/pages/ChatSplit/chatSplitView/SessionBranchNavigator.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const t = (key) => key

test('branch navigator loads the owned tree and opens a selected branch', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  const requests = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    return response({
      rootSessionId: 'root-session',
      truncated: false,
      branches: [
        {
          id: 'root-session', title: 'Project', depth: 0, revision: 1,
          branchSummary: 'Root answer', fileOperations: [], fileOperationsTruncated: true,
        },
        {
          id: 'child-session', title: 'Project', depth: 1, revision: 2,
          parentSessionId: 'root-session', branchLabel: 'Alternative', branchSummary: 'Alternative prompt',
          fileOperations: [
            { path: 'D:\\project\\created.txt', action: 'created', toolName: 'write_file' },
            { path: 'D:\\project\\updated.js', action: 'modified', toolName: 'apply_patch' },
          ],
          fileOperationsTruncated: false,
        },
        {
          id: 'grandchild-session', title: 'Project', depth: 2, revision: 3,
          parentSessionId: 'child-session', branchLabel: null, branchSummary: 'Newest branch answer',
        },
      ],
    })
  }

  try {
    await act(async () => root.render(<SessionBranchNavigator
      sessionId="child-session"
      onOpenSession={(session) => opened.push(session)}
      t={t}
    />))

    const toggle = rootElement.querySelector('[data-testid="session-branch-navigator"]')
    assert.ok(toggle)
    await act(async () => {
      toggle.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/api/sessions/child-session/branches')
    const menu = rootElement.querySelector('[data-testid="session-branch-menu"]')
    assert.ok(menu)
    assert.equal(menu.querySelectorAll('[role="menuitem"]').length, 3)
    assert.match(menu.querySelector('[data-branch-id="root-session"]').textContent, /nav\.branchRoot/)
    assert.match(menu.querySelector('[data-branch-id="child-session"]').textContent, /Alternative.*Alternative prompt.*nav\.branchCurrent/)
    assert.match(menu.querySelector('[data-branch-id="grandchild-session"]').textContent, /nav\.branchUntitled.*Newest branch answer/)
    assert.match(menu.querySelector('[data-branch-id="root-session"]').textContent, /nav\.branchFileChangesUnavailable/)
    const fileChanges = menu.querySelector('[data-testid="branch-file-operations-child-session"]')
    assert.match(fileChanges.textContent, /nav\.branchFileChanges.*\+ created\.txt.*~ updated\.js/)
    assert.match(fileChanges.title, /created: D:\\project\\created\.txt \(write_file\)/)

    await act(async () => menu.querySelector('[data-branch-id="grandchild-session"]').click())
    assert.equal(opened.length, 1)
    assert.equal(opened[0].id, 'grandchild-session')
    assert.equal(rootElement.querySelector('[data-testid="session-branch-menu"]'), null)

    await act(async () => root.render(<SessionBranchNavigator sessionId="" onOpenSession={() => {}} t={t} />))
    assert.equal(rootElement.querySelector('[data-testid="session-branch-navigator"]'), null)
  } finally {
    globalThis.fetch = previousFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})
