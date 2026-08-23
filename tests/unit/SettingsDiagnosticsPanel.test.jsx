import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import SettingsDiagnosticsPanel from '../../src/components/settings/SettingsDiagnosticsPanel.jsx'
import { I18nProvider, useT } from '../../src/i18n/I18nProvider.jsx'

function Harness({ turnHost }) {
  const { t } = useT()
  return (
    <SettingsDiagnosticsPanel
      authMode="local"
      diagnostics={{
        model: { configured: true, modelName: 'local-model', baseUrlMasked: 'http://127.0.0.1' },
        endpoint: { checked: false },
        runtime: { turnHost },
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
        }} />
      </I18nProvider>,
    ))

    assert.match(rootElement.textContent, /Agent 运行时/)
    assert.match(rootElement.textContent, /需要重启/)
    assert.match(rootElement.textContent, /Turn 持久化可用/)
    assert.match(rootElement.textContent, /上下文压缩归档未就绪/)
    assert.match(rootElement.textContent, /检查启动日志/)
    assert.doesNotMatch(rootElement.textContent, /adapterId|portId|private/i)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
