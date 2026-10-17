import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { bundledModelContextWindow, indexBundledCatalog, resetBundledModelCatalog } from '../server/llm/bundledModelCatalog.js'
import { modelRuntimeProfiles } from '../server/llm/modelRuntimeProfiles.js'
import { getVisibleModels } from '../server/adapters/modelRuntimeCatalog.js'
import { resolveEndpointProfile } from '../server/utils/endpointProfile.js'

function emptyHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'gugo-bundled-model-'))
  return { home, env: { GUGO_HOME: home } }
}

function writeCache(home, models) {
  mkdirSync(home, { recursive: true })
  writeFileSync(path.join(home, 'models-dev.cache.json'), JSON.stringify({ fetchedAt: Date.now(), models }), 'utf8')
}

test('the bundled catalogue resolves a provider entry and a globally consistent model id', () => {
  resetBundledModelCatalog()
  assert.equal(bundledModelContextWindow('gpt-6-luna', { providerId: 'openai' }), 1_050_000)
  assert.equal(bundledModelContextWindow('gpt-6-luna', { providerId: 'unknown-provider' }), 1_050_000)
  // A custom Provider key is not a catalogue id; the model id still resolves.
  assert.equal(bundledModelContextWindow('mimo-v2.6-flash', {
    providerId: '36aeaa37-dd2f-4c0b-a631-147fb2935ed0',
  }), 1_048_576)
  assert.equal(bundledModelContextWindow('not-a-real-model-xyz'), null)
})

test('provider-specific and conflicting entries are not guessed', () => {
  const catalog = {
    providers: [
      { id: 'one', models: [{ id: 'shared', context: 1000 }, { id: 'only-one', context: 32000 }] },
      { id: 'two', models: [{ id: 'shared', context: 2000 }] },
      { id: 'three', models: [{ id: 'same', context: 64000 }] },
      { id: 'four', models: [{ id: 'same', context: 64000 }] },
    ],
  }
  const index = indexBundledCatalog(catalog)
  assert.equal(index.byProvider.get('one').get('shared'), 1000)
  assert.equal(bundledModelContextWindow('shared', { providerId: 'one', catalog }), 1000)
  assert.equal(bundledModelContextWindow('shared', { catalog }), null, 'providers disagree')
  assert.equal(bundledModelContextWindow('only-one', { catalog }), 32000)
  assert.equal(bundledModelContextWindow('same', { catalog }), 64000)
})

test('explicit model settings outrank models.dev, which outranks the bundled catalogue', () => {
  const { home, env } = emptyHome()
  try {
    resetBundledModelCatalog()
    writeCache(home, {})
    const bundled = modelRuntimeProfiles([{ id: 'gpt-6-luna' }], env, 'openai')['gpt-6-luna']
    assert.equal(bundled.contextWindow, 1_050_000)
    assert.equal(bundled.source, 'bundled_catalog')
    assert.equal(bundled.contextWindowEstimated, true)

    const customProvider = modelRuntimeProfiles([{ id: 'mimo-v2.6-flash' }], env, '36aeaa37-dd2f-4c0b-a631-147fb2935ed0')['mimo-v2.6-flash']
    assert.equal(customProvider.contextWindow, 1_048_576)

    writeCache(home, { 'gpt-6-luna': { contextWindow: 900_000 } })
    const cached = modelRuntimeProfiles([{ id: 'gpt-6-luna' }], env, 'openai')['gpt-6-luna']
    assert.equal(cached.contextWindow, 900_000)
    assert.equal(cached.source, 'models.dev')
    assert.notEqual(cached.contextWindowEstimated, true)

    const explicit = modelRuntimeProfiles([{
      id: 'gpt-6-luna',
      contextWindow: 500_000,
      contextWindowSource: 'provider_override',
    }], env, 'openai')['gpt-6-luna']
    assert.equal(explicit.contextWindow, 500_000)
    assert.equal(explicit.source, 'provider_override')
  } finally {
    resetBundledModelCatalog()
    rmSync(home, { recursive: true, force: true })
  }
})

test('the endpoint profile marks a bundled window as estimated rather than exact', () => {
  const profile = resolveEndpointProfile({
    baseUrl: 'https://api.example.com/v1',
    modelName: 'gpt-6-luna',
    overrides: {},
    modelProfiles: {
      'gpt-6-luna': { contextWindow: 1_050_000, source: 'bundled_catalog', contextWindowEstimated: true },
    },
  })
  assert.equal(profile.contextWindow, 1_050_000)
  assert.equal(profile.contextWindowSource, 'bundled_catalog')
  assert.equal(profile.contextWindowEstimated, true)
})

test('an explicit per-model override still wins over generated catalogue metadata', () => {
  const profile = resolveEndpointProfile({
    baseUrl: 'https://api.example.com/v1',
    modelName: 'gpt-6-luna',
    overrides: { models: { 'gpt-6-luna': { contextWindow: 500_000, supportsTools: false } } },
    modelProfiles: {
      'gpt-6-luna': {
        contextWindow: 1_050_000,
        source: 'bundled_catalog',
        contextWindowEstimated: true,
        catalogOnly: true,
      },
    },
  })
  assert.equal(profile.contextWindow, 500_000)
  assert.equal(profile.contextWindowSource, 'provider_override')
  assert.equal(profile.contextWindowEstimated, false)
  assert.equal(profile.supportsTools, false)
})

test('the visible model catalogue carries the bundled window and its estimated provenance', () => {
  const { home, env } = emptyHome()
  try {
    resetBundledModelCatalog()
    writeCache(home, {})
    const models = getVisibleModels({
      ...env,
      MODEL_PROVIDERS: 'openai',
      MODEL_PROVIDER_OPENAI_BASE_URL: 'https://api.openai.com/v1',
      MODEL_PROVIDER_OPENAI_MODELS: 'gpt-6-luna',
    }, 'gpt-6-luna', 'openai')
    const model = models.find((entry) => entry.name === 'gpt-6-luna')
    assert.equal(model.contextWindow, 1_050_000)
    assert.equal(model.contextWindowSource, 'bundled_catalog')
    assert.equal(model.contextWindowEstimated, true)
  } finally {
    resetBundledModelCatalog()
    rmSync(home, { recursive: true, force: true })
  }
})
