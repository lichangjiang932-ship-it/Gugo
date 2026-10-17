import assert from 'node:assert/strict'
import test from 'node:test'
import { contextUsageObservation, observeContextTextDeltas } from '../server/services/loop/contextUsageObservation.js'
import { estimateContextTokens } from '../server/services/contextCompactionMetrics.js'
import { publicRequestDiagnostics } from '../shared/publicRequestDiagnostics.js'
const state = () => ({ job: { modelName: 'm', modelProviderId: 'p' }, contextWindow: 64000, activeToolSpecs: [], convo: [{ role: 'user', content: 'hello' }],
  modelInvocation: { id: 'r', configRevision: 2, providerAttempts: [{ sequence: 1, modelName: 'm', providerId: 'p' }] } })
test('the primary durable Provider binding can expose its runtime-key route window without accepting failover', () => {
  const s = state()
  s.job.modelProviderId = 'durable-provider-uuid'
  s.modelInvocation.providerId = 'durable-provider-uuid'
  s.modelInvocation.providerAttempts[0].providerId = 'runtime-key'
  s.modelInvocation.providerAttempts[0].failoverIndex = 0
  assert.equal(contextUsageObservation(s, { stage: 'prepared' }).contextWindow, 64000)
  s.modelInvocation.providerAttempts[0].failoverIndex = 1
  assert.equal(contextUsageObservation(s, { stage: 'prepared' }).contextWindow, null)
})
test('completed observations can include the retained public response before final task completion', () => {
  const s = state(), prepared = contextUsageObservation(s, { stage: 'prepared' })
  const messages = [...s.convo, { role: 'assistant', content: 'A growing response before the next tool batch.' }]
  const completed = contextUsageObservation(s, { stage: 'completed', inputTokens: 800, messages })
  assert.equal(completed.retainedEstimatedTokens, 800 + estimateContextTokens(messages, []) - prepared.inputEstimatedTokens)
})
test('public streaming deltas publish bounded numeric updates even while narrative is buffered', async () => {
  const s = state(), phases = []
  let time = 0
  s.onModelPhase = async event => phases.push(structuredClone(event))
  const prepared = contextUsageObservation(s, { stage: 'prepared' })
  const observe = observeContextTextDeltas(s, async () => {}, { now: () => time })
  await observe('Public draft '.repeat(100))
  assert.equal(phases.length, 1)
  assert.equal(phases[0].contextUsage.inputEstimatedTokens, prepared.inputEstimatedTokens)
  assert.ok(phases[0].contextUsage.retainedEstimatedTokens > prepared.inputEstimatedTokens)
  time = 900; await observe('more text')
  assert.equal(phases.length, 1)
  time = 1100; await observe('next chunk')
  assert.equal(phases.length, 2)
  assert.ok(phases[1].contextUsage.retainedEstimatedTokens > phases[0].contextUsage.retainedEstimatedTokens)
  assert.doesNotMatch(JSON.stringify(phases), /Public draft|hello|next chunk/)
})
test('a long stream publishes at most one durable context observation per second', async () => {
  const s = state(), phases = [], published = []
  s.onModelPhase = async event => phases.push(structuredClone(event))
  let time = 0
  const observe = observeContextTextDeltas(s, async text => { published.push(text) }, { now: () => time })
  for (let index = 0; index < 3001; index += 1) {
    time = index * 20
    await observe(`chunk-${index} `)
  }
  assert.equal(published.length, 3001, 'throttling must never drop streamed text')
  assert.equal(phases.length, 61, 'first chunk plus one observation per second')
  assert.doesNotMatch(JSON.stringify(phases), /chunk-/)
})
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
  s.modelInvocation.providerAttempts[0].sequence = 2
  assert.equal(contextUsageObservation(s, { stage: 'prepared' }).inputTokens, null)
  s.modelInvocation.id = 'other-request'
  assert.equal(contextUsageObservation(s, { stage: 'completed' }).inputTokens, null)
})
