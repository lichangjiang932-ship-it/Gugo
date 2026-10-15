import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeUsageEvents } from '../server/services/localUsageReportService.js'
const terminal = (sequence, tokens, type = 'turn.completed', changes = {}) => ({ userId: 'u', sessionId: 's', turnId: 't', sequence, createdAt: sequence * 1000, type,
  payload: tokens == null ? {} : { turnModelUsage: { promptTokens: tokens, completionTokens: 0 } }, ...changes })
const phase = (sequence, tokens, extra = {}) => ({ userId: 'u', sessionId: 's', turnId: 't', sequence, createdAt: sequence * 1000, type: 'model.phase',
  payload: { phase: 'completed', modelName: 'same-model', usage: { promptTokens: tokens, completionTokens: 0 }, ...extra } })

test('paused and resumed cumulative snapshots contribute one turn and one total', () => {
  const report = summarizeUsageEvents([terminal(4, 800), phase(3, 300), terminal(2, 500, 'turn.paused'), phase(1, 500)])
  assert.equal(report.turns.total, 1)
  assert.equal(report.turns.stopped, 0)
  assert.equal(report.totals.promptTokens, 800)
  assert.equal(report.bySession[0].usage.promptTokens, 800)
})
test('sequence owns latest state; missing final usage retains the last known cumulative snapshot', () => {
  const report = summarizeUsageEvents([terminal(2, null, 'turn.failed', { createdAt: 1 }), terminal(1, 500, 'turn.paused', { createdAt: 9999 })])
  assert.equal(report.turns.byType['turn.failed'], 1)
  assert.equal(report.totals.promptTokens, 500)
})
test('an invalid final snapshot cannot erase previously recorded cumulative usage', () => {
  const invalid = terminal(2, null); invalid.payload.turnModelUsage = { promptTokens: null }
  assert.equal(summarizeUsageEvents([invalid, terminal(1, 500)]).totals.promptTokens, 500)
})
test('different owners and sessions never deduplicate each other; legacy anonymous boundaries remain separate', () => {
  const report = summarizeUsageEvents([terminal(1, 10), terminal(1, 20, 'turn.completed', { userId: 'other' }), terminal(1, 30, 'turn.completed', { sessionId: 'other' }),
    terminal(1, 40, 'turn.completed', { turnId: undefined }), terminal(2, 50, 'turn.completed', { turnId: undefined })])
  assert.equal(report.turns.total, 5)
  assert.equal(report.totals.promptTokens, 150)
})
test('date windows count recorded responses, not whole cumulative turns that began earlier', () => {
  const report = summarizeUsageEvents([terminal(4, 800), phase(3, 300)], { since: 2500 })
  assert.equal(report.totals.promptTokens, 300)
  assert.equal(report.accounting.basis, 'responses_in_window')
  assert.equal(report.turnCumulativeTotals.promptTokens, 800)
})
test('repeated completed events with a physical request identity count once', () => {
  const report = summarizeUsageEvents([phase(2, 100, { modelRequestId: 'req', physicalAttempt: 1 }), phase(1, 100, { modelRequestId: 'req', physicalAttempt: 1 })])
  assert.equal(report.perModelPhases, 1)
  assert.equal(report.phaseTotals.promptTokens, 100)
})
test('same model across providers/configurations has separate groups and cache continuity', () => {
  const source = (id, char) => ({ version: 1, providerId: id, endpointFingerprint: char.repeat(64), configFingerprint: 'c'.repeat(64) })
  const report = summarizeUsageEvents([phase(3, 100, { modelSource: source('p1', 'a') }), phase(2, 100, { modelSource: source('p2', 'b') }), phase(1, 100, { modelSource: source('p1', 'b') })])
  assert.equal(report.byModel.length, 3)
  assert.ok(report.byModel.every(row => row.modelName === 'same-model'))
})
