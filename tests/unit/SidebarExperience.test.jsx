import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import SessionList from '../../src/components/leftRail/SessionList.jsx'
import RailDisclosureIcon from '../../src/components/leftRail/RailDisclosureIcon.jsx'
import { translateKey } from '../../src/i18n/translations.js'

const t = (key, values = {}) => translateKey(key, 'en').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`))
const noop = () => {}

function SidebarList({ initialSessions, projects = [], calls = [] }) {
  const [sessions, setSessions] = useState(initialSessions)
  const [menu, setMenu] = useState(null)
  return <SessionList sessions={sessions} storedProjects={projects} activeSessionId="first" locale="en"
    openMenuId={menu} onMenuOpen={setMenu} onMenuToggle={(id) => setMenu((current) => current === id ? null : id)}
    onMenuClose={() => setMenu(null)} onSearch={() => calls.push('search')} onNewRecent={noop} onNewInProject={noop}
    onOpen={(id) => calls.push(`open:${id}`)} onFork={noop} onDelete={noop}
    onPinToggle={(session) => setSessions((current) => current.map((item) => item.id === session.id
      ? { ...item, pinnedAt: item.pinnedAt ? null : 2000 } : item))}
    onArchiveToggle={(session) => setSessions((current) => current.filter((item) => item.id !== session.id))} t={t} />
}

async function withSidebar(props, check) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/chat' })
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'SVGElement', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement, IS_REACT_ACT_ENVIRONMENT: true })
  const element = dom.window.document.getElementById('root')
  const root = createRoot(element)
  try {
    await act(async () => root.render(<SidebarList {...props} />))
    await check({ dom, element, root })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
}

test('long session titles stay intact in labels/tooltips while pinned state and precise times remain identifiable', async () => {
  const title = 'A long project conversation title — '.repeat(8)
  const timestamp = new Date(2026, 8, 8, 9, 5).getTime()
  await withSidebar({ initialSessions: [
    { id: 'first', title, pinnedAt: 1000, updatedAt: timestamp },
    { id: 'empty-title', title: '  ', updatedAt: 0 },
  ] }, async ({ element }) => {
    const row = element.querySelector('[data-session-row="first"]')
    const opener = row.querySelector('[data-session-open]')
    assert.equal(row.getAttribute('data-active'), 'true')
    assert.equal(row.querySelector('[data-session-title]').textContent, title.trim())
    assert.ok(opener.title.startsWith(`${title.trim()}\n`))
    assert.equal(opener.getAttribute('aria-current'), 'page')
    assert.equal(opener.getAttribute('aria-label'), `${title.trim()} · Pinned`)
    assert.ok(row.querySelector('[data-session-pinned]'))
    assert.equal(row.querySelector('time').dateTime, new Date(timestamp).toISOString())
    assert.equal(row.querySelector('[aria-haspopup="menu"]').getAttribute('aria-label'), `More actions for “${title.trim()}”`)
    const untitled = element.querySelector('[data-session-row="empty-title"]')
    assert.equal(untitled.querySelector('[data-session-title]').textContent, 'Untitled conversation')
    assert.equal(untitled.querySelector('time'), null)
  })
})

test('pin and unpin keep one row, reorder correctly, close the menu, and return focus to its trigger', async () => {
  await withSidebar({ initialSessions: [
    { id: 'first', title: 'First', updatedAt: 3000 }, { id: 'second', title: 'Second', updatedAt: 1000 },
  ] }, async ({ element, dom }) => {
    const trigger = element.querySelector('[data-session-row="second"] [aria-haspopup="menu"]')
    await act(async () => trigger.click())
    await act(async () => element.querySelector('[role="menuitem"]').click())
    assert.equal(element.querySelector('[role="menu"]'), null)
    assert.equal(element.querySelector('[data-session-row]').getAttribute('data-session-row'), 'second')
    assert.equal(element.querySelectorAll('[data-session-row]').length, 2)
    assert.equal(dom.window.document.activeElement, trigger)
    assert.ok(element.querySelector('[data-session-row="second"] [data-session-pinned]'))
    await act(async () => trigger.click())
    assert.match(element.querySelector('[role="menuitem"]').textContent, /Unpin conversation/)
    await act(async () => element.querySelector('[role="menuitem"]').click())
    assert.equal(element.querySelector('[data-session-row]').getAttribute('data-session-row'), 'first')
    assert.equal(element.querySelector('[data-session-pinned]'), null)
    assert.equal(dom.window.document.activeElement, trigger)
  })
})

test('archiving a row restores keyboard focus to the adjacent remaining conversation', async () => {
  await withSidebar({ initialSessions: [
    { id: 'first', title: 'First', updatedAt: 3000 }, { id: 'second', title: 'Second', updatedAt: 1000 },
  ] }, async ({ element, dom }) => {
    await act(async () => element.querySelector('[data-session-row="first"] [aria-haspopup="menu"]').click())
    const archive = [...element.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes('Archive session'))
    await act(async () => archive.click())
    assert.equal(element.querySelector('[data-session-row="first"]'), null)
    assert.equal(dom.window.document.activeElement, element.querySelector('[data-session-row="second"] [data-session-open]'))
    assert.equal(element.querySelector('[role="menu"]'), null)
  })
})

test('Tab and Shift+Tab close the menu without trapping normal browser traversal', async () => {
  await withSidebar({ initialSessions: [{ id: 'first', title: 'First' }] }, async ({ element, dom }) => {
    const trigger = element.querySelector('[aria-haspopup="menu"]')
    for (const shiftKey of [false, true]) {
      await act(async () => trigger.click())
      const event = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
      await act(async () => element.querySelector('[role="menuitem"]').dispatchEvent(event))
      assert.equal(element.querySelector('[role="menu"]'), null)
      assert.equal(dom.window.document.activeElement, trigger)
      assert.equal(event.defaultPrevented, false, 'native Tab traversal remains available')
    }
  })
})

test('empty project disclosure has a real controlled region, clear state label, and folder state icon', async () => {
  await withSidebar({ initialSessions: [], projects: [{ path: '/', name: 'Root' }] }, async ({ element, dom }) => {
    const toggle = element.querySelector('[data-project-toggle]')
    const region = dom.window.document.getElementById(toggle.getAttribute('aria-controls'))
    assert.ok(region)
    assert.equal(toggle.getAttribute('aria-label'), 'Collapse “Root” (0 conversations)')
    assert.match(region.textContent, /No conversations in this project yet/)
    assert.equal(toggle.querySelector('svg').getAttribute('stroke-width'), '1.45')
    assert.equal(toggle.querySelector('[data-project-state-icon]').getAttribute('data-project-state-icon'), 'expanded')
    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-label'), 'Expand “Root” (0 conversations)')
    assert.equal(region.hidden, true)
    assert.equal(toggle.querySelector('[data-project-state-icon]').getAttribute('data-project-state-icon'), 'collapsed')
  })
})

test('sidebar disclosure uses a rounded, frameless direction glyph with no duplicate accessible label', async () => {
  await withSidebar({ initialSessions: [] }, async ({ element, root }) => {
    await act(async () => root.render(<RailDisclosureIcon collapsed={false} />))
    const expanded = element.querySelector('svg')
    const left = expanded.querySelector('path').getAttribute('d')
    assert.equal(expanded.getAttribute('aria-hidden'), 'true')
    assert.equal(expanded.querySelector('rect').getAttribute('stroke'), null)
    assert.equal(expanded.querySelector('path').getAttribute('stroke-linecap'), 'round')
    await act(async () => root.render(<RailDisclosureIcon collapsed />))
    assert.notEqual(element.querySelector('path').getAttribute('d'), left)
    assert.equal(element.querySelector('svg').getAttribute('data-sidebar-disclosure'), 'collapsed')
  })
})
