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
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
  const previous = globalThis.fetch
  globalThis.fetch = fetchImpl || (async () => { throw Error('unexpected network') })
  const root = createRoot(document.getElementById('root'))
  context.after(async () => { await act(async () => root.unmount()); globalThis.fetch = previous; dom.window.close() })
  await act(async () => root.render(<I18nProvider>{element}</I18nProvider>))
  return async selector => { const node = document.querySelector(selector); assert.ok(node, selector); await act(async () => node.click()) }
}
const catalog = { cloud: [{ id: 'openai', displayName: 'Fixture', api: 'openai-completions', baseURL: 'https://fixture.invalid/v1' }] }
const json = data => new Response(JSON.stringify({ ok: true, ...data }), { headers: { 'content-type': 'application/json' } })
const modelIds = Array.from({ length: 32 }, (_, index) => `fixture-model-${String(index + 1).padStart(2, '0')}`)
const modelProfiles = Object.fromEntries(modelIds.map((id, index) => [id, { contextWindow: 32000 + index * 1000, maxTokens: 4000 + index }]))
const choiceIds = (selectedOnly = false) => [...document.querySelectorAll(`[data-testid=model-choice]${selectedOnly ? '[aria-pressed=true]' : ''}`)].map(node => node.dataset.model)
const submit = async () => { await act(async () => document.querySelector('[data-testid=add-provider-panel]').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))) }
async function setInput(selector, value) {
  const input = document.querySelector(selector)
  assert.ok(input, selector)
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set
  await act(async () => {
    input.focus()
    setter.call(input, value)
    input.dispatchEvent(new window.InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
    // react-dom is imported before jsdom; its legacy input fallback observes keyup.
    input.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'a', bubbles: true }))
  })
  assert.equal(document.querySelector(selector).value, value)
}
test('fetch exposes all 32 IDs; select none, two individual choices and select all save exact candidates with metadata', async context => {
  let saved
  const click = await mount(context, <AddProviderPanel catalog={catalog} t={key => key} onSaved={() => {}} />, async (url, init) => {
    if (url === '/api/llm/probe') return json({ discovered: modelIds, modelProfiles })
    if (url === '/api/llm/providers') { saved = JSON.parse(init.body); return json({ provider: saved }) }
    throw Error('unexpected '+url)
  })
  await click('[data-testid=probe-draft-models]')
  assert.deepEqual(choiceIds(), modelIds)
  assert.deepEqual(choiceIds(true), modelIds)
  await click('[data-testid=models-select-none]')
  assert.deepEqual(choiceIds(), modelIds)
  assert.deepEqual(choiceIds(true), [])
  await submit()
  assert.deepEqual(saved.models, modelIds.map(id => ({ id, ...modelProfiles[id], enabled: false })))
  const selected = [modelIds[1], modelIds[30]]
  for (const id of selected) await click(`[data-testid=model-choice][data-model="${id}"]`)
  assert.deepEqual(choiceIds(), modelIds)
  assert.deepEqual(choiceIds(true), selected)
  await submit()
  assert.deepEqual(saved.models, modelIds.map(id => ({ id, ...modelProfiles[id], enabled: selected.includes(id) })))
  await click('[data-testid=models-select-all]')
  assert.deepEqual(choiceIds(), modelIds)
  assert.deepEqual(choiceIds(true), modelIds)
  await submit()
  assert.deepEqual(saved.models, modelIds.map(id => ({ id, ...modelProfiles[id], enabled: true })))
})
test('repeated probes deduplicate without re-enabling disabled candidates; new candidates retain their window metadata', async context => {
  let probes = 0, saved
  const addedId = 'fixture-model-new'
  const addedProfile = { contextWindow: 128000, maxTokens: 16000 }
  const click = await mount(context, <AddProviderPanel catalog={catalog} t={key => key} />, async (url, init) => {
    if (url === '/api/llm/probe') {
      probes += 1
      const discovered = probes === 1 ? modelIds : [...modelIds].reverse().concat(modelIds[0], probes === 3 ? [addedId, addedId] : [])
      return json({ discovered, modelProfiles: probes === 3 ? { ...modelProfiles, [modelIds[0]]: { contextWindow: 999999 }, [addedId]: addedProfile } : modelProfiles })
    }
    if (url === '/api/llm/providers') { saved = JSON.parse(init.body); return json({ provider: saved }) }
    throw Error('unexpected '+url)
  })
  await click('[data-testid=probe-draft-models]')
  await click('[data-testid=models-select-none]')
  const selected = [modelIds[1], modelIds[30]]
  for (const id of selected) await click(`[data-testid=model-choice][data-model="${id}"]`)
  await click('[data-testid=probe-draft-models]')
  assert.deepEqual(choiceIds(), modelIds)
  assert.deepEqual(choiceIds(true), selected)
  await click('[data-testid=probe-draft-models]')
  assert.equal(probes, 3)
  assert.deepEqual(choiceIds(), [...modelIds, addedId])
  assert.deepEqual(choiceIds(true), [...selected, addedId])
  await submit()
  assert.deepEqual(saved.models, [...modelIds.map(id => ({ id, ...modelProfiles[id], enabled: selected.includes(id) })), { id: addedId, ...addedProfile }])
})
test('a failed probe preserves unsaved provider fields, pending manual ID and the exact model selection', async context => {
  let rejectProbe = false, saved, savedCallbacks = 0, events = 0
  const click = await mount(context, <AddProviderPanel catalog={catalog} t={key => key} onSaved={() => { savedCallbacks += 1 }} />, async (url, init) => {
    if (url === '/api/llm/probe') return rejectProbe
      ? new Response(JSON.stringify({ error: { code: 'FIXTURE_PROBE_FAILED', message: 'Fixture probe failed' } }), { status: 503 })
      : json({ discovered: modelIds, modelProfiles })
    if (url === '/api/llm/providers') { saved = JSON.parse(init.body); return json({ provider: saved }) }
    throw Error('unexpected '+url)
  })
  window.addEventListener('model-providers:changed', () => { events += 1 })
  await click('[data-testid=tab-custom]')
  const fields = { 'custom-provider-id': 'fixture-draft', 'custom-display-name': 'Unsaved fixture', 'custom-base-url': 'https://draft.fixture.invalid/v1', 'draft-model-input': 'pending-manual-model' }
  for (const [id, value] of Object.entries(fields)) await setInput(`[data-testid=${id}]`, value)
  await click('[data-testid=probe-draft-models]')
  await click('[data-testid=models-select-none]')
  const selected = [modelIds[1], modelIds[30]]
  for (const id of selected) await click(`[data-testid=model-choice][data-model="${id}"]`)
  rejectProbe = true
  await click('[data-testid=probe-draft-models]')
  assert.equal(document.querySelector('[data-testid=probe-note]').textContent, 'Fixture probe failed')
  for (const [id, value] of Object.entries(fields)) assert.equal(document.querySelector(`[data-testid=${id}]`).value, value)
  assert.deepEqual(choiceIds(), modelIds)
  assert.deepEqual(choiceIds(true), selected)
  assert.equal(saved, undefined)
  assert.equal(savedCallbacks, 0)
  assert.equal(events, 0)
  await submit()
  assert.deepEqual(saved, { id: 'fixture-draft', displayName: 'Unsaved fixture', api: 'openai-completions', baseURL: fields['custom-base-url'], custom: true,
    models: modelIds.map(id => ({ id, ...modelProfiles[id], enabled: selected.includes(id) })) })
  assert.equal(savedCallbacks, 1)
  assert.equal(events, 1)
})
test('a rejected save keeps the draft and choices without an onSaved callback or success notification', async context => {
  let rejectSave = true, savedCallbacks = 0, events = 0
  const attempts = []
  const click = await mount(context, <AddProviderPanel catalog={catalog} t={key => key} onSaved={() => { savedCallbacks += 1 }} />, async (url, init) => {
    if (url === '/api/llm/probe') return json({ discovered: modelIds, modelProfiles })
    if (url === '/api/llm/providers') {
      attempts.push(JSON.parse(init.body))
      return rejectSave ? json({ ok: false, error: { code: 'FIXTURE_SAVE_FAILED', message: 'Fixture save failed' } }) : json({ provider: attempts.at(-1) })
    }
    throw Error('unexpected '+url)
  })
  window.addEventListener('model-providers:changed', () => { events += 1 })
  await click('[data-testid=probe-draft-models]')
  await click('[data-testid=models-select-none]')
  const selected = [modelIds[1], modelIds[30]]
  for (const id of selected) await click(`[data-testid=model-choice][data-model="${id}"]`)
  await submit()
  const expected = { id: 'openai', models: modelIds.map(id => ({ id, ...modelProfiles[id], enabled: selected.includes(id) })) }
  assert.deepEqual(attempts, [expected])
  assert.equal(document.querySelector('[data-testid=add-provider-error]').textContent, 'Fixture save failed')
  assert.deepEqual(choiceIds(), modelIds)
  assert.deepEqual(choiceIds(true), selected)
  assert.equal(document.querySelector('[data-testid=add-provider-save]').disabled, false)
  assert.equal(savedCallbacks, 0)
  assert.equal(events, 0)
  rejectSave = false
  await submit()
  assert.deepEqual(attempts, [expected, expected])
  assert.equal(document.querySelector('[data-testid=add-provider-error]'), null)
  assert.equal(savedCallbacks, 1)
  assert.equal(events, 1)
})
test('provider is saved before the credential so a failed credential cannot orphan a secret', async context => {
  let rejectProvider = true, rejectCredential = true, savedCallbacks = 0
  const calls = []
  const click = await mount(context, <AddProviderPanel catalog={catalog} t={key => key} onSaved={() => { savedCallbacks += 1 }} />, async (url, init) => {
    const body = JSON.parse(init.body)
    if (url === '/api/llm/providers') {
      calls.push('provider')
      return rejectProvider
        ? json({ ok: false, error: { code: 'FIXTURE_PROVIDER_SAVE_FAILED', message: 'Fixture provider save failed' } })
        : json({ provider: body })
    }
    if (String(url).endsWith('/credential')) {
      calls.push('credential')
      return rejectCredential
        ? json({ ok: false, error: { code: 'FIXTURE_CREDENTIAL_SAVE_FAILED', message: 'Fixture credential save failed' } })
        : json({})
    }
    throw Error('unexpected '+url)
  })
  await click('[data-testid=tab-custom]')
  await setInput('[data-testid=custom-provider-id]', 'credential-order')
  await setInput('[data-testid=custom-api-key]', 'synthetic-order-key')

  await submit()
  assert.deepEqual(calls, ['provider'], 'a failed provider save never writes a credential')
  assert.equal(document.querySelector('[data-testid=add-provider-error]').textContent, 'Fixture provider save failed')
  assert.equal(savedCallbacks, 0)

  rejectProvider = false
  await submit()
  assert.deepEqual(calls, ['provider', 'provider', 'credential'])
  assert.equal(document.querySelector('[data-testid=add-provider-error]').textContent, 'Fixture credential save failed')
  assert.equal(savedCallbacks, 0)

  rejectCredential = false
  await submit()
  assert.deepEqual(calls, ['provider', 'provider', 'credential', 'provider', 'credential'])
  assert.equal(document.querySelector('[data-testid=add-provider-error]'), null)
  assert.equal(savedCallbacks, 1)
})

