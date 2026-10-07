import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSnapshot,
  compactModel,
  compactProvider,
  isUsableSnapshot,
} from '../shared/modelCatalogSnapshot.js'
import {
  catalogIdForPreset,
  catalogModelIds,
  catalogProvider,
  catalogStatus,
  currentCatalog,
  listCatalogProviders,
  refreshCatalog,
  resetCatalogCache,
} from '../server/services/modelCatalogService.js'

const UPSTREAM = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    env: ['OPENAI_API_KEY'],
    doc: 'https://platform.openai.com/docs/models',
    models: {
      'gpt-old': { id: 'gpt-old', name: 'Old', tool_call: true, release_date: '2024-01-01', limit: { context: 1000, output: 0 }, status: 'deprecated' },
      'gpt-new': {
        id: 'gpt-new', name: 'New', tool_call: true, reasoning: true, release_date: '2026-05-05',
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        limit: { context: 400000, output: 128000 }, cost: { input: 1.5, output: 6 },
      },
    },
  },
  google: { id: 'google', name: 'Google', models: { 'gemini-x': { id: 'gemini-x', tool_call: true, release_date: '2026-01-01', limit: { context: 1000000 } } } },
  alibaba: { id: 'alibaba', name: 'Alibaba', models: { 'qwen-x': { id: 'qwen-x', tool_call: true, release_date: '2026-01-01', limit: { context: 200000 } } } },
  empty: { id: 'empty', name: 'Empty', models: {} },
}

test('a compacted model keeps what the picker reads and normalises absent limits', () => {
  const model = compactModel(UPSTREAM.openai.models['gpt-new'], 'gpt-new')
  assert.deepEqual(model, {
    id: 'gpt-new',
    name: 'New',
    context: 400000,
    output: 128000,
    tools: true,
    vision: true,
    pdf: true,
    reasoning: true,
    released: '2026-05-05',
    cost: { input: 1.5, output: 6 },
  })
})

test('an upstream output limit of 0 becomes 0 rather than a missing key', () => {
  const model = compactModel({ id: 'm', name: 'M', limit: { context: 500 } }, 'm')
  assert.equal(model.output, 0)
  assert.equal(model.context, 500)
})

test('a deprecated model is carried but flagged, so a retired id stays selectable', () => {
  const model = compactModel(UPSTREAM.openai.models['gpt-old'], 'gpt-old')
  assert.equal(model.deprecated, true)
  assert.equal(model.released, '2024-01-01')
})

test('a model with no usable id is dropped instead of producing an empty entry', () => {
  assert.equal(compactModel(null, ''), null)
  assert.equal(compactModel({}, ''), null)
  assert.equal(compactModel({ name: 'nameless' }, '   '), null)
})

test('a provider with no models is dropped: there would be nothing to configure', () => {
  assert.equal(compactProvider(UPSTREAM.empty, 'empty'), null)
  assert.equal(compactProvider(null, 'x'), null)
})

test('provider models are ordered newest first, with id order as the tie-break', () => {
  const provider = compactProvider({
    id: 'p',
    models: {
      'same-b': { id: 'same-b', release_date: '2026-01-01' },
      'same-a': { id: 'same-a', release_date: '2026-01-01' },
      newest: { id: 'newest', release_date: '2026-09-09' },
      undated: { id: 'undated' },
    },
  }, 'p')
  // A refresh must not reshuffle a list the reader is looking at, and undated
  // entries must not jump ahead of dated ones.
  assert.deepEqual(provider.models.map((model) => model.id), ['newest', 'same-a', 'same-b', 'undated'])
})

test('buildSnapshot reports counts and sorts providers by id', () => {
  const snapshot = buildSnapshot(UPSTREAM, { now: new Date('2026-10-07T00:00:00Z') })
  assert.equal(snapshot.schemaVersion, 1)
  assert.equal(snapshot.generatedAt, '2026-10-07')
  assert.deepEqual(snapshot.providers.map((provider) => provider.id), ['alibaba', 'google', 'openai'])
  assert.equal(snapshot.providerCount, 3)
  assert.equal(snapshot.modelCount, 4)
  assert.equal(snapshot.source, 'https://models.dev/api.json')
})

test('buildSnapshot refuses input that would produce an empty catalogue', () => {
  assert.throws(() => buildSnapshot(null), /keyed by provider id/)
  assert.throws(() => buildSnapshot([]), /keyed by provider id/)
  assert.throws(() => buildSnapshot({ only: { id: 'only', models: {} } }), /no usable providers/)
})

test('isUsableSnapshot rejects the shapes a hostile or changed upstream could send', () => {
  const good = buildSnapshot(UPSTREAM)
  assert.equal(isUsableSnapshot(good), true)
  assert.equal(isUsableSnapshot(null), false)
  assert.equal(isUsableSnapshot([]), false)
  assert.equal(isUsableSnapshot('{}'), false)
  assert.equal(isUsableSnapshot({ schemaVersion: 2, providers: good.providers }), false)
  assert.equal(isUsableSnapshot({ schemaVersion: 1, providers: [] }), false)
  assert.equal(isUsableSnapshot({ schemaVersion: 1, providers: [{ id: 'x' }] }), false)
  assert.equal(isUsableSnapshot({ schemaVersion: 1, providers: [{ id: 'x', models: [] }] }), false)
  assert.equal(isUsableSnapshot({ schemaVersion: 1, providers: [{ id: 'x', models: [{ name: 'no id' }] }] }), false)
})

