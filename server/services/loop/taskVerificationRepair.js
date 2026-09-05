import { projectVerificationFields } from '../../utils/processExecutionFailure.js'
import { PROJECT_SCOPE_TARGET } from './heuristics/constants.js'
import { diagnosticPaths, relatedMutationTargets } from './taskVerificationAttribution.js'
import { compactVerificationFailure, isDeterministicVerificationFailure, isDeterministicVerificationSuccess } from './taskVerificationResult.js'
import { buildTaskVerificationRepairPrompt, hasPendingTaskVerificationRepair, MAX_TASK_VERIFICATION_FAILURES, TASK_VERIFICATION_REPAIR_MARKER, taskVerificationRepairBlockerText, taskVerificationRepairDetails, taskVerificationRepairExhausted } from './taskVerificationRepairPresentation.js'
import {
  taskVerificationScopes,
} from './taskVerificationCheckScope.js'
import {
  FAILURE_PENDING_REASON,
  clearCoveredVerificationOverflow,
  markVerificationOverflow,
  MAX_PENDING_TASK_VERIFICATIONS,
  MAX_TASK_VERIFICATION_CANDIDATES,
  MAX_TASK_VERIFICATION_EPOCH,
  MAX_TASK_VERIFICATION_INDETERMINATES,
  MAX_TASK_VERIFICATION_MUTATION_TARGETS,
  MAX_TASK_VERIFICATION_VERIFIED,
  normalizeBatchId,
  normalizeCandidate,
  normalizeEpoch,
  normalizeFailure,
  normalizeIndeterminate,
  normalizePathList,
  normalizeScopeDescriptor,
  normalizeVerified,
  PRE_MUTATION_FAILURE_PENDING_REASON,
  relatedVerificationScopes,
  STALE_SUCCESS_PENDING_REASON,
  syncLastIndeterminate,
  verificationScopeCovers,
} from './taskVerificationRepairState.js'

export { taskVerificationKinds } from './taskVerificationCheckScope.js'
export {
  restoreTaskVerificationRepair,
  serializeTaskVerificationRepair,
} from './taskVerificationRepairState.js'

function recordSuccessfulVerification(state, scopes, currentEpoch, workspaceRoot) {
  const cleared = []
  let indeterminateCleared = false
  let overflowCleared = false
  for (const scope of scopes) {
    overflowCleared = clearCoveredVerificationOverflow(state, scope, workspaceRoot) || overflowCleared
    for (const [candidateKey, candidate] of [...state.candidates]) {
      if (verificationScopeCovers(scope, candidate, workspaceRoot)) state.candidates.delete(candidateKey)
    }
    for (const [pendingKey, pending] of [...state.pending]) {
      if (currentEpoch >= pending.requiredEpoch
        && verificationScopeCovers(scope, pending, workspaceRoot)) {
        state.pending.delete(pendingKey)
        cleared.push(pending)
      }
    }
    for (const [verifiedKey, verified] of [...state.verified]) {
      if (verificationScopeCovers(scope, verified, workspaceRoot)) state.verified.delete(verifiedKey)
    }
    const verified = normalizeVerified({ ...scope, verifiedEpoch: currentEpoch })
    if (verified) {
      if (!state.verified.has(verified.scope)
        && state.verified.size >= MAX_TASK_VERIFICATION_VERIFIED) {
        markVerificationOverflow(state, verified)
      } else {
        state.verified.set(verified.scope, verified)
      }
    }
    for (const [key, indeterminate] of [...state.indeterminate]) {
      if (verificationScopeCovers(scope, indeterminate, workspaceRoot)) {
        state.indeterminate.delete(key)
        indeterminateCleared = true
      }
    }
  }
  syncLastIndeterminate(state)
  if ((cleared.length > 0 || indeterminateCleared || overflowCleared)
    && state.pending.size === 0
    && state.indeterminate.size === 0
    && !state.verificationOverflowed) {
    state.consecutiveFailures = 0
    state.lastFailureBatchId = ''
  }
  return {
    changed: cleared.length > 0 || indeterminateCleared || overflowCleared,
    failed: false,
    cleared,
  }
}

