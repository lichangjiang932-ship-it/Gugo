import { redactSensitiveText } from '../../utils/toolCallHarness.js'
import { PROJECT_SCOPE_TARGET } from './heuristics/constants.js'
import { normalizeMutationTarget } from './heuristics/mutationClassification.js'
import { diagnosticPaths, relatedMutationTargets } from './taskVerificationAttribution.js'
import {
  normalizeCheckKind,
  normalizeScopePath,
  taskVerificationScopes,
} from './taskVerificationCheckScope.js'

export { taskVerificationKinds } from './taskVerificationCheckScope.js'

const TASK_VERIFICATION_REPAIR_MARKER = '[TASK VERIFICATION REPAIR REQUIRED]'
const MAX_TASK_VERIFICATION_FAILURES = 3
const MAX_PENDING_TASK_VERIFICATIONS = 8
const MAX_TASK_VERIFICATION_CANDIDATES = 8
const MAX_TASK_VERIFICATION_MUTATION_TARGETS = 64

const FAILURE_PENDING_REASON = 'verification_failed'
const PRE_MUTATION_FAILURE_PENDING_REASON = 'failure_before_mutation'
const STALE_SUCCESS_PENDING_REASON = 'mutation_after_success'

const NON_VERDICT_CODES = new Set([
  'approval_denied',
  'tool_budget_exceeded',
  'tool_execution_skipped',
  'tool_execution_superseded_by_steering',
  'tool_arguments_invalid',
  'tool_arguments_validation_failed',
  'tool_call_parse_error',
  'side_effect_outcome_unknown',
  'side_effect_ledger_conflict',
])

