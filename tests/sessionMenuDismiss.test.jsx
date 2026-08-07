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

function MenuHarness({ calls }) {
  const [openMenuId, setOpenMenuId] = useState('session-one')
  return <>
    <SessionList
      sessions={sessions}
      activeSessionId="session-one"
      openMenuId={openMenuId}
      onMenuToggle={(id) => setOpenMenuId((current) => current === id ? null : id)}
      onMenuClose={() => setOpenMenuId(null)}
      onOpen={(id) => calls.opened.push(id)}
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
  const calls = { opened: [], archived: [], deleted: [] }

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

test('session menu trigger toggles cleanly and switching sessions dismisses the menu', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const calls = { opened: [], archived: [], deleted: [] }

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
