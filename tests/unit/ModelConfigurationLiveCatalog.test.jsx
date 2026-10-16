import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useT } from '../../src/i18n/I18nProvider.jsx'
import ModelConfigPanel from '../../src/components/modelConfig/ModelConfigPanel.jsx'
import useChatRuntimeCatalog from '../../src/pages/ChatSplit/useChatRuntimeCatalog.js'
import { listProviders, upsertProvider, setCredential } from '../../server/llm/llmProviderService.js'
import { getModelStatus } from '../../server/adapters/modelRuntimeCatalog.js'
function Catalog() {
  const { t, lang } = useT()
  const value = useChatRuntimeCatalog({ t, lang })
  return <output data-testid="live-catalog">{value.modelOptions.map(model => model.provider+':'+model.name).join(',')}</output>
}
const json = data => new Response(JSON.stringify({ ok: true, ...data }), { headers: { 'content-type': 'application/json' } })
test('saved-directory bulk selection stays open and refreshes a mounted chat; provider edits cannot restore stale choices', async context => {
  const home = mkdtempSync(join(tmpdir(), 'gugo-live-catalog-')), env = { GUGO_HOME: home }
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/#/chat' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, IS_REACT_ACT_ENVIRONMENT: true })
  upsertProvider({ id: 'fixture', baseURL: 'https://fixture.invalid/v1', custom: true, models: [{ id: 'alpha', contextWindow: 10000 }, { id: 'beta', contextWindow: 20000 }] }, env)
  setCredential('fixture', 'synthetic-fixture-token', env)
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    if (url === '/api/model/status') return json(getModelStatus(env))
    if (url === '/api/llm/providers' && init.method === 'POST') return json({ provider: upsertProvider(JSON.parse(init.body), env) })
    if (url === '/api/llm/providers') return json(listProviders(env))
    if (url === '/api/llm/catalog') return json({ catalog: { cloud: [], local: [] } })
    if (String(url).includes('/skills')) return json({ skills: [] })
    if (String(url).includes('/plugins')) return json({ plugins: [] })
    throw Error('unexpected '+url)
  }
  const root = createRoot(document.getElementById('root'))
  context.after(async () => { await act(async () => root.unmount()); globalThis.fetch = oldFetch; dom.window.close(); rmSync(home, { recursive: true, force: true }) })
  const waitFor = async condition => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (condition()) return
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    }
    assert.ok(condition(), 'expected UI state did not become ready')
  }
  await act(async () => root.render(<I18nProvider><ModelConfigPanel /><Catalog /></I18nProvider>))
  await waitFor(() => document.querySelector('[data-testid=provider-edit]') && document.querySelector('[data-testid=live-catalog]').textContent.includes('fixture:beta'))
  const click = async selector => { assert.ok(document.querySelector(selector), selector); await act(async () => document.querySelector(selector).click()) }
  assert.match(document.querySelector('[data-testid=live-catalog]').textContent, /fixture:alpha,fixture:beta/)
  await click('[data-testid=provider-edit]')
  await click('[data-testid=models-select-none]')
  await waitFor(() => document.querySelector('[data-testid=live-catalog]').textContent === '')
  assert.equal(document.querySelector('[data-testid=live-catalog]').textContent, '')
  assert.equal(!!document.querySelector('[data-testid=model-directory]'), true)
  assert.equal(document.querySelectorAll('[data-testid=model-choice]').length, 2)
  await click('[data-testid=model-choice][data-model=beta]')
  await waitFor(() => document.querySelector('[data-testid=live-catalog]').textContent === 'fixture:beta')
  assert.equal(document.querySelector('[data-testid=live-catalog]').textContent, 'fixture:beta')
  await act(async () => document.querySelector('[data-testid=add-provider-panel]').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  await waitFor(() => !document.querySelector('[data-testid=add-provider-panel]'))
  assert.equal(document.querySelector('[data-testid=live-catalog]').textContent, 'fixture:beta')
  assert.equal(listProviders(env).providers[0].models.find(model => model.id === 'alpha').enabled, false)
})
