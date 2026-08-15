import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OFFICIAL_MODEL_CAPABILITY_CATALOG,
  getOfficialModelProfile,
} from '../shared/modelCapabilityCatalog.js'

const EXPECTED_MODELS = {
  'gpt-5.6-sol': [1_050_000, 128_000],
  'gpt-5.6-terra': [1_050_000, 128_000],
  'gpt-5.6-luna': [1_050_000, 128_000],
  'claude-opus-4-8': [1_000_000, 128_000],
  'claude-sonnet-4-6': [1_000_000, 128_000],
  'claude-haiku-4-5': [200_000, 64_000],
  'gemini-3.6-flash': [1_048_576, 65_536],
  'gemini-3.5-flash': [1_048_576, 65_536],
  'gemini-3.1-pro-preview': [1_048_576, 65_536],
  'deepseek-v4-flash': [1_000_000, 384_000],
  'deepseek-v4-pro': [1_000_000, 384_000],
  'glm-5': [200_000, 128_000],
}

test('official model catalog stores verified exact-model limits and provenance', () => {
  for (const [modelName, [contextWindow, maxOutputTokens]] of Object.entries(EXPECTED_MODELS)) {
    const profile = getOfficialModelProfile(modelName)
    assert.ok(profile, `${modelName} is cataloged`)
    assert.equal(profile.contextWindow, contextWindow)
    assert.equal(profile.maxOutputTokens, maxOutputTokens)
    assert.equal(profile.source, 'official-catalog')
    assert.equal(profile.verifiedAt, '2026-08-15')
    assert.match(profile.sourceUrl, /^https:\/\//)
  }
  assert.equal(Object.keys(OFFICIAL_MODEL_CAPABILITY_CATALOG).length, Object.keys(EXPECTED_MODELS).length)
})

test('official model catalog never guesses aliases, prefixes, or unverified dated IDs', () => {
  for (const modelName of [
    'gpt-5.6-sol-latest',
    'openai/gpt-5.6-sol',
    'gemini-3.1-pro',
    'deepseek-v4-flash-0731',
    'glm-5-flash',
    'kimi-k3',
    '',
  ]) {
    assert.equal(getOfficialModelProfile(modelName), null, `${modelName || '<empty>'} must remain unverified`)
  }
})
