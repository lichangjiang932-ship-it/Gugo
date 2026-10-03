import assert from 'node:assert/strict'
import test from 'node:test'

import {
  discoverLmStudioEndpoint,
  lmStudioCatalogUrl,
  parseLmStudioCatalog,
} from '../server/adapters/lmStudioNative.js'
import { buildProviderOverrides, normalizeReadinessEntry } from '../server/services/modelProviderConfig.js'
import { getModelContextWindow } from '../server/adapters/modelRuntimeCatalog.js'
import { resolveEndpointProfile } from '../server/utils/endpointProfile.js'

const CATALOG = {
  data: [
    { id: 'prism-ml/bonsai-27b', state: 'loaded', max_context_length: 32768, loaded_context_length: 8192 },
    { id: 'qwen/qwen3.5-9b', state: 'not-loaded', max_context_length: 131072, loaded_context_length: null },
    { id: 'broken-model', state: 'loaded', max_context_length: null, loaded_context_length: null },
  ],
}

test('the served window wins over the ceiling, and a missing window is no answer', () => {
  const parsed = parseLmStudioCatalog(CATALOG)
  // A loaded model states what it serves; the ceiling is only a fallback for a
  // model LM Studio would load with its default.
  assert.deepEqual(parsed.modelProfiles['prism-ml/bonsai-27b'], {
    contextWindow: 8192,
    source: 'lmstudio-api',
    basis: 'loaded',
  })
  assert.deepEqual(parsed.modelProfiles['qwen/qwen3.5-9b'], {
    contextWindow: 131072,
    source: 'lmstudio-api',
    basis: 'ceiling',
  })
  // A model the server says nothing usable about is left out rather than guessed.
  assert.equal(parsed.modelProfiles['broken-model'], undefined)
  assert.deepEqual(parsed.models, ['prism-ml/bonsai-27b', 'qwen/qwen3.5-9b'])

  assert.deepEqual(parseLmStudioCatalog(null), { models: [], modelProfiles: {} })
  assert.deepEqual(parseLmStudioCatalog({ data: 'nope' }), { models: [], modelProfiles: {} })
})

test('the catalog is read from the origin, and only for a local endpoint', () => {
  assert.equal(lmStudioCatalogUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/api/v0/models')
  assert.equal(lmStudioCatalogUrl('http://localhost:1234/v1/'), 'http://localhost:1234/api/v0/models')

  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    return { ok: true, json: async () => CATALOG }
  }
  return (async () => {
    const found = await discoverLmStudioEndpoint({ baseUrl: 'http://127.0.0.1:1234/v1', fetchImpl })
    assert.equal(found.ok, true)
    assert.deepEqual(calls, ['http://127.0.0.1:1234/api/v0/models'])
    assert.equal(found.modelProfiles['prism-ml/bonsai-27b'].contextWindow, 8192)

    // A hosted endpoint is never asked for a local server's catalog.
    const cloud = await discoverLmStudioEndpoint({ baseUrl: 'https://api.example.com/v1', fetchImpl })
    assert.equal(cloud.ok, false)
    assert.equal(calls.length, 1)

    // A server that refuses, or answers with something else, is not an error.
    const refusing = await discoverLmStudioEndpoint({
      baseUrl: 'http://127.0.0.1:1234/v1',
      fetchImpl: async () => { throw new Error('ECONNREFUSED') },
    })
    assert.equal(refusing.ok, false)
    assert.match(refusing.error, /ECONNREFUSED/)
    const foreign = await discoverLmStudioEndpoint({
      baseUrl: 'http://127.0.0.1:8080/v1',
      fetchImpl: async () => ({ ok: true, json: async () => ({ object: 'list', data: [{ id: 'x' }] }) }),
    })
    assert.equal(foreign.ok, false, 'a bare model list is not a window report')
  })()
})

test('the observation keeps a usable window and drops anything else', () => {
  const revision = 5
  const base = { chat: true, tools: true, agent: true, mode: 'agent', checkedAt: 1789900000000, configRevision: revision }
  assert.equal(normalizeReadinessEntry({ ...base, contextWindow: 32768 }, revision).contextWindow, 32768)
  assert.equal(normalizeReadinessEntry({ ...base, contextWindow: -5 }, revision).contextWindow, undefined)
  assert.equal(normalizeReadinessEntry({ ...base, contextWindow: 12 }, revision).contextWindow, undefined)
  assert.equal(normalizeReadinessEntry({ ...base, contextWindow: 'x' }, revision).contextWindow, undefined)
})

test('a discovered window reaches compaction, and never displaces a configured one', () => {
  // What the provider test writes, projected the way a turn reads it.
  const overrides = JSON.parse(buildProviderOverrides({
    kind: 'lmstudio',
    contextWindow: null,
    modelProfiles: { 'by-hand': { contextWindow: 4096 } },
    modelReadiness: {
      'by-hand': { contextWindow: 32768, checkedAt: 1789900000000 },
      discovered: { contextWindow: 16384, checkedAt: 1789900000000 },
      silent: { checkedAt: 1789900000000 },
    },
  }))
  assert.equal(overrides.models['by-hand'].contextWindow, 4096, 'a window the reader typed is theirs')
  assert.equal(overrides.models.discovered.contextWindow, 16384)
  assert.equal(overrides.models.discovered.source, 'endpoint_discovered')
  assert.equal(overrides.models.silent, undefined, 'nothing observed, nothing claimed')

  const env = {
    MODEL_PROVIDERS: 'lm-studio',
    MODEL_PROVIDER_LM_STUDIO_LABEL: 'LM Studio',
    MODEL_PROVIDER_LM_STUDIO_BASE_URL: 'http://127.0.0.1:1234/v1',
    MODEL_PROVIDER_LM_STUDIO_MODELS: 'discovered,unknown',
    MODEL_PROVIDER_LM_STUDIO_PROFILE: JSON.stringify({ kind: 'lmstudio', ...overrides }),
    MODEL_NAME: 'discovered',
  }
  // End to end: the number the endpoint reported is what a turn will plan with.
  assert.equal(getModelContextWindow({ modelName: 'discovered', env }), 16384)
  const unknown = getModelContextWindow({ modelName: 'unknown', env })
  assert.equal(unknown, resolveEndpointProfile({
    baseUrl: 'http://127.0.0.1:1234/v1', modelName: 'unknown', env: {}, overrides: { kind: 'lmstudio' },
  }).contextWindow, 'a model nobody reported on keeps the conservative default')

  const profile = resolveEndpointProfile({
    baseUrl: 'http://127.0.0.1:1234/v1',
    modelName: 'discovered',
    env: {},
    overrides: overrides.models ? { models: overrides.models } : {},
  })
  assert.equal(profile.contextWindowSource, 'endpoint_discovered')
  assert.equal(profile.contextWindowEstimated, false, 'an observation outranks the local default')
})

test('the catalog is read over real HTTP, the way the settings probe does it', async () => {
  const { createServer } = await import('node:http')
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(CATALOG))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const found = await discoverLmStudioEndpoint({ baseUrl: `http://127.0.0.1:${port}/v1` })
    assert.equal(found.ok, true)
    assert.deepEqual(seen, ['/api/v0/models'])
    assert.equal(found.modelProfiles['prism-ml/bonsai-27b'].contextWindow, 8192)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
