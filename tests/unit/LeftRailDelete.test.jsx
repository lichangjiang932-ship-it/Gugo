import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import LeftRail from '../../src/components/LeftRail.jsx'
import { AppProvider } from '../../src/store/AppContext.jsx'
import { HashRouter } from '../../src/lib/router.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { ToastProvider } from '../../src/components/Toast.jsx'
import { setAuthToken } from '../../src/lib/accountClient.js'

const SESSION = { id: 'delete-fixture', title: 'Delete fixture', revision: 1, createdAt: 1, updatedAt: 1 }
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function mount(context, deleteResponse, sessions = [SESSION]) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/#/chat' })
  for (const key of ['window', 'document', 'HTMLElement', 'SVGElement', 'CustomEvent', 'localStorage']) {
    globalThis[key] = key === 'window' ? dom.window : dom.window[key]
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.localStorage.setItem('lang', 'zh')
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const original = globalThis.fetch
  const originalWarn = console.warn
  console.warn = () => {}
  let deletes = 0
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'DELETE') { deletes += 1; return deleteResponse(url, options) }
    if (url === '/api/auth/bootstrap') return Response.json({ ok: true, mode: 'local', authenticated: true, token: 'offline-fixture', user: { id: 'local-fixture', email: 'local@example.com' } })
    if (String(url).startsWith('/api/sessions')) return Response.json({ sessions, session: SESSION, messages: [], complete: true, revision: 1, source: null })
    if (String(url).includes('stream-ticket')) return Response.json({}, { status: 401 })
    return Response.json({ ok: true, count: 0 })
  }
  const root = createRoot(document.getElementById('root'))
  context.after(async () => {
    await act(async () => root.unmount())
    setAuthToken('')
    globalThis.fetch = original
    console.warn = originalWarn
    dom.window.close()
  })
  await act(async () => root.render(<I18nProvider><HashRouter><ToastProvider><AppProvider><LeftRail /></AppProvider></ToastProvider></HashRouter></I18nProvider>))
  for (let attempt = 0; attempt < 100 && !document.querySelector('[data-session-row]'); attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
  }
  assert.ok(document.querySelector('[data-session-row]'), 'the server-backed conversation is hydrated')
  await act(async () => document.querySelector('[data-session-row] .left-rail-action').click())
  const deleteItem = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === '删除会话')
  assert.ok(deleteItem, document.body.textContent)
  await act(async () => deleteItem.click())
  return { dom, deletes: () => deletes }
}

test('deletion waits for the server, prevents duplicate submission, then reports success', async (context) => {
  const response = deferred()
  const view = await mount(context, () => response.promise)
  const button = document.querySelector('[data-testid="session-delete-confirm"]')
  await act(async () => { button.click(); button.click() })
  assert.equal(view.deletes(), 1)
  assert.equal(button.disabled, true)
  assert.equal(document.querySelector('[data-testid="session-delete-cancel"]').textContent, '收起窗口')
  assert.equal(document.querySelector('.toast-layer').textContent.includes('已删除'), false)
  assert.ok(document.querySelector('[data-session-row]'))
  await act(async () => response.resolve(Response.json({ ok: true })))
  assert.equal(document.querySelector('[data-session-row]'), null)
  assert.ok(document.querySelector('.toast-layer').textContent.includes('已删除'))
  assert.equal(document.querySelector('[data-testid="session-delete-confirm"]'), null)
})

test('hiding a pending deletion keeps the UI usable without cancelling or duplicating it', async (context) => {
  const response = deferred()
  const view = await mount(context, () => response.promise)
  await act(async () => document.querySelector('[data-testid="session-delete-confirm"]').click())
  await act(async () => document.querySelector('[data-testid="session-delete-cancel"]').click())
  assert.equal(document.querySelector('[data-testid="session-delete-confirm"]'), null)
  assert.ok(document.querySelector('[data-session-row]'))
  assert.equal(view.deletes(), 1)
  await act(async () => response.resolve(Response.json({ ok: true })))
  assert.equal(document.querySelector('[data-session-row]'), null)
  assert.ok(document.querySelector('.toast-layer').textContent.includes('已删除'))
})

test('a late result for A cannot close or disable the confirmation for B', async (context) => {
  const pending = deferred()
  const other = { ...SESSION, id: 'delete-other', title: 'Other conversation' }
  const view = await mount(context, () => pending.promise, [SESSION, other])
  await act(async () => document.querySelector('[data-testid="session-delete-confirm"]').click())
  await act(async () => document.querySelector('[data-testid="session-delete-cancel"]').click())
  await act(async () => document.querySelector('[data-session-row="delete-other"] .left-rail-action').click())
  await act(async () => [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === '删除会话').click())
  assert.equal(document.querySelector('[data-testid="session-delete-confirm"]').disabled, false, 'B is not waiting for A')
  await act(async () => pending.resolve(Response.json({ ok: true })))
  assert.ok(document.querySelector('#session-delete-title').textContent.includes(other.title))
  assert.equal(view.deletes(), 1)
  assert.ok(document.querySelector('[data-session-row="delete-other"]'))
})

test('an active-task refusal is actionable without exposing raw errors or asking for login', async (context) => {
  await mount(context, () => Response.json({ error: { code: 'SESSION_ACTIVE', message: 'PRIVATE_DIAGNOSTIC' } }, { status: 409 }))
  await act(async () => document.querySelector('[data-testid="session-delete-confirm"]').click())
  assert.match(document.querySelector('[role="alert"]').textContent, /运行|停止/)
  assert.doesNotMatch(document.body.textContent, /PRIVATE_DIAGNOSTIC|登录|注册/)
})

test('a rejected deletion keeps the row and a retryable error instead of a success toast', async (context) => {
  let succeeded = false
  const view = await mount(context, () => succeeded ? Response.json({ ok: true })
    : Response.json({ error: { code: 'SESSION_ACTIVE', message: 'fixture refusal' } }, { status: 409 }))
  await act(async () => document.querySelector('[data-testid="session-delete-confirm"]').click())
  assert.equal(view.deletes(), 1)
  assert.ok(document.querySelector('[data-session-row]'))
  assert.equal(document.querySelector('.toast-layer').textContent.includes('已删除'), false)
  assert.ok(document.querySelector('[role="alert"]'), 'the dialog exposes the failure')
  assert.equal(document.querySelector('[data-testid="session-delete-confirm"]').disabled, false)
  succeeded = true
  await act(async () => document.querySelector('[data-testid="session-delete-confirm"]').click())
  assert.equal(view.deletes(), 2)
  assert.equal(document.querySelector('[data-session-row]'), null)
})
