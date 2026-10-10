import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateLiveEval,
  liveEvalComparison,
  renderComparisonTable,
} from '../scripts/liveEvalMetrics.mjs'

function run(overrides = {}) {
  return {
    passed: true,
    durationMs: 1000,
    metrics: { toolCalls: 4, modelRequests: 2, approvalRequests: 0, falseCompletion: false },
    ...overrides,
  }
}

function result(id, runs, overrides = {}) {
  return {
    id,
    passed: runs.every((item) => item.passed === true),
    terminalType: 'turn.completed',
    runs,
    passedRuns: runs.filter((item) => item.passed === true).length,
    passRate: runs.filter((item) => item.passed === true).length / runs.length,
    ...overrides,
  }
}

test('an empty report aggregates to zeros, not NaN', () => {
  const aggregate = aggregateLiveEval({ results: [] })
  assert.equal(aggregate.totalTasks, 0)
  assert.equal(aggregate.successRate, 0)
  assert.equal(aggregate.passAt1, 0)
  assert.equal(aggregate.passAtK, 0)
  assert.equal(aggregate.falseCompletionRate, 0)
  assert.equal(aggregate.meanDurationMs, 0)
})

test('success rate is strict (all repeats) while pass@1 and pass@k separate reliability from capability', () => {
  // Task A: 2/2 runs pass (strict pass). Task B: 1/2 runs pass (flaky, not strict).
  // Task C: 0/2 runs pass.
  const report = {
    results: [
      result('A', [run(), run()]),
      result('B', [run(), run({ passed: false })]),
      result('C', [run({ passed: false }), run({ passed: false })]),
    ],
  }
  const aggregate = aggregateLiveEval(report)
  assert.equal(aggregate.totalTasks, 3)
  assert.equal(aggregate.strictPassed, 1, 'only A is strict')
  assert.equal(aggregate.successRate, 1 / 3, 'strict success over all tasks')
  assert.equal(aggregate.totalRuns, 6)
  assert.equal(aggregate.passedRuns, 3, 'A:2 + B:1')
  assert.equal(aggregate.passAt1, 3 / 6, 'mean per-run pass rate')
  assert.equal(aggregate.passAtK, 2 / 3, 'A and B each had at least one pass')
})

test('false completion rate counts runs that claimed done but failed the verifier', () => {
  const report = {
    results: [
      result('A', [run(), run()]),
      result('B', [
        run({ metrics: { toolCalls: 1, modelRequests: 1, approvalRequests: 0, falseCompletion: true } }),
        run({ passed: false }),
      ]),
    ],
  }
  const aggregate = aggregateLiveEval(report)
  assert.equal(aggregate.totalRuns, 4)
  assert.equal(aggregate.falseCompletionRuns, 1)
  assert.equal(aggregate.falseCompletionRate, 1 / 4)
})

test('single-repetition runs and non-finite durations are handled', () => {
  const report = {
    results: [
      result('A', [run({ durationMs: 2000 })]),
      result('B', [run({ passed: false, durationMs: undefined })], { terminalType: 'turn.failed' }),
    ],
  }
  const aggregate = aggregateLiveEval(report)
  assert.equal(aggregate.totalRuns, 2)
  assert.equal(aggregate.passAt1, 0.5)
  assert.equal(aggregate.meanDurationMs, 2000, 'only the finite duration counts')
  assert.equal(aggregate.byTerminalType['turn.completed'], 1)
  assert.equal(aggregate.byTerminalType['turn.failed'], 1)
})

test('comparison shows the rate movement and flags a changed fingerprint', () => {
  const baseline = {
    generatedAt: '2026-10-01T00:00:00Z',
    results: [
      result('A', [run(), run()]),
      result('B', [run({ passed: false }), run({ passed: false })]),
    ],
  }
  const current = {
    generatedAt: '2026-10-09T00:00:00Z',
    results: [
      result('A', [run(), run()]),
      result('B', [run(), run()]),
    ],
  }
  const comparison = liveEvalComparison(current, baseline, {
    status: 'ok',
    comparable: true,
    fingerprintChanged: false,
    regressions: [],
    fixes: [{ id: 'B', from: 'failed', to: 'passed' }],
  })
  const successRow = comparison.rows.find((row) => row.metric.includes('success_rate'))
  assert.equal(successRow.before, 0.5)
  assert.equal(successRow.after, 1)
  assert.equal(successRow.delta, 0.5)
  assert.equal(comparison.fixes.length, 1)

  const stale = liveEvalComparison(current, baseline, {
    status: 'not_comparable',
    comparable: false,
    fingerprintChanged: true,
    regressions: [],
    fixes: [],
  })
  assert.equal(stale.fingerprintChanged, true)
  assert.equal(stale.comparable, false)
})

test('renderComparisonTable prints rates as percentages and a verdict line', () => {
  const comparison = liveEvalComparison(
    { results: [result('A', [run()])] },
    { results: [result('A', [run({ passed: false })])] },
    { status: 'ok', comparable: true, fingerprintChanged: false, regressions: [], fixes: [] },
  )
  const text = renderComparisonTable(comparison)
  assert.match(text, /success_rate/)
  assert.match(text, /100\.0%/)
  assert.match(text, /status: ok/)
})
