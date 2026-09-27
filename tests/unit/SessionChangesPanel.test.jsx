import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'

const COPY = {
  'chat.changes.title': 'Changes in this conversation',
  'chat.changes.summary': '{count} file(s)',
  'chat.changes.totals': '+{additions} -{deletions}',
  'chat.changes.empty': 'This conversation has not changed any files yet.',
  'chat.changes.scriptOnly': 'Produced by a script; no edit was recorded.',
  'chat.changes.readOnly': 'Read-only review: nothing here commits or pushes.',
  'chat.changes.close': 'Close the change list',
  'chat.changes.toggle': 'Show the files this conversation changed',
  'chat.changes.toggleCount': 'This conversation changed {count} files',
}

const t = (key, values) => Object.entries(values || {})
  .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), String(COPY[key] || key))

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

const CHANGES = {
  files: [
    {
      key: 'd:/work/app.js',
      path: 'D:/work/app.js',
      displayPath: 'app.js',
      reported: { additions: 3, deletions: 1 },
      toolNames: ['apply_patch'],
      toolCallIds: ['c1'],
    },
    {
      key: 'd:/work/readme.md',
      path: 'D:/work/readme.md',
      displayPath: 'readme.md',
      reported: null,
      toolNames: ['edit_file'],
      toolCallIds: ['c2'],
    },
    {
      key: 'd:/work/out.html',
      path: 'D:/work/out.html',
      displayPath: 'out.html',
      reported: null,
      toolNames: ['bash_exec'],
      toolCallIds: ['c3'],
    },
  ],
  totals: { files: 3, reportedFiles: 1, additions: 3, deletions: 1 },
}

const EDIT_INDEX = new Map([
  ['d:/work/readme.md', [{
    toolName: 'edit_file',
    kind: 'replace',
    removed: ['old line', 'another'],
    added: ['new line'],
  }]],
])

async function render(props = {}) {
  const { createRoot } = await import('react-dom/client')
  const SessionChangesPanel = (await import('../../src/pages/ChatSplit/chatSplitView/SessionChangesPanel.jsx')).default
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let closed = 0
  await act(async () => {
    root.render(
      <SessionChangesPanel
        review={{
          changes: props.changes ?? CHANGES,
          close: () => { closed += 1 },
          editIndex: props.editIndex ?? EDIT_INDEX,
          visible: props.visible ?? true,
        }}
        t={t}
      />,
    )
  })
  return {
    container,
    root,
    closedCount: () => closed,
    rows: () => [...container.querySelectorAll('[data-testid="session-change-file"]')],
  }
}

test('the review lists each file with the counts that belong to it', async () => {
  setupDom()
  const { container, rows } = await render()
  assert.match(container.textContent, /3 file\(s\)/)
  // Totals are only shown for what an executor actually reported.
  assert.match(container.textContent, /\+3 -1/)

  assert.deepEqual(rows().map((row) => row.dataset.path), ['app.js', 'readme.md', 'out.html'])
  const [app, readme, scripted] = rows()
  assert.equal(app.textContent, 'app.js+3−1')
  // The executor reported nothing for this one, so the lines of the recorded edit
  // are what its numbers are made of.
  assert.equal(readme.textContent, 'readme.md+1−2')
  assert.equal(scripted.textContent, 'out.html+0−0')
  assert.equal(container.querySelector('[data-testid="session-changes-empty"]'), null)
})

test('opening a file shows the edit the agent made, and a script-only file says so', async () => {
  setupDom()
  const { container, rows } = await render()
  const [app, readme, scripted] = rows()

  await act(async () => { app.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true })) })
  assert.equal(app.getAttribute('aria-expanded'), 'true')
  assert.match(container.textContent, /Produced by a script/, 'a patch with no recorded body is honest about it')
  assert.equal(container.querySelectorAll('[data-testid="session-change-edit"]').length, 0)

  await act(async () => { readme.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true })) })
  const lines = [...container.querySelectorAll('[data-testid="session-change-edit"] pre')]
  assert.deepEqual(lines.map((line) => line.textContent), ['-old line', '-another', '+new line'])
  assert.match(lines[0].className, /text-danger/)
  assert.match(lines[2].className, /text-success/)

  // One file at a time: opening another closes the first.
  await act(async () => { scripted.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true })) })
  assert.equal(readme.getAttribute('aria-expanded'), 'false')
  assert.equal(scripted.getAttribute('aria-expanded'), 'true')
})

test('a closed review renders nothing at all', async () => {
  setupDom()
  const { container } = await render({ visible: false })
  assert.equal(container.querySelector('[data-testid="session-changes-panel"]'), null)
})

test('an untouched conversation says so instead of showing an empty list', async () => {
  setupDom()
  const { container, rows } = await render({
    changes: { files: [], totals: { files: 0, reportedFiles: 0, additions: 0, deletions: 0 } },
    editIndex: new Map(),
  })
  assert.equal(rows().length, 0)
  assert.match(container.textContent, /has not changed any files/)
  assert.match(container.textContent, /Read-only review/)
})

test('closing is one press, and the header shows the file count', async () => {
  setupDom()
  const { container, closedCount } = await render()
  await act(async () => {
    container.querySelector('[data-testid="session-changes-close"]')
      .dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(closedCount(), 1)

  const { createRoot } = await import('react-dom/client')
  const SessionChangesReview = (await import('../../src/pages/ChatSplit/chatSplitView/SessionChangesReview.jsx')).default
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<SessionChangesReview review={{ count: 3, toggle: () => {}, visible: false }} t={t} />) })
  // The count is visible; the sentence is only for readers who need it spoken.
  assert.equal(host.querySelector('span.tabular-nums').textContent, '3')
  assert.match(host.querySelector('.sr-only').textContent, /changed 3 files/)
  await act(async () => { root.render(<SessionChangesReview review={{ count: 0, toggle: () => {}, visible: false }} t={t} />) })
  // Nothing changed: the indicator stays an icon rather than claiming a zero.
  assert.equal(host.querySelector('button').textContent, '')
})
