import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useCallback, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import SessionList from '../src/components/leftRail/SessionList.jsx'
import AccountArea from '../src/components/leftRail/AccountArea.jsx'
import useLeftRailDisclosure from '../src/components/leftRail/useLeftRailDisclosure.js'
import { I18nProvider } from '../src/i18n/I18nProvider.jsx'

const noop = () => {}
const sourceSessions = [
  { id: 'project-session', title: 'Project conversation', workspacePath: 'D:\\work\\project', updatedAt: 2_000 },
  { id: 'recent-session', title: 'Recent conversation', updatedAt: 1_000 },
]

function setupDom({ narrow = false, savedCollapsed = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const listeners = new Set()
  const media = {
    matches: narrow,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  }
  dom.window.matchMedia = () => media
  if (savedCollapsed !== null) dom.window.localStorage.setItem('gugo:left-rail-collapsed', savedCollapsed)
  return {
    dom,
    setNarrow(value) {
      media.matches = value
      for (const listener of listeners) listener({ matches: value })
    },
  }
}

function Harness({ includeAccount = false }) {
  const [openMenuId, setOpenMenuId] = useState(null)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const accountMenuRef = useRef(null)
  const closeMenus = useCallback(() => { setOpenMenuId(null); setAccountMenuOpen(false) }, [])
  const { collapsed, closeMobileRail, mobileExpanded, railRef, toggleRef, setRailCollapsed } = useLeftRailDisclosure({
    mediaQuery: '(max-width: 959px)', onCollapse: closeMenus, hasOpenMenu: openMenuId !== null || accountMenuOpen,
  })
  return <>
    {mobileExpanded && <button
      type="button" data-left-rail-backdrop tabIndex={-1} aria-hidden="true"
      onClick={() => closeMobileRail({ restoreFocus: true })}
    >Backdrop</button>}
    <aside
      ref={railRef} tabIndex={-1} aria-label="Navigation"
      role={mobileExpanded ? 'dialog' : 'navigation'}
      aria-modal={mobileExpanded ? true : undefined}
    >
      <button ref={toggleRef} type="button" data-toggle aria-expanded={!collapsed}
        onClick={() => setRailCollapsed(!collapsed)}>
        Toggle sidebar
      </button>
      <div hidden={collapsed} data-history>
        <SessionList
          sessions={sourceSessions} activeSessionId="project-session" openMenuId={openMenuId}
          onMenuOpen={setOpenMenuId} onMenuToggle={(id) => setOpenMenuId((current) => current === id ? null : id)}
          onMenuClose={closeMenus} onNewInProject={noop} onNewRecent={noop} onProjectToggle={noop}
          onSearch={noop} onOpen={noop} onFork={noop} onPinToggle={noop} onArchiveToggle={noop}
          onDelete={noop} t={(key) => key}
        />
      </div>
      {includeAccount ? <I18nProvider><AccountArea
        compact={collapsed} accountMenuOpen={accountMenuOpen} accountMenuRef={accountMenuRef}
        user={{ name: 'Account', email: '' }} onToggle={() => setAccountMenuOpen((current) => !current)}
        onNavigate={noop} t={(key) => key}
      /></I18nProvider> : <button type="button" data-last>Account</button>}
    </aside>
    <main data-background><button type="button" data-outside>Outside content</button></main>
    <div inert data-already-inert>Previously inert content</div>
  </>
}

async function withHarness(options, run) {
  const environment = setupDom(options)
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => root.render(<Harness includeAccount={options?.includeAccount} />))
    await run({ ...environment, rootElement, root })
  } finally {
    await act(async () => root.unmount())
    environment.dom.window.close()
  }
}

test('mobile drawer traps focus, inerts only its background, and returns focus after Escape', async () => {
  await withHarness({ narrow: true }, async ({ dom, rootElement }) => {
    const toggle = rootElement.querySelector('[data-toggle]')
    const background = rootElement.querySelector('[data-background]')
    const last = rootElement.querySelector('[data-last]')
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    await act(async () => { toggle.focus(); toggle.click() })
    assert.equal(rootElement.querySelector('aside').getAttribute('aria-modal'), 'true')
    assert.equal(document.activeElement, toggle)
    assert.equal(background.hasAttribute('inert'), true)
    assert.equal(rootElement.querySelector('[data-left-rail-backdrop]').hasAttribute('inert'), false)
    await act(async () => {
      last.focus()
      last.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    })
    assert.equal(document.activeElement, toggle)
    await act(async () => toggle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    })))
    assert.equal(document.activeElement, last)
    await act(async () => rootElement.querySelector('[data-outside]').focus())
    assert.equal(document.activeElement, toggle)
    await act(async () => toggle.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    })))
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(background.hasAttribute('inert'), false)
    assert.equal(rootElement.querySelector('[data-already-inert]').hasAttribute('inert'), true)
    assert.equal(document.activeElement, toggle)
  })
})

