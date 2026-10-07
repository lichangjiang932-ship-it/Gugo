import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  addModel,
  listProviders,
  probeDraftModels,
  probeModels,
  removeModel,
  removeProvider,
  setCredential,
  setDefaultModel,
  upsertProvider,
} from '../server/llm/llmProviderService.js'
import { getModelProviders } from '../server/adapters/modelProviderConfig.js'

async function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'gugo-llm-service-'))
  const previous = process.env.GUGO_HOME
  process.env.GUGO_HOME = home
  try {
    return await run(process.env)
  } finally {
    if (previous === undefined) delete process.env.GUGO_HOME
    else process.env.GUGO_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test('a provider can be added from the catalogue, keyed, and read back without its key', async () => {
  withHome((env) => {
    const view = upsertProvider({ id: 'bailian', api: 'openai-completions', baseURL: 'https://example/v1', models: ['qwen3.8-max'] }, env)
    assert.equal(view.credential.configured, false)
    setCredential('bailian', 'sk-secret-123456', env)
    const listed = listProviders(env).providers.find((provider) => provider.id === 'bailian')
    assert.equal(listed.credential.configured, true)
    assert.equal(listed.credential.descriptor, 'sk-••••••3456')
    // The whole view is serialisable without the secret.
    assert.doesNotMatch(JSON.stringify(listed), /sk-secret-123456/u)
    assert.deepEqual(listed.models.map((model) => model.id), ['qwen3.8-max'])
  })
})

test('a key submitted as configuration is refused, and ids stay strict', async () => {
  withHome((env) => {
    assert.throws(() => upsertProvider({ id: 'x', apiKey: 'sk-1' }, env), /LLM_PROVIDER_KEY_IN_FORBIDDEN/u)
    assert.throws(() => upsertProvider({ id: 'Bad Id' }, env), /LLM_PROVIDER_ID_INVALID/u)
    assert.throws(() => upsertProvider({ id: 'ok', api: 'carrier-pigeon' }, env), /LLM_PROTOCOL_UNSUPPORTED/u)
  })
})

test('models and the default model are edited in place', async () => {
  withHome((env) => {
    upsertProvider({ id: 'gateway', displayName: 'Gateway', api: 'openai-completions', baseURL: 'https://gw/v1', custom: true }, env)
    addModel('gateway', 'model-a', env)
    addModel('gateway', 'model-b', env)
    addModel('gateway', 'model-a', env)
    assert.deepEqual(listProviders(env).providers[0].models.map((model) => model.id), ['model-a', 'model-b'])
    removeModel('gateway', 'model-a', env)
    assert.deepEqual(listProviders(env).providers[0].models.map((model) => model.id), ['model-b'])
    assert.deepEqual(setDefaultModel({ provider: 'gateway', model: 'model-b' }, env), { provider: 'gateway', model: 'model-b' })
    assert.deepEqual(listProviders(env).defaultModel, { provider: 'gateway', model: 'model-b' })
    assert.equal(removeProvider('gateway', env), true)
    assert.deepEqual(listProviders(env).providers, [])
    assert.deepEqual(listProviders(env).defaultModel, { provider: '', model: '' })
  })
})

test('probing merges what the endpoint serves, and scrubs the key from failures', async () => {
  withHome(async (env) => {
    upsertProvider({ id: 'gateway', api: 'openai-completions', baseURL: 'https://gw/v1', models: ['kept'] }, env)
    setCredential('gateway', 'sk-secret-abcdef', env)
    const seen = []
    const fetchImpl = async (url, options) => {
      seen.push({ url, auth: options.headers.authorization })
      return { ok: true, json: async () => ({ data: [{ id: 'kept' }, { id: 'fresh-1' }, { id: 'fresh-2' }] }) }
    }
    const result = await probeModels('gateway', { env, fetchImpl })
    assert.equal(seen[0].url, 'https://gw/v1/models')
    assert.equal(seen[0].auth, 'Bearer sk-secret-abcdef')
    assert.deepEqual(result.discovered, ['kept', 'fresh-1', 'fresh-2'])
    assert.deepEqual(result.merged, ['kept', 'fresh-1', 'fresh-2'])

    const failing = async () => { throw new Error('upstream said no to sk-secret-abcdef') }
    await assert.rejects(probeModels('gateway', { env, fetchImpl: failing }), (error) => {
      assert.doesNotMatch(error.message, /sk-secret-abcdef/u)
      assert.match(error.message, /••••••/u)
      return true
    })
  })
})

test('the add panel can probe an unsaved provider', async () => {
  const seen = []
  const fetchImpl = async (url, options) => {
    seen.push({ url, headers: options.headers })
    return { ok: true, json: async () => ({ data: [{ id: 'draft-a' }, { id: 'draft-b' }] }) }
  }
  // Anthropic speaks x-api-key; openai-compatible speaks a bearer token.
  assert.deepEqual(await probeDraftModels({ baseURL: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'k' }, { fetchImpl }),
    { discovered: ['draft-a', 'draft-b'] })
  assert.equal(seen[0].url, 'http://127.0.0.1:9/v1/models')
  assert.equal(seen[0].headers.authorization, 'Bearer k')
  await probeDraftModels({ baseURL: 'https://api.anthropic.com/v1', api: 'anthropic-messages', apiKey: 'k' }, { fetchImpl })
  assert.equal(seen[1].headers['x-api-key'], 'k')
  await assert.rejects(probeDraftModels({ baseURL: '', api: 'openai-completions' }, { fetchImpl }), /LLM_PROVIDER_URL_MISSING/u)
  await assert.rejects(probeDraftModels({ baseURL: 'https://x/v1', api: 'carrier-pigeon' }, { fetchImpl }), /LLM_PROTOCOL_UNSUPPORTED/u)
})

test('settings.yaml providers reach the model resolution path, env keeping precedence', async () => {
  withHome((env) => {
    upsertProvider({ id: 'yaml-provider', api: 'openai-completions', baseURL: 'https://yaml/v1', models: ['yaml-model'] }, env)
    setCredential('yaml-provider', 'sk-yaml-123456', env)
    const fromShared = getModelProviders({ ...env, MODEL_PROVIDERS: 'other', MODEL_PROVIDER_OTHER_BASE_URL: 'https://env/v1', MODEL_PROVIDER_OTHER_MODELS: 'env-model', MODEL_PROVIDER_OTHER_API_KEY: 'sk-env-1' })
    const yamlEntry = fromShared.find((provider) => provider.id === 'yaml-provider')
    assert.equal(yamlEntry.baseUrl, 'https://yaml/v1')
    assert.equal(yamlEntry.apiKey, 'sk-yaml-123456')
    assert.deepEqual(yamlEntry.models, ['yaml-model'])
    // env wins when both name the same provider
    const both = getModelProviders({ ...env, MODEL_PROVIDERS: 'yaml-provider', MODEL_PROVIDER_YAML_PROVIDER_BASE_URL: 'https://env-wins/v1', MODEL_PROVIDER_YAML_PROVIDER_MODELS: 'env-model', MODEL_PROVIDER_YAML_PROVIDER_API_KEY: 'sk-env-2' })
    const collision = both.filter((provider) => provider.id === 'yaml-provider')
    assert.equal(collision.length, 1)
    assert.equal(collision[0].baseUrl, 'https://env-wins/v1')
  })
})
