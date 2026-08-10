import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import SettingsToolsPanel from '../../src/components/settings/SettingsToolsPanel.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/settings/tools',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

test('code execution settings describe the local runtime honestly and keep the toggle wired', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const actions = []

  try {
    await act(async () => root.render(
      <SettingsToolsPanel
        state={{ toolsConfig: { bash_exec: true } }}
        dispatch={(action) => actions.push(action)}
      />,
    ))

    assert.match(rootElement.textContent, /执行代码与命令/)
    assert.match(rootElement.textContent, /Python、Node、PowerShell/)
    assert.match(rootElement.textContent, /已授权的读写目录/)
    assert.doesNotMatch(rootElement.textContent, /服务端还需显式启用/)

    const toggle = rootElement.querySelector('button[aria-label="执行代码与命令: 开启"]')
    assert.ok(toggle)
    assert.equal(toggle.getAttribute('aria-pressed'), 'true')
    await act(async () => toggle.click())
    assert.deepEqual(actions, [{ type: 'SET_TOOLS_CONFIG', payload: { bash_exec: false } }])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
