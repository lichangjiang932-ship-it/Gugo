import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import AccessConnectModal from '../../src/components/AccessConnectModal.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })
  return dom
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const connector = {
  provider: 'notion',
  label: 'Notion',
  hintKey: 'access.notionHint',
  oauth: true,
}

const integration = {
  id: 'integration-1',
  provider: 'notion',
  config: { workspace: 'atelier' },
  enabled: true,
}

const t = (key) => key

test('OAuth one-click opens the provider, polls the durable session, and connects', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  const requests = []
  const connected = []
  let openedUrl = ''
  let popupClosed = false
  dom.window.open = (url) => {
    openedUrl = String(url)
    return { close: () => { popupClosed = true } }
  }
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (String(url).endsWith('/oauth/start')) {
      return jsonResponse({
        ok: true,
        authorizationUrl: 'https://api.notion.com/v1/oauth/authorize?state=opaque',
        session: { id: 'oauth-session-1', status: 'pending' },
      })
    }
    return jsonResponse({
      ok: true,
      session: {
        id: 'oauth-session-1',
        status: 'completed',
        integration: { ...integration, enabled: true, config: { authSource: 'oauth' } },
      },
    })
  }

  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(
        <AccessConnectModal
          connector={connector}
          integration={integration}
          onClose={() => {}}
          onConnected={(value) => connected.push(value)}
          t={t}
        />,
      )
    })
    const oauthButton = [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent.includes('access.oauthConnect'))
    await act(async () => {
      oauthButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    assert.equal(openedUrl, 'https://api.notion.com/v1/oauth/authorize?state=opaque')
    assert.equal(requests[0].url, '/api/integrations/oauth/start')
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      provider: 'notion',
      integrationId: 'integration-1',
    })
    assert.equal(requests[1].url, '/api/integrations/oauth/sessions/oauth-session-1')
    assert.equal(connected[0]?.config?.authSource, 'oauth')
    assert.equal(popupClosed, true)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})
