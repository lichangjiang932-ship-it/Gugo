import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

import {
  createOfflineEvalFailureReport,
  discoverOfflineEvalSuites,
  executeOfflineEvalCase,
  OFFLINE_EVAL_WORKER_READY_KIND,
  OFFLINE_EVAL_WORKER_RESULT_KIND,
} from './offlineEvalHarness.js'

async function networkAttempts() {
  if (process.env.YMA_OFFLINE_EVAL_NETWORK_GUARD !== '1') return []
  const guard = await import('../../scripts/offlineEvalNetworkGuard.mjs')
  return guard.getOfflineEvalNetworkAttempts()
}

function workerFailure(error) {
  const failure = createOfflineEvalFailureReport(error).suites[0].cases[0]
  return {
    ...failure,
    suiteId: workerData.suiteId,
    id: workerData.caseId,
    title: 'Isolated offline eval case failure',
  }
}

async function main() {
  let outcome
  try {
    let suite = null
    if (workerData.suiteFilePath) {
      const module = await import(pathToFileURL(workerData.suiteFilePath).href)
      suite = module?.default || null
    } else {
      const suites = await discoverOfflineEvalSuites({
        ...(workerData.suiteDirectory ? { directory: workerData.suiteDirectory } : {}),
      })
      suite = suites.find((candidate) => candidate.id === workerData.suiteId)
    }
    const evalCase = suite?.cases.find((candidate) => candidate.id === workerData.caseId)
    if (!suite || suite.id !== workerData.suiteId || !evalCase) {
      const error = new Error('isolated offline eval case was not found')
      error.code = 'OFFLINE_EVAL_CASE_NOT_FOUND'
      throw error
    }
    parentPort.postMessage({
      kind: OFFLINE_EVAL_WORKER_READY_KIND,
      suiteId: suite.id,
      caseId: evalCase.id,
    })
    outcome = await executeOfflineEvalCase(suite, evalCase)
  } catch (error) {
    outcome = workerFailure(error)
  }

  parentPort.postMessage({
    kind: OFFLINE_EVAL_WORKER_RESULT_KIND,
    outcome,
    networkAttempts: await networkAttempts(),
  })
  parentPort.close()
}

await main()
