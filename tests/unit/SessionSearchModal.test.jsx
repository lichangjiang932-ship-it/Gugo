import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { JSDOM } from 'jsdom'

const SESSIONS = [
  {
    id: 'search-orchard', title: 'Orchard notes',
    messages: [{ id: 'message/orchard', role: 'user', content: 'Compare Cobalt lantern materials.', timestamp: 1_700_000_000_000 }],
  },
  {
    id: 'search-inventory', title: 'Cobalt inventory',
    messages: [{ id: 'message inventory', role: 'assistant', content: [{ type: 'text', text: 'A folded amber map.' }], timestamp: 1_700_000_000_001 }],
  },
  {
    id: 'search-travel', title: 'Unrelated itinerary',
    messages: [{ id: 'message-travel', role: 'user', content: 'Take the evening train.', timestamp: 1_700_000_000_002 }],
  },
]

async function mount(context, lang = 'en') {
  const dom = new JSDOM('<!doctype html><html><body><button id="launcher">Search conversations</button><div id="root"></div></body></html>', {
    url: 'http://localhost/#/settings',
  })
  const globals = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement, HTMLInputElement: dom.window.HTMLInputElement,
    CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previousGlobals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  dom.window.localStorage.setItem('lang', lang)
  const requests = []
  context.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url))
    assert.equal(String(url), '/api/auth/bootstrap', 'no search, model, or other real HTTP calls are allowed')
    return Response.json({ ok: true, mode: 'local', authenticated: false, user: null })
  })
  // Import React DOM after installing the DOM so its real input-event support is detected.
  const [{ act }, { createRoot }, { AppProvider, useAppContext }, { I18nProvider }, { HashRouter }, { default: SessionSearchModal }, { setAuthToken }, { translateKey }] = await Promise.all([
    import('react'), import('react-dom/client'), import('../../src/store/AppContext.jsx'),
    import('../../src/i18n/I18nProvider.jsx'), import('../../src/lib/router.jsx'),
    import('../../src/components/SessionSearchModal.jsx'), import('../../src/lib/accountClient.js'),
    import('../../src/i18n/translations.js'),
  ])
  setAuthToken('')
  let app
  function StateProbe() {
    app = useAppContext()
    return null
  }
  const root = createRoot(document.getElementById('root'))
  const runtimeErrors = []
  dom.window.addEventListener('error', event => runtimeErrors.push(event.error || event.message))
  context.after(async () => {
    try {
      await act(async () => root.unmount())
      setAuthToken('')
      assert.deepEqual(requests, ['/api/auth/bootstrap'], 'the fixture handles only auth bootstrap; all search stays local')
      assert.deepEqual(runtimeErrors, [], 'the component must not emit DOM runtime errors')
    } finally {
      dom.window.close()
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      }
    }
  })
  await act(async () => root.render(
    <I18nProvider><HashRouter><AppProvider><StateProbe /><SessionSearchModal /></AppProvider></HashRouter></I18nProvider>,
  ))
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 2_000
    while (!predicate() && Date.now() < deadline) await act(async () => { await delay(0) })
    assert.ok(predicate(), message)
  }
  await waitFor(() => app, 'the real AppProvider completes isolated bootstrap')
  await act(async () => {
    app.dispatch({ type: 'RECONCILE_SERVER_SESSION_CATALOG', payload: { sessions: SESSIONS.map(({ id, title }) => ({ id, title, revision: 1, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 })) } })
    for (const session of SESSIONS) {
      app.dispatch({ type: 'APPLY_SERVER_SESSION_SNAPSHOT', payload: { sessionId: session.id, snapshot: { complete: true, revision: 1, messages: session.messages } } })
    }
  })
  assert.equal(app.state.sessions.length, SESSIONS.length)
  const launcher = document.getElementById('launcher')
  launcher.focus()
  const dialog = () => document.querySelector('[role="dialog"]')
  const input = () => dialog()?.querySelector('input[type="search"]')
  const press = async (target, key, modifiers = {}) => {
    const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
    await act(async () => target.dispatchEvent(event))
    return event
  }
  const open = async (query) => {
    await act(async () => dom.window.dispatchEvent(new dom.window.CustomEvent('session-search:open', {
      detail: query === undefined ? undefined : { query },
    })))
    await waitFor(() => input() && document.activeElement === input(), 'opening focuses the search field without a manual focus call')
  }
  const type = async value => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input(), value)
      input().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }
  const result = title => [...(dialog()?.querySelectorAll('button') || [])].find(button => button.textContent.includes(title))
  return { dom, launcher, dialog, input, press, open, type, result, waitFor, act, state: () => app.state, t: key => translateKey(key, lang) }
}

for (const lang of ['zh', 'en']) {
  test(`${lang}: opening the real session search auto-focuses its translated, labelled input`, async context => {
    const view = await mount(context, lang)
    assert.equal(view.dialog(), null)
    await view.open()
    assert.equal(view.dialog().getAttribute('aria-modal'), 'true')
    assert.equal(view.dialog().getAttribute('aria-label'), view.t('sessionSearch.placeholder'))
    assert.equal(view.input().getAttribute('aria-label'), view.t('sessionSearch.placeholder'))
    assert.ok(view.dialog().textContent.includes(view.t('sessionSearch.hint')))
    assert.ok(view.dialog().querySelector(`button[aria-label="${view.t('common.cancel')}"]`))
    assert.equal(document.activeElement, view.input())
  })
}

