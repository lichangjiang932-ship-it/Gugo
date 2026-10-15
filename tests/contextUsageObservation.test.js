import assert from 'node:assert/strict'
import test from 'node:test'
import { contextUsageObservation } from '../server/services/loop/contextUsageObservation.js'
import { estimateContextTokens } from '../server/services/contextCompactionMetrics.js'
import { publicRequestDiagnostics } from '../shared/publicRequestDiagnostics.js'
const state = () => ({ job: { modelName: 'm', modelProviderId: 'p' }, contextWindow: 64000, activeToolSpecs: [], convo: [{ role: 'user', content: 'hello' }],
  modelInvocation: { id: 'r', configRevision: 2, providerAttempts: [{ sequence: 1, modelName: 'm', providerId: 'p' }] } })
test('retained estimates calibrate to actual input and count only retained output, not the UI archive', () => {
  const s = state(), prepared = contextUsageObservation(s, { stage: 'prepared' })
  assert.equal(prepared.contextWindow, 64000)
  contextUsageObservation(s, { stage: 'completed', inputTokens: 800 })
  s.modelInvocation = null // Runtime retires the invocation before accepting the final answer.
  s.convo.push({ role: 'assistant', content: 'An answer that is retained for the next request.' })
  const retained = contextUsageObservation(s, { stage: 'retained' })
  assert.equal(retained.retainedEstimatedTokens, 800 + estimateContextTokens(s.convo, []) - prepared.inputEstimatedTokens)
  assert.equal(retained.inputTokens, 800)
  assert.doesNotMatch(JSON.stringify(retained), /hello|An answer/)
  assert.deepEqual(publicRequestDiagnostics({ modelContextUsage: retained }).modelContextUsage, retained)
})
test('failover never claims that the configured model window is its actual route window', () => {
  const s = state(); s.modelInvocation.providerAttempts[0].providerId = 'other'
  assert.equal(contextUsageObservation(s, { stage: 'prepared' }).contextWindow, null)
})
test('unknown and zero input remain different, and old request calibration cannot contaminate a new request', () => {
  const s = state()
  contextUsageObservation(s, { stage: 'prepared' })
  assert.equal(contextUsageObservation(s, { stage: 'completed', inputTokens: 0 }).inputTokens, 0)
  s.modelInvocation.id = 'other-request'
  assert.equal(contextUsageObservation(s, { stage: 'completed' }).inputTokens, null)
})
