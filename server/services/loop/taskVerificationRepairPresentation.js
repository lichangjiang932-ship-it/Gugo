import { normalizeMutationTarget } from './heuristics/mutationClassification.js'
import { redactSensitiveText } from '../../utils/toolCallHarness.js'

export const TASK_VERIFICATION_REPAIR_MARKER = '[TASK VERIFICATION REPAIR REQUIRED]'
export const MAX_TASK_VERIFICATION_FAILURES = 3

const MAX_TERMINAL_CHECKS = 9
const FAILURE_PENDING_REASON = 'verification_failed'
const STALE_SUCCESS_PENDING_REASON = 'mutation_after_success'
const GENERIC_VERIFICATION_DIAGNOSTICS = new Set([
  'The check passed before a later related mutation and must be rerun.',
  'The verification command returned a failing result.',
  'The verification environment did not produce a conclusive result.',
])

function pendingEntries(state) {
  return state?.pending instanceof Map ? [...state.pending.values()] : []
}

function indeterminateEntries(state) {
  const values = state?.indeterminate instanceof Map
    ? [...state.indeterminate.values()]
    : state?.lastIndeterminate ? [state.lastIndeterminate] : []
  return values.filter((value) => (
    value && typeof value === 'object' && String(value.kind || '').trim()
  ))
}

function verificationOverflowed(state) {
  return state?.verificationOverflowed === true
}

function normalizeEpoch(value) {
  const epoch = Math.floor(Number(value) || 0)
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : 0
}

function normalizePathList(value, limit = 16) {
  const paths = new Set()
  for (const candidate of Array.isArray(value) ? value : []) {
    const normalized = normalizeMutationTarget(candidate)
    if (!normalized) continue
    paths.add(normalized.slice(0, 2_000))
    if (paths.size >= limit) break
  }
  return [...paths]
}

function terminalVerificationCheck(entry, status) {
  const diagnostic = redactSensitiveText(String(entry?.message || '').trim()).slice(0, 1_200)
  return {
    status,
    kind: String(entry?.kind || '').trim(),
    cwd: String(entry?.cwd || '.').trim().slice(0, 1_000) || '.',
    commandScope: String(entry?.commandScope || entry?.tool || '').trim().slice(0, 1_000),
    coverage: entry?.coverage === 'targeted' ? 'targeted' : 'cwd',
    code: String(entry?.code || 'VERIFICATION_INDETERMINATE').trim().toUpperCase(),
    failures: Math.max(0, Math.min(
      MAX_TASK_VERIFICATION_FAILURES,
      Math.floor(Number(entry?.failures) || 0),
    )),
    requiredEpoch: normalizeEpoch(entry?.requiredEpoch),
    mutationTargets: normalizePathList(entry?.mutationTargets),
    ...(diagnostic && !GENERIC_VERIFICATION_DIAGNOSTICS.has(diagnostic)
      ? { diagnostic }
      : {}),
  }
}

export function hasPendingTaskVerificationRepair(state) {
  return pendingEntries(state).length > 0
    || indeterminateEntries(state).length > 0
    || verificationOverflowed(state)
}

export function taskVerificationRepairExhausted(state) {
  const pending = pendingEntries(state)
  return Number(state?.consecutiveFailures || 0) >= MAX_TASK_VERIFICATION_FAILURES
    || pending.some((entry) => Number(entry?.failures || 0) >= MAX_TASK_VERIFICATION_FAILURES)
}

export function taskVerificationRepairDetails(state) {
  const checks = []
  if (verificationOverflowed(state)) {
    checks.push(terminalVerificationCheck({
      kind: 'check',
      cwd: '.',
      commandScope: 'verification-state',
      code: 'TASK_VERIFICATION_STATE_OVERFLOW',
      requiredEpoch: Number(state?.mutationEpoch) || 0,
    }, 'indeterminate'))
  }
  checks.push(...pendingEntries(state).map((entry) => {
    const status = entry.reason === FAILURE_PENDING_REASON
      ? 'failed'
      : entry.reason === STALE_SUCCESS_PENDING_REASON ? 'stale' : 'rerun_required'
    return terminalVerificationCheck(entry, status)
  }))
  for (const indeterminate of indeterminateEntries(state)) {
    checks.push(terminalVerificationCheck(indeterminate, 'indeterminate'))
  }
  if (checks.length === 0) return null
  return {
    version: 1,
    maxFailures: MAX_TASK_VERIFICATION_FAILURES,
    consecutiveFailures: Math.max(0, Math.min(
      MAX_TASK_VERIFICATION_FAILURES,
      Math.floor(Number(state?.consecutiveFailures) || 0),
    )),
    checks: checks.slice(0, MAX_TERMINAL_CHECKS),
  }
}

