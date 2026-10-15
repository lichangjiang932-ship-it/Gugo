import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'

import SessionList from '../src/components/leftRail/SessionList.jsx'

const SESSION = { id: 'rename-1', title: 'Original name' }

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function typeInto(dom, input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  // React tracks the node's last known value on the node itself; going through
  // the prototype setter leaves that tracker behind, which is what makes React
  // see a change at all. A plain `input` event is enough to deliver it.
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}

const press = (dom, element, key) => element.dispatchEvent(
  new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
)

async function renderList({ onRename = () => {} } = {}) {
  const dom = setupDom()
  // Loaded after the DOM exists, not at the top of the file: react-dom reads
  // the document when it initializes, and a copy loaded against the previous
  // test's window leaves controlled inputs silently never firing onChange.
  const { createRoot } = await import('react-dom/client')
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  await act(async () => root.render(<SessionList
    sessions={[SESSION]}
    activeSessionId="rename-1"
    openMenuId="rename-1"
    onMenuOpen={() => {}}
    onMenuToggle={() => {}}
    onMenuClose={() => {}}
    onNewInProject={() => {}}
    onNewRecent={() => {}}
    onSearch={() => {}}
    onOpen={() => {}}
    onFork={() => {}}
    onPinToggle={() => {}}
    onArchiveToggle={() => {}}
    onDelete={() => {}}
    onRename={onRename}
    t={(key, values = {}) => Object.entries(values)
      .reduce((text, [name, value]) => `${text}:${name}=${value}`, key)}
  />))
  return { dom, root, rootElement }
}

const menuItem = (rootElement, key) => [...rootElement.querySelectorAll('[role="menuitem"]')]
  .find((button) => button.textContent.includes(key))

test('the menu renames in place, and Enter keeps exactly what the reader typed', async () => {
  const renamed = []
  const { dom, root, rootElement } = await renderList({
    onRename: (session, title) => renamed.push([session.id, title]),
  })
  try {
    await act(async () => menuItem(rootElement, 'nav.renameSession').click())
    const input = rootElement.querySelector('[data-session-rename-input]')
    assert.ok(input, 'the row turns into an input')
    assert.equal(input.value, 'Original name')

    await act(async () => typeInto(dom, input, '  A   name I chose  '))
    assert.equal(input.value, '  A   name I chose  ', 'the draft reaches the input')
    await act(async () => press(dom, input, 'Enter'))
    assert.equal(rootElement.querySelector('[data-session-rename-input]'), null, 'Enter reaches the handler')

    // Whitespace collapses, and it is sent once — Enter removes the input, and
    // the blur that follows must not send the same rename a second time.
    assert.deepEqual(renamed, [['rename-1', 'A name I chose']])
    assert.equal(rootElement.querySelector('[data-session-rename-input]'), null, 'the editor closes')
    assert.equal(rootElement.querySelector('[data-session-open]').textContent, 'Original name',
      'the list redraws from the store, not from the draft')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('IME candidate confirmation cannot commit a rename; Enter after composition commits once', async () => {
  const renamed = []
  const { dom, root, rootElement } = await renderList({ onRename: (session, title) => renamed.push([session.id, title]) })
  try {
    await act(async () => menuItem(rootElement, 'nav.renameSession').click())
    const input = rootElement.querySelector('[data-session-rename-input]')
    await act(async () => typeInto(dom, input, 'zhongwen'))
    for (const event of [
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }),
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }),
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }),
    ]) {
      await act(async () => input.dispatchEvent(event))
      assert.equal(rootElement.querySelector('[data-session-rename-input]'), input)
      assert.deepEqual(renamed, [])
    }
    await act(async () => typeInto(dom, input, '中文标题'))
    await act(async () => press(dom, input, 'Enter'))
    assert.deepEqual(renamed, [['rename-1', '中文标题']])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('Escape abandons the edit without renaming', async () => {
  const renamed = []
  const { dom, root, rootElement } = await renderList({
    onRename: (session, title) => renamed.push([session.id, title]),
  })
  try {
    await act(async () => menuItem(rootElement, 'nav.renameSession').click())
    const input = rootElement.querySelector('[data-session-rename-input]')
    await act(async () => typeInto(dom, input, 'Discarded'))
    await act(async () => press(dom, input, 'Escape'))
    assert.deepEqual(renamed, [])
    assert.equal(rootElement.querySelector('[data-session-rename-input]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a blank or unchanged name is a cancel, not a rename', async () => {
  const renamed = []
  const { dom, root, rootElement } = await renderList({
    onRename: (session, title) => renamed.push([session.id, title]),
  })
  try {
    for (const draft of ['   ', 'Original name']) {
      await act(async () => menuItem(rootElement, 'nav.renameSession').click())
      const input = rootElement.querySelector('[data-session-rename-input]')
      await act(async () => typeInto(dom, input, draft))
      await act(async () => press(dom, input, 'Enter'))
    }
    assert.deepEqual(renamed, [], 'the title is the only way to tell rows apart, so it never goes blank')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
