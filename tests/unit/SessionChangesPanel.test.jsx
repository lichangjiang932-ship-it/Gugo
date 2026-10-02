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
  'chat.changes.expand': "Expand this file's change in place",
  'chat.changes.openDiff': 'Read the change to {path} in the main area',
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
  const opened = []
  await act(async () => {
    root.render(
      <SessionChangesPanel
        review={{
          changes: props.changes ?? CHANGES,
          close: () => { closed += 1 },
          editIndex: props.editIndex ?? EDIT_INDEX,
          openDiff: props.openDiff === undefined
            ? (file, edits) => opened.push({ edits, file })
            : props.openDiff,
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
    openedDiffs: () => opened,
    rows: () => [...container.querySelectorAll('[data-testid="session-change-file"]')],
    toggles: () => [...container.querySelectorAll('[data-testid="session-change-file-toggle"]')],
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
  const { container, toggles } = await render()
  const [app, readme, scripted] = toggles()

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

test('the file row hands its file and its recorded edits to the review', async () => {
  setupDom()
  const { rows, openedDiffs } = await render()
  const [app, readme] = rows()
  assert.equal(rows().length, 3)
  // The row names the file it will open, so a reader with several previews open
  // knows which one this is.
  assert.equal(app.getAttribute('title'), 'Read the change to app.js in the main area')

  await act(async () => { readme.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true })) })
  assert.equal(openedDiffs().length, 1)
  const [{ edits, file }] = openedDiffs()
  assert.equal(file.displayPath, 'readme.md')
  assert.deepEqual(edits, EDIT_INDEX.get('d:/work/readme.md'))
})

test('the review turns a file and its edits into the diff the main area opens', async () => {
  setupDom()
  const { createRoot } = await import('react-dom/client')
  const useSessionChangesReview = (await import('../../src/pages/ChatSplit/useSessionChangesReview.js')).default
  const opened = []
  let review = null
  function Probe() {
    review = useSessionChangesReview({ messages: [], onOpenDiff: (artifact) => opened.push(artifact) })
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<Probe />) })
    const [reportedFile] = CHANGES.files
    const editedFile = CHANGES.files[1]
    const edits = EDIT_INDEX.get(editedFile.key)
    await act(async () => {
      review.openDiff(editedFile, edits)
      review.openDiff(reportedFile, [])
    })
    const [edited, reported] = opened
    assert.equal(edited.preview.type, 'diff')
    assert.equal(edited.preview.filename, 'readme.md')
    assert.equal(edited.preview.path, 'D:/work/readme.md')
    // The lines are the ones the panel shows, and its summary is what it counted.
    assert.deepEqual(edited.preview.hunks, edits)
    assert.equal(edited.preview.summary, '+1 −2')
    // A file the executor reported numbers for keeps those numbers, not a recount.
    assert.equal(reported.preview.summary, '+3 −1')
    assert.deepEqual(reported.preview.hunks, [])
    // Two files are two tabs: identity comes from the path, not from the order.
    assert.notEqual(edited.preview.path, reported.preview.path)
  } finally {
    await act(async () => root.unmount())
  }
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
})

test('closing is one press, and the header shows the diff stat', async () => {
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
  await act(async () => {
    root.render(<SessionChangesReview review={{ count: 3, summary: { files: 3, additions: 12, deletions: 4 }, toggle: () => {}, visible: false }} t={t} />)
  })
  // Codex's "+12 −4": the size of the change, in diff colours. The file count is
  // still spoken for readers who need it, and is on the tooltip.
  assert.equal(host.querySelector('[data-testid="session-changes-stat"]').textContent, '+12−4')
  assert.match(host.querySelector('.sr-only').textContent, /changed 3 files/)
  assert.match(host.querySelector('button').getAttribute('title'), /3 files/)
  await act(async () => { root.render(<SessionChangesReview review={{ count: 0, toggle: () => {}, visible: false }} t={t} />) })
  // Nothing changed: the indicator stays an icon rather than claiming a zero.
  assert.equal(host.querySelector('button').textContent, '')
})

test('the panel opens below the header and Escape closes it from the panel or its toggle', async () => {
  setupDom()
  const { container, closedCount } = await render()
  const panel = container.querySelector('[data-testid="session-changes-panel"]')
  // top-3 put the panel over the header row, covering the very toggle that
  // closes it; it now clears the 48px header.
  assert.match(panel.className, /\btop-14\b/)
  assert.doesNotMatch(panel.className, /\btop-3\b/)

  const escape = () => new globalThis.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  await act(async () => { container.querySelector('[data-testid="session-change-file-toggle"]').dispatchEvent(escape()) })
  assert.equal(closedCount(), 1, 'Escape inside the panel closes it')

  const { createRoot } = await import('react-dom/client')
  const SessionChangesReview = (await import('../../src/pages/ChatSplit/chatSplitView/SessionChangesReview.jsx')).default
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  let reviewClosed = 0
  const review = (visible) => ({ count: 1, close: () => { reviewClosed += 1 }, toggle: () => {}, visible })
  await act(async () => { root.render(<SessionChangesReview review={review(true)} t={t} />) })
  await act(async () => { host.querySelector('button').dispatchEvent(escape()) })
  assert.equal(reviewClosed, 1, 'focus stays on the toggle after a click, so Escape there closes too')
  await act(async () => { root.render(<SessionChangesReview review={review(false)} t={t} />) })
  await act(async () => { host.querySelector('button').dispatchEvent(escape()) })
  assert.equal(reviewClosed, 1, 'a closed panel leaves Escape alone')
})
