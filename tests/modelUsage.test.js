import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateModelCostUsd } from '../server/adapters/modelUsage.js'
import { resolveEndpointProfile } from '../server/utils/endpointProfile.js'

test('provider token rates calculate optional local upstream-cost telemetry', () => {
  const cost = calculateModelCostUsd({
    modelName: 'deepseek-v4-flash',
    usage: { promptTokens: 2_000_000, completionTokens: 500_000 },
    env: {
      MODEL_USD_RATES: JSON.stringify({
        'deepseek-v4-flash': { input: 0.1, output: 0.4 },
      }),
    },
  })
  assert.equal(cost, 0.4)
})

test('missing or incomplete cost evidence stays unknown while explicit zero rates remain measured', () => {
  const usage = { promptTokens: 1_000, completionTokens: 500 }
  assert.equal(calculateModelCostUsd({ modelName: 'missing', usage, env: {} }), null)
  assert.equal(calculateModelCostUsd({
    modelName: 'local-model',
    usage,
    env: { MODEL_USD_RATES: '{invalid-json' },
  }), null)
  assert.equal(calculateModelCostUsd({
    modelName: 'local-model',
    usage,
    env: { MODEL_USD_RATES: JSON.stringify({ 'local-model': { input: 0 } }) },
  }), null)
  assert.equal(calculateModelCostUsd({
    modelName: 'local-model',
    usage: null,
    env: { MODEL_USD_RATES: JSON.stringify({ 'local-model': { input: 0, output: 0 } }) },
  }), null)
  assert.equal(calculateModelCostUsd({
    modelName: 'local-model',
    usage,
    env: { MODEL_USD_RATES: JSON.stringify({ 'local-model': { input: 0, output: 0 } }) },
  }), 0)
})

test('local endpoints default to zero only when no explicit rate matches', () => {
  const usage = { promptTokens: 1_000, completionTokens: 500 }
  const baseUrl = 'http://127.0.0.1:4000/v1'

  assert.equal(calculateModelCostUsd({ modelName: 'local-model', baseUrl, usage, env: {} }), 0)
  assert.equal(calculateModelCostUsd({
    modelName: 'local-model',
    baseUrl,
    usage,
    env: { MODEL_USD_RATES: JSON.stringify({ 'another-model': { input: 2, output: 4 } }) },
  }), 0)
  assert.equal(calculateModelCostUsd({
    modelName: 'local-model',
    baseUrl,
    usage,
    env: { MODEL_USD_RATES: '{invalid-json' },
  }), null)
  assert.equal(calculateModelCostUsd({
    modelName: 'local-model',
    baseUrl,
    usage,
    env: { MODEL_USD_RATES: JSON.stringify({ 'local-model': { input: 2 } }) },
  }), null)
})

test('provider-specific rates disambiguate identical model names while preserving model defaults', () => {
  const usage = { promptTokens: 1_000_000, completionTokens: 0 }
  const env = {
    MODEL_USD_RATES: JSON.stringify({
      shared: { input: 1, output: 1 },
      'provider-b:shared': { input: 2, output: 2 },
      providers: {
        'provider-c': { shared: { input: 3, output: 3 } },
      },
    }),
  }
  assert.equal(calculateModelCostUsd({ providerId: 'provider-a', modelName: 'shared', usage, env }), 1)
  assert.equal(calculateModelCostUsd({ providerId: 'provider-b', modelName: 'shared', usage, env }), 2)
  assert.equal(calculateModelCostUsd({ providerId: 'provider-c', modelName: 'shared', usage, env }), 3)
})

test('explicit provider rates apply across local and private proxy address forms', () => {
  const providerId = 'shared-provider'
  const modelName = 'same-model'
  const usage = { promptTokens: 1_000_000, completionTokens: 500_000 }
  const env = {
    MODEL_USD_RATES: JSON.stringify({
      providers: {
        [providerId]: {
          [modelName]: { input: 2, output: 4 },
        },
      },
    }),
  }
  const localUrls = [
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234/v1',
    'http://[::1]:8080/v1',
    'http://10.20.30.40:11434/v1',
    'http://172.31.255.1:8000/v1',
    'http://192.168.1.50:11434/v1',
    'http://100.100.100.100:11434/v1',
    'http://gpu-box.local:11434/v1',
    'http://model-host.lan:1234/v1',
  ]

  for (const baseUrl of localUrls) {
    const endpointProfile = resolveEndpointProfile({ baseUrl, modelName, env })
    assert.equal(endpointProfile.isLocal, true, baseUrl)
    assert.equal(calculateModelCostUsd({
      providerId,
      modelName,
      endpointProfile,
      usage,
      env,
    }), 4, baseUrl)
  }
})

test('model-default rates apply to a loopback LiteLLM proxy', () => {
  const baseUrl = 'http://localhost:4000/v1'
  const modelName = 'proxied-model'
  const usage = { promptTokens: 1_000_000, completionTokens: 500_000 }
  const env = {
    MODEL_USD_RATES: JSON.stringify({
      [modelName]: { input: 2, output: 4 },
    }),
  }
  const endpointProfile = resolveEndpointProfile({ baseUrl, modelName, env })

  assert.equal(endpointProfile.isLocal, true)
  assert.equal(calculateModelCostUsd({ modelName, endpointProfile, usage, env }), 4)
})

test('remote endpoints with the same provider and model identity are never incorrectly zeroed', () => {
  const providerId = 'local'
  const modelName = 'same-model'
  const usage = { promptTokens: 1_000_000, completionTokens: 500_000 }
  const env = {
    MODEL_USD_RATES: JSON.stringify({
      providers: {
        [providerId]: {
          [modelName]: { input: 2, output: 4 },
        },
      },
    }),
  }
  const remoteUrls = [
    'https://api.example.com/v1',
    'http://172.15.255.255:11434/v1',
    'http://172.32.0.1:11434/v1',
    'http://100.128.0.1:11434/v1',
    'https://gpu-box.local.example/v1',
  ]

  for (const baseUrl of remoteUrls) {
    const endpointProfile = resolveEndpointProfile({ baseUrl, modelName, env })
    assert.equal(endpointProfile.isLocal, false, baseUrl)
    assert.equal(calculateModelCostUsd({
      providerId,
      modelName,
      endpointProfile,
      usage,
      env,
    }), 4, baseUrl)
  }
})
