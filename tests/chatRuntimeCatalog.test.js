import assert from 'node:assert/strict'
import test from 'node:test'

import { modelOptionsFromStatus } from '../src/pages/ChatSplit/useChatRuntimeCatalog.js'

test('single-model status keeps resolved context metadata', () => {
  assert.deepEqual(modelOptionsFromStatus({
    modelName: 'local-model',
    contextWindow: 8_192,
    contextWindowSource: 'provider_override',
    contextWindowEstimated: false,
    contextWindowSourceUrl: 'https://example.com/models/local-model',
    contextWindowVerifiedAt: '2026-08-15',
    maxOutputTokens: 2_048,
  }), [{
    name: 'local-model',
    active: true,
    contextWindow: 8_192,
    contextWindowSource: 'provider_override',
    contextWindowEstimated: false,
    contextWindowSourceUrl: 'https://example.com/models/local-model',
    contextWindowVerifiedAt: '2026-08-15',
    maxOutputTokens: 2_048,
  }])
})

test('multi-model status preserves the server catalog unchanged', () => {
  const models = [
    { name: 'small', contextWindow: 8_192, contextWindowSource: 'catalog' },
    { name: 'large', contextWindow: 262_144, contextWindowSource: 'catalog' },
  ]

  assert.strictEqual(modelOptionsFromStatus({ modelName: 'small', models }), models)
})
