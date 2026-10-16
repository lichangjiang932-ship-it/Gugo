import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import AddProviderPanel from '../../src/components/modelConfig/AddProviderPanel.jsx'
import ModelPicker from '../../src/pages/ChatSplit/ModelPicker.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { saveLlmProvider } from '../../src/lib/llmConfigClient.js'

async function mount(context, element, fetchImpl) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/#/chat' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, IS_REACT_ACT_ENVIRONMENT: true })
  const previous = globalThis.fetch
  globalThis.fetch = fetchImpl || (async () => { throw Error('unexpected network') })
  const root = createRoot(document.getElementById('root'))
  context.after(async () => { await act(async () => root.unmount()); globalThis.fetch = previous; dom.window.close() })
  await act(async () => root.render(<I18nProvider>{element}</I18nProvider>))
  return async selector => { const node = document.querySelector(selector); assert.ok(node, selector); await act(async () => node.click()) }
}
const catalog = { cloud: [{ id: 'openai', displayName: 'Fixture', api: 'openai-completions', baseURL: 'https://fixture.invalid/v1' }] }
const json = data => new Response(JSON.stringify({ ok: true, ...data }), { headers: { 'content-type': 'application/json' } })
test('fetch, select none, individual selection and select all preserve candidates and save the exact choices', async context => {
  let saved
  const click = await mount(context, <AddProviderPanel catalog={catalog} t={key => key} onSaved={() => {}} />, async (url, init) => {
    if (url === '/api/llm/probe') return json({ discovered: ['alpha', 'beta', 'gamma'] })
    if (url === '/api/llm/providers') { saved = JSON.parse(init.body); return json({ provider: saved }) }
    throw Error('unexpected '+url)
  })
  await click('[data-testid=probe-draft-models]')
  await click('[data-testid=models-select-none]')
  assert.equal(document.querySelectorAll('[data-testid=model-choice]').length, 3)
  assert.equal(document.querySelectorAll('[data-testid=model-choice][aria-pressed=true]').length, 0)
  await click('[data-testid=model-choice][data-model=beta]')
  await click('[data-testid=probe-draft-models]')
  assert.equal(document.querySelectorAll('[data-testid=model-choice][aria-pressed=true]').length, 1)
  await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  assert.deepEqual(saved.models.filter(model => model.enabled !== false).map(model => model.id), ['beta'])
  await click('[data-testid=models-select-all]')
  assert.equal(document.querySelectorAll('[data-testid=model-choice][aria-pressed=true]').length, 3)
  await click('[data-testid=models-select-none]')
  await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  assert.equal(saved.models.filter(model => model.enabled !== false).length, 0)
})
test('successful model configuration changes notify the mounted chat, failures do not', async context => {
  await mount(context, <div />, async () => json({ provider: {} }))
  let events = 0
  window.addEventListener('model-providers:changed', () => { events += 1 })
  await saveLlmProvider({ id: 'fixture' })
  assert.equal(events, 1)
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'FIXTURE_REJECTED' } }), { status: 400 })
  await assert.rejects(saveLlmProvider({ id: 'fixture' }))
  assert.equal(events, 1)
})
function Picker({ onManage }) {
  const [open, setOpen] = useState(true)
  return <ModelPicker open={open} modelOptions={[{ name: 'ready', provider: 'fixture', active: true }]} selectedModel="ready" selectedModelProviderId="fixture"
    modelReadiness={{ kind: 'ready', canSend: true }} onClose={() => setOpen(false)} onManage={onManage} />
}
test('a usable model list still offers Add model and closes before navigating to settings', async context => {
  let managed = 0
  const click = await mount(context, <Picker onManage={() => { managed += 1 }} />)
  await click('[data-testid=model-picker-model-row]')
  await click('[data-testid=model-picker-manage]')
  assert.equal(managed, 1)
  assert.equal(document.querySelector('[data-testid=model-picker-panel]'), null)
})
