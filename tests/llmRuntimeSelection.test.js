import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { upsertProvider, setCredential, setDefaultModel, probeModels, listProviders } from '../server/llm/llmProviderService.js'
import { getModelStatus, getModelContextWindow } from '../server/adapters/modelRuntimeCatalog.js'
import { resolveModelConfigForModel } from '../server/adapters/modelProviderConfig.js'
import { buildModelProviderRequest } from '../server/adapters/modelRequestBuilder.js'

function fixture(context) {
  const home = mkdtempSync(join(tmpdir(), 'gugo-model-choice-'))
  context.after(() => rmSync(home, { recursive: true, force: true }))
  return { GUGO_HOME: home }
}
test('saved model selection reaches status, endpoint binding and the effective context window', context => {
  const env = fixture(context)
  upsertProvider({ id: 'gateway', api: 'anthropic-messages', baseURL: 'https://fixture.invalid/v1', models: [
    { id: 'chosen', contextWindow: 10000 }, { id: 'unchecked', enabled: false, contextWindow: 20000 },
  ] }, env)
  setCredential('gateway', 'synthetic-fixture-token', env)
  const status = getModelStatus(env)
  assert.equal(status.configured, true)
  assert.deepEqual(status.models.map(model => model.name), ['chosen'])
  assert.equal(status.models[0].contextWindow, 10000)
  assert.equal(status.models[0].contextWindowEstimated, false)
  const config = resolveModelConfigForModel({ modelName: 'chosen', providerId: 'gateway', env })
  assert.equal(config.baseUrl, 'https://fixture.invalid/v1')
  assert.equal(config.profileOverrides.kind, 'anthropic')
  assert.equal(getModelContextWindow({ modelName: 'chosen', modelProviderId: 'gateway', env }), 10000)
  const request = buildModelProviderRequest({ config, messages: [{ role: 'user', content: 'offline fixture' }], stream: false, env })
  assert.match(request.url, /\/messages$/)
  assert.equal(resolveModelConfigForModel({ modelName: 'unchecked', providerId: 'gateway', env }).configured, false)
})
test('provider-only edits retain protocol and unselected candidates; probing does not re-enable them', async context => {
  const env = fixture(context)
  upsertProvider({ id: 'gateway', api: 'anthropic-messages', baseURL: 'https://fixture.invalid/v1', models: [{ id: 'kept', enabled: false }] }, env)
  await probeModels('gateway', { env, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'kept' }, { id: 'new' }] }) }) })
  const provider = listProviders(env).providers[0]
  assert.equal(provider.api, 'anthropic-messages')
  assert.equal(provider.models.find(model => model.id === 'kept').enabled, false)
})
test('the saved default binds the correct provider even when model names collide', context => {
  const env = fixture(context)
  for (const id of ['first', 'second']) {
    upsertProvider({ id, baseURL: `https://${id}.invalid/v1`, models: ['same'] }, env)
    setCredential(id, 'synthetic-fixture-token', env)
  }
  setDefaultModel({ provider: 'second', model: 'same' }, env)
  assert.equal(getModelStatus(env).models.find(model => model.active).provider, 'second')
  upsertProvider({ id: 'second', models: [{ id: 'same', enabled: false }] }, env)
  assert.deepEqual(listProviders(env).defaultModel, { provider: '', model: '' })
  assert.throws(() => setDefaultModel({ provider: 'second', model: 'same' }, env), /LLM_DEFAULT_MODEL_INVALID/)
})
test('select none stays empty instead of being replaced by preset defaults', context => {
  const env = fixture(context)
  upsertProvider({ id: 'openai', models: [{ id: 'disabled', enabled: false }] }, env)
  setCredential('openai', 'synthetic-fixture-token', env)
  assert.equal(getModelStatus(env).configured, false)
  assert.equal(getModelStatus(env).models?.length || 0, 0)
})
test('an incomplete earlier provider does not hide a later usable model', context => {
  const env = fixture(context)
  upsertProvider({ id: 'unfinished', baseURL: '', models: ['unfinished'] }, env)
  upsertProvider({ id: 'ready', baseURL: 'https://ready.invalid/v1', models: ['usable'] }, env)
  setCredential('ready', 'synthetic-fixture-token', env)
  const status = getModelStatus(env)
  assert.equal(status.configured, true)
  assert.ok(status.models.some(model => model.name === 'usable'))
})
test('discovered model limits survive saving and reach the effective runtime window', async context => {
  const env = fixture(context)
  upsertProvider({ id: 'gateway', baseURL: 'https://fixture.invalid/v1', models: [] }, env)
  setCredential('gateway', 'synthetic-fixture-token', env)
  await probeModels('gateway', { env, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'discovered', context_length: 10000 }] }) }) })
  assert.equal(getModelStatus(env).models[0].contextWindow, 10000)
  assert.equal(getModelContextWindow({ modelName: 'discovered', modelProviderId: 'gateway', env }), 10000)
})
test('normal startup reads the same default home as model settings without requiring GUGO_HOME', context => {
  const home = fixture(context).GUGO_HOME
  const service = new URL('../server/llm/llmProviderService.js', import.meta.url).href
  const runtime = new URL('../server/adapters/modelRuntimeCatalog.js', import.meta.url).href
  const script = `import{upsertProvider,setCredential}from ${JSON.stringify(service)};import{getModelStatus}from ${JSON.stringify(runtime)};upsertProvider({id:'fixture',baseURL:'https://fixture.invalid/v1',models:['saved']});setCredential('fixture','synthetic-fixture-token');const s=getModelStatus();if(!s.configured||s.models?.[0]?.name!=='saved')throw Error('default-home model is invisible')`
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home, USERPROFILE: home, GUGO_HOME: '' }, stdio: 'pipe' })
})
