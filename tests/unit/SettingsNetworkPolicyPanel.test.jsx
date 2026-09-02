import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import SettingsNetworkPolicyPanel from '../../src/components/settings/SettingsNetworkPolicyPanel.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/settings',
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

const labels = {
  'settings.networkPrivacy': '网络与隐私',
  'settings.networkPrivacyDescription': '控制是否联网',
  'settings.pureLocalMode': '纯本地模式',
  'settings.pureLocalModeDescription': '阻止公网连接',
  'settings.pureLocalModeLockedDescription': '由部署锁定',
  'settings.pureLocalModeOn': '仅本地',
  'settings.pureLocalModeOff': '允许联网',
  'settings.pureLocalModeSaving': '正在保存',
  'settings.pureLocalModeEnabled': '已开启',
  'settings.pureLocalModeDisabled': '已关闭',
  'settings.pureLocalModeLoadFailed': '读取失败：{message}',
  'settings.pureLocalModeUpdateFailed': '更新失败：{message}',
}

function t(key, values = {}) {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, value),
    labels[key] || key,
  )
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('pure-local Settings toggle reads authoritative state and renders the saved response', async () => {
  const dom = setupDom()
  const previousFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options })
    if (!options.method) {
      return jsonResponse({
        ok: true,
        policy: {
          mode: 'pure-local',
          pureLocal: true,
          locked: false,
          source: 'user_config',
          blockedErrorCode: 'OUTBOUND_PURE_LOCAL_DENIED',
        },
      })
    }
    assert.equal(options.method, 'PATCH')
    assert.deepEqual(JSON.parse(options.body), { pureLocal: false })
    return jsonResponse({
      ok: true,
      policy: {
        mode: 'standard',
        pureLocal: false,
        locked: false,
        source: 'user_config',
        blockedErrorCode: 'OUTBOUND_PURE_LOCAL_DENIED',
      },
    })
  }

  const container = dom.window.document.getElementById('root')
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<SettingsNetworkPolicyPanel t={t} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const toggle = container.querySelector('[role="switch"]')
    assert.ok(toggle)
    assert.equal(toggle.getAttribute('aria-checked'), 'true')
    assert.match(container.textContent, /仅本地/)
    assert.equal(requests[0].url, '/api/system/network-policy')
    assert.equal(requests[0].options.credentials, 'same-origin')

    await act(async () => {
      toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(toggle.getAttribute('aria-checked'), 'false')
    assert.match(container.textContent, /允许联网/)
    assert.match(container.textContent, /已关闭/)
    assert.equal(requests[1].url, '/api/system/network-policy')
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = previousFetch
    dom.window.close()
  }
})

test('deployment-locked pure-local state is read back with a disabled toggle', async () => {
  const dom = setupDom()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    ok: true,
    policy: {
      mode: 'pure-local',
      pureLocal: true,
      locked: true,
      source: 'environment',
      blockedErrorCode: 'OUTBOUND_PURE_LOCAL_DENIED',
    },
  })
  const container = dom.window.document.getElementById('root')
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<SettingsNetworkPolicyPanel t={t} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const toggle = container.querySelector('[role="switch"]')
    assert.equal(toggle.getAttribute('aria-checked'), 'true')
    assert.equal(toggle.disabled, true)
    assert.match(container.textContent, /由部署锁定/)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = previousFetch
    dom.window.close()
  }
})
