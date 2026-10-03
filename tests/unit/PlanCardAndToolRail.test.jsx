import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'

import PlanCard from '../../src/pages/ChatSplit/chatSplitView/PlanCard.jsx'
import {
  shortcutKeyHint,
  shortcutLabelFor,
  matchWorkbenchShortcut,
  WORKBENCH_TOOLS,
} from '../../src/lib/workbenchShortcuts.js'
import { translateKey } from '../../src/i18n/translations.js'

const t = (key, values = {}) => translateKey(key, 'zh').replace(/\{(\w+)\}/g, (_, name) => values[name])
const tool = (id) => WORKBENCH_TOOLS.find((entry) => entry.id === id)

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

async function mount(panel) {
  const dom = setupDom()
  const { createRoot } = await import('react-dom/client')
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  await act(async () => { root.render(panel) })
  return { dom, root, rootElement }
}

// ---------------------------------------------------------------------------
// The three tool keys
// ---------------------------------------------------------------------------

test('exactly the three tool combinations open a tool, and nothing else does', () => {
  assert.deepEqual(WORKBENCH_TOOLS.map((entry) => entry.id), ['files', 'browser', 'terminal'])
  assert.equal(matchWorkbenchShortcut({ key: 'f', ctrlKey: true, altKey: true }), 'files')
  // The side chat's old key opens nothing now.
  assert.equal(matchWorkbenchShortcut({ key: 's', ctrlKey: true, altKey: true }), null)
  assert.equal(matchWorkbenchShortcut({ key: 't', ctrlKey: true }), 'browser')
  assert.equal(matchWorkbenchShortcut({ key: '\\', ctrlKey: true }), 'terminal')

  // A stray modifier must not be mistaken for the tool: Ctrl+Shift+T is the
  // browser's "reopen closed tab", and Cmd+T belongs to the operating system.
  for (const event of [
    { key: 't', ctrlKey: true, shiftKey: true },
    { key: 't', metaKey: true },
    { key: 't' },
    { key: 's', ctrlKey: true },
    { key: 's', altKey: true },
    { key: 'b', ctrlKey: true },
    { key: '', ctrlKey: true },
    null,
  ]) {
    assert.equal(matchWorkbenchShortcut(event), null, JSON.stringify(event))
  }
})

test('the hint on a tool button is the key that actually works', () => {
  // Written for this machine's keyboard, so a Mac reader is not told to press a
  // key their keyboard does not have.
  assert.equal(shortcutLabelFor(tool('files'), { platform: 'Win32' }), 'Ctrl+Alt+F')
  assert.equal(shortcutLabelFor(tool('browser'), { platform: 'Win32' }), 'Ctrl+T')
  assert.equal(shortcutLabelFor(tool('terminal'), { platform: 'Win32' }), 'Ctrl+\\')
  assert.equal(shortcutLabelFor(tool('files'), { platform: 'MacIntel' }), '⌘⌥F')
  assert.equal(shortcutLabelFor(tool('browser'), { platform: 'MacIntel' }), '⌘T')
  // The narrow rail prints only the final key; the modifier lives in the tooltip.
  assert.equal(shortcutKeyHint(tool('files')), 'F')
  assert.equal(shortcutKeyHint(tool('terminal')), '\\')
  assert.equal(shortcutLabelFor(undefined), '')
})

// ---------------------------------------------------------------------------
// The plan card
// ---------------------------------------------------------------------------

test('the plan card floats over the working area and closes from its own button', async (t2) => {
  const closed = []
  const { dom, root, rootElement } = await mount(
    <PlanCard
      onClose={() => closed.push(true)}
      onOpenArtifact={() => {}}
      sessionId="session-1"
      t={t}
      todos={[{ id: 'todo-1', content: '检查右侧工具条', status: 'in_progress' }]}
    />,
  )
  t2.after(async () => { await act(async () => root.unmount()); dom.window.close() })

  const card = rootElement.querySelector('[data-testid="plan-card"]')
  assert.ok(card)
  // It is an overlay, not a docked pane: that is what lets it sit over the chat
  // when the tool panel is closed and over the panel when it is open.
  assert.match(card.className, /absolute/)
  assert.match(card.className, /right-3/)
  assert.match(card.textContent, /任务清单/)
  assert.match(card.textContent, /检查右侧工具条/)

  const close = rootElement.querySelector('[data-testid="plan-card-close"]')
  assert.ok(close, 'the card can be closed explicitly')
  assert.equal(close.getAttribute('aria-label'), '关闭任务清单')
  await act(async () => { close.click() })
  assert.deepEqual(closed, [true])
})

test('an empty session still gets a card that says so rather than a blank box', async (t2) => {
  const { dom, root, rootElement } = await mount(<PlanCard onClose={() => {}} t={t} todos={[]} />)
  t2.after(async () => { await act(async () => root.unmount()); dom.window.close() })
  assert.match(rootElement.querySelector('[data-testid="plan-card"]').textContent, /还没有任务清单/)
})

test('the plan card clears the header row and Escape inside it closes it', async (t2) => {
  const closed = []
  const { dom, root, rootElement } = await mount(<PlanCard onClose={() => closed.push(true)} t={t} todos={[]} />)
  t2.after(async () => { await act(async () => root.unmount()); dom.window.close() })
  const card = rootElement.querySelector('[data-testid="plan-card"]')
  // Anchored at top-3 the card sat on the 48px header and hid its toggle and the
  // workbench's close button.
  assert.match(card.className, /\btop-14\b/)
  assert.doesNotMatch(card.className, /\btop-3\b/)
  // Progress only: the files moved to the workbench's own tool.
  assert.equal(rootElement.querySelector('[role="tablist"]'), null)
  assert.equal(rootElement.querySelector('[data-testid="plan-card-tab-files"]'), null)
  assert.equal(rootElement.querySelector('[data-testid="workbench-plan-output"]'), null)
  await act(async () => {
    rootElement.querySelector('[data-testid="plan-card-close"]')
      .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  assert.deepEqual(closed, [true])
})
