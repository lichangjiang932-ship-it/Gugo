import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

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