test('a session menu owns the first Escape and the second closes the mobile drawer', async () => {
  await withHarness({ narrow: true }, async ({ dom, rootElement }) => {
    const toggle = rootElement.querySelector('[data-toggle]')
    await act(async () => { toggle.focus(); toggle.click() })
    const menuTrigger = rootElement.querySelector('[data-session-row="recent-session"] [aria-haspopup="menu"]')
    await act(async () => menuTrigger.click())
    assert.ok(rootElement.querySelector('[role="menu"]'))
    await act(async () => document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    })))
    assert.equal(rootElement.querySelector('[role="menu"]'), null)
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(document.activeElement, menuTrigger)
    await act(async () => menuTrigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    })))
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(document.activeElement, toggle)
  })
})

test('project disclosure survives whole-rail collapse and does not duplicate Recent entries', async () => {
  await withHarness({}, async ({ rootElement }) => {
    const projectToggle = rootElement.querySelector('[data-project-toggle]')
    const railToggle = rootElement.querySelector('[data-toggle]')
    await act(async () => projectToggle.click())
    assert.equal(projectToggle.getAttribute('aria-expanded'), 'false')
    await act(async () => railToggle.click())
    assert.equal(rootElement.querySelector('[data-history]').hidden, true)
    await act(async () => railToggle.click())
    assert.equal(rootElement.querySelector('[data-history]').hidden, false)
    assert.equal(rootElement.querySelector('[data-project-toggle]').getAttribute('aria-expanded'), 'false')
    assert.equal(rootElement.querySelector('[data-project-sessions]').hidden, true)
    const recent = rootElement.querySelector('section[aria-label="chatMessages.workspaceRecent"]')
    assert.match(recent.textContent, /Recent conversation/u)
    assert.doesNotMatch(recent.textContent, /Project conversation/u)
  })
})

test('mobile expansion never overwrites desktop preference and viewport changes release the modal fence', async () => {
  await withHarness({ savedCollapsed: '1' }, async ({ rootElement, setNarrow, dom }) => {
    const toggle = rootElement.querySelector('[data-toggle]')
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    await act(async () => setNarrow(true))
    await act(async () => { toggle.focus(); toggle.click() })
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(dom.window.localStorage.getItem('gugo:left-rail-collapsed'), '1')
    await act(async () => setNarrow(false))
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(rootElement.querySelector('[data-background]').hasAttribute('inert'), false)
    assert.equal(document.activeElement, toggle)
  })
})

test('the backdrop and app Escape close the drawer without changing project disclosure', async () => {
  await withHarness({ narrow: true }, async ({ rootElement, dom }) => {
    const toggle = rootElement.querySelector('[data-toggle]')
    await act(async () => { toggle.focus(); toggle.click() })
    await act(async () => rootElement.querySelector('[data-project-toggle]').click())
    await act(async () => rootElement.querySelector('[data-left-rail-backdrop]').click())
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(document.activeElement, toggle)
    await act(async () => toggle.click())
    assert.equal(rootElement.querySelector('[data-project-toggle]').getAttribute('aria-expanded'), 'false')
    await act(async () => dom.window.dispatchEvent(new dom.window.CustomEvent('app:escape')))
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(rootElement.querySelector('[data-background]').hasAttribute('inert'), false)
  })
})

test('account menu Escape restores its trigger before a later Escape closes the drawer', async () => {
  await withHarness({ narrow: true, includeAccount: true }, async ({ rootElement, dom }) => {
    const toggle = rootElement.querySelector('[data-toggle]')
    await act(async () => { toggle.focus(); toggle.click() })
    const account = rootElement.querySelector('[data-settings-focus-return]')
    await act(async () => account.click())
    const menu = rootElement.querySelector('[data-left-rail-account-menu]')
    assert.ok(menu)
    assert.equal(document.activeElement, menu.querySelector('button'))
    await act(async () => document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    })))
    assert.equal(rootElement.querySelector('[data-left-rail-account-menu]'), null)
    assert.equal(document.activeElement, account)
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    await act(async () => account.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    })))
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(document.activeElement, toggle)
  })
})
