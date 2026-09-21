import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import WorkbenchGit from '../../src/pages/ChatSplit/rightWorkbench/WorkbenchGit.jsx'

const COPY = {
  'workbench.git': 'Changes',
  'workbench.gitBranchUnknown': 'Unknown branch',
  'workbench.gitRefresh': 'Refresh Git status',
  'workbench.gitLoading': 'Reading Git status…',
  'workbench.gitClean': 'Working tree clean — no uncommitted changes.',
  'workbench.gitChangedFiles': 'Changed files',
  'workbench.gitSelectFile': 'Select a file to view its diff.',
  'workbench.gitUnavailable': 'Could not read Git status (Git is disabled, or this directory is not a repository).',
  'workbench.gitDiffUnavailable': 'Could not read the diff for this file.',
  'workbench.gitDiffTruncated': 'Showing the first {shown} of {total} lines.',
  'workbench.gitModified': 'Modified',
  'workbench.gitUntracked': 'Untracked',
}

const t = (key, values) => String(COPY[key] || key)
  .replace('{shown}', String(values?.shown ?? ''))
  .replace('{total}', String(values?.total ?? ''))

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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Route the two workbench endpoints and record every call. */
function stubWorkbench({ status = { ok: true, branch: 'main', files: [] }, diff = { ok: true, diff: '' }, failStatus = null, failDiff = null } = {}) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    calls.push({ url: target, body: init.body ? JSON.parse(init.body) : null })
    if (target.includes('/api/workbench/git/status')) {
      if (failStatus) return jsonResponse({ ok: false, error: failStatus }, 500)
      return jsonResponse(status)
    }
    if (target.includes('/api/workbench/git/diff')) {
      if (failDiff) return jsonResponse({ ok: false, error: failDiff }, 500)
      return jsonResponse(diff)
    }
    throw new Error(`unexpected request: ${target}`)
  }
  return calls
}

// One document for the whole file: a fresh jsdom per test accumulated enough
// DOM to fail allocation on the fifth case.
const dom = setupDom()

async function render() {
  const rootElement = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(rootElement)
  const root = createRoot(rootElement)
  await act(async () => { root.render(<WorkbenchGit t={t} />) })
  // The mount fetch settles on a later tick than the render itself.
  await act(async () => { await Promise.resolve() })
  return { dom, root, rootElement }
}

async function cleanup(root, rootElement) {
  await act(async () => { root.unmount() })
  rootElement.remove()
}

test('the panel lists changed files and renders the selected diff', async () => {
  const calls = stubWorkbench({
    status: {
      ok: true,
      branch: 'feature/git-panel',
      files: [
        { status: 'M', path: 'src/app.js' },
        { status: '??', path: 'notes.txt' },
      ],
    },
    diff: { ok: true, diff: '@@ -1,2 +1,3 @@\n-const one = 1\n+const one = 2\n+const two = 3' },
  })
  const { dom, root, rootElement } = await render()

  assert.equal(rootElement.querySelector('[data-testid="workbench-git"]').getAttribute('data-testid'), 'workbench-git')
  assert.match(rootElement.textContent, /feature\/git-panel/)
  assert.match(rootElement.textContent, /Changed files/)
  const files = [...rootElement.querySelectorAll('[data-testid="workbench-git-file"]')]
  assert.deepEqual(files.map((button) => button.textContent), [
    'Msrc/app.jsModified',
    '??notes.txtUntracked',
  ])
  // Nothing is fetched until a file is chosen.
  assert.equal(calls.length, 1)
  assert.match(rootElement.textContent, /Select a file to view its diff/)

  await act(async () => { files[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  assert.deepEqual(calls[1], { url: '/api/workbench/git/diff', body: { path: 'src/app.js' } })
  const diff = rootElement.querySelector('[data-testid="workbench-git-diff"]')
  assert.ok(diff)
  const lines = [...diff.querySelectorAll('pre')]
  assert.deepEqual(lines.map((line) => line.textContent), [
    '@@ -1,2 +1,3 @@',
    '-const one = 1',
    '+const one = 2',
    '+const two = 3',
  ])
  assert.match(lines[2].className, /text-success/)
  assert.match(lines[1].className, /text-danger/)

  await cleanup(root, rootElement)
})

test('a clean tree says so instead of rendering an empty list', async () => {
  stubWorkbench({ status: { ok: true, branch: 'main', files: [] } })
  const { root, rootElement } = await render()
  assert.match(rootElement.textContent, /Working tree clean/)
  assert.equal(rootElement.querySelectorAll('[data-testid="workbench-git-file"]').length, 0)
  await cleanup(root, rootElement)
})

test('a failed status read explains itself and keeps the server text visible', async () => {
  stubWorkbench({ failStatus: 'WORKSPACE_GIT_ENABLED=1 is not enabled' })
  const { root, rootElement } = await render()
  const alert = rootElement.querySelector('[data-testid="workbench-git-error"]')
  assert.ok(alert)
  assert.match(alert.textContent, /Could not read Git status/)
  // The server message is data, shown for diagnosis rather than acted on.
  assert.match(alert.textContent, /WORKSPACE_GIT_ENABLED/)
  assert.equal(rootElement.querySelectorAll('[data-testid="workbench-git-file"]').length, 0)
  await cleanup(root, rootElement)
})

test('a failed diff read keeps the file list and reports the failure', async () => {
  stubWorkbench({
    status: { ok: true, branch: 'main', files: [{ status: 'M', path: 'src/app.js' }] },
    failDiff: 'diff is unavailable',
  })
  const { dom, root, rootElement } = await render()
  const file = rootElement.querySelector('[data-testid="workbench-git-file"]')
  await act(async () => { file.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  const alert = rootElement.querySelector('[data-testid="workbench-git-diff-error"]')
  assert.ok(alert)
  assert.match(alert.textContent, /Could not read the diff for this file/)
  assert.ok(rootElement.querySelector('[data-testid="workbench-git-file"]'), 'the list stays usable')
  assert.equal(Boolean(rootElement.querySelector('[data-testid="workbench-git-diff"]')), false)
  await cleanup(root, rootElement)
})

test('refreshing re-reads status and drops a selection the tree no longer has', async () => {
  stubWorkbench({
    status: { ok: true, branch: 'main', files: [{ status: 'M', path: 'src/app.js' }] },
    diff: { ok: true, diff: '+const one = 2' },
  })
  const { dom, root, rootElement } = await render()
  const file = rootElement.querySelector('[data-testid="workbench-git-file"]')
  await act(async () => { file.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  assert.ok(rootElement.querySelector('[data-testid="workbench-git-diff"]'))

  // The file is committed elsewhere, so the next read no longer lists it.
  stubWorkbench({ status: { ok: true, branch: 'main', files: [] } })
  await act(async () => {
    rootElement.querySelector('[data-testid="workbench-git-refresh"]')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.match(rootElement.textContent, /Working tree clean/)
  assert.equal(Boolean(rootElement.querySelector('[data-testid="workbench-git-diff"]')), false)
  await cleanup(root, rootElement)
})
