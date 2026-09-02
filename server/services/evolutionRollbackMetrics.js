import { normalizeOptionalUsageNumber } from '../../shared/modelUsage.js'

function ratio(candidate, baseline) {
  if (baseline === 0) return candidate === 0 ? 1 : null
  return candidate / baseline
}

function average(rows, readValue) {
  if (!rows.length) return null
  return rows.reduce((sum, row) => sum + readValue(row), 0) / rows.length
}

function measuredCost(row) {
  let usage = null
  try { usage = JSON.parse(row.usage_json) } catch { /* optional telemetry */ }
  return normalizeOptionalUsageNumber(usage?.costUsd)
}

export function buildEvolutionRollbackMetrics(rows, policy) {
  const candidate = rows.filter((row) => row.effective_variant === 'candidate')
  const baseline = rows.filter((row) => row.effective_variant === 'baseline')
  const candidateCosts = candidate.map(measuredCost).filter((value) => value !== null)
  const baselineCosts = baseline.map(measuredCost).filter((value) => value !== null)
  const candidateAverageDurationMs = average(candidate, (row) => Math.max(0, Number(row.duration_ms) || 0))
  const baselineAverageDurationMs = average(baseline, (row) => Math.max(0, Number(row.duration_ms) || 0))
  const candidateAverageCostUsd = candidateCosts.length
    ? candidateCosts.reduce((sum, value) => sum + value, 0) / candidateCosts.length
    : null
  const baselineAverageCostUsd = baselineCosts.length
    ? baselineCosts.reduce((sum, value) => sum + value, 0) / baselineCosts.length
    : null
  const candidateReady = candidate.length >= policy.minimum_candidate_outcomes
  const baselineReady = baseline.length >= policy.minimum_baseline_outcomes
  const costReady = candidateReady && baselineReady
    && candidateCosts.length === candidate.length
    && baselineCosts.length === baseline.length
  return {
    windowSize: policy.window_size,
    candidate: {
      outcomes: candidate.length,
      completed: candidate.filter((row) => row.terminal_state === 'completed').length,
      failed: candidate.filter((row) => row.terminal_state === 'failed').length,
      cancelled: candidate.filter((row) => row.terminal_state === 'cancelled').length,
      failureRate: candidate.length
        ? candidate.filter((row) => row.terminal_state === 'failed').length / candidate.length
        : null,
      cancellationRate: candidate.length
        ? candidate.filter((row) => row.terminal_state === 'cancelled').length / candidate.length
        : null,
      averageDurationMs: candidateAverageDurationMs,
      costMeasured: candidateCosts.length,
      averageCostUsd: candidateAverageCostUsd,
    },
    baseline: {
      outcomes: baseline.length,
      completed: baseline.filter((row) => row.terminal_state === 'completed').length,
      failed: baseline.filter((row) => row.terminal_state === 'failed').length,
      cancelled: baseline.filter((row) => row.terminal_state === 'cancelled').length,
      averageDurationMs: baselineAverageDurationMs,
      costMeasured: baselineCosts.length,
      averageCostUsd: baselineAverageCostUsd,
    },
    evidence: { candidateReady, baselineReady, costReady },
    latencyRatio: candidateReady && baselineReady
      ? ratio(candidateAverageDurationMs, baselineAverageDurationMs)
      : null,
    costRatio: costReady ? ratio(candidateAverageCostUsd, baselineAverageCostUsd) : null,
  }
}

export function findEvolutionRollbackPolicyBreaches(metrics, policy) {
  const breaches = []
  if (metrics.evidence.candidateReady
    && metrics.candidate.failureRate > policy.maximum_candidate_failure_rate) {
    breaches.push('maximum_candidate_failure_rate')
  }
  if (metrics.evidence.candidateReady
    && metrics.candidate.cancellationRate > policy.maximum_candidate_cancellation_rate) {
    breaches.push('maximum_candidate_cancellation_rate')
  }
  if (metrics.evidence.candidateReady && metrics.evidence.baselineReady) {
    const latencyBreach = metrics.latencyRatio === null
      ? metrics.candidate.averageDurationMs > 0 && metrics.baseline.averageDurationMs === 0
      : metrics.latencyRatio > policy.maximum_latency_ratio
    if (latencyBreach) breaches.push('maximum_latency_ratio')
  }
  return breaches
}

export function evolutionRollbackDecisionMetrics(metrics = {}) {
  const stripCost = (value = {}) => {
    const result = { ...value }
    delete result.costMeasured
    delete result.averageCostUsd
    return result
  }
  const root = { ...(metrics || {}) }
  const candidate = root.candidate || {}
  const baseline = root.baseline || {}
  const evidence = root.evidence || {}
  delete root.costRatio
  delete root.candidate
  delete root.baseline
  delete root.evidence
  const decisionEvidence = { ...evidence }
  delete decisionEvidence.costReady
  return {
    ...root,
    candidate: stripCost(candidate),
    baseline: stripCost(baseline),
    evidence: decisionEvidence,
  }
}
