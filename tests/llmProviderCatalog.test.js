import assert from 'node:assert/strict'
import test from 'node:test'

import {
  catalogEntry,
  isSupportedProtocol,
  isValidProviderId,
  LLM_PROTOCOL_IDS,
  LOCAL_PROVIDER_PRESETS,
  presetProviderConfig,
  PROVIDER_CATALOG,
} from '../shared/llmProviderCatalog.js'

test('the catalogue is what the picker shows: twelve services plus the local runtimes', () => {
  const names = PROVIDER_CATALOG.map((entry) => entry.displayName)
  for (const expected of ['OpenAI', 'Anthropic Claude', 'Google Gemini', 'DeepSeek', 'OpenRouter', '阿里云通义千问',
    '硅基流动', 'Moonshot Kimi', '智谱 GLM', 'xAI Grok', 'Groq', 'Mistral AI']) {
    assert.ok(names.includes(expected), `${expected} is offered`)
  }
  assert.deepEqual(LOCAL_PROVIDER_PRESETS.map((entry) => entry.id), ['ollama', 'lmstudio', 'llamacpp', 'vllm'])
  // Every entry names a protocol the adapter table actually implements.
  for (const entry of [...PROVIDER_CATALOG, ...LOCAL_PROVIDER_PRESETS]) {
    assert.ok(isSupportedProtocol(entry.api), `${entry.id} → ${entry.api}`)
  }
  assert.ok(LLM_PROTOCOL_IDS.includes('anthropic-messages'))
})

test('a catalogue entry carries an endpoint and a key *name*, never a key', () => {
  for (const entry of PROVIDER_CATALOG) {
    assert.match(entry.baseURL, /^https:\/\//u)
    assert.match(entry.apiKeyEnv, /^[A-Z0-9_]+$/u)
    assert.equal(Object.hasOwn(entry, 'apiKey'), false)
    assert.ok(entry.models.length > 0)
  }
})

test('provider ids are the strict shape the credential name derives from', () => {
  for (const valid of ['openai', 'bailian', 'my-gateway-2']) assert.equal(isValidProviderId(valid), true, valid)
  for (const invalid of ['OpenAI', '1gateway', 'gate way', '-leading', 'x'.repeat(41), '']) {
    assert.equal(isValidProviderId(invalid), false, invalid)
  }
})

test('picking a catalogue entry pre-fills the settings shape', () => {
  const config = presetProviderConfig('deepseek')
  assert.equal(config.displayName, 'DeepSeek')
  assert.equal(config.api, 'openai-completions')
  assert.equal(config.baseURL, 'https://api.deepseek.com/v1')
  assert.equal(config.apiKeyEnv, 'DEEPSEEK_API_KEY')
  assert.deepEqual(config.models.map((model) => model.id), ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'])
  assert.equal(presetProviderConfig('nope'), null)
  assert.equal(catalogEntry('OpenAI').id, 'openai')
})
