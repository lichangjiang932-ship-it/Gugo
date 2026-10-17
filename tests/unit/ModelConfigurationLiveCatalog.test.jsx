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
test('all 32 saved candidates survive bulk and individual selection, refresh mounted chat, and cannot be restored by a stale edit', async context => {
  const home = mkdtempSync(join(tmpdir(), 'gugo-live-catalog-')), env = { GUGO_HOME: home }
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/#/chat' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, IS_REACT_ACT_ENVIRONMENT: true })
  const models = Array.from({ length: 32 }, (_, index) => ({ id: `fixture-model-${String(index + 1).padStart(2, '0')}`, contextWindow: 32000 + index * 1000, maxTokens: 4000 + index }))
  const ids = models.map(model => model.id)
  const selected = [ids[1], ids[30]]
  const catalogText = values => values.map(id => `fixture:${id}`).join(',')
  const liveText = () => document.querySelector('[data-testid=live-catalog]').textContent
  const choices = (selectedOnly = false) => [...document.querySelectorAll(`[data-testid=model-choice]${selectedOnly ? '[aria-pressed=true]' : ''}`)].map(node => node.dataset.model)
  upsertProvider({ id: 'fixture', baseURL: 'https://fixture.invalid/v1', custom: true, models }, env)
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
  await waitFor(() => document.querySelector('[data-testid=provider-edit]') && liveText() === catalogText(ids))
  const click = async selector => { assert.ok(document.querySelector(selector), selector); await act(async () => document.querySelector(selector).click()) }
  assert.equal(liveText(), catalogText(ids))
  await click('[data-testid=provider-edit]')
  assert.deepEqual(choices(), ids)
  await click('[data-testid=models-select-none]')
  await waitFor(() => liveText() === '' && !document.querySelector('[data-testid=models-select-all]').disabled)
  assert.equal(liveText(), '')
  assert.ok(document.querySelector('[data-testid=model-directory]'))
  assert.deepEqual(choices(), ids)
  assert.deepEqual(choices(true), [])
  assert.deepEqual(listProviders(env).providers[0].models, models.map(model => ({ ...model, enabled: false })))
  for (const [index, id] of selected.entries()) {
    await click(`[data-testid=model-choice][data-model="${id}"]`)
    await waitFor(() => liveText() === catalogText(selected.slice(0, index + 1)) && !document.querySelector('[data-testid=models-select-all]').disabled)
  }
  assert.deepEqual(choices(), ids)
  assert.deepEqual(choices(true), selected)
  await click('[data-testid=models-select-all]')
  await waitFor(() => liveText() === catalogText(ids) && !document.querySelector('[data-testid=models-select-none]').disabled)
  assert.deepEqual(choices(), ids)
  assert.deepEqual(choices(true), ids)
  assert.deepEqual(listProviders(env).providers[0].models, models.map(model => ({ ...model, enabled: true })))
  await click('[data-testid=models-select-none]')
  await waitFor(() => liveText() === '' && !document.querySelector('[data-testid=models-select-all]').disabled)
  for (const [index, id] of selected.entries()) {
    await click(`[data-testid=model-choice][data-model="${id}"]`)
    await waitFor(() => liveText() === catalogText(selected.slice(0, index + 1)) && !document.querySelector('[data-testid=models-select-all]').disabled)
  }
  await act(async () => document.querySelector('[data-testid=add-provider-panel]').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  await waitFor(() => !document.querySelector('[data-testid=add-provider-panel]'))
  assert.equal(liveText(), catalogText(selected))
  assert.deepEqual(listProviders(env).providers[0].models, models.map(model => ({ ...model, enabled: selected.includes(model.id) })))
  await click('[data-testid=provider-edit]')
  assert.deepEqual(choices(), ids)
  assert.deepEqual(choices(true), selected)
})
