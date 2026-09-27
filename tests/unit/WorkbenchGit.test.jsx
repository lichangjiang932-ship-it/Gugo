import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'

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
  'workbench.gitChooseFile': 'Include {path} in the next commit',
  'workbench.gitChosenCount': 'Chosen: {count}',
  'workbench.gitChooseAll': 'Select all',
  'workbench.gitChooseNone': 'Clear',
  'workbench.gitCommit': 'Commit',
  'workbench.gitCommitMessage': 'Commit message',
  'workbench.gitCommitMessageHint': 'Commit message (3-200 characters)',
  'workbench.gitPush': 'Push',
  'workbench.gitCommitDone': 'Committed {commit}',
  'workbench.gitPushDone': 'Pushed {branch}',
}

const t = (key, values) => Object.entries(values || {})
  .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), String(COPY[key] || key))

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

/** Route the four workbench endpoints and record every call. */
function stubWorkbench({
  status = { ok: true, branch: 'main', files: [] },
  diff = { ok: true, diff: '' },
  failStatus = null,
  failDiff = null,
  commit = { ok: true, commit: 'abcdef1234567890', summary: '[main abcdef1] message' },
  failCommit = null,
  push = { ok: true, branch: 'main', remote: 'origin' },
  failPush = null,
} = {}) {
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
    if (target.includes('/api/workbench/git/commit')) {
      if (failCommit) return jsonResponse({ ok: false, error: failCommit }, 400)
      return jsonResponse(commit)
    }
    if (target.includes('/api/workbench/git/push')) {
      if (failPush) return jsonResponse({ ok: false, error: failPush }, 500)
      return jsonResponse(push)
    }
    throw new Error(`unexpected request: ${target}`)
  }
  return calls
}

// One document for the whole file: a fresh jsdom per test accumulated enough
// DOM to fail allocation on the fifth case.
const dom = setupDom()

