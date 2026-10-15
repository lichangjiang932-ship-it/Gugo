import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import SessionList from '../../src/components/leftRail/SessionList.jsx'

function mount(context, sessions, activeSessionId) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/#/chat' })
  for (const key of ['window', 'document', 'HTMLElement', 'SVGElement']) globalThis[key] = key === 'window' ? dom.window : dom.window[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById('root'))
  context.after(async () => { await act(async () => root.unmount()); dom.window.close() })
  return act(async () => root.render(<SessionList sessions={sessions} activeSessionId={activeSessionId}
    openMenuId={null} onMenuOpen={() => {}} onMenuClose={() => {}} onMenuToggle={() => {}}
    t={(key, values = {}) => `${key}:${Object.values(values).join(',')}`} />))
}

test('large catalogs render bounded pages and keep an older active project visible', async (context) => {
  const sessions = Array.from({ length: 2000 }, (_, index) => ({ id: `s-${index}`, title: `Conversation ${index}`,
    workspacePath: `D:/projects/p${Math.floor(index / 100)}`, createdAt: 2001 - index, updatedAt: 2001 - index }))
  await mount(context, sessions, 's-1999')
  assert.ok(document.querySelector('[data-session-row="s-1999"]'), 'search can reveal an older active conversation')
  assert.ok(document.querySelectorAll('[data-session-row]').length <= 400, 'offscreen history is not all constructed at once')
  assert.ok(document.querySelector('[data-projects-more]'))
  await act(async () => document.querySelector('[data-projects-more]').click())
  assert.equal(document.querySelectorAll('[data-session-project]').length, 20)
})

test('conversation pages expand explicitly and collapsed projects do not keep hidden row trees', async (context) => {
  const sessions = Array.from({ length: 100 }, (_, index) => ({ id: `r-${index}`, title: `Conversation ${index}`,
    workspacePath: 'D:/one-project', createdAt: 1000 - index, updatedAt: 1000 - index }))
  await mount(context, sessions, 'r-99')
  const before = document.querySelectorAll('[data-session-row]').length
  assert.ok(before <= 31)
  await act(async () => document.querySelector('[data-session-more]').click())
  assert.ok(document.querySelectorAll('[data-session-row]').length > before)
  await act(async () => document.querySelector('[data-project-toggle]').click())
  assert.equal(document.querySelectorAll('[data-session-row]').length, 0)
  assert.equal(document.querySelector('[data-project-sessions]').hidden, true)
})
