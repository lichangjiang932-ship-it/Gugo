import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import SettingsDiagnosticsPanel from '../../src/components/settings/SettingsDiagnosticsPanel.jsx'
import { I18nProvider, useT } from '../../src/i18n/I18nProvider.jsx'

function Harness({ turnHost, codexHost, lspHost }) {
  const { t } = useT()
  return (
    <SettingsDiagnosticsPanel
      authMode="local"
      diagnostics={{
        model: { configured: true, modelName: 'local-model', baseUrlMasked: 'http://127.0.0.1' },
        endpoint: { checked: false },
        runtime: { turnHost, codexHost, lspHost },
      }}
      loading={false}
      onConfigureModels={() => {}}
      onRefresh={() => {}}
      onTest={() => {}}
      t={t}
    />
  )
}

test('runtime diagnostics expose host readiness without internal adapter identities', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => root.render(
      <I18nProvider>
        <Harness turnHost={{
          ready: false,
          persistenceConfigured: true,
          compactionArchiveConfigured: false,
        }} codexHost={{
          enabled: true,
          configured: true,
          discovered: true,
          signatureValid: true,
          version: '0.150.0-alpha.8',
          ready: false,
          failureStage: 'handshake',
          reasonCode: 'CODEX_APP_SERVER_HANDSHAKE_TIMEOUT',
        }} />
      </I18nProvider>,
    ))

    assert.match(rootElement.textContent, /Agent 运行时/)
    assert.match(rootElement.textContent, /需要重启/)
    assert.match(rootElement.textContent, /Turn 持久化可用/)
    assert.match(rootElement.textContent, /上下文压缩归档未就绪/)
    assert.match(rootElement.textContent, /检查启动日志/)
    assert.match(rootElement.textContent, /Codex app-server/)
    assert.match(rootElement.textContent, /握手超时/)
    assert.match(rootElement.textContent, /原生代码工具/)
    assert.doesNotMatch(rootElement.textContent, /adapterId|portId|private|protocolReady|source|stderr/i)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('LSP diagnostics show bounded readiness states without reading sensitive configuration', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const allowedFields = new Set(['enabled', 'providerCount', 'reason', 'code'])
  const forbiddenReads = []
  const lspHostWithSensitiveFields = (status) => ({
    ...status,
    command: 'C:\\private-language-server.exe',
    args: ['--secret-argument'],
    env: { PRIVATE_TOKEN: 'secret-environment' },
    cwd: 'C:\\private-workspace',
    path: 'C:\\private-source.ts',
    sourcePath: 'C:\\private-source-path.ts',
    executablePath: 'C:\\private-executable.exe',
  })
  const guardedLspHost = new Proxy(lspHostWithSensitiveFields({
    enabled: true,
    providerCount: 1,
    reason: 'configured',
  }), {
    get(target, property, receiver) {
      if (typeof property === 'symbol' || allowedFields.has(property)) {
        return Reflect.get(target, property, receiver)
      }
      forbiddenReads.push(String(property))
      return undefined
    },
    ownKeys(target) {
      forbiddenReads.push('[[OwnKeys]]')
      return Reflect.ownKeys(target)
    },
  })
  const fixtures = [
    {
      status: { enabled: false, providerCount: 0, reason: 'not_configured' },
      expected: [/未配置/, /尚未配置语言服务器/],
    },
    {
      status: {
        enabled: false,
        providerCount: 0,
        reason: 'invalid_config',
        code: 'LSP_COMMAND_NOT_ALLOWED',
      },
      expected: [/配置无效/, /命令允许列表/],
    },
    {
      status: {
        enabled: false,
        providerCount: 0,
        reason: 'provider_initialization_failed',
        code: 'LSP_CONFLICT',
      },
      expected: [/初始化失败/, /未能初始化/],
    },
    {
      status: {
        enabled: true,
        providerCount: 2,
        reason: 'query_failed',
        code: 'LSP_PROCESS_FAILED',
      },
      expected: [/首次查询执行失败/, /无法启动或完成/, /2 个语言服务器提供方仍已配置/],
    },
    {
      status: {
        enabled: true,
        providerCount: 2,
        reason: 'query_failed',
        code: 'LSP_PROCESS_BACKOFF',
      },
      expected: [/首次查询执行失败/, /无法启动或完成/, /2 个语言服务器提供方仍已配置/],
    },
    {
      status: {
        enabled: true,
        providerCount: 2,
        reason: 'query_failed',
        code: 'LSP_MALFORMED_RESPONSE',
      },
      expected: [/协议失败/, /无效或不兼容的协议响应/, /2 个语言服务器提供方仍已配置/],
    },
    {
      status: { enabled: true, providerCount: 2, reason: 'configured' },
      expected: [/已就绪/, /已加载 2 个语言服务器提供方/],
    },
  ]

  try {
    SettingsDiagnosticsPanel({
      authMode: 'local',
      diagnostics: { runtime: { lspHost: guardedLspHost } },
      loading: false,
      onConfigureModels: () => {},
      onRefresh: () => {},
      onTest: () => {},
      t: (key) => key,
    })
    assert.deepEqual(forbiddenReads, [])

    for (const fixture of fixtures) {
      await act(async () => root.render(
        <I18nProvider>
          <Harness lspHost={lspHostWithSensitiveFields(fixture.status)} />
        </I18nProvider>,
      ))

      assert.match(rootElement.textContent, /LSP 代码导航/)
      assert.match(rootElement.textContent, /语言服务器/)
      for (const expected of fixture.expected) assert.match(rootElement.textContent, expected)
      assert.doesNotMatch(
        rootElement.textContent,
        /private-language-server|secret-argument|secret-environment|private-workspace|private-source|private-executable/i,
      )
    }
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
