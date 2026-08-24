import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OFFICIAL_MODEL_CAPABILITY_CATALOG,
  getOfficialModelProfile,
} from '../shared/modelCapabilityCatalog.js'
import { CLOUD_PRESETS } from '../src/components/modelProviders/providerConfig.js'

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
  'mimo-v2.5': [1_000_000, undefined],
  'mimo-v2.5-pro': [1_000_000, undefined],
  'glm-5': [204_800, 128_000],
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
})

test('every cloud preset has exact-model context metadata instead of a provider-wide estimate', () => {
  const presetModels = CLOUD_PRESETS.flatMap((preset) => preset.models)
  assert.equal(new Set(presetModels).size, presetModels.length, 'cloud preset model IDs stay unambiguous')
  for (const modelName of presetModels) {
    const profile = getOfficialModelProfile(modelName)
    assert.ok(profile, `${modelName} has an exact profile`)
    assert.ok(Number.isInteger(profile.contextWindow) && profile.contextWindow > 0, `${modelName} has a context window`)
    assert.equal(profile.source, 'official-catalog')
    assert.match(profile.sourceUrl, /^https:\/\//)
  }
  assert.ok(
    Object.keys(OFFICIAL_MODEL_CAPABILITY_CATALOG).length >= presetModels.length,
    'the verified catalog may also include exact models configured outside UI presets',
  )
})

test('official model catalog never guesses aliases, prefixes, or unverified dated IDs', () => {
  for (const modelName of [
    'gpt-5.6-sol-latest',
    'gemini-3.1-pro',
    'deepseek-v4-flash-9999',
    'mimo-v2.5-latest',
    'glm-5-unknown',
    'kimi-k4',
    '',
  ]) {
    assert.equal(getOfficialModelProfile(modelName), null, `${modelName || '<empty>'} must remain unverified`)
  }
})
