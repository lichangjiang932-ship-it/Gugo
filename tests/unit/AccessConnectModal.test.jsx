import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import AccessConnectModal from '../../src/components/AccessConnectModal.jsx'
import { manualIntegrationValues } from '../../src/lib/accessManualCredentials.js'

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
}

const integration = {
  id: 'integration-1',
  provider: 'notion',
  config: { workspace: 'atelier' },
  enabled: true,
}

const t = (key) => ({
  'access.connect': '连接',
  'access.cancel': '取消',
  'access.connectError': '连接失败',
  'access.notionHint': '连接 Notion',
  'access.openSetup': '打开设置',
  'access.saveAndTest': '保存并测试',
  'access.secretKept': '留空保留原密钥',
  'access.token': '令牌',
  'access.workspace': '工作区',
}[key] || key)

async function renderModal(dom, onConnected) {
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  await act(async () => {
    root.render(
      <AccessConnectModal
        connector={connector}
        integration={integration}
        onClose={() => {}}
        onConnected={onConnected}
        t={t}
      />,
    )
  })
  return { root, rootElement }
}

async function submit(dom, rootElement) {
  await act(async () => {
    rootElement.querySelector('form').dispatchEvent(new dom.window.Event('submit', {
      bubbles: true,
      cancelable: true,
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test('只有明确探测成功才启用连接', async () => {
  const originalFetch = globalThis.fetch

  for (const probeResult of [
    { ok: false, message: 'invalid token' },
    {},
    { ok: true, message: 'connected' },
  ]) {
    const dom = setupDom()
    const requests = []
    const connected = []
    globalThis.fetch = async (url, init = {}) => {
      requests.push({ url: String(url), init })
      if (requests.length === 1) {
        return jsonResponse({ ok: true, integration: { ...integration, enabled: false } })
      }
      if (requests.length === 2) {
        return jsonResponse({
          ok: true,
          result: probeResult,
        })
      }
      return jsonResponse({ ok: true, integration: { ...integration, enabled: true } })
    }

    const { root, rootElement } = await renderModal(dom, (value) => connected.push(value))
    try {
      await submit(dom, rootElement)

      const savedBody = JSON.parse(requests[0].init.body)
      assert.equal(savedBody.enabled, false)
      assert.match(requests[1].url, /\/integration-1\/test$/)

      if (probeResult.ok === true) {
        assert.equal(requests.length, 3)
        assert.match(requests[2].url, /\/integration-1\/enabled$/)
        assert.equal(JSON.parse(requests[2].init.body).enabled, true)
        assert.equal(connected[0]?.enabled, true)
      } else {
        assert.equal(requests.length, 2)
        assert.equal(connected.length, 0)
        assert.match(rootElement.textContent, probeResult.message ? /invalid token/ : /连接失败/)
      }
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  }

  globalThis.fetch = originalFetch
})

test('Slack and Google Drive manual fallback map tokens to provider secret fields', () => {
  assert.deepEqual(manualIntegrationValues('slack', {
    workspace: 'Atelier',
    token: 'xoxb-manual',
  }), {
    config: { workspace: 'Atelier' },
    secret: { botToken: 'xoxb-manual' },
  })
  assert.deepEqual(manualIntegrationValues('google_drive', {
    account: 'reader@example.com',
    token: 'drive-manual',
  }), {
    config: { account: 'reader@example.com' },
    secret: { token: 'drive-manual' },
  })
  assert.deepEqual(manualIntegrationValues('telegram', {
    botUsername: 'atelier_bot',
    token: '123:telegram',
  }), {
    config: { botUsername: 'atelier_bot', mode: 'polling' },
    secret: { botToken: '123:telegram' },
  })
  assert.deepEqual(manualIntegrationValues('qq', {
    appId: 'qq-app',
    appSecret: 'qq-secret',
  }), {
    config: { appId: 'qq-app' },
    secret: { appSecret: 'qq-secret' },
  })
})