test('this app preset ids resolve to the catalogue ids that key them upstream', () => {
  assert.equal(catalogIdForPreset('gemini'), 'google')
  assert.equal(catalogIdForPreset('qwen'), 'alibaba')
  assert.equal(catalogIdForPreset('moonshot'), 'moonshotai')
  assert.equal(catalogIdForPreset('zhipu'), 'zhipuai')
  assert.equal(catalogIdForPreset('openai'), 'openai')
  assert.equal(catalogIdForPreset('  xai  '), 'xai')
  assert.equal(catalogIdForPreset(''), '')
})

test('the bundled snapshot is present, validates, and covers the shipped presets', () => {
  resetCatalogCache()
  const catalog = currentCatalog()
  assert.ok(catalog, 'shared/modelCatalogSnapshot.json must exist and validate')
  assert.equal(isUsableSnapshot(catalog), true)
  assert.ok(catalog.providers.length > 100, `expected a broad catalogue, got ${catalog.providers.length}`)
  const ids = new Set(catalog.providers.map((provider) => provider.id))
  // The ids from the settings screenshots, which had no bundled preset at all.
  for (const id of ['amazon-bedrock', 'cerebras', 'baseten', 'github-copilot', 'google-vertex', 'minimax-cn']) {
    assert.ok(ids.has(id), `catalogue is missing ${id}`)
  }
  for (const preset of ['openai', 'anthropic', 'google', 'deepseek', 'xai', 'groq', 'mistral', 'openrouter', 'moonshotai']) {
    assert.ok(ids.has(preset), `catalogue is missing ${preset}`)
  }
})

test('model ids come back newest first and can include retired ones on request', () => {
  resetCatalogCache()
  const ids = catalogModelIds('deepseek')
  assert.ok(ids.length > 0, 'the bundled catalogue must know DeepSeek models')
  // Newest first: the first id must not be older than the last one.
  const released = catalogProvider('deepseek').models.map((model) => model.released || '')
  assert.ok(
    released.filter(Boolean).length === 0 || released[0] >= released[released.length - 1],
    'the model list must be ordered newest first',
  )
  const withDeprecated = catalogModelIds('openai', { includeDeprecated: true })
  const withoutDeprecated = catalogModelIds('openai')
  assert.ok(withDeprecated.length >= withoutDeprecated.length)
})

test('an unknown provider yields no models instead of throwing', () => {
  resetCatalogCache()
  assert.equal(catalogProvider('definitely-not-a-provider'), null)
  assert.deepEqual(catalogModelIds('definitely-not-a-provider'), [])
})

test('provider search matches id and display name', () => {
  resetCatalogCache()
  const all = listCatalogProviders()
  assert.ok(all.length > 0)
  const matched = listCatalogProviders({ query: 'bedrock' })
  assert.ok(matched.some((provider) => provider.id === 'amazon-bedrock'))
  for (const provider of matched) {
    const haystack = `${provider.id} ${provider.name}`.toLowerCase()
    assert.ok(haystack.includes('bedrock'))
  }
  assert.ok(matched.every((provider) => typeof provider.modelCount === 'number'))
})

test('a refresh that fails leaves the previous catalogue in place and reports why', async () => {
  resetCatalogCache()
  const before = currentCatalog()
  const status = await refreshCatalog({
    fetchImpl: async () => { throw new Error('offline') },
  })
  assert.equal(status.error, 'offline')
  assert.equal(status.source, 'bundled')
  assert.equal(currentCatalog(), before, 'a failed refresh must not discard the catalogue in use')
})

test('a refresh that returns a non-OK response is reported, not thrown', async () => {
  resetCatalogCache()
  const status = await refreshCatalog({
    fetchImpl: async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => '' }),
  })
  assert.match(status.error, /503/)
  assert.equal(currentCatalog() !== null, true)
})

test('a refresh that returns a malformed catalogue is rejected rather than adopted', async () => {
  resetCatalogCache()
  const before = currentCatalog()
  for (const body of ['{"schemaVersion":9,"providers":[{"id":"x","models":[{"id":"y"}]}]}', '{"providers":[]}', 'not json']) {
    const status = await refreshCatalog({
      fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body }),
    })
    assert.ok(status.error, `expected ${body.slice(0, 24)} to be rejected`)
    assert.equal(currentCatalog(), before)
  }
})

test('a valid refresh is adopted and reported as coming from models.dev', async () => {
  resetCatalogCache()
  const status = await refreshCatalog({
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(UPSTREAM) }),
    now: 1_800_000_000_000,
  })
  assert.equal(status.error, '')
  assert.equal(status.source, 'models.dev')
  assert.equal(status.refreshedAt, 1_800_000_000_000)
  assert.equal(status.providers, 3)
  assert.deepEqual(catalogModelIds('openai'), ['gpt-new'])
  // The alias still applies after a refresh.
  assert.deepEqual(catalogModelIds('gemini'), ['gemini-x'])
  resetCatalogCache()
})

test('an oversized catalogue is refused before it is parsed into memory', async () => {
  resetCatalogCache()
  const status = await refreshCatalog({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'content-length' ? String(64 * 1024 * 1024) : null) },
      text: async () => '{}',
    }),
  })
  assert.match(status.error, /larger than this app will accept/)
})

test('catalogStatus describes the bundled baseline on a fresh process', () => {
  resetCatalogCache()
  const status = catalogStatus()
  assert.equal(status.available, true)
  assert.equal(status.source, 'bundled')
  assert.equal(status.error, '')
  assert.ok(status.providers > 100)
  assert.ok(status.models > 1000)
  assert.match(status.generatedAt, /^\d{4}-\d{2}-\d{2}$/)
})