function normalizeBatchId(value) {
  return String(value || '').trim().slice(0, 2_000)
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

function isDeterministicFailure(result) {
  if (result?.ok !== false
    || result?.timedOut === true
    || result?.cancelled === true
    || result?.denied === true
    || result?.policyDenied === true
    || result?.systemFailure === true
    || result?.requiresUserVerification === true
    || result?.retryable === true) return false
  const code = String(result?.code || '').trim().toLowerCase()
  if (NON_VERDICT_CODES.has(code)
    || /(?:timeout|cancel|denied|permission|authori[sz]|unknown|conflict|invalid|parse)/iu.test(code)) {
    return false
  }
  const exitCode = Number(result?.exitCode)
  return result?.passed === false || (Number.isInteger(exitCode) && exitCode !== 0)
}

function isDeterministicSuccess(result) {
  if (result?.ok !== true || result?.passed === false || result?.timedOut === true) return false
  if (result?.exitCode == null) return true
  return Number(result.exitCode) === 0
}

function compactDiagnosticText(value, fallback = 'The verification command returned a failing result.') {
  const text = String(value || fallback).trim()
  const compact = [...text].filter((character) => {
    const code = character.codePointAt(0)
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
  }).join('')
  const bounded = compact.length > 1_200 ? compact.slice(-1_200) : compact
  return redactSensitiveText(bounded)
}

function compactFailureMessage(result) {
  const candidates = [result?.stderr, result?.stdout, result?.error]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  return compactDiagnosticText(candidates[0])
}

function normalizeFailure(value, fallbackKind = '') {
  const kind = normalizeCheckKind(value?.kind || fallbackKind)
  const scope = String(value?.scope || '').slice(0, 2_000)
  if (!kind || !scope) return null
  const [, legacyCwd = '.', legacyCommandScope = ''] = scope.split('\u0000')
  const reason = [
    FAILURE_PENDING_REASON,
    PRE_MUTATION_FAILURE_PENDING_REASON,
    STALE_SUCCESS_PENDING_REASON,
  ].includes(value?.reason)
    ? value.reason
    : FAILURE_PENDING_REASON
  const defaultFailures = reason === FAILURE_PENDING_REASON ? 1 : 0
  return {
    kind,
    scope,
    cwd: normalizeScopePath(value?.cwd || legacyCwd),
    commandScope: String(value?.commandScope || legacyCommandScope).slice(0, 1_000),
    scopeLabel: String(value?.scopeLabel || `${value?.tool || 'project check'}:${kind}`)
      .slice(0, 300),
    failures: Math.min(
      MAX_TASK_VERIFICATION_FAILURES,
      Math.max(0, Math.floor(Number(value?.failures) || defaultFailures)),
    ),
    reason,
    requiredEpoch: normalizeEpoch(value?.requiredEpoch || value?.mutationEpoch),
    diagnosticPaths: normalizePathList(value?.diagnosticPaths),
    mutationTargets: normalizePathList(value?.mutationTargets),
    tool: String(value?.tool || '').slice(0, 120),
    code: String(value?.code || 'task_verification_failed').slice(0, 160),
    message: compactDiagnosticText(
      value?.message,
      reason === STALE_SUCCESS_PENDING_REASON
        ? 'The check passed before a later related mutation and must be rerun.'
        : 'The verification command returned a failing result.',
    ),
    lastFailureBatchId: normalizeBatchId(value?.lastFailureBatchId),
  }
}

function normalizeCandidate(value) {
  const normalized = normalizeFailure({
    ...value,
    reason: PRE_MUTATION_FAILURE_PENDING_REASON,
    failures: 0,
  }, value?.kind)
  if (!normalized) return null
  return {
    ...normalized,
    observedEpoch: normalizeEpoch(value?.observedEpoch),
  }
}

function normalizeVerified(value) {
  const kind = normalizeCheckKind(value?.kind)
  const scope = String(value?.scope || '').slice(0, 2_000)
  if (!kind || !scope) return null
  const [, legacyCwd = '.', legacyCommandScope = ''] = scope.split('\u0000')
  return {
    kind,
    scope,
    cwd: normalizeScopePath(value?.cwd || legacyCwd),
    commandScope: String(value?.commandScope || legacyCommandScope).slice(0, 1_000),
    scopeLabel: String(value?.scopeLabel || `${kind}@${legacyCwd}`).slice(0, 300),
    verifiedEpoch: normalizeEpoch(value?.verifiedEpoch),
  }
}

function restoreEntryMap(value, normalizer, limit) {
  const entries = new Map()
  for (const entry of (Array.isArray(value) ? value : []).slice(-limit)) {
    const normalized = normalizer(entry)
    if (normalized) entries.set(normalized.scope, normalized)
  }
  return entries
}

function restoreMutationTargets(value) {
  const targets = new Map()
  for (const entry of (Array.isArray(value) ? value : [])
    .slice(-MAX_TASK_VERIFICATION_MUTATION_TARGETS)) {
    const target = normalizeMutationTarget(entry?.target || entry)
    if (!target) continue
    targets.set(target, normalizeEpoch(entry?.epoch))
  }
  return targets
}

export function restoreTaskVerificationRepair(value = {}) {
  const pending = restoreEntryMap(value?.pending, normalizeFailure, MAX_PENDING_TASK_VERIFICATIONS)
  const candidates = restoreEntryMap(
    value?.candidates,
    normalizeCandidate,
    MAX_TASK_VERIFICATION_CANDIDATES,
  )
  const verified = restoreEntryMap(
    value?.verified,
    normalizeVerified,
    MAX_PENDING_TASK_VERIFICATIONS,
  )
  const mutationTargets = restoreMutationTargets(value?.mutationTargets)
  const mutationEpoch = Math.max(
    normalizeEpoch(value?.mutationEpoch),
    ...[...mutationTargets.values()],
    ...[...pending.values()].map((entry) => entry.requiredEpoch),
    ...[...verified.values()].map((entry) => entry.verifiedEpoch),
  )
  return {
    pending,
    candidates,
    verified,
    mutationEpoch,
    mutationTargets,
    consecutiveFailures: Math.min(
      MAX_TASK_VERIFICATION_FAILURES,
      Math.max(0, Math.floor(Number(value?.consecutiveFailures) || 0)),
    ),
    lastFailureBatchId: normalizeBatchId(value?.lastFailureBatchId),
  }
}

export function serializeTaskVerificationRepair(value = {}) {
  return {
    pending: [...(value.pending instanceof Map ? value.pending.values() : [])]
      .slice(-MAX_PENDING_TASK_VERIFICATIONS)
      .map((entry) => ({ ...entry })),
    candidates: [...(value.candidates instanceof Map ? value.candidates.values() : [])]
      .slice(-MAX_TASK_VERIFICATION_CANDIDATES)
      .map((entry) => ({ ...entry })),
    verified: [...(value.verified instanceof Map ? value.verified.values() : [])]
      .slice(-MAX_PENDING_TASK_VERIFICATIONS)
      .map((entry) => ({ ...entry })),
    mutationEpoch: normalizeEpoch(value.mutationEpoch),
    mutationTargets: [...(value.mutationTargets instanceof Map ? value.mutationTargets : [])]
      .slice(-MAX_TASK_VERIFICATION_MUTATION_TARGETS)
      .map(([target, epoch]) => ({ target, epoch: normalizeEpoch(epoch) })),
    consecutiveFailures: Math.min(
      MAX_TASK_VERIFICATION_FAILURES,
      Math.max(0, Math.floor(Number(value?.consecutiveFailures) || 0)),
    ),
    lastFailureBatchId: normalizeBatchId(value?.lastFailureBatchId),
  }
}

export function observeTaskVerificationRepair(state, call, result, {
  mutationObserved = false,
  batchId = '',
  workspaceRoot = '',
} = {}) {
  const scopes = taskVerificationScopes(call, result)
  if (!(state?.pending instanceof Map)
    || !(state?.candidates instanceof Map)
    || !(state?.verified instanceof Map)
    || !(state?.mutationTargets instanceof Map)
    || scopes.length === 0) {
    return { changed: false, failed: false, cleared: [] }
  }

  if (mutationObserved && state.mutationEpoch === 0) {
    state.mutationEpoch = 1
    state.mutationTargets.set(PROJECT_SCOPE_TARGET, state.mutationEpoch)
  }
  const currentEpoch = normalizeEpoch(state.mutationEpoch)

  if (isDeterministicSuccess(result)) {
    const cleared = []
    for (const scope of scopes) {
      state.candidates.delete(scope.scope)
      const pending = state.pending.get(scope.scope)
      if (pending && currentEpoch >= pending.requiredEpoch) {
        state.pending.delete(scope.scope)
        cleared.push(scope)
      }
      state.verified.set(scope.scope, normalizeVerified({
        ...scope,
        verifiedEpoch: currentEpoch,
      }))
    }
    if (cleared.length > 0 && state.pending.size === 0) {
      state.consecutiveFailures = 0
      state.lastFailureBatchId = ''
    }
    return { changed: cleared.length > 0, failed: false, cleared }
  }
  if (!isDeterministicFailure(result)) {
    return { changed: false, failed: false, cleared: [] }
  }

  const tool = String(call?.name || '').trim()
  const code = String(result?.code || `task_${scopes[0].kind}_failed`)
  const message = compactFailureMessage(result)
  const failurePaths = diagnosticPaths(result)
  for (const scope of scopes) {
    if (!state.candidates.has(scope.scope)
      && state.candidates.size >= MAX_TASK_VERIFICATION_CANDIDATES) continue
    state.candidates.set(scope.scope, normalizeCandidate({
      ...scope,
      tool,
      code,
      message,
      diagnosticPaths: failurePaths,
      observedEpoch: currentEpoch,
    }))
    state.verified.delete(scope.scope)
  }

  const recordedMutationTargets = [...state.mutationTargets.keys()]
  // A diagnostic path identifies where a failure surfaced, not every source
  // file that can repair it. Keep cwd as the safety boundary and conservatively
  // invalidate the check for any mutation inside that scope.
  const relatedScopes = (mutationObserved || currentEpoch > 0)
    ? scopes.map((scope) => ({
        ...scope,
        mutationTargets: relatedMutationTargets(
          scope,
          [],
          recordedMutationTargets,
          workspaceRoot,
        ),
      })).filter((scope) => scope.mutationTargets.length > 0)
    : []
  if (relatedScopes.length === 0) {
    return { changed: false, failed: false, cleared: [], candidateRecorded: true }
  }

  const normalizedBatchId = normalizeBatchId(batchId)
  const alreadyCountedBatch = Boolean(
    normalizedBatchId && state.lastFailureBatchId === normalizedBatchId,
  )
  if (!alreadyCountedBatch) {
    state.consecutiveFailures = Math.min(
      MAX_TASK_VERIFICATION_FAILURES,
      Math.max(0, Number(state.consecutiveFailures) || 0) + 1,
    )
    state.lastFailureBatchId = normalizedBatchId
  }
  for (const { kind, cwd, commandScope, scope, scopeLabel, mutationTargets } of relatedScopes) {
    const previous = state.pending.get(scope)
    if (!previous && state.pending.size >= MAX_PENDING_TASK_VERIFICATIONS) continue
    const scopeAlreadyCounted = Boolean(
      normalizedBatchId && previous?.lastFailureBatchId === normalizedBatchId,
    )
    state.pending.set(scope, normalizeFailure({
      kind,
      cwd,
      commandScope,
      scope,
      scopeLabel,
      failures: Number(previous?.failures || 0) + (scopeAlreadyCounted ? 0 : 1),
      reason: FAILURE_PENDING_REASON,
      requiredEpoch: currentEpoch,
      diagnosticPaths: failurePaths,
      mutationTargets,
      tool,
      code,
      message,
      lastFailureBatchId: normalizedBatchId,
    }, kind))
    state.candidates.delete(scope)
  }
  return {
    changed: true,
    failed: true,
    cleared: [],
    kinds: relatedScopes.map(({ kind }) => kind),
  }
}

export function observeTaskVerificationMutation(state, targets, { workspaceRoot = '' } = {}) {
  if (!(state?.pending instanceof Map)
    || !(state?.candidates instanceof Map)
    || !(state?.verified instanceof Map)
    || !(state?.mutationTargets instanceof Map)) {
    return { changed: false, promoted: [], invalidated: [] }
  }
  const normalizedTargets = normalizePathList(
    targets instanceof Set ? [...targets] : targets,
    MAX_TASK_VERIFICATION_MUTATION_TARGETS,
  )
  if (normalizedTargets.length === 0) {
    return { changed: false, promoted: [], invalidated: [] }
  }

  state.mutationEpoch = normalizeEpoch(state.mutationEpoch) + 1
  const currentEpoch = state.mutationEpoch
  for (const target of normalizedTargets) {
    state.mutationTargets.delete(target)
    state.mutationTargets.set(target, currentEpoch)
  }
  while (state.mutationTargets.size > MAX_TASK_VERIFICATION_MUTATION_TARGETS) {
    state.mutationTargets.delete(state.mutationTargets.keys().next().value)
  }

  const promoted = []
  for (const candidate of [...state.candidates.values()]) {
    const related = relatedMutationTargets(
      candidate,
      [],
      normalizedTargets,
      workspaceRoot,
    )
    if (related.length === 0) continue
    const previous = state.pending.get(candidate.scope)
    if (!previous && state.pending.size >= MAX_PENDING_TASK_VERIFICATIONS) continue
    state.pending.set(candidate.scope, normalizeFailure({
      ...candidate,
      failures: Number(previous?.failures || 0),
      reason: PRE_MUTATION_FAILURE_PENDING_REASON,
      requiredEpoch: currentEpoch,
      mutationTargets: related,
    }, candidate.kind))
    state.candidates.delete(candidate.scope)
    promoted.push(candidate.scope)
  }

  const invalidated = []
  for (const verified of [...state.verified.values()]) {
    const related = relatedMutationTargets(verified, [], normalizedTargets, workspaceRoot)
    if (related.length === 0) continue
    const previous = state.pending.get(verified.scope)
    if (!previous && state.pending.size >= MAX_PENDING_TASK_VERIFICATIONS) continue
    state.pending.set(verified.scope, normalizeFailure({
      ...verified,
      failures: Number(previous?.failures || 0),
      reason: previous?.reason === FAILURE_PENDING_REASON
        ? FAILURE_PENDING_REASON
        : STALE_SUCCESS_PENDING_REASON,
      requiredEpoch: currentEpoch,
      mutationTargets: related,
      tool: previous?.tool,
      code: previous?.code || 'task_verification_stale',
      message: previous?.message
        || 'The check passed before a later related mutation and must be rerun.',
    }, verified.kind))
    state.verified.delete(verified.scope)
    invalidated.push(verified.scope)
  }

  for (const pending of [...state.pending.values()]) {
    const related = relatedMutationTargets(
      pending,
      [],
      normalizedTargets,
      workspaceRoot,
    )
    if (related.length === 0) continue
    state.pending.set(pending.scope, normalizeFailure({
      ...pending,
      requiredEpoch: currentEpoch,
      mutationTargets: [...new Set([...pending.mutationTargets, ...related])],
    }, pending.kind))
  }

  return {
    changed: promoted.length > 0 || invalidated.length > 0,
    promoted,
    invalidated,
    mutationEpoch: currentEpoch,
  }
}

export function hasPendingTaskVerificationRepair(state) {
  return state?.pending instanceof Map && state.pending.size > 0
}

export function taskVerificationRepairExhausted(state) {
  return state?.pending instanceof Map
    && (Number(state.consecutiveFailures || 0) >= MAX_TASK_VERIFICATION_FAILURES
      || [...state.pending.values()].some((entry) => (
        Number(entry?.failures || 0) >= MAX_TASK_VERIFICATION_FAILURES
      )))
}

export function buildTaskVerificationRepairPrompt(state) {
  const pending = state?.pending instanceof Map ? [...state.pending.values()] : []
  if (pending.length === 0) return ''
  const failed = pending.filter((entry) => entry.reason === FAILURE_PENDING_REASON)
  const rerunOnly = pending.filter((entry) => entry.reason !== FAILURE_PENDING_REASON)
  return [
    TASK_VERIFICATION_REPAIR_MARKER,
    failed.length > 0
      ? `Post-mutation project verification is failing: ${failed.map((entry) => entry.kind).join(', ')}.`
      : `Related project verification must be rerun after the latest mutation: ${rerunOnly.map((entry) => entry.kind).join(', ')}.`,
    failed.length > 0
      ? 'Treat the exact tool output as actionable feedback. Inspect the failing assertion or diagnostic, correct the implementation with the available tools, then rerun every pending check.'
      : 'The latest related change invalidated earlier verification evidence. Rerun every pending check before completing the task.',
    'A file read, directory listing, or diff cannot clear a failed test/lint/build result. Do not claim completion while any pending check remains.',
    ...pending.map((entry) => entry.reason === FAILURE_PENDING_REASON
      ? `${entry.kind} remains pending after verification failure ${entry.failures}/${MAX_TASK_VERIFICATION_FAILURES}. Read the preceding tool-role result for diagnostics and rerun the same check scope after correcting the implementation.`
      : `${entry.kind} has no verification result for mutation epoch ${entry.requiredEpoch}; rerun the same check scope.`,
    ),
  ].join('\n')
}

export function taskVerificationRepairBlockerText(state) {
  const pending = state?.pending instanceof Map ? [...state.pending.values()] : []
  if (pending.length === 0) return ''
  const failedChecks = pending.map((entry) => entry.kind).join(', ')
  const last = pending.sort((left, right) => right.failures - left.failures)[0]
  const failureCount = Math.max(last.failures, Number(state.consecutiveFailures) || 0)
  if (failureCount === 0) {
    return [
      `Task verification was not rerun after the latest related mutation (${failedChecks}).`,
      `Required check epoch: ${Math.max(...pending.map((entry) => entry.requiredEpoch))}.`,
      'The applied file changes were preserved, but the task was not marked complete.',
    ].join(' ')
  }
  return [
    `Task verification did not pass after ${failureCount} verification failures (${failedChecks}).`,
    `Last failure: ${last.message}`,
    'The applied file changes were preserved, but the task was not marked complete.',
  ].join(' ')
}

export {
  MAX_TASK_VERIFICATION_FAILURES,
  TASK_VERIFICATION_REPAIR_MARKER,
}
