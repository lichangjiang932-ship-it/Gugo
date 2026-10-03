import { normalizeModelUsage } from '../../../shared/modelUsage.js'

/**
 * Interpret persisted usage receipts separately from request/provider identity.
 * These fields describe accounting, never authorization to replay a request.
 * The checkpoint owner validates the invocation identity and status first.
 */
export function normalizeModelInvocationUsage(value, status) {
  if (status === 'completed') {
    const hasUsageApplied = Object.hasOwn(value, 'usageApplied')
    if (hasUsageApplied && typeof value.usageApplied !== 'boolean') {
      return null
    }
    const reconciliation = value.reconciliation
    const isLegacyManualCompletion = !hasUsageApplied
      && reconciliation
      && typeof reconciliation === 'object'
      && !Array.isArray(reconciliation)
      && reconciliation.source === 'manual'
      && reconciliation.outcome === 'completed'
    // Provider-completed checkpoints created before usageApplied existed had
    // already persisted their matching budget snapshot. A manually materialized
    // response is the exception: the provider usage is first applied when the
    // resumed loop consumes that response.
    return { usageApplied: hasUsageApplied ? value.usageApplied : !isLegacyManualCompletion }
  }
  if (status === 'failed' && (Object.hasOwn(value, 'failureUsage') || Object.hasOwn(value, 'failureUsageApplied'))) {
    const usage = normalizeModelUsage(value.failureUsage)
    // Written atomically with its budget snapshot. A legacy failed invocation
    // has no such fields; an unaccounted/incomplete new receipt fails closed.
    if (!usage || value.failureUsageApplied !== true) return null
    return { failureUsage: usage, failureUsageApplied: true }
  }
  return {}
}
