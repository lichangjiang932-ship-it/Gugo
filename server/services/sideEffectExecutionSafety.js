import { getDb } from '../db.js'

const REQUIRED_LEDGER_METHODS = Object.freeze([
  'prepare',
  'read',
  'prepareRecovery',
  'readRecovery',
  'claimExecution',
  'markExecuting',
  'markUnknown',
  'finish',
  'parseOutcome',
])

export function hasUnresolvedJobStepSideEffects({ userId, jobId, stepId } = {}) {
  if (!userId || !jobId || !stepId) return true
  return Boolean(getDb().prepare(`
    SELECT 1 FROM side_effect_executions
     WHERE owner_id = ? AND job_id = ? AND step_id = ?
       AND status IN ('prepared', 'executing', 'unknown')
     LIMIT 1
  `).get(userId, jobId, stepId))
}

export function resolveSideEffectExecutionLedgerContract({
  configuredLedger,
  usesDefaultExecutor = false,
  getDefaultLedger,
} = {}) {
  if (configuredLedger === null) return null
  if (configuredLedger === undefined && !usesDefaultExecutor) return null
  const ledger = configuredLedger === undefined
    ? getDefaultLedger()
    : configuredLedger
  if (!ledger || REQUIRED_LEDGER_METHODS.some((name) => typeof ledger[name] !== 'function')) {
    throw new TypeError('sideEffectLedger must implement the durable side-effect ledger contract')
  }
  return ledger
}