export function buildTaskVerificationRepairPrompt(state) {
  const pending = pendingEntries(state)
  const indeterminate = indeterminateEntries(state)
  const overflowed = verificationOverflowed(state)
  if (pending.length === 0 && indeterminate.length === 0 && !overflowed) return ''
  const failed = pending.filter((entry) => entry.reason === FAILURE_PENDING_REASON)
  const rerunOnly = pending.filter((entry) => entry.reason !== FAILURE_PENDING_REASON)
  return [
    TASK_VERIFICATION_REPAIR_MARKER,
    pending.length === 0 && indeterminate.length > 0
      ? 'The latest project verification did not produce a conclusive result.'
      : pending.length === 0
        ? 'The verification state exceeded its bounded capacity and completion remains blocked.'
      : failed.length > 0
        ? `Post-mutation project verification is failing: ${failed.map((entry) => entry.kind).join(', ')}.`
        : `Related project verification must be rerun after the latest mutation: ${rerunOnly.map((entry) => entry.kind).join(', ')}.`,
    pending.length === 0 && indeterminate.length > 0
      ? 'Restore the required tool or execution environment, then rerun the same check scope before completing the task.'
      : pending.length === 0
        ? 'Restart verification from a fresh task checkpoint and rerun every required project check before completing the task.'
      : failed.length > 0
        ? 'Treat the exact tool output as actionable feedback. Inspect the failing assertion or diagnostic, correct the implementation with the available tools, then rerun every pending check.'
        : 'The latest related change invalidated earlier verification evidence. Rerun every pending check before completing the task.',
    indeterminate.length > 0
      ? 'At least one check did not produce a conclusive project verdict. Restore the named tool or execution environment, then rerun that check; infrastructure failures do not consume the code-repair budget.'
      : '',
    overflowed
      ? 'Verification scope capacity was exceeded. The overflow sentinel is fail-closed and cannot be cleared by partial checks.'
      : '',
    'A file read, directory listing, or diff cannot clear a failed test/lint/build result. Do not claim completion while any pending check remains.',
    ...pending.map((entry) => {
      const scope = `${entry.kind}@${entry.cwd} via ${entry.commandScope || entry.tool || 'project check'}`
      return entry.reason === FAILURE_PENDING_REASON
        ? `${scope} remains pending after verification failure ${entry.failures}/${MAX_TASK_VERIFICATION_FAILURES} [${entry.code}]. Read the preceding tool-role result for diagnostics, correct the implementation, and rerun a check that covers this scope.`
        : `${scope} has no verification result for mutation epoch ${entry.requiredEpoch}; rerun a check that covers this scope.`
    }),
    ...indeterminate.map((entry) => (
      `${entry.kind}@${entry.cwd} via ${entry.commandScope || entry.tool || 'project check'} is inconclusive [${entry.code}]: ${entry.message} Rerun a check that covers this scope after restoring the missing execution requirement.`
    )),
  ].filter(Boolean).join('\n')
}

export function taskVerificationRepairBlockerText(state) {
  const pending = pendingEntries(state)
  const indeterminate = indeterminateEntries(state)
  const overflowed = verificationOverflowed(state)
  if (pending.length === 0 && indeterminate.length === 0 && !overflowed) return ''
  if (pending.length === 0) {
    return [
      ...indeterminate.map((entry) => (
        `Task verification could not produce a conclusive result (${entry.kind}@${entry.cwd} via ${entry.commandScope || entry.tool || 'project check'}) [${entry.code}]: ${entry.message}`
      )),
      overflowed
        ? 'Task verification state exceeded its bounded capacity [TASK_VERIFICATION_STATE_OVERFLOW].'
        : '',
      indeterminate.length > 0
        ? `Required check epoch: ${Math.max(...indeterminate.map((entry) => entry.requiredEpoch))}.`
        : '',
      'The applied file changes were preserved, but the task was not marked complete.',
    ].filter(Boolean).join(' ')
  }
  const failedChecks = pending
    .map((entry) => `${entry.kind}@${entry.cwd} via ${entry.commandScope || entry.tool || 'project check'}`)
    .join(', ')
  const last = [...pending].sort((left, right) => right.failures - left.failures)[0]
  const failureCount = Math.max(last.failures, Number(state.consecutiveFailures) || 0)
  if (failureCount === 0) {
    return [
      `Task verification was not rerun after the latest related mutation (${failedChecks}).`,
      indeterminate.length > 0
        ? `Some verification attempts remain inconclusive: ${indeterminate.map((entry) => `[${entry.code}] ${entry.message}`).join('; ')}`
        : '',
      overflowed ? 'Verification state capacity was exceeded.' : '',
      `Required check epoch: ${Math.max(...pending.map((entry) => entry.requiredEpoch))}.`,
      'The applied file changes were preserved, but the task was not marked complete.',
    ].filter(Boolean).join(' ')
  }
  return [
    `Task verification did not pass after ${failureCount} verification failures (${failedChecks}).`,
    `Last failure [${last.code}]: ${last.message}`,
    indeterminate.length > 0
      ? `Some reruns remain inconclusive: ${indeterminate.map((entry) => `[${entry.code}] ${entry.message}`).join('; ')}.`
      : '',
    overflowed ? 'Verification state capacity was exceeded.' : '',
    'The applied file changes were preserved, but the task was not marked complete.',
  ].filter(Boolean).join(' ')
}
