import { Worker } from 'node:worker_threads'

import {
  DEFAULT_OFFLINE_EVAL_CASE_TIMEOUT_MS,
  offlineEvalSuiteSourcePath,
} from './offlineEvalHarness.js'

const WORKER_ENTRY = new URL('./offlineEvalCaseWorker.mjs', import.meta.url)
const WORKER_RESULT_KIND = 'gugo.offline-eval-case-result'
const MIN_WORKER_HARD_TIMEOUT_GRACE_MS = 1_500
const MAX_WORKER_HARD_TIMEOUT_GRACE_MS = 4_000
const WORKER_NATURAL_EXIT_GRACE_MS = 1_000
const WORKER_TERMINATE_GRACE_MS = 1_000
const OUTER_TEST_SCHEDULING_GRACE_MS = 2_000

function failedOutcome(suite, evalCase, diagnostic, durationMs) {
  return {
    suiteId: suite.id,
    id: evalCase.id,
    category: evalCase.category,
    title: evalCase.title,
    status: 'failed',
    durationMs: Math.max(0, durationMs),
    metrics: {},
    diagnostics: [diagnostic],
  }
}

function caseTimeoutMs(evalCase) {
  return evalCase.timeoutMs || DEFAULT_OFFLINE_EVAL_CASE_TIMEOUT_MS
}

export function offlineEvalCaseWorkerDeadlineMs(evalCase) {
  const timeoutMs = caseTimeoutMs(evalCase)
  const startupGraceMs = Math.min(
    MAX_WORKER_HARD_TIMEOUT_GRACE_MS,
    Math.max(MIN_WORKER_HARD_TIMEOUT_GRACE_MS, Math.ceil(timeoutMs * 0.8)),
  )
  return timeoutMs + startupGraceMs
}

export function offlineEvalCaseTestDeadlineMs(evalCase) {
  return offlineEvalCaseWorkerDeadlineMs(evalCase)
    + WORKER_NATURAL_EXIT_GRACE_MS
    + WORKER_TERMINATE_GRACE_MS
    + OUTER_TEST_SCHEDULING_GRACE_MS
}

function validWorkerResult(message, suite, evalCase) {
  const outcome = message?.outcome
  return message?.kind === WORKER_RESULT_KIND
    && outcome
    && outcome.suiteId === suite.id
    && outcome.id === evalCase.id
    && ['passed', 'failed', 'skipped'].includes(outcome.status)
    && Array.isArray(message.networkAttempts)
}

async function terminateWorker(worker) {
  await Promise.race([
    Promise.resolve(worker.terminate()).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, WORKER_TERMINATE_GRACE_MS)),
  ])
}

async function waitForNaturalWorkerExit(worker) {
  let timer = null
  let onError = null
  let onExit = null
  const exited = await new Promise((resolve) => {
    const finish = (value) => {
      if (timer) clearTimeout(timer)
      worker.removeListener('error', onError)
      worker.removeListener('exit', onExit)
      resolve(value)
    }
    onError = () => finish(false)
    onExit = () => finish(true)
    worker.once('error', onError)
    worker.once('exit', onExit)
    timer = setTimeout(() => finish(false), WORKER_NATURAL_EXIT_GRACE_MS)
  })
  if (!exited) await terminateWorker(worker)
}

export async function runOfflineEvalCaseInWorker({
  suite,
  evalCase,
  suiteDirectory = null,
  createWorker = (url, options) => new Worker(url, options),
} = {}) {
  const startedAt = Date.now()
  const hardTimeoutMs = offlineEvalCaseWorkerDeadlineMs(evalCase)
  const worker = createWorker(WORKER_ENTRY, {
    workerData: {
      suiteId: suite.id,
      caseId: evalCase.id,
      suiteDirectory,
      suiteFilePath: offlineEvalSuiteSourcePath(suite),
    },
  })

  return new Promise((resolve) => {
    let settled = false
    let timer = null

    const finish = async (outcome, networkAttempts = [], allowNaturalExit = false) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      worker.removeAllListeners()
      if (allowNaturalExit) {
        await waitForNaturalWorkerExit(worker)
      } else {
        await terminateWorker(worker)
      }
      resolve({ outcome, networkAttempts })
    }

    worker.once('message', (message) => {
      if (!validWorkerResult(message, suite, evalCase)) {
        void finish(failedOutcome(
          suite,
          evalCase,
          '[OFFLINE_EVAL_WORKER_PROTOCOL_INVALID] isolated eval worker returned an invalid result',
          Date.now() - startedAt,
        ))
        return
      }
      const allowNaturalExit = message.outcome.status === 'passed'
        || message.outcome.status === 'skipped'
      void finish(message.outcome, message.networkAttempts, allowNaturalExit)
    })

    worker.once('error', () => {
      void finish(failedOutcome(
        suite,
        evalCase,
        '[OFFLINE_EVAL_WORKER_ERROR] isolated eval worker failed',
        Date.now() - startedAt,
      ))
    })

    worker.once('exit', (code) => {
      if (settled) return
      void finish(failedOutcome(
        suite,
        evalCase,
        `[OFFLINE_EVAL_WORKER_EXIT] isolated eval worker exited before reporting (code ${code})`,
        Date.now() - startedAt,
      ))
    })

    timer = setTimeout(() => {
      void finish(failedOutcome(
        suite,
        evalCase,
        `[OFFLINE_EVAL_CASE_HARD_TIMEOUT] isolated eval worker exceeded ${hardTimeoutMs}ms`,
        Date.now() - startedAt,
      ))
    }, hardTimeoutMs)
  })
}
