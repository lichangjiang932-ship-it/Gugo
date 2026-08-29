import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsPluginsPanel } from '../../src/components/settings/SettingsSecondaryPanels.jsx'

const approvalDigest = `sha256-${'a'.repeat(64)}`
const sourceDigest = `sha256-${'b'.repeat(64)}`
const permissions = ['runtime:tool', 'sandbox:network']

const labels = {
  'settings.plugins': '插件',
  'settings.pluginsDescription': '管理插件',
  'settings.skillPlugins': '技能插件',
  'settings.skillPluginsDescription': '技能插件说明',
  'settings.managePlugins': '管理插件',
  'settings.mcpExtensions': 'MCP 扩展',
  'settings.mcpExtensionsDescription': 'MCP 说明',
  'settings.manageMcp': '管理 MCP',
  'settings.runtimePlugins': '运行时插件',
  'settings.runtimePluginsDescription': '运行时插件说明',
  'settings.pluginInactive': '未启用',
  'settings.pluginActive': '运行中',
  'settings.pluginEnable': '启用',
  'settings.pluginDisable': '禁用',
  'settings.pluginReload': '重载',
  'settings.pluginRevokePermissions': '撤销授权',
  'settings.pluginRevokePermissionsHint': '撤销权限',
  'settings.pluginPermissionReviewTitle': '需要确认插件权限',
  'settings.pluginPermissionReviewHint': '仅在信任来源时继续',
  'settings.pluginPermissionVersion': '版本',
  'settings.pluginPermissionSource': '源码指纹',
  'settings.pluginPermissionRequested': '请求的权限',
  'settings.pluginPermissionChangeHint': '版本、源码或权限变化后需重新确认',
  'settings.pluginPermissionCancel': '取消',
  'settings.pluginPermissionApprove': '确认并继续',
  'settings.pluginActionFailedTitle': '插件操作未完成',
  'settings.pluginActionFailedHint': '当前状态保持不变',
  'settings.pluginRevokeFailedTitle': '授权撤销/停止未完成',
  'settings.pluginRevokeFailedHint': '撤权/停止可能仅部分完成，已刷新当前状态',
}

const t = (key) => labels[key] || key

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
  dom.window.confirm = () => { throw new Error('window.confirm must not be used') }
  return dom
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function inventoryPlugin({ enabled, granted }) {
  return {
    id: 'demo-transformer',
    name: 'Demo Transformer',
    version: '2.0.0',
    controllable: true,
    canRevokePermissions: granted,
    enabled,
    active: enabled,
    permissionGrant: {
      required: true,
      granted,
      permissions,
      approvalDigest,
      grantedAt: granted ? '2026-08-23T00:00:00.000Z' : null,
    },
  }
}

