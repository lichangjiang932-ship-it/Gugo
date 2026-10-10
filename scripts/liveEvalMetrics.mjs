/**
 * Suite-level metrics and a "current vs baseline" comparison for live agent
 * evals. Pure functions over report objects so they can be unit-tested without
 * invoking a real model.
 *
 * The live runner already records per-task results (`passed`, `passedRuns`,
 * `passRate`, `runs[]`) and a baseline diff. What it did not expose is the
 * single "how good is the agent" number and its movement over time — success
 * rate, pass@1 / pass@k, and the false-completion rate. Those are what let a
 * change be judged instead of assumed.
 */

const EMPTY_AGGREGATE = Object.freeze({
  totalTasks: 0,
  strictPassed: 0,
  anyPassed: 0,
  totalRuns: 0,
  passedRuns: 0,
  falseCompletionRuns: 0,
  successRate: 0,
  passAt1: 0,
  passAtK: 0,
  falseCompletionRate: 0,
  meanDurationMs: 0,
  meanToolCalls: 0,
  meanModelRequests: 0,
  meanApprovalRequests: 0,
  byTerminalType: Object.freeze({}),
})

function safeRate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0
}

function mean(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

/**
 * Reduce a live-eval report to suite-level rates.
 *
 * - `successRate` (strict): the share of tasks where every repetition passed.
 *   This is the headline — a flaky run cannot be certified by one lucky pass.
 * - `passAt1`: the share of individual runs that passed (mean pass rate).
 * - `passAtK`: the share of tasks with at least one passing run (capability
 *   ceiling — the agent *can* do it, even if not reliably).
 * - `falseCompletionRate`: runs that claimed `turn.completed` yet failed the
 *   verifier — a first-class honesty metric, not a raw count.
 */
export function aggregateLiveEval(report) {
  const results = Array.isArray(report?.results) ? report.results : []
  if (results.length === 0) return { ...EMPTY_AGGREGATE, byTerminalType: {} }

  let strictPassed = 0
  let anyPassed = 0
  let totalRuns = 0
  let passedRuns = 0
  let falseCompletionRuns = 0
  const durations = []
  const toolCalls = []
  const modelRequests = []
  const approvalRequests = []
  const byTerminalType = {}

  for (const result of results) {
    const runs = Array.isArray(result?.runs) && result.runs.length > 0 ? result.runs : [result]
    const runPassed = runs.filter((run) => run?.passed === true).length
    totalRuns += runs.length
    passedRuns += runPassed
    if (result?.passed === true) strictPassed += 1
    if (runPassed > 0) anyPassed += 1
    for (const run of runs) {
      if (run?.metrics?.falseCompletion === true) falseCompletionRuns += 1
      if (Number.isFinite(Number(run?.durationMs))) durations.push(Number(run.durationMs))
      const metrics = run?.metrics || {}
      toolCalls.push(Number(metrics.toolCalls) || 0)
      modelRequests.push(Number(metrics.modelRequests) || 0)
      approvalRequests.push(Number(metrics.approvalRequests) || 0)
      const terminal = String(result?.terminalType || 'unknown')
      byTerminalType[terminal] = (byTerminalType[terminal] || 0) + 1
    }
  }

  return {
    totalTasks: results.length,
    strictPassed,
    anyPassed,
    totalRuns,
    passedRuns,
    falseCompletionRuns,
    successRate: safeRate(strictPassed, results.length),
    passAt1: safeRate(passedRuns, totalRuns),
    passAtK: safeRate(anyPassed, results.length),
    falseCompletionRate: safeRate(falseCompletionRuns, totalRuns),
    meanDurationMs: Math.round(mean(durations)),
    meanToolCalls: Number(mean(toolCalls).toFixed(2)),
    meanModelRequests: Number(mean(modelRequests).toFixed(2)),
    meanApprovalRequests: Number(mean(approvalRequests).toFixed(2)),
    byTerminalType,
  }
}

function roundRate(value) {
  return Number((Number(value) || 0).toFixed(4))
}

function rateRow(metric, before, after) {
  return {
    metric,
    unit: 'rate',
    before: roundRate(before),
    after: roundRate(after),
    delta: roundRate(Number(after) - Number(before)),
  }
}

function numberRow(metric, before, after, unit = 'count') {
  const beforeValue = Number(before) || 0
  const afterValue = Number(after) || 0
  return { metric, unit, before: beforeValue, after: afterValue, delta: Number((afterValue - beforeValue).toFixed(2)) }
}

/**
 * Compare two aggregated reports as a small table.
 *
 * `compareResult` (from `compareWithBaseline`) supplies the verdict and the
 * regression/fix lists; this adds the rate movement a reader actually scans.
 * A fingerprint change keeps the verdict `not_comparable` and is flagged here
 * too so a stale baseline can never be read as a clean win.
 */
export function liveEvalComparison(current, baseline, compareResult = null) {
  const after = aggregateLiveEval(current)
  const before = aggregateLiveEval(baseline)
  const rows = [
    rateRow('success_rate (strict)', before.successRate, after.successRate),
    rateRow('pass@1', before.passAt1, after.passAt1),
    rateRow('pass@k (≥1)', before.passAtK, after.passAtK),
    rateRow('false_completion_rate', before.falseCompletionRate, after.falseCompletionRate),
    numberRow('tasks', before.totalTasks, after.totalTasks),
    numberRow('mean_tool_calls', before.meanToolCalls, after.meanToolCalls),
    numberRow('mean_duration_ms', before.meanDurationMs, after.meanDurationMs),
  ]
  return {
    status: compareResult?.status || (after.successRate >= before.successRate ? 'ok' : 'regressed'),
    comparable: compareResult ? compareResult.comparable !== false : true,
    fingerprintChanged: compareResult ? compareResult.fingerprintChanged === true : false,
    baselineGeneratedAt: compareResult?.baselineGeneratedAt ?? baseline?.generatedAt ?? null,
    rows,
    regressions: compareResult?.regressions || [],
    fixes: compareResult?.fixes || [],
  }
}

function formatRate(value) {
  return `${(Number(value) * 100).toFixed(1)}%`
}

function formatCell(row, key) {
  const value = row[key]
  return row.unit === 'rate' ? formatRate(value) : String(value)
}

/**
 * Render the comparison as a plain-text table for CLI output. Kept dependency
 * free so the report can be printed in any environment.
 */
export function renderComparisonTable(comparison) {
  const header = ['metric', 'baseline', 'current', 'delta'].map((cell) => cell.padEnd(28)).join('  ')
  const lines = comparison.rows.map((row) => {
    const delta = row.unit === 'rate'
      ? formatRate(row.delta)
      : String(row.delta)
    return [
      row.metric.padEnd(28),
      formatCell(row, 'before').padEnd(8),
      formatCell(row, 'after').padEnd(8),
      delta,
    ].join('  ')
  })
  const verdict = [
    `status: ${comparison.status}`,
    comparison.fingerprintChanged ? 'warning: baseline fingerprint changed (not comparable)' : null,
    `regressions: ${comparison.regressions.length}`,
    `fixes: ${comparison.fixes.length}`,
  ].filter(Boolean).join('  |  ')
  return [header, '-'.repeat(header.length), ...lines, '', verdict].join('\n')
}
