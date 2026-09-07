export const DEFAULT_SEMANTIC_SUMMARY_POLICY = Object.freeze({ mode: 'auto', maxCalls: 12, timeoutMs: 45_000 })
export const SEMANTIC_SUMMARY_CACHE_HIT = Symbol('semantic-summary-cache-hit')

function boundedInteger(value, fallback, maximum) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? Math.min(maximum, number) : fallback
}

/** Provider-neutral, opt-out policy. Automatic summaries run only when needed. */
export function resolveSemanticSummaryPolicy(value, env = {}) {
  const input = value && typeof value === 'object' ? value : { mode: value }
  const requested = input.mode ?? env.GUGO_CONTEXT_SEMANTIC_SUMMARY ?? 'auto'
  const mode = requested === false || ['off', 'false', '0'].includes(String(requested).toLowerCase())
    ? 'off'
    : requested === true || ['always', 'true', '1'].includes(String(requested).toLowerCase()) ? 'always' : 'auto'
  return Object.freeze({
    mode,
    maxCalls: boundedInteger(input.maxCalls ?? env.GUGO_CONTEXT_SEMANTIC_MAX_CALLS, DEFAULT_SEMANTIC_SUMMARY_POLICY.maxCalls, 32),
    timeoutMs: boundedInteger(input.timeoutMs ?? env.GUGO_CONTEXT_SEMANTIC_TIMEOUT_MS, DEFAULT_SEMANTIC_SUMMARY_POLICY.timeoutMs, 120_000),
  })
}

export function semanticSummaryError(code, message) {
  return Object.assign(new Error(message), { code, retryable: false })
}

/** Race uncooperative adapters too; late results cannot continue this workflow. */
export function createSemanticSummaryScope(parentSignal, timeoutMs) {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(parentSignal.reason)
  if (parentSignal?.aborted) forwardAbort()
  else parentSignal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => controller.abort(semanticSummaryError(
    'SEMANTIC_SUMMARY_TIMEOUT', 'Semantic compaction exceeded its time budget',
  )), timeoutMs)
  return {
    signal: controller.signal,
    async run(operation) {
      if (controller.signal.aborted) throw controller.signal.reason
      let onAbort
      const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      try { return await Promise.race([Promise.resolve().then(operation), cancelled]) }
      finally { controller.signal.removeEventListener('abort', onAbort) }
    },
    close() {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', forwardAbort)
    },
  }
}
