import { Worker } from 'node:worker_threads'

import {
  DEFAULT_OFFLINE_EVAL_CASE_TIMEOUT_MS,
} from './offlineEvalHarness.js'

const WORKER_ENTRY = new URL('./offlineEvalCaseWorker.mjs', import.meta.url)
const WORKER_RESULT_KIND = 'gugo.offline-eval-case-result'
const MIN_WORKER_HARD_TIMEOUT_GRACE_MS = 1_500
const MAX_WORKER_HARD_TIMEOUT_GRACE_MS = 4_000
const WORKER_SHUTDOWN_GRACE_MS = 1_000

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
    new Promise((resolve) => setTimeout(resolve, WORKER_SHUTDOWN_GRACE_MS)),
  ])
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
    },
  })

  return new Promise((resolve) => {
    let settled = false
    let timer = null

    const finish = async (outcome, networkAttempts = []) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      worker.removeAllListeners()
      await terminateWorker(worker)
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
      void finish(message.outcome, message.networkAttempts)
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
