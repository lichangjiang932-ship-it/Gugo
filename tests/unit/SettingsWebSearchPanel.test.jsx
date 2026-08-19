import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import SettingsWebSearchPanel from '../../src/components/settings/SettingsWebSearchPanel.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/settings?tab=web-search',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const t = (key, values = {}) => Object.entries(values)
  .reduce((text, [name, value]) => `${text}:${name}=${value}`, key)

test('web search settings edit and persist an ordered multi-API fallback list without exposing keys', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  const requests = []
  const storedConnections = [
    { id: 'primary', provider: 'tavily', enabled: true, config: {}, apiKeyPresent: true },
    { id: 'backup', provider: 'brave', enabled: true, config: {}, apiKeyPresent: true },
  ]
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if ((init.method || 'GET') === 'GET') {
      return jsonResponse({ ok: true, config: { version: 2, enabled: true, strategy: 'fallback', connections: storedConnections } })
    }
    const payload = JSON.parse(init.body)
    return jsonResponse({
      ok: true,
      config: {
        version: 2,
        enabled: payload.enabled,
        strategy: payload.strategy,
        connections: payload.connections.map((item) => ({
          id: item.id,
          provider: item.provider,
          enabled: item.enabled,
          config: item.config,
          apiKeyPresent: storedConnections.some((saved) => saved.id === item.id),
        })),
      },
    })
  }

  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(<SettingsWebSearchPanel t={t} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(rootElement.querySelectorAll('[data-testid="web-search-connections"] > div').length, 2)
    assert.equal(rootElement.querySelectorAll('[data-testid="web-search-connection-actions"]').length, 2)
    assert.match(rootElement.textContent, /Tavily/)
    assert.match(rootElement.textContent, /Brave Search/)
    assert.doesNotMatch(rootElement.textContent, /secret/i)

    const add = [...rootElement.querySelectorAll('button')].find((button) => button.textContent.includes('webSearch.addApi'))
    await act(async () => add.click())
    assert.equal(rootElement.querySelectorAll('[data-testid="web-search-connections"] > div').length, 3)

    const moveUpButtons = rootElement.querySelectorAll('button[aria-label="webSearch.moveUp"]')
    await act(async () => moveUpButtons[2].click())
    const save = [...rootElement.querySelectorAll('button')].find((button) => button.textContent === 'common.save')
    await act(async () => {
      save.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const put = requests.find((request) => request.init.method === 'PUT')
    assert.ok(put)
    const payload = JSON.parse(put.init.body)
    assert.equal(payload.strategy, 'fallback')
    assert.equal(payload.connections.length, 3)
    assert.equal(payload.connections[0].id, 'primary')
    assert.equal(payload.connections[2].id, 'backup')
    assert.equal(payload.connections.some((item) => Object.hasOwn(item, 'apiKey')), false)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('web search settings hide single-API actions and restore them only while multiple APIs exist', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  globalThis.fetch = async () => jsonResponse({
    ok: true,
    config: {
      version: 2,
      enabled: true,
      strategy: 'fallback',
      connections: [
        { id: 'primary', provider: 'tavily', enabled: true, config: {}, apiKeyPresent: true },
      ],
    },
  })

  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(<SettingsWebSearchPanel t={t} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const panel = rootElement.querySelector('.web-search-settings')
    assert.ok(panel)
    assert.equal(panel.classList.contains('animate-float-up'), false)
    assert.equal(rootElement.querySelectorAll('[data-testid="web-search-connection-actions"]').length, 0)

    const templateGrid = rootElement.querySelector('[data-testid="web-search-template-grid"]')
    assert.ok(templateGrid)
    assert.ok(templateGrid.classList.contains('grid-cols-2'))
    assert.ok(templateGrid.classList.contains('lg:grid-cols-3'))
    assert.equal(templateGrid.querySelectorAll('button[data-provider]').length, 6)
    for (const button of templateGrid.querySelectorAll('button[data-provider]')) {
      assert.equal(button.querySelector('.truncate'), null)
    }

    const add = [...rootElement.querySelectorAll('button')].find((button) => button.textContent.includes('webSearch.addApi'))
    await act(async () => add.click())
    assert.equal(rootElement.querySelectorAll('[data-testid="web-search-connections"] > div').length, 2)
    assert.equal(rootElement.querySelectorAll('[data-testid="web-search-connection-actions"]').length, 2)

    const removeButtons = rootElement.querySelectorAll('button[aria-label="webSearch.removeApi"]')
    await act(async () => removeButtons[1].click())
    assert.equal(rootElement.querySelectorAll('[data-testid="web-search-connections"] > div').length, 1)
    assert.equal(rootElement.querySelectorAll('[data-testid="web-search-connection-actions"]').length, 0)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})
