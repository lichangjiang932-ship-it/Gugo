import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { CLOUD_PRESETS, LOCAL_PRESETS, formatContextTokens } from '../src/components/modelProviders/providerConfig.js'
import { getOfficialModelProfile } from '../shared/modelCapabilityCatalog.js'

const source = fs.readFileSync(new URL('../src/components/modelProviders/providerConfig.js', import.meta.url), 'utf8')

test('verified DeepSeek and Qwen presets use current official API model IDs', () => {
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-flash-0731', 'deepseek-v4-pro']) {
    assert.match(source, new RegExp(`['"]${model}['"]`))
  }
  for (const model of ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-flash']) {
    assert.match(source, new RegExp(`['"]${model.replace('.', '\\.')}['"]`))
  }
  assert.doesNotMatch(source, /qwen3\.5-(?:max|plus|flash)/)
  assert.doesNotMatch(source, /models:\s*\['deepseek-v4',/)
})

test('every preset ships defaults so users only paste an API key', () => {
  for (const preset of [...CLOUD_PRESETS, ...LOCAL_PRESETS]) {
    assert.ok(preset.baseUrl, `${preset.id} has a baseUrl`)
    if (preset.local) continue
    for (const key of ['supportsTools', 'supportsStreaming', 'supportsVision', 'supportsPdf']) {
      assert.ok(['0', '1'].includes(preset.caps?.[key]), `${preset.id} caps.${key} is 0/1`)
    }
    assert.ok(Array.isArray(preset.models) && preset.models.length > 0, `${preset.id} has models`)
  }
})

test('cloud presets never impose a provider-wide context window', () => {
  for (const preset of CLOUD_PRESETS) {
    assert.equal('contextWindow' in preset, false, `${preset.id} must use exact-model metadata`)
  }
})

test('Gemini and Moonshot presets use current exact IDs while preserving labeled legacy IDs', () => {
  const gemini = CLOUD_PRESETS.find((preset) => preset.id === 'gemini')
  assert.ok(gemini.models.includes('gemini-3.1-pro-preview'))
  assert.ok(!gemini.models.includes('gemini-3.1-pro'))

  const moonshot = CLOUD_PRESETS.find((preset) => preset.id === 'moonshot')
  assert.deepEqual(moonshot.models.slice(0, 2), ['kimi-k3', 'kimi-k2.6'])
  assert.deepEqual(moonshot.legacyModels, ['kimi-k2.5', 'kimi-k2-thinking', 'moonshot-v1-128k'])
  for (const model of moonshot.legacyModels) assert.ok(moonshot.models.includes(model))
})

test('OpenRouter and xAI presets use current exact IDs with model-specific context profiles', () => {
  const openrouter = CLOUD_PRESETS.find((preset) => preset.id === 'openrouter')
  assert.ok(openrouter.models.includes('google/gemini-3.1-pro-preview'))
  assert.ok(!openrouter.models.includes('google/gemini-3.1-pro'))

  const xai = CLOUD_PRESETS.find((preset) => preset.id === 'xai')
  assert.deepEqual(xai.models, ['grok-4.6', 'grok-4.5', 'grok-4.3'])
  assert.deepEqual(xai.models.map((model) => getOfficialModelProfile(model).contextWindow), [500_000, 500_000, 1_000_000])
})

test('formatContextTokens renders compact sizes', () => {
  assert.equal(formatContextTokens(128000), '128K')
  assert.equal(formatContextTokens(1000000), '1M')
  assert.equal(formatContextTokens(200000), '200K')
  assert.equal(formatContextTokens(''), '')
  assert.equal(formatContextTokens(0), '')
  assert.equal(formatContextTokens(undefined), '')
})
