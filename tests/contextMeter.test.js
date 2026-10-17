import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateClientContextUsage } from '../src/lib/contextUsage.js'
import { buildPendingContextUsage, resolveContextMeter, createContextHistoryGuard } from '../src/lib/contextMeter.js'
const history = [{ id: 'u', role: 'user', content: 'Hello' }, { id: 'a', role: 'assistant', content: 'Answer', meta: { actualPromptTokens: 800 } }]
const base = { messages: history, tools: [], systemPrompt: '', contextWindow: 128000, contextWindowAuthoritative: true, selectedModel: 'm', selectedModelProviderId: 'p' }
const observed = { version: 1, stage: 'retained', requestId: 'r', physicalAttempt: 1, modelName: 'm', providerId: 'p', configuredModelName: 'm', configuredProviderId: 'p', configRevision: null, contextWindow: 64000, inputEstimatedTokens: 500, inputTokens: 800, retainedEstimatedTokens: 1000 }
const build = extra => buildPendingContextUsage({ ...base, ...extra, estimate: estimateClientContextUsage })
test('prepared and completed host observations drive the current meter before the turn ends', () => {
  const prepared = { ...observed, stage: 'prepared', providerId: 'runtime-alias', contextWindow: 10000, inputEstimatedTokens: 7000, inputTokens: null, retainedEstimatedTokens: null }
  const usage = build({ observation: prepared, allowServerBaseline: true, observationDeltaTokens: 300, contextWindowAuthoritative: false })
  assert.equal(usage.meter.usedTokens, 7300)
  assert.equal(usage.meter.percent, 73)
  const streamed = build({ observation: { ...prepared, retainedEstimatedTokens: 7400 }, allowServerBaseline: true, observationDeltaTokens: 30 })
  assert.equal(streamed.meter.usedTokens, 7430)
  const completed = build({ observation: { ...prepared, stage: 'completed', inputTokens: 7100, retainedEstimatedTokens: 7500 }, allowServerBaseline: true, observationDeltaTokens: 300 })
  assert.equal(completed.meter.usedTokens, 7500)
  assert.equal(completed.meter.contextWindow, 10000)
  assert.equal(build({ observation: { ...prepared, contextWindow: null }, allowServerBaseline: true }).meter.source, 'client_estimate')
})
test('drafts and text attachments affect pending estimates; an old measured 800 never pins the meter', () => {
  const empty = build({}), draft = build({ input: '中文草稿'.repeat(4000) }), attached = build({ attachments: [{ name: 'a.txt', text: '附件文本'.repeat(2000) }] })
  assert.ok(draft.meter.usedTokens > empty.meter.usedTokens)
  assert.ok(attached.meter.usedTokens > empty.meter.usedTokens)
  assert.equal(draft.meter.estimated, true)
  assert.notEqual(draft.meter.usedTokens, 800)
})
test('same-model host retained estimates replace full uncompressed UI history, with draft added exactly once', () => {
  const empty = build({ observation: observed, allowServerBaseline: true })
  const draft = build({ observation: observed, allowServerBaseline: true, input: '下一条'.repeat(100) })
  assert.equal(empty.meter.usedTokens, 1000)
  assert.equal(empty.meter.contextWindow, 64000)
  assert.equal(draft.meter.usedTokens, 1000 + draft.meter.draftTokens)
  assert.equal(draft.meter.lastRequest.inputTokens, 800)
})
test('model/provider/config mismatches do not reuse old input or its denominator', () => {
  for (const change of [{ selectedModel: 'other' }, { selectedModelProviderId: 'other' }, { selectedConfigRevision: 2 }]) {
    const usage = build({ observation: observed, allowServerBaseline: true, ...change })
    assert.equal(usage.meter.source, 'client_estimate')
    assert.equal(usage.meter.contextWindow, 128000)
  }
})
test('an estimated window shows a marked percentage; only an unresolved window stays unknown', () => {
  const attachments = [{ name: 'large.pdf', size: 500000 }, { name: 'image.png', kind: 'image' }]
  const estimated = build({ contextWindowAuthoritative: false, attachments })
  assert.equal(estimated.meter.contextWindow, 128000)
  assert.equal(estimated.meter.contextWindowEstimated, true)
  assert.notEqual(estimated.meter.percent, null)
  assert.equal(estimated.meter.unknownAttachments, 2)

  const unknown = build({ contextWindowKnown: false, attachments })
  assert.equal(unknown.meter.percent, null)
  assert.equal(unknown.meter.contextWindowKnown, false)
  assert.equal(unknown.meter.unknownAttachments, 2)
})
test('cache hits are part of context occupancy; cumulative consumption is not current occupancy', () => {
  const usage = build({ observation: observed, allowServerBaseline: true, modelUsage: { promptTokens: 800, cacheHitTokens: 800 }, cumulativeTokens: 999999 })
  assert.equal(usage.meter.usedTokens, 1000)
  assert.ok(usage.meter.percent > 0)
})
test('the shared resolver does not reinterpret old measured metadata as current occupancy', () => {
  const meter = resolveContextMeter({ actualPromptTokens: 800, estimatedTokens: 2000, contextWindow: 10000, contextWindowAuthoritative: true })
  assert.equal(meter.usedTokens, 2000)
  assert.equal(meter.estimated, true)
})
test('history edits invalidate a request baseline, while immutable equivalent snapshots remain comparable', () => {
  const guard = createContextHistoryGuard()
  assert.equal(guard('scope/r', history.slice(0, 1)), true)
  assert.equal(guard('scope/r', structuredClone(history.slice(0, 1))), true)
  assert.equal(guard('scope/r', [{ ...history[0], content: 'Edited history' }]), false)
  assert.equal(guard('scope/r', history.slice(0, 1)), false)
  assert.equal(guard('scope/new-request', history.slice(0, 1)), true)
})