for (const modifier of ['ctrlKey', 'metaKey']) {
  test(`${modifier}: Ctrl/Cmd+K opens search and Escape restores the previous focus`, async context => {
    const view = await mount(context)
    const shortcut = await view.press(view.launcher, 'K', { [modifier]: true })
    assert.equal(shortcut.defaultPrevented, true)
    await view.waitFor(() => view.input() && document.activeElement === view.input(), 'the shortcut focuses search')
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
    const escape = await view.press(view.input(), 'Escape')
    assert.equal(escape.defaultPrevented, true)
    assert.equal(view.dialog(), null)
    await view.waitFor(() => document.activeElement === view.launcher, 'Escape restores focus to the shortcut origin')
  })
}

test('IME Escape and legacy key 229 keep the search dialog open', async context => {
  const view = await mount(context)
  await view.open()
  await view.press(view.input(), 'Escape', { isComposing: true })
  assert.equal(Boolean(view.dialog()), true)
  await view.press(view.input(), 'Escape', { keyCode: 229 })
  assert.equal(Boolean(view.dialog()), true)
  await view.press(view.input(), 'Escape')
  assert.equal(Boolean(view.dialog()), false)
})

test('typed local queries match synthetic message text and titles, clear correctly, and open the selected conversation', async context => {
  const view = await mount(context)
  await view.open()
  await view.type(' cObAlT ')
  await view.waitFor(() => view.result('Orchard notes') && view.result('Cobalt inventory'), 'the debounced local search completes')
  assert.ok(view.result('Orchard notes'), 'a case-insensitive message match is shown')
  assert.ok(view.result('Cobalt inventory'), 'a title-only match is shown')
  assert.equal(view.result('Unrelated itinerary'), undefined)
  assert.equal(view.result('Orchard notes').querySelector('mark').textContent, 'Cobalt')

  await view.type('no-such-synthetic-phrase')
  await view.waitFor(() => !view.result('Orchard notes') && view.dialog().textContent.includes(view.t('sessionSearch.empty')), 'the current no-match scan replaces prior results')
  assert.ok(view.dialog().textContent.includes(view.t('sessionSearch.empty')))
  assert.equal(view.result('Orchard notes'), undefined)
  assert.equal(view.result('Cobalt inventory'), undefined)

  await view.type('   ')
  assert.ok(view.dialog().textContent.includes(view.t('sessionSearch.hint')))
  assert.equal(view.dialog().textContent.includes(view.t('sessionSearch.empty')), false)

  await view.type('AMBER')
  await view.waitFor(() => view.result('Cobalt inventory'), 'structured text search completes')
  const match = view.result('Cobalt inventory')
  assert.ok(match, 'structured text content is searchable')
  assert.equal(match.querySelector('mark').textContent, 'amber')
  assert.equal(view.result('Orchard notes'), undefined)
  await view.act(async () => match.click())
  assert.equal(view.dialog(), null)
  assert.equal(view.state().activeSessionId, 'search-inventory', 'selection reaches the real AppProvider reducer')
  assert.equal(view.dom.window.location.hash, '#/chat#message-message%20inventory', 'selection reaches the real router with the encoded message anchor')
  await view.waitFor(() => document.activeElement === view.launcher, 'selection restores the search origin')
  await view.open()
  assert.equal(view.input().value, '', 'selecting a result clears the query for the next open')
})

// JSDOM verifies boundary key handlers and activeElement, not native Tab traversal or CSS visibility.
test('Tab and Shift+Tab wrap between the search field and live results without escaping the dialog', async context => {
  const view = await mount(context)
  await view.open('Cobalt')
  await view.waitFor(() => view.result('Cobalt inventory'), 'focus traversal waits for actual result controls')
  const lastResult = view.result('Cobalt inventory')
  assert.ok(lastResult)
  lastResult.focus()
  const forward = await view.press(lastResult, 'Tab')
  assert.equal(forward.defaultPrevented, true)
  assert.equal(document.activeElement, view.input())
  const backward = await view.press(view.input(), 'Tab', { shiftKey: true })
  assert.equal(backward.defaultPrevented, true)
  assert.equal(document.activeElement, lastResult)
  view.launcher.focus()
  assert.equal(document.activeElement, view.input(), 'attempted background focus is redirected inside')
})

for (const closeWith of ['Escape', 'close button']) {
  test(`${closeWith} dismisses session search and restores its launcher`, async context => {
    const view = await mount(context)
    await view.open()
    if (closeWith === 'Escape') await view.press(view.input(), 'Escape')
    else await view.act(async () => view.dialog().querySelector(`button[aria-label="${view.t('common.cancel')}"]`).click())
    assert.equal(view.dialog(), null)
    await view.waitFor(() => document.activeElement === view.launcher, 'dismissal restores launcher focus')
    await view.open()
    assert.equal(document.activeElement, view.input(), 'the modal can be opened and auto-focused again')
  })
}
