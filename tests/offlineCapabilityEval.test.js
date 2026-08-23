import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachOfflineEvalNetworkAttempts,
  compareOfflineEvalBaseline,
  createOfflineEvalFailureReport,
  discoverOfflineEvalSuites,
  parseOfflineEvalOptions,
  runOfflineEvalSuites,
  writeOfflineEvalReport,
} from './helpers/offlineEvalHarness.js'
import {
  offlineEvalCaseWorkerDeadlineMs,
  runOfflineEvalCaseInWorker,
} from './helpers/offlineEvalCaseWorkerHost.js'

function baselineGateFailure(report) {
  const baseline = report?.baseline
  if (!baseline?.compared) return null
  if (!baseline.compatible) {
    const detail = baseline.incompatibilities?.[0]
    return `offline eval baseline is incompatible${detail ? `: ${JSON.stringify(detail)}` : ''}`
  }
  if (baseline.regressions?.length) {
    return `offline eval baseline has ${baseline.regressions.length} regression(s)`
  }
  if (baseline.missingCases?.length) {
    return `offline eval run is missing ${baseline.missingCases.length} baseline case(s)`
  }
  return null
}

const options = parseOfflineEvalOptions()
let report = null
const isolatedNetworkAttempts = []

test('offline eval suites', async (t) => {
  try {
    const suites = await discoverOfflineEvalSuites()
    report = await runOfflineEvalSuites({
      suites,
      selectedSuiteIds: options.suiteIds,
      runCase: async ({ suite, evalCase }) => {
        let outcome = null
        await t.test(
          `[offline:${suite.id}:${evalCase.id}] ${evalCase.category} — ${evalCase.title}`,
          { timeout: offlineEvalCaseWorkerDeadlineMs(evalCase) + 1_000 },
          async () => {
            const isolated = await runOfflineEvalCaseInWorker({ suite, evalCase })
            outcome = isolated.outcome
            isolatedNetworkAttempts.push(...isolated.networkAttempts)
            if (outcome?.status === 'failed') {
              assert.fail(outcome.diagnostics?.[0] || `${suite.id}/${evalCase.id} failed`)
            }
          },
        )
        return outcome
      },
    })
  } catch (error) {
    report = createOfflineEvalFailureReport(error, { selectedSuiteIds: options.suiteIds })
    throw error
  }
})

test.after(async () => {
  if (!report) {
    report = createOfflineEvalFailureReport(new Error('offline eval produced no report'), {
      selectedSuiteIds: options.suiteIds,
    })
  }

  if (process.env.YMA_OFFLINE_EVAL_NETWORK_GUARD === '1') {
    const { getOfflineEvalNetworkAttempts } = await import('../scripts/offlineEvalNetworkGuard.mjs')
    report = attachOfflineEvalNetworkAttempts(report, [
      ...getOfflineEvalNetworkAttempts(),
      ...isolatedNetworkAttempts,
    ])
  }

  if (options.baselinePath && !report.harnessFailure) {
    report = await compareOfflineEvalBaseline(report, options.baselinePath)
  }
  if (options.reportPath) {
    await writeOfflineEvalReport(options.reportPath, report)
  }

  const gateFailure = baselineGateFailure(report)
  if (gateFailure) throw new Error(gateFailure)
  if (report.networkAttempts?.length) {
    throw new Error(`offline eval blocked ${report.networkAttempts.length} network attempt(s)`)
  }
})
