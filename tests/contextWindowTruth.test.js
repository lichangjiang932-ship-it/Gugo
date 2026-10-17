import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPendingContextUsage, resolveContextMeter } from '../src/lib/contextMeter.js'

const base = {
  messages: [],
  tools: [],
  systemPrompt: '',
  selectedModel: 'gpt-6-luna',
  selectedModelProviderId: 'openai',
  selectedConfigRevision: 3,
}

test('a known estimated window produces a percentage instead of an unknown meter', () => {
  const usage = buildPendingContextUsage({
    ...base,
    contextWindow: 1_050_000,
    contextWindowKnown: true,
    contextWindowEstimated: true,
    contextWindowSource: 'bundled_catalog',
  })
  assert.equal(usage.meter.contextWindow, 1_050_000)
  assert.equal(usage.meter.contextWindowKnown, true)
  assert.equal(usage.meter.contextWindowEstimated, true)
  assert.equal(usage.meter.contextWindowSource, 'bundled_catalog')
  assert.equal(typeof usage.meter.percent, 'number')
})

test('a server-observed window is exact even when the catalogue value was estimated', () => {
  const usage = buildPendingContextUsage({
    ...base,
    contextWindow: 1_050_000,
    contextWindowKnown: true,
    contextWindowEstimated: true,
    contextWindowSource: 'bundled_catalog',
    allowServerBaseline: true,
    observation: {
      version: 1,
      stage: 'retained',
      requestId: 'request-1',
      physicalAttempt: 1,
      modelName: 'gpt-6-luna',
      providerId: 'openai',
      configuredModelName: 'gpt-6-luna',
      configuredProviderId: 'openai',
      configRevision: 3,
      contextWindow: 10_000,
      inputEstimatedTokens: 5_000,
      inputTokens: null,
      retainedEstimatedTokens: 5_000,
    },
  })
  assert.equal(usage.meter.contextWindow, 10_000)
  assert.equal(usage.meter.contextWindowEstimated, false)
  assert.equal(usage.meter.contextWindowSource, 'server')
  assert.equal(usage.meter.usedTokens, 5_000)
})

test('no resolved window stays unknown and carries no percentage', () => {
  const usage = buildPendingContextUsage({
    ...base,
    contextWindow: 128_000,
    contextWindowKnown: false,
  })
  assert.equal(usage.meter.contextWindow, null)
  assert.equal(usage.meter.contextWindowKnown, false)
  assert.equal(usage.meter.contextWindowSource, 'unknown')
  assert.equal(usage.meter.percent, null)
})

test('a legacy usage object keeps its window and marks estimate provenance', () => {
  const estimated = resolveContextMeter({ estimatedTokens: 14_000, contextWindow: 128_000, contextWindowAuthoritative: false })
  assert.equal(estimated.contextWindow, 128_000)
  assert.equal(estimated.contextWindowEstimated, true)
  assert.equal(estimated.contextWindowSource, 'catalog_estimate')
  assert.equal(Math.round(estimated.percent), 11)

  const exact = resolveContextMeter({ estimatedTokens: 14_000, contextWindow: 128_000, contextWindowAuthoritative: true })
  assert.equal(exact.contextWindowEstimated, false)
  assert.equal(exact.contextWindowSource, 'catalog')

  const unknown = resolveContextMeter({ estimatedTokens: 14_000, contextWindow: 128_000, contextWindowKnown: false })
  assert.equal(unknown.contextWindow, null)
  assert.equal(unknown.percent, null)
})
