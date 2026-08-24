import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import DesktopUpdateCard from '../../src/components/DesktopUpdateCard.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'

test('desktop updates stay idle until the user explicitly checks and downloads', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let checks = 0
  let statusListener = null
  dom.window.gugoDesktop = {
    isDesktop: true,
    onUpdateStatus(listener) {
      statusListener = listener
      return () => { statusListener = null }
    },
    async checkForUpdates() {
      checks += 1
      return { supported: true }
    },
  }
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => root.render(<I18nProvider><DesktopUpdateCard /></I18nProvider>))

    assert.equal(checks, 0)
    assert.match(rootElement.textContent, /更新由你手动控制/)
    assert.match(rootElement.textContent, /启动时不会联网/)
    const checkButton = [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent.includes('检查并下载更新'))
    assert.ok(checkButton)

    await act(async () => checkButton.click())
    assert.equal(checks, 1)
    assert.match(rootElement.textContent, /正在检查更新/)

    await act(async () => statusListener?.({ status: 'downloading', transferred: 10, total: 100 }))
    assert.match(rootElement.textContent, /正在下载更新/)

    const dismissButton = rootElement.querySelector('button[aria-label="隐藏更新提示"]')
    assert.ok(dismissButton)
    await act(async () => dismissButton.click())
    assert.equal(rootElement.querySelector('[data-desktop-update-notice]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
