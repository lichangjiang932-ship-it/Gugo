import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTick } from 'node:timers/promises'
import { JSDOM } from 'jsdom'

import { I18nProvider } from '../src/i18n/I18nProvider.jsx'
import MobileKeysView from '../src/pages/MobileKeysView.jsx'
import { AppProvider } from '../src/store/AppContext.jsx'
import { HashRouter } from '../src/lib/router.jsx'
import { setAuthToken } from '../src/lib/accountClient.js'

for (const lang of ['en', 'zh']) {
test(`MobileKeysView renders loaded keys through the real ${lang} i18n provider`, async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/mobile-keys',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.localStorage.setItem('lang', lang)
  const originalFetch = globalThis.fetch
  setAuthToken('')
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/mobile/access-keys') return Response.json(options.method === 'POST'
      ? await globalThis.__YMA_CREATE_MOBILE_KEY__(JSON.parse(options.body)) : await globalThis.__YMA_LIST_MOBILE_KEYS__())
    if (String(url).startsWith('/api/mobile/access-keys/')) return Response.json(await globalThis.__YMA_REVOKE_MOBILE_KEY__(url))
    if (url === '/api/auth/bootstrap') return Response.json({ ok: true, mode: 'local', authenticated: true, token: 'offline-mobile-fixture', user: { id: 'local-mobile-fixture', email: 'local@example.com' } })
    if (String(url).includes('stream-ticket')) return Response.json({}, { status: 401 })
    return Response.json({ ok: true, sessions: [], source: null, count: 0, directories: [], capabilities: {} })
  }
  globalThis.__YMA_LIST_MOBILE_KEYS__ = async () => ({
    keys: [{
      id: 'mobile-key-1',
      label: 'Kitchen tablet',
      prefix: 'gugo_test',
      createdAt: Date.UTC(2026, 8, 3, 0, 0, 0),
      lastUsedAt: null,
      expiresAt: null,
    }],
  })
  globalThis.__YMA_CREATE_MOBILE_KEY__ = async () => ({})
  globalThis.__YMA_REVOKE_MOBILE_KEY__ = async () => ({})

  const [{ act }, { createRoot }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
  ])
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => root.render(
      <I18nProvider><HashRouter><AppProvider><MobileKeysView /></AppProvider></HashRouter></I18nProvider>,
    ))
    const deadline = Date.now() + 5000
    while (!rootElement.textContent.includes('Kitchen tablet') && Date.now() < deadline) {
      await act(async () => { await nextTick() })
    }
    assert.equal(rootElement.querySelectorAll('main').length, 1)
    assert.match(rootElement.textContent, lang === 'en' ? /Mobile access/ : /手机入口/)
    assert.match(rootElement.textContent, /Kitchen tablet/)
    assert.match(rootElement.textContent, lang === 'en' ? /Last used: Never/ : /上次使用：从未/)
    assert.match(rootElement.textContent, lang === 'en' ? /Validity: Permanent/ : /有效期：永久/)
    assert.equal(rootElement.querySelector('input[type=password]'), null)
  } finally {
    await act(async () => root.unmount())
    setAuthToken('')
    globalThis.fetch = originalFetch
    dom.window.close()
  }
})
}
