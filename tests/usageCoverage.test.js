import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeUsageEvents } from '../server/services/localUsageReportService.js'

const event = (sequence, usage) => ({ type: 'model.phase', sessionId: 'coverage-session', turnId: 'coverage-turn',
  sequence, createdAt: sequence * 1000, payload: { phase: 'completed', modelName: 'coverage-model', usage } })

test('request coverage distinguishes unknown reads, reported zero and independent writes', () => {
  const report = summarizeUsageEvents([
    event(3, { promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100, cacheCreationTokens: 0 }),
    event(2, { promptTokens: 200, cacheCreationTokens: 30 }),
    event(1, { promptTokens: 100, cacheHitTokens: 20, cacheMissTokens: 80 }),
  ])
  assert.deepEqual(report.cacheCoverage, {
    requests: 3, readReported: 2, readUnknown: 1, writeReported: 2, writeUnknown: 1,
    reportedPromptTokens: 400, measuredPromptTokens: 200, cacheHitTokens: 20, cacheCreationTokens: 30,
    readCoveragePercent: 66.67, hitRatePercent: 10,
  })
  assert.equal(report.phaseTotals.cacheCreationTokens, 30)
  assert.equal(report.byModel[0].cacheCoverage.readUnknown, 1)
  assert.equal(report.bySession[0].cacheCoverage.hitRatePercent, 10)
})

test('malformed counters do not manufacture measured samples or token totals', () => {
  const report = summarizeUsageEvents([event(1, { promptTokens: 100, cacheHitTokens: [80], cacheCreationTokens: {} })])
  assert.equal(report.cacheCoverage.readReported, 0)
  assert.equal(report.cacheCoverage.hitRatePercent, null)
  assert.equal(report.cacheCoverage.cacheCreationTokens, null)
  assert.equal(report.phaseTotals.cacheHitTokens, 0)
})