function recordIndeterminateVerification({
  state, scopes, projectedResult, currentEpoch, mutationObserved, workspaceRoot, call,
}) {
  const recordedMutationTargets = [...state.mutationTargets.keys()]
  const relatedScopes = (mutationObserved || currentEpoch > 0)
    ? relatedVerificationScopes(scopes, recordedMutationTargets, workspaceRoot)
    : []
  if (relatedScopes.length === 0) {
    return { changed: false, failed: false, indeterminate: true, cleared: [] }
  }
  const tool = String(call?.name || '').trim()
  const code = String(projectedResult.code
    || (projectedResult.timedOut ? 'COMMAND_TIMEOUT' : '')
    || (projectedResult.cancelled ? 'COMMAND_CANCELLED' : '')
    || 'VERIFICATION_INDETERMINATE')
  const message = compactVerificationFailure(
    projectedResult,
    'The verification environment did not produce a conclusive result.',
  )
  let recorded = false
  for (const scope of relatedScopes) {
    const indeterminate = normalizeIndeterminate({
      ...scope,
      requiredEpoch: currentEpoch,
      mutationTargets: scope.mutationTargets,
      tool,
      code,
      message,
    })
    if (!indeterminate) continue
    if (!state.indeterminate.has(indeterminate.scope)
      && state.indeterminate.size >= MAX_TASK_VERIFICATION_INDETERMINATES) {
      markVerificationOverflow(state, indeterminate)
      continue
    }
    state.indeterminate.delete(indeterminate.scope)
    state.indeterminate.set(indeterminate.scope, indeterminate)
    recorded = true
  }
  syncLastIndeterminate(state)
  return {
    changed: recorded,
    failed: false,
    indeterminate: true,
    cleared: [],
    kinds: relatedScopes.map(({ kind }) => kind),
  }
}

