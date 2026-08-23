import test from 'node:test'
import assert from 'node:assert/strict'

import {
  readStoredModelSelection,
  resolveInitialModel,
  resolveInitialModelSelection,
  resolveSessionModel,
  resolveSessionModelSelection,
  withSessionModel,
  withSessionModelSelection,
  writeStoredModelSelection,
} from '../src/lib/modelSelection.js'

const MODELS = [
  { name: 'deepseek-v4-pro', active: true },
  { name: 'deepseek-v4-flash', active: false },
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

test('same-name models preserve their provider identity across selection and session persistence', () => {
  const duplicateModels = [
    { name: 'shared-model', provider: 'alpha', active: true },
    { name: 'shared-model', provider: 'beta', active: false },
  ]
  const selected = resolveInitialModelSelection(duplicateModels, {
    modelName: 'shared-model',
    providerId: 'beta',
  })
  assert.deepEqual(selected, { modelName: 'shared-model', providerId: 'beta' })
  assert.deepEqual(resolveSessionModelSelection(duplicateModels, {
    sessionModel: 'shared-model',
    sessionProviderId: 'beta',
    selectedModel: 'shared-model',
    selectedProviderId: 'alpha',
  }), selected)
  assert.deepEqual(withSessionModelSelection(
    [{ id: 'chat', modelName: 'shared-model', modelProviderId: 'alpha', updatedAt: 1 }],
    'chat',
    selected,
    2,
  ), [{ id: 'chat', modelName: 'shared-model', modelProviderId: 'beta', updatedAt: 2 }])

  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
  writeStoredModelSelection(selected, storage)
  assert.deepEqual(readStoredModelSelection(storage), selected)
})
