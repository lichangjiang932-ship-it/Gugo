import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'

import { translateKey } from '../../src/i18n/translations.js'
import { _testing as pageStore } from '../../src/lib/previewPageStore.js'

const t = (key, values = {}) => translateKey(key, 'zh').replace(/\{(\w+)\}/g, (_, name) => values[name])

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.CustomEvent = dom.window.CustomEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

/** react-dom/client only after the DOM exists — see the JSX bootstrap note. */
async function renderToolbar(props) {
  const { createRoot } = await import('react-dom/client')
  const WorkbenchToolbar = (await import('../../src/pages/ChatSplit/rightWorkbench/WorkbenchToolbar.jsx')).default
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(<WorkbenchToolbar t={t} {...props} />) })
  return { container, root }
}

test.afterEach(() => pageStore.reset())

test('the arrows walk the sidebar until a page is open, then they walk the page', async () => {
  setupDom()
  const dom = globalThis.window
  const events = []
  dom.addEventListener('workbench-preview:back', () => events.push('back'))
  dom.addEventListener('workbench-preview:forward', () => events.push('forward'))
  const tabs = []
  const { container, root } = await renderToolbar({ activeTab: 'browser', onTabChange: (tab) => tabs.push(tab) })
  try {
    const back = container.querySelector('[data-testid="workbench-tool-entry"]')
    const forward = container.querySelector('[data-testid="workbench-tool-forward"]')

    // Nothing loaded yet: there is no page history, so back still means "leave
    // the browser tab" and forward has nowhere to go.
    assert.equal(back.disabled, false)
    assert.equal(forward.disabled, true)
    assert.equal(back.getAttribute('title'), translateKey('workbench.entryBack', 'zh'))

    // With a page that has history, the same two buttons are the page's.
    await act(async () => {
      const { publishPreviewPageStatus } = await import('../../src/lib/previewPageStore.js')
      publishPreviewPageStatus({ url: 'http://localhost:3000/', canGoBack: true, canGoForward: true, backend: 'frame' })
    })
    assert.equal(back.disabled, false)
    assert.equal(forward.disabled, false)
    assert.equal(back.getAttribute('title'), translateKey('workbench.browserBack', 'zh'))
    assert.equal(forward.getAttribute('title'), translateKey('workbench.browserForward', 'zh'))

    await act(async () => back.dispatchEvent(new dom.MouseEvent('click', { bubbles: true })))
    await act(async () => forward.dispatchEvent(new dom.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(events, ['back', 'forward'])
    assert.deepEqual(tabs, [], 'the page arrows do not switch tools')

    // A page with no history of its own disables them again.
    await act(async () => {
      const { publishPreviewPageStatus } = await import('../../src/lib/previewPageStore.js')
      publishPreviewPageStatus({ url: 'http://localhost:3000/', canGoBack: false, canGoForward: false })
    })
    assert.equal(back.disabled, true)
    assert.equal(forward.disabled, true)
  } finally {
    await act(async () => root.unmount())
    dom.close()
  }
})

test('the picker is offered only where a page can be read, and reports being on', async () => {
  setupDom()
  const dom = globalThis.window
  const picks = []
  const { container, root } = await renderToolbar({ activeTab: 'browser', onPickElement: () => picks.push('pick') })
  try {
    const select = container.querySelector('[data-testid="workbench-tool-select"]')
    // No desktop browser view here: the app cannot see into a frame it does not own.
    assert.equal(select.disabled, true)

    // With one, the control is live and says when it is picking.
    dom.gugoDesktop = { browser: { navigate: () => {}, capture: () => {}, evaluate: () => {} } }
    const second = await renderToolbar({ activeTab: 'browser', onPickElement: () => picks.push('pick') })
    const live = second.container.querySelector('[data-testid="workbench-tool-select"]')
    assert.equal(live.disabled, false)
    assert.equal(live.getAttribute('aria-pressed'), null)
    await act(async () => live.dispatchEvent(new dom.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(picks, ['pick'])

    const picking = await renderToolbar({ activeTab: 'browser', onPickElement: () => {}, picking: true })
    assert.equal(picking.container.querySelector('[data-testid="workbench-tool-select"]').getAttribute('aria-pressed'), 'true')

    // Off the browser tab there is no page to point at.
    const elsewhere = await renderToolbar({ activeTab: 'chat', onPickElement: () => {} })
    assert.equal(elsewhere.container.querySelector('[data-testid="workbench-tool-select"]').disabled, true)

    await act(async () => second.root.unmount())
    await act(async () => picking.root.unmount())
    await act(async () => elsewhere.root.unmount())
  } finally {
    delete dom.gugoDesktop
    await act(async () => root.unmount())
  }
})

test('the tool list stays reachable from the browser tab', async () => {
  setupDom()
  const tabs = []
  const { container, root } = await renderToolbar({ activeTab: 'browser', onTabChange: (tab) => tabs.push(tab) })
  try {
    const entry = container.querySelector('[data-testid="workbench-menu-entry"]')
    assert.ok(entry, 'the menu carries the way back to the entry page')
    assert.equal(entry.textContent, translateKey('workbench.entryHome', 'zh'))
    await act(async () => entry.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(tabs, ['entry'])
  } finally {
    await act(async () => root.unmount())
  }
})

test('the entry page itself has no back arrow to offer', async () => {
  setupDom()
  const { container, root } = await renderToolbar({ activeTab: 'entry' })
  try {
    assert.equal(container.querySelector('[data-testid="workbench-tool-entry"]').disabled, true)
    assert.equal(container.querySelector('[data-testid="workbench-menu-entry"]'), null)
  } finally {
    await act(async () => root.unmount())
  }
})

test('the preview page store notifies only when something changed', async () => {
  setupDom()
  const { previewPageSnapshot, publishPreviewPageStatus, subscribePreviewPageStatus } = await import('../../src/lib/previewPageStore.js')
  let notifications = 0
  const unsubscribe = subscribePreviewPageStatus(() => { notifications += 1 })
  try {
    publishPreviewPageStatus({ url: 'http://localhost:3000/' })
    assert.equal(notifications, 1)
    // The panel reports its status on every render; only real changes are news.
    publishPreviewPageStatus({ url: 'http://localhost:3000/' })
    assert.equal(notifications, 1)
    publishPreviewPageStatus({ url: 'http://localhost:3000/', canGoBack: true })
    assert.equal(notifications, 2)
    assert.deepEqual(previewPageSnapshot(), {
      url: 'http://localhost:3000/', title: '', canGoBack: true, canGoForward: false, loading: false, backend: 'frame',
    })
  } finally {
    unsubscribe()
  }
})