export function observeTaskVerificationRepair(state, call, result, {
  mutationObserved = false,
  batchId = '',
  workspaceRoot = '',
} = {}) {
  const scopes = taskVerificationScopes(call, result)
    .map((scope) => normalizeScopeDescriptor(scope))
    .filter(Boolean)
  if (!(state?.pending instanceof Map)
    || !(state?.candidates instanceof Map)
    || !(state?.verified instanceof Map)
    || !(state?.indeterminate instanceof Map)
    || !(state?.mutationTargets instanceof Map)
    || scopes.length === 0) {
    return { changed: false, failed: false, cleared: [] }
  }

  if (mutationObserved && state.mutationEpoch === 0) {
    state.mutationEpoch = 1
    state.mutationTargets.set(PROJECT_SCOPE_TARGET, state.mutationEpoch)
    while (state.mutationTargets.size > MAX_TASK_VERIFICATION_MUTATION_TARGETS) {
      state.mutationTargets.clear()
      state.mutationTargets.set(PROJECT_SCOPE_TARGET, state.mutationEpoch)
    }
  }
  const currentEpoch = normalizeEpoch(state.mutationEpoch)
  const projectedResult = { ...(result || {}), ...projectVerificationFields(result) }

  if (isDeterministicVerificationSuccess(projectedResult)) {
    return recordSuccessfulVerification(state, scopes, currentEpoch, workspaceRoot)
  }
  if (!isDeterministicVerificationFailure(projectedResult)) {
    return recordIndeterminateVerification({
      state,
      scopes,
      projectedResult,
      currentEpoch,
      mutationObserved,
      workspaceRoot,
      call,
    })
  }

  const tool = String(call?.name || '').trim()
  const code = String(projectedResult.code || `task_${scopes[0].kind}_failed`)
  const message = compactVerificationFailure(projectedResult)
  const failurePaths = diagnosticPaths(projectedResult)
  for (const [indeterminateKey, indeterminate] of [...state.indeterminate]) {
    if (scopes.some((scope) => verificationScopeCovers(scope, indeterminate, workspaceRoot))) {
      state.indeterminate.delete(indeterminateKey)
    }
  }
  syncLastIndeterminate(state)
  for (const scope of scopes) {
    const candidate = normalizeCandidate({
      ...scope,
      tool,
      code,
      message,
      diagnosticPaths: failurePaths,
      observedEpoch: currentEpoch,
    })
    if (!candidate) continue
    if (!state.candidates.has(candidate.scope)
      && state.candidates.size >= MAX_TASK_VERIFICATION_CANDIDATES) {
      markVerificationOverflow(state, candidate)
      continue
    }
    state.candidates.set(candidate.scope, candidate)
    state.verified.delete(candidate.scope)
  }

  const recordedMutationTargets = [...state.mutationTargets.keys()]
  // A diagnostic path identifies where a failure surfaced, not every source
  // file that can repair it. Keep cwd as the safety boundary and conservatively
  // invalidate the check for any mutation inside that scope.
  const relatedScopes = (mutationObserved || currentEpoch > 0)
    ? relatedVerificationScopes(scopes, recordedMutationTargets, workspaceRoot)
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
  for (const {
    kind,
    cwd,
    commandScope,
    verifierFamily,
    coverage,
    scope,
    scopeLabel,
    mutationTargets,
  } of relatedScopes) {
    const previous = state.pending.get(scope)
    if (!previous && state.pending.size >= MAX_PENDING_TASK_VERIFICATIONS) {
      markVerificationOverflow(state, {
        kind,
        cwd,
        commandScope,
        verifierFamily,
        coverage,
        scope,
        scopeLabel,
      })
      continue
    }
    const scopeAlreadyCounted = Boolean(
      normalizedBatchId && previous?.lastFailureBatchId === normalizedBatchId,
    )
    const normalized = normalizeFailure({
      kind,
      cwd,
      commandScope,
      verifierFamily,
      coverage,
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
    }, kind)
    if (normalized) {
      state.pending.set(normalized.scope, normalized)
      state.candidates.delete(normalized.scope)
    }
  }
  return {
    changed: true,
    failed: true,
    cleared: [],
    kinds: relatedScopes.map(({ kind }) => kind),
  }
}

function recordMutationEpochAndTargets(state, normalizedTargets, targetsOverflowed) {
  const previousEpoch = normalizeEpoch(state.mutationEpoch)
  if (previousEpoch >= MAX_TASK_VERIFICATION_EPOCH) {
    // Never wrap: stale verification must not clear newer debt.
    markVerificationOverflow(state)
    state.mutationEpoch = MAX_TASK_VERIFICATION_EPOCH
  } else {
    state.mutationEpoch = previousEpoch + 1
  }
  const currentEpoch = state.mutationEpoch
  if (targetsOverflowed || state.mutationTargets.has(PROJECT_SCOPE_TARGET)) {
    state.mutationTargets.clear()
    state.mutationTargets.set(PROJECT_SCOPE_TARGET, currentEpoch)
    return currentEpoch
  }
  for (const target of normalizedTargets) {
    state.mutationTargets.delete(target)
    state.mutationTargets.set(target, currentEpoch)
  }
  if (state.mutationTargets.size > MAX_TASK_VERIFICATION_MUTATION_TARGETS) {
    state.mutationTargets.clear()
    state.mutationTargets.set(PROJECT_SCOPE_TARGET, currentEpoch)
  }
  return currentEpoch
}

