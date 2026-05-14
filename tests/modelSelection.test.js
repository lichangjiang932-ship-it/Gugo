import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveInitialModel } from '../src/lib/modelSelection.js'

const MODELS = [
  { name: 'deepseek-v4-pro', multiplier: 3, active: true },
  { name: 'deepseek-v4-flash', multiplier: 0.6, active: false },
]

test('keeps a previously selected model when it is still allowed', () => {
  assert.equal(resolveInitialModel(MODELS, 'deepseek-v4-flash'), 'deepseek-v4-flash')
})

test('falls back to the backend active model when stored selection is unavailable', () => {
  assert.equal(resolveInitialModel(MODELS, 'removed-model'), 'deepseek-v4-pro')
})

test('returns an empty model when backend exposes no options', () => {
  assert.equal(resolveInitialModel([], 'deepseek-v4-flash'), '')
})
