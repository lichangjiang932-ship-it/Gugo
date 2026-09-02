import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { I18nProvider } from '../src/i18n/I18nProvider.jsx'
import MobileKeysView from '../src/pages/MobileKeysView.jsx'

test('MobileKeysView renders loaded keys through the real i18n provider', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/mobile-keys',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.localStorage.setItem('lang', 'en')
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
      <I18nProvider><MobileKeysView /></I18nProvider>,
    ))
    await act(async () => {
      await new Promise((resolve) => dom.window.setTimeout(resolve, 20))
    })

    assert.ok(rootElement.querySelector('[data-testid="app-layout"]'))
    assert.match(rootElement.textContent, /Mobile access/)
    assert.match(rootElement.textContent, /Kitchen tablet/)
    assert.match(rootElement.textContent, /Last used: Never/)
    assert.match(rootElement.textContent, /Validity: Permanent/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