export function observeTaskVerificationMutation(state, targets, { workspaceRoot = '' } = {}) {
  if (!(state?.pending instanceof Map)
    || !(state?.candidates instanceof Map)
    || !(state?.verified instanceof Map)
    || !(state?.indeterminate instanceof Map)
    || !(state?.mutationTargets instanceof Map)) {
    return { changed: false, promoted: [], invalidated: [] }
  }
  const observedTargets = normalizePathList(
    targets instanceof Set ? [...targets] : targets,
    MAX_TASK_VERIFICATION_MUTATION_TARGETS + 1,
  )
  const mutationTargetsOverflowed = observedTargets.length > MAX_TASK_VERIFICATION_MUTATION_TARGETS
  const normalizedTargets = mutationTargetsOverflowed
    ? [PROJECT_SCOPE_TARGET]
    : observedTargets
  if (normalizedTargets.length === 0) {
    return { changed: false, promoted: [], invalidated: [] }
  }

  const currentEpoch = recordMutationEpochAndTargets(
    state,
    normalizedTargets,
    mutationTargetsOverflowed,
  )

  const promoted = []
  for (const candidate of [...state.candidates.values()]) {
    const related = relatedMutationTargets(
      candidate,
      candidate.coverage === 'targeted' ? candidate.targetPaths : [],
      normalizedTargets,
      workspaceRoot,
    )
    if (related.length === 0) continue
    const previous = state.pending.get(candidate.scope)
    if (!previous && state.pending.size >= MAX_PENDING_TASK_VERIFICATIONS) {
      markVerificationOverflow(state, candidate)
      continue
    }
    const normalized = normalizeFailure({
      ...candidate,
      failures: Number(previous?.failures || 0),
      reason: PRE_MUTATION_FAILURE_PENDING_REASON,
      requiredEpoch: currentEpoch,
      mutationTargets: related,
    }, candidate.kind)
    if (!normalized) continue
    state.pending.set(normalized.scope, normalized)
    state.candidates.delete(normalized.scope)
    promoted.push(normalized.scope)
  }

  const invalidated = []
  for (const verified of [...state.verified.values()]) {
    const related = relatedMutationTargets(
      verified,
      verified.coverage === 'targeted' ? verified.targetPaths : [],
      normalizedTargets,
      workspaceRoot,
    )
    if (related.length === 0) continue
    const previous = state.pending.get(verified.scope)
    if (!previous && state.pending.size >= MAX_PENDING_TASK_VERIFICATIONS) {
      markVerificationOverflow(state, verified)
      continue
    }
    const normalized = normalizeFailure({
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
    }, verified.kind)
    if (!normalized) continue
    state.pending.set(normalized.scope, normalized)
    state.verified.delete(normalized.scope)
    invalidated.push(normalized.scope)
  }

  for (const pending of [...state.pending.values()]) {
    const related = relatedMutationTargets(
      pending,
      pending.coverage === 'targeted' ? pending.targetPaths : [],
      normalizedTargets,
      workspaceRoot,
    )
    if (related.length === 0) continue
    const normalized = normalizeFailure({
      ...pending,
      requiredEpoch: currentEpoch,
      mutationTargets: [...new Set([...pending.mutationTargets, ...related])],
    }, pending.kind)
    if (normalized) state.pending.set(normalized.scope, normalized)
  }

  let indeterminateInvalidated = false
  for (const [indeterminateKey, indeterminate] of [...state.indeterminate]) {
    const related = relatedMutationTargets(
      indeterminate,
      indeterminate.coverage === 'targeted'
        ? indeterminate.targetPaths
        : [],
      normalizedTargets,
      workspaceRoot,
    )
    if (related.length > 0) {
      const normalized = normalizeIndeterminate({
        ...indeterminate,
        requiredEpoch: currentEpoch,
        mutationTargets: [
          ...new Set([...indeterminate.mutationTargets, ...related]),
        ],
      })
      if (normalized) state.indeterminate.set(indeterminateKey, normalized)
      indeterminateInvalidated = true
    }
  }
  syncLastIndeterminate(state)

  return {
    changed: promoted.length > 0 || invalidated.length > 0 || indeterminateInvalidated,
    promoted,
    invalidated,
    mutationEpoch: currentEpoch,
  }
}

export {
  buildTaskVerificationRepairPrompt,
  hasPendingTaskVerificationRepair,
  MAX_TASK_VERIFICATION_FAILURES,
  TASK_VERIFICATION_REPAIR_MARKER,
  taskVerificationRepairBlockerText,
  taskVerificationRepairDetails,
  taskVerificationRepairExhausted,
}