async function click(dom, button) {
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function button(rootElement, text) {
  const found = [...rootElement.querySelectorAll('button')]
    .find((item) => item.textContent.trim() === text)
  assert.ok(found, `missing button: ${text}`)
  return found
}

test('runtime plugin permission challenge stays inline and retries only after explicit approval', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const originalFetch = globalThis.fetch
  const calls = []
  let enabled = false
  let granted = false
  let approvedEnableAttempts = 0
  let revokeAttempts = 0
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (!init.method) {
      return response({ ok: true, schemaVersion: 8, plugins: [inventoryPlugin({ enabled, granted })] })
    }
    if (String(url).endsWith('/enable')) {
      if (init.headers?.['X-Gugo-Plugin-Permission-Approval'] !== approvalDigest) {
        return response({
          ok: false,
          error: {
            code: 'PLUGIN_PERMISSION_APPROVAL_REQUIRED',
            message: 'approval required',
            details: {
              permissionApproval: {
                contractVersion: 1,
                pluginId: 'demo-transformer',
                pluginVersion: '2.0.0',
                sourceDigest,
                approvalDigest,
                permissions,
              },
            },
          },
        }, 409)
      }
      approvedEnableAttempts += 1
      if (approvedEnableAttempts === 1) {
        return response({
          ok: false,
          error: {
            code: 'RUNTIME_PLUGIN_CONTROL_FAILED',
            message: 'activation failed upstream',
          },
        }, 503)
      }
      enabled = true
      granted = true
      return response({ ok: true, plugin: inventoryPlugin({ enabled, granted }) })
    }
    if (String(url).endsWith('/revoke-permissions')) {
      revokeAttempts += 1
      if (revokeAttempts === 1) {
        granted = false
        return response({
          ok: false,
          error: {
            code: 'RUNTIME_PLUGIN_CONTROL_FAILED',
            message: 'revocation failed upstream',
          },
        }, 503)
      }
      enabled = false
      granted = false
      return response({ ok: true, plugin: inventoryPlugin({ enabled, granted }) })
    }
    throw new Error(`unexpected request: ${url}`)
  }

  try {
    await act(async () => {
      root.render(<SettingsPluginsPanel navigate={() => {}} t={t} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await click(dom, button(rootElement, '启用'))
    const approvalCard = rootElement.querySelector('[data-testid="runtime-plugin-permission-approval-demo-transformer"]')
    assert.ok(approvalCard)
    assert.match(approvalCard.textContent, /runtime:tool/)
    assert.match(approvalCard.textContent, /sandbox:network/)
    assert.match(approvalCard.textContent, /2\.0\.0/)
    assert.match(approvalCard.textContent, new RegExp(sourceDigest))

    await click(dom, button(rootElement, '取消'))
    assert.equal(rootElement.querySelector('[data-testid^="runtime-plugin-permission-approval-"]'), null)
    assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1)

    await click(dom, button(rootElement, '启用'))
    await click(dom, button(rootElement, '确认并继续'))
    const approvedRequest = calls.find((call) => (
      call.init.headers?.['X-Gugo-Plugin-Permission-Approval'] === approvalDigest
    ))
    assert.ok(approvedRequest)
    assert.match(approvedRequest.url, /\/demo-transformer\/enable$/)
    assert.equal(rootElement.querySelector('[data-testid^="runtime-plugin-permission-approval-"]'), null)
    const activationFailure = rootElement.querySelector('[data-testid="runtime-plugin-action-failure-demo-transformer"]')
    assert.ok(activationFailure)
    assert.match(activationFailure.textContent, /activation failed upstream/)
    assert.match(rootElement.textContent, /Demo Transformer/)
    assert.match(rootElement.textContent, /未启用/)

    await click(dom, button(rootElement, '启用'))
    assert.ok(rootElement.querySelector('[data-testid="runtime-plugin-permission-approval-demo-transformer"]'))
    await click(dom, button(rootElement, '确认并继续'))
    assert.equal(rootElement.querySelector('[data-testid^="runtime-plugin-permission-approval-"]'), null)
    assert.equal(rootElement.querySelector('[data-testid^="runtime-plugin-action-failure-"]'), null)

    const inventoryReadsBeforeRevoke = calls.filter((call) => !call.init.method).length
    await click(dom, button(rootElement, '撤销授权'))
    const failureCard = rootElement.querySelector('[data-testid="runtime-plugin-action-failure-demo-transformer"]')
    assert.ok(failureCard)
    assert.match(failureCard.textContent, /授权撤销\/停止未完成/)
    assert.match(failureCard.textContent, /撤权\/停止可能仅部分完成/)
    assert.match(failureCard.textContent, /已刷新当前状态/)
    assert.match(failureCard.textContent, /revocation failed upstream/)
    assert.match(rootElement.textContent, /Demo Transformer/)
    assert.match(rootElement.textContent, /运行中/)
    assert.equal(calls.filter((call) => !call.init.method).length, inventoryReadsBeforeRevoke + 1)
    assert.ok(calls.some((call) => call.url.endsWith('/demo-transformer/revoke-permissions')))
    assert.doesNotMatch(rootElement.textContent, /撤销授权/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('a persisted grant stays revocable when the plugin is no longer controllable', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const originalFetch = globalThis.fetch
  let revoked = false
  globalThis.fetch = async (url, init = {}) => {
    if (!init.method) {
      return response({
        ok: true,
        schemaVersion: 8,
        plugins: [{
          id: 'stale-transformer',
          name: 'Stale Transformer',
          controllable: false,
          canRevokePermissions: !revoked,
          enabled: false,
          active: false,
          permissionGrant: null,
        }],
      })
    }
    assert.match(String(url), /\/stale-transformer\/revoke-permissions$/)
    revoked = true
    return response({
      ok: true,
      plugin: {
        id: 'stale-transformer',
        name: 'Stale Transformer',
        controllable: false,
        canRevokePermissions: false,
        enabled: false,
        active: false,
        permissionGrant: null,
      },
    })
  }

  try {
    await act(async () => {
      root.render(<SettingsPluginsPanel navigate={() => {}} t={t} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const actionLabels = [...rootElement.querySelectorAll('button')]
      .map((item) => item.textContent.trim())
    assert.equal(actionLabels.includes('启用'), false)
    assert.equal(actionLabels.includes('重载'), false)
    await click(dom, button(rootElement, '撤销授权'))
    assert.equal(revoked, true)
    assert.doesNotMatch(rootElement.textContent, /撤销授权/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})