async function render() {
  // Imported after setupDom(): react-dom captured before the document exists
  // silently stops dispatching change events for controlled inputs.
  const { createRoot } = await import('react-dom/client')
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

const CHANGED = [
  { status: 'M', path: 'src/app.js' },
  { status: '??', path: 'notes.txt' },
]

function boxes(rootElement) {
  return [...rootElement.querySelectorAll('[data-testid="workbench-git-choose"]')]
}

function button(rootElement, testid) {
  return rootElement.querySelector(`[data-testid="${testid}"]`)
}

async function click(dom, element) {
  await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
}

async function type(dom, input, value) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

test('committing sends exactly the chosen files and the typed message', async () => {
  const calls = stubWorkbench({ status: { ok: true, branch: 'main', files: CHANGED } })
  const { dom, root, rootElement } = await render()

  const commitButton = button(rootElement, 'workbench-git-commit')
  assert.equal(commitButton.disabled, true, 'nothing is chosen and no message is typed yet')

  await click(dom, boxes(rootElement)[1])
  assert.match(rootElement.textContent, /Chosen: 1/)
  assert.equal(commitButton.disabled, true, 'a message is still missing')

  await type(dom, button(rootElement, 'workbench-git-message'), 'ab')
  assert.equal(commitButton.disabled, true, 'the server refuses a message shorter than 3 characters')
  await type(dom, button(rootElement, 'workbench-git-message'), 'abc')
  assert.equal(commitButton.disabled, false)

  await act(async () => {
    button(rootElement, 'workbench-git-actions').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  })

  const commitCall = calls.find((call) => call.url.includes('/commit'))
  assert.deepEqual(commitCall, { url: '/api/workbench/git/commit', body: { message: 'abc', files: ['notes.txt'] } })
  // The panel reports what happened, empties itself, and re-reads the tree.
  assert.match(rootElement.textContent, /Committed abcdef12/)
  assert.equal(button(rootElement, 'workbench-git-message').value, '')
  assert.match(rootElement.textContent, /Chosen: 0/)
  assert.equal(calls.filter((call) => call.url.includes('/status')).length, 2, 'status is re-read after a commit')
  await cleanup(root, rootElement)
})

test('a refused commit keeps the plan and shows the server reason', async () => {
  const calls = stubWorkbench({
    status: { ok: true, branch: 'main', files: CHANGED },
    failCommit: 'git mutation permission is not granted',
  })
  const { dom, root, rootElement } = await render()
  await click(dom, boxes(rootElement)[0])
  await type(dom, button(rootElement, 'workbench-git-message'), 'fix the thing')
  await act(async () => {
    button(rootElement, 'workbench-git-actions').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  })

  const notice = button(rootElement, 'workbench-git-notice')
  assert.equal(notice.getAttribute('role'), 'alert')
  assert.match(notice.textContent, /permission is not granted/)
  // Nothing is thrown away on a failure: the reader can grant access and retry.
  assert.equal(button(rootElement, 'workbench-git-message').value, 'fix the thing')
  assert.match(rootElement.textContent, /Chosen: 1/)
  assert.equal(calls.filter((call) => call.url.includes('/status')).length, 1)
  await cleanup(root, rootElement)
})

test('select all and clear choose the whole tree or none of it', async () => {
  stubWorkbench({ status: { ok: true, branch: 'main', files: CHANGED } })
  const { dom, root, rootElement } = await render()

  await click(dom, button(rootElement, 'workbench-git-choose-all'))
  assert.match(rootElement.textContent, /Chosen: 2/)
  assert.deepEqual(boxes(rootElement).map((box) => box.checked), [true, true])
  assert.equal(button(rootElement, 'workbench-git-choose-all').textContent, 'Clear')

  await click(dom, button(rootElement, 'workbench-git-choose-all'))
  assert.match(rootElement.textContent, /Chosen: 0/)
  assert.deepEqual(boxes(rootElement).map((box) => box.checked), [false, false])
  await cleanup(root, rootElement)
})

test('a chosen file the tree no longer lists is dropped from the plan', async () => {
  stubWorkbench({ status: { ok: true, branch: 'main', files: CHANGED } })
  const { dom, root, rootElement } = await render()
  await click(dom, boxes(rootElement)[0])
  assert.match(rootElement.textContent, /Chosen: 1/)

  // Committed elsewhere in the meantime, so the next read does not list it.
  stubWorkbench({ status: { ok: true, branch: 'main', files: [CHANGED[1]] } })
  await click(dom, button(rootElement, 'workbench-git-refresh'))
  assert.match(rootElement.textContent, /Chosen: 0/)
  assert.equal(button(rootElement, 'workbench-git-commit').disabled, true)
  await cleanup(root, rootElement)
})

test('pushing is its own press and reports what the remote said', async () => {
  stubWorkbench({ status: { ok: true, branch: 'feature/git-panel', files: [] } })
  const { dom, root, rootElement } = await render()
  assert.equal(button(rootElement, 'workbench-git-push'), null, 'no changes means no action bar')

  // A second stub answers the next reads; its call log is the one to inspect.
  const calls = stubWorkbench({ status: { ok: true, branch: 'feature/git-panel', files: CHANGED }, push: { ok: true, branch: 'feature/git-panel' } })
  await click(dom, button(rootElement, 'workbench-git-refresh'))
  await click(dom, button(rootElement, 'workbench-git-push'))
  const pushCall = calls.find((call) => call.url.includes('/push'))
  assert.deepEqual(pushCall, { url: '/api/workbench/git/push', body: {} })
  assert.match(button(rootElement, 'workbench-git-notice').textContent, /Pushed feature\/git-panel/)
  assert.equal(button(rootElement, 'workbench-git-notice').getAttribute('role'), 'status')
  await cleanup(root, rootElement)
})

test('a failed push leaves the working tree alone and says why', async () => {
  stubWorkbench({
    status: { ok: true, branch: 'main', files: CHANGED },
    failPush: 'git push origin main failed: no upstream',
  })
  const { dom, root, rootElement } = await render()
  await click(dom, button(rootElement, 'workbench-git-push'))

  const notice = button(rootElement, 'workbench-git-notice')
  assert.equal(notice.getAttribute('role'), 'alert')
  assert.match(notice.textContent, /no upstream/)
  assert.equal(boxes(rootElement).length, 2, 'the change list is untouched')
  await cleanup(root, rootElement)
})
