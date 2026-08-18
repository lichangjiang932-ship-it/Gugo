import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'

import SessionList from '../src/components/leftRail/SessionList.jsx'
import useLeftRailController from '../src/components/leftRail/useLeftRailController.js'

const sessions = [
  { id: 'session-one', title: 'Session one', archivedAt: null },
  { id: 'session-two', title: 'Session two', archivedAt: null },
]

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.CustomEvent = dom.window.CustomEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function MenuHarness({ calls, sourceSessions = sessions }) {
  const [openMenuId, setOpenMenuId] = useState('session-one')
  return <>
    <SessionList
      sessions={sourceSessions}
      activeSessionId="session-one"
      openMenuId={openMenuId}
      onMenuOpen={setOpenMenuId}
      onMenuToggle={(id) => setOpenMenuId((current) => current === id ? null : id)}
      onMenuClose={() => setOpenMenuId(null)}
      onSearch={() => calls.searched?.push('search')}
      onOpen={(id) => calls.opened.push(id)}
      onPinToggle={(session) => calls.pinned?.push(session.id)}
      onArchiveToggle={(session) => calls.archived.push(session.id)}
      onDelete={(session) => calls.deleted.push(session.id)}
      t={(key) => key}
    />
    <button type="button" data-testid="outside">Outside</button>
  </>
}

function ControllerHarness() {
  const controller = useLeftRailController({
    authMode: 'local',
    dispatch: () => {},
    location: { pathname: '/chat' },
    navigate: () => {},
    t: (key) => key,
    toast: { error: () => {} },
  })
  return <>
    <button type="button" data-testid="open-controller-menu" onClick={() => controller.setOpenMenuId('session-one')}>Open</button>
    <output data-testid="controller-menu-state">{controller.openMenuId || 'closed'}</output>
  </>
}

function findButton(rootElement, text) {
  return [...rootElement.querySelectorAll('button')].find((button) => button.textContent.includes(text))
}

test('session menu closes on an outside pointer without swallowing menu item clicks', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const calls = { opened: [], pinned: [], archived: [], deleted: [] }

  try {
    await act(async () => root.render(<MenuHarness calls={calls} />))
    const archiveButton = findButton(rootElement, 'nav.archiveSession')
    assert.ok(archiveButton)

    await act(async () => {
      archiveButton.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
      archiveButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(calls.archived, ['session-one'])
    assert.ok(findButton(rootElement, 'nav.archiveSession'), 'menu item pointerdown must not dismiss the menu before click')

    await act(async () => {
      rootElement.querySelector('[data-testid="outside"]').dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
    })
    assert.equal(findButton(rootElement, 'nav.archiveSession'), undefined)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('session history groups concise summaries by project and uses relative time', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const calls = { opened: [], pinned: [], archived: [], deleted: [] }
  const datedSessions = sessions.map((session, index) => ({
    ...session,
    totalMessages: index + 7,
    updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
  }))

  try {
    await act(async () => root.render(<MenuHarness calls={calls} sourceSessions={datedSessions} />))
    const historyToggle = findButton(rootElement, 'nav.history')
    const sessionButtons = rootElement.querySelectorAll('[data-session-open]')

    assert.equal(historyToggle.textContent.trim(), 'nav.history')
    assert.match(sessionButtons[0].textContent, /Session oneGugo/)
    assert.match(sessionButtons[1].textContent, /Session twoGugo/)
    assert.match(sessionButtons[0].textContent, /此刻|分钟/)
    assert.doesNotMatch(rootElement.textContent, /nav\.groupToday|nav\.groupYesterday|nav\.groupWeek|nav\.groupEarlier/)
    assert.doesNotMatch(rootElement.textContent, /nav\.filterActive|history\.messageCount|\d{2}:\d{2}/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('history search sits beside the title and opens without collapsing the list', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const calls = { opened: [], pinned: [], archived: [], deleted: [], searched: [] }

  try {
    await act(async () => root.render(<MenuHarness calls={calls} />))
    const historyToggle = findButton(rootElement, 'nav.history')
    const searchButton = rootElement.querySelector('button[aria-label="nav.searchPlaceholder"]')
    assert.ok(searchButton)
    assert.equal(historyToggle.parentElement, searchButton.parentElement)
    assert.equal(historyToggle.getAttribute('aria-expanded'), 'true')

    await act(async () => searchButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(calls.searched, ['search'])
    assert.equal(historyToggle.getAttribute('aria-expanded'), 'true')
    assert.equal(rootElement.querySelectorAll('[data-session-open]').length, 2)
    assert.equal(findButton(rootElement, 'nav.archiveSession'), undefined)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('session menu trigger toggles cleanly and switching sessions dismisses the menu', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const calls = { opened: [], pinned: [], archived: [], deleted: [] }

  try {
    await act(async () => root.render(<MenuHarness calls={calls} />))
    const menuTrigger = rootElement.querySelector('button[title="nav.sessionMenu"]')
    assert.ok(menuTrigger)

    await act(async () => {
      menuTrigger.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
      menuTrigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(findButton(rootElement, 'nav.archiveSession'), undefined)

    await act(async () => menuTrigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.ok(findButton(rootElement, 'nav.archiveSession'))

    await act(async () => findButton(rootElement, 'Session two').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(calls.opened, ['session-two'])
    assert.equal(findButton(rootElement, 'nav.archiveSession'), undefined)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('app escape event still dismisses an open session menu', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => root.render(<ControllerHarness />))
    await act(async () => rootElement.querySelector('[data-testid="open-controller-menu"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(rootElement.querySelector('[data-testid="controller-menu-state"]').textContent, 'session-one')

    await act(async () => window.dispatchEvent(new dom.window.CustomEvent('app:escape')))
    assert.equal(rootElement.querySelector('[data-testid="controller-menu-state"]').textContent, 'closed')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('right click opens the shared session menu at the pointer and Escape closes it', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const calls = { opened: [], pinned: [], archived: [], deleted: [] }

  try {
    await act(async () => root.render(<MenuHarness calls={calls} />))
    await act(async () => {
      findButton(rootElement, 'Session two').dispatchEvent(new dom.window.MouseEvent('contextmenu', {
        bubbles: true,
        clientX: 140,
        clientY: 90,
      }))
    })

    const menu = rootElement.querySelector('[role="menu"]')
    assert.ok(menu)
    assert.equal(menu.style.left, '140px')
    assert.equal(menu.style.top, '90px')
    assert.equal(menu.querySelector('[role="menuitem"]'), document.activeElement)
    assert.equal(findButton(rootElement, 'Session two').hasAttribute('aria-haspopup'), false)

    assert.match(document.activeElement.textContent, /nav\.pinSession/)
    await act(async () => menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' })))
    assert.match(document.activeElement.textContent, /nav\.archiveSession/)
    await act(async () => menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'End' })))
    assert.match(document.activeElement.textContent, /nav\.deleteSession/)
    await act(async () => menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Home' })))
    assert.match(document.activeElement.textContent, /nav\.pinSession/)

    await act(async () => findButton(rootElement, 'nav.pinSession').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(calls.pinned, ['session-two'])
    await act(async () => findButton(rootElement, 'nav.archiveSession').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(calls.archived, ['session-two'])

    await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
    assert.equal(rootElement.querySelector('[role="menu"]'), null)
    assert.deepEqual(calls.opened, [])

    await act(async () => findButton(rootElement, 'Session one').dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      key: 'F10',
      shiftKey: true,
    })))
    assert.ok(rootElement.querySelector('[role="menu"]'))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
