import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { CLOUD_PRESETS, LOCAL_PRESETS, formatContextTokens } from '../src/components/modelProviders/providerConfig.js'

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
    assert.ok(Number.isFinite(preset.contextWindow) && preset.contextWindow > 0, `${preset.id} has a contextWindow`)
    for (const key of ['supportsTools', 'supportsStreaming', 'supportsVision', 'supportsPdf']) {
      assert.ok(['0', '1'].includes(preset.caps?.[key]), `${preset.id} caps.${key} is 0/1`)
    }
    assert.ok(Array.isArray(preset.models) && preset.models.length > 0, `${preset.id} has models`)
  }
})

test('mainstream cloud presets default to the real 1M context window', () => {
  const million = CLOUD_PRESETS.filter((preset) => preset.contextWindow >= 1000000)
  assert.ok(million.length >= 10, `expected most presets at 1M, got ${million.length}`)
  for (const id of ['openai', 'anthropic', 'gemini', 'deepseek', 'openrouter', 'qwen', 'siliconflow', 'moonshot', 'zhipu', 'xai']) {
    assert.ok(million.some((preset) => preset.id === id), `${id} should be 1M`)
  }
})

test('formatContextTokens renders compact sizes', () => {
  assert.equal(formatContextTokens(128000), '128K')
  assert.equal(formatContextTokens(1000000), '1M')
  assert.equal(formatContextTokens(200000), '200K')
  assert.equal(formatContextTokens(''), '')
  assert.equal(formatContextTokens(0), '')
  assert.equal(formatContextTokens(undefined), '')
})
