import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProvider } from '../../src/store/AppContext.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { HashRouter } from '../../src/lib/router.jsx'
import RequireAuth from '../../src/components/RequireAuth.jsx'
import LeftRail from '../../src/components/LeftRail.jsx'
import useLeftRailController from '../../src/components/leftRail/useLeftRailController.js'
import { setAuthToken } from '../../src/lib/accountClient.js'

function setup(context, mode, authenticated) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/#/settings' })
  for (const key of ['window', 'document', 'HTMLElement', 'SVGElement', 'CustomEvent', 'localStorage']) globalThis[key] = key === 'window' ? dom.window : dom.window[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.localStorage.setItem('lang', 'zh')
  const original = globalThis.fetch
  globalThis.fetch = async (url) => Response.json(String(url) === '/api/auth/bootstrap'
    ? { ok: true, mode, authenticated, token: authenticated ? 'local-offline-fixture' : '', user: authenticated ? { id: 'local-fixture', email: 'local@example.com' } : null }
    : { ok: true, sessions: [], source: null, directories: [], capabilities: {} })
  setAuthToken('')
  const root = createRoot(document.getElementById('root'))
  context.after(async () => { await act(async () => root.unmount()); setAuthToken(''); globalThis.fetch = original; dom.window.close() })
  return { dom, root }
}

for (const mode of ['local', 'unknown']) {
  test(`${mode}: an unavailable local identity offers reconnect, never a login form or silent redirect`, async (context) => {
    const { root } = setup(context, mode, false)
    await act(async () => root.render(<I18nProvider><HashRouter><AppProvider><RequireAuth><p data-protected>Private data</p></RequireAuth></AppProvider></HashRouter></I18nProvider>))
    assert.ok(document.querySelector('[data-testid="local-service-unavailable"]'))
    assert.equal(document.querySelector('[data-protected]'), null)
    assert.equal(document.querySelector('input[type=password]'), null)
    assert.match(window.location.hash, /settings/)
  })
}

test('the healthy local bootstrap opens features without a registration or sign-in step', async (context) => {
  const { root } = setup(context, 'local', true)
  await act(async () => root.render(<I18nProvider><HashRouter><AppProvider><RequireAuth><p data-protected>Local feature</p></RequireAuth></AppProvider></HashRouter></I18nProvider>))
  assert.ok(document.querySelector('[data-protected]'))
  assert.equal(document.querySelector('input[type=password]'), null)
})

for (const mode of ['local', 'multi_user']) {
  test(`${mode}: saved empty projects are visible only in the local workspace`, async (context) => {
    const { root, dom } = setup(context, mode, true)
    dom.window.localStorage.setItem('gugo:chat-projects:v1', JSON.stringify([{ path: 'D:/saved-empty', name: 'Saved empty', usedAt: 1 }]))
    await act(async () => root.render(<I18nProvider><HashRouter><AppProvider><LeftRail /></AppProvider></HashRouter></I18nProvider>))
    assert.equal(Boolean(document.querySelector('[data-session-project="D:/saved-empty"]')), mode === 'local')
    if (mode === 'local') {
      dom.window.localStorage.setItem('gugo:chat-projects:v1', JSON.stringify([{ path: 'D:/another-empty', name: 'Another empty', usedAt: 2 }]))
      await act(async () => window.dispatchEvent(new dom.window.Event('chat-projects:changed')))
      assert.ok(document.querySelector('[data-session-project="D:/another-empty"]'))
    }
  })
}

test('an unknown bootstrap cannot accidentally open the multi-user login dialog', async (context) => {
  const { root, dom } = setup(context, 'unknown', false)
  let controller
  const notices = []
  function Harness() {
    controller = useLeftRailController({ authMode: 'unknown', dispatch() {}, location: { pathname: '/chat' }, navigate() {}, t: (key) => key, toast: { error: (value) => notices.push(value) } })
    return null
  }
  await act(async () => root.render(<Harness />))
  await act(async () => controller.navigateItem({ path: '/settings', requiresLogin: true }))
  await act(async () => window.dispatchEvent(new dom.window.CustomEvent('auth:required', { detail: { path: '/settings' } })))
  assert.equal(controller.login.open, false)
  assert.ok(notices.length > 0)
})