test('switching catalogue provider clears credentials, URL, model draft and candidates before probe/save', async context => {
  const targetCatalog = { cloud: [...catalog.cloud, { id: 'anthropic', api: 'anthropic-messages', baseURL: 'https://b.fixture.invalid/v1' }] }
  const probes = [], credentials = [], saved = []
  const click = await mount(context, <AddProviderPanel catalog={targetCatalog} t={key => key} />, async (url, init) => {
    const body = JSON.parse(init.body)
    if (url === '/api/llm/probe') { probes.push(body); return json({ discovered: [probes.length === 1 ? 'from-a' : 'from-b'] }) }
    if (String(url).endsWith('/credential')) { credentials.push({ url, body }); return json({}) }
    if (url === '/api/llm/providers') { saved.push(body); return json({ provider: body }) }
    throw Error('unexpected '+url)
  })
  await setInput('[data-testid=provider-api-key]', 'synthetic-a-credential')
  await click('[data-testid=toggle-custom-settings]')
  await setInput('[data-testid=provider-base-url]', 'https://override-a.fixture.invalid/v1')
  await setInput('[data-testid=draft-model-input]', 'pending-a')
  await click('[data-testid=probe-draft-models]')
  await click('[data-testid=catalog-entry][data-provider=anthropic]')
  assert.equal(document.querySelector('[data-testid=provider-api-key]').value, '')
  assert.deepEqual(choiceIds(), [])
  assert.equal(document.querySelector('[data-testid=draft-model-input]').value, '')
  await setInput('[data-testid=provider-api-key]', 'synthetic-b-credential')
  await click('[data-testid=probe-draft-models]')
  assert.deepEqual(probes[1], { api: 'anthropic-messages', baseURL: 'https://b.fixture.invalid/v1', apiKey: 'synthetic-b-credential' })
  await submit()
  assert.deepEqual(credentials, [{ url: '/api/llm/providers/anthropic/credential', body: { apiKey: 'synthetic-b-credential' } }])
  assert.deepEqual(saved, [{ id: 'anthropic', models: [{ id: 'from-b' }] }])
})
test('editing the custom Provider ID preserves the draft and saves it under the new identity', async context => {
  const probes = [], saved = [], credentials = []
  const click = await mount(context, <AddProviderPanel catalog={catalog} t={key => key} />, async (url, init) => {
    const body = JSON.parse(init.body)
    if (url === '/api/llm/probe') { probes.push(body); return json({ discovered: ['from-custom-a'] }) }
    if (url === '/api/llm/providers') { saved.push(body); return json({ provider: body }) }
    if (String(url).endsWith('/credential')) { credentials.push({ url, body }); return json({}) }
    throw Error('unexpected '+url)
  })
  await click('[data-testid=tab-custom]')
  await setInput('[data-testid=custom-provider-id]', 'custom-a')
  await setInput('[data-testid=custom-display-name]', 'Draft display')
  await setInput('[data-testid=custom-base-url]', 'https://custom-a.fixture.invalid/v1')
  await setInput('[data-testid=custom-api-key]', 'synthetic-custom-a')
  await setInput('[data-testid=draft-model-input]', 'manual-model')
  await click('[data-testid=probe-draft-models]')
  await click('[data-testid=draft-add-model]')
  await setInput('[data-testid=custom-provider-id]', 'custom-b')

  assert.equal(document.querySelector('[data-testid=custom-api-key]').value, 'synthetic-custom-a')
  assert.equal(document.querySelector('[data-testid=custom-display-name]').value, 'Draft display')
  assert.equal(document.querySelector('[data-testid=custom-base-url]').value, 'https://custom-a.fixture.invalid/v1')
  assert.deepEqual(choiceIds(), ['from-custom-a', 'manual-model'])
  await submit()

  assert.equal(saved[0].id, 'custom-b')
  assert.equal(saved[0].displayName, 'Draft display')
  assert.equal(saved[0].baseURL, 'https://custom-a.fixture.invalid/v1')
  assert.deepEqual(saved[0].models.map(model => model.id), ['from-custom-a', 'manual-model'])
  assert.deepEqual(credentials, [{ url: '/api/llm/providers/custom-b/credential', body: { apiKey: 'synthetic-custom-a' } }])
  assert.deepEqual(probes.map(probe => probe.apiKey), ['synthetic-custom-a'])
})
test('catalogue/custom mode changes start with a clean target and same-provider clicks preserve drafts', async context => {
  const click = await mount(context, <AddProviderPanel catalog={catalog} t={key => key} />)
  await setInput('[data-testid=provider-api-key]', 'synthetic-a-credential')
  await click('[data-testid=catalog-entry][data-provider=openai]')
  assert.equal(document.querySelector('[data-testid=provider-api-key]').value, 'synthetic-a-credential')
  await click('[data-testid=tab-custom]')
  assert.equal(document.querySelector('[data-testid=custom-api-key]').value, '')
  assert.equal(document.querySelector('[data-testid=custom-base-url]').value, '')
  await setInput('[data-testid=custom-api-key]', 'synthetic-custom-credential')
  await click('[data-testid=tab-catalog]')
  assert.equal(document.querySelector('[data-testid=provider-api-key]').value, '')
})
function ReplacedDraft({ targetCatalog }) {
  const [target, change] = useState('openai')
  return <><button data-testid="replace-target" onClick={() => change('anthropic')}>replace owner</button>
    <AddProviderPanel initialCatalogEntryId={target} catalog={targetCatalog} t={key => key} /></>
}
test('a pending probe locks target controls and a late response cannot enter a replacement target', async context => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const targetCatalog = { cloud: [...catalog.cloud, { id: 'anthropic', api: 'anthropic-messages', baseURL: 'https://b.fixture.invalid/v1' }] }
  const click = await mount(context, <ReplacedDraft targetCatalog={targetCatalog} />, async () => pending)
  await click('[data-testid=probe-draft-models]')
  assert.equal(document.querySelector('[data-testid=catalog-entry][data-provider=anthropic]').disabled, true)
  assert.equal(document.querySelector('[data-testid=tab-custom]').disabled, true)
  await click('[data-testid=replace-target]')
  await act(async () => finish(json({ discovered: ['late-from-a'] })))
  assert.deepEqual(choiceIds(), [])
  assert.equal(document.querySelector('[data-testid=catalog-entry][data-provider=anthropic]').getAttribute('aria-pressed'), 'true')
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
