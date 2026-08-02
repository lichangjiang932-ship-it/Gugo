import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveInitialModel,
  resolveSessionModel,
  withSessionModel,
} from '../src/lib/modelSelection.js'

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

test('session model wins over the global and stored defaults after refresh', () => {
  assert.equal(resolveSessionModel(MODELS, {
    sessionModel: 'deepseek-v4-pro',
    selectedModel: 'deepseek-v4-flash',
    storedModel: 'deepseek-v4-flash',
  }), 'deepseek-v4-pro')
})

test('session model falls back only when it is no longer exposed by the backend', () => {
  assert.equal(resolveSessionModel(MODELS, {
    sessionModel: 'removed-model',
    selectedModel: 'deepseek-v4-flash',
  }), 'deepseek-v4-flash')
})

test('session model persistence updates only the selected session', () => {
  const sessions = [
    { id: 'pro-chat', modelName: 'deepseek-v4-flash', updatedAt: 1 },
    { id: 'flash-chat', modelName: 'deepseek-v4-flash', updatedAt: 1 },
  ]
  const updated = withSessionModel(sessions, 'pro-chat', 'deepseek-v4-pro', 99)
  assert.deepEqual(updated, [
    { id: 'pro-chat', modelName: 'deepseek-v4-pro', updatedAt: 99 },
    sessions[1],
  ])
  assert.equal(withSessionModel(updated, 'pro-chat', 'deepseek-v4-pro'), updated)
})
