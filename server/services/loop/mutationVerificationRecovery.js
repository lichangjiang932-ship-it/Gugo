import { createHash } from 'node:crypto'
import { modelAssistantHistoryMessage } from './modelAssistantHistory.js'
import { getDynamicToolRegistrationId } from '../../utils/toolSchemaDynamicRegistry.js'
import { getBoundRuntimeTool } from '../../core/runtimeCapabilityState.js'
import { getBuiltinSpec, getToolMetadata } from '../../utils/toolSchemaCatalog.js'

export const MAX_AUTOMATIC_VERIFICATION_CALLS = 24
const MAX_TARGET_ATTEMPTS = 2
const MAX_BATCH_CALLS = 4
const HASH = /^[a-f0-9]{64}$/u

function freshState(generation = 0) {
  return { version: 1, generation, totalCalls: 0, completedCalls: 0, progressEvents: 0, pendingCount: 0, iterationLimit: 0, attempts: [], blockedFingerprints: [] }
}

export function restoreMutationVerificationRecovery(value) {
  if (value == null) return freshState()
  const invalid = () => ({ ...freshState(), totalCalls: MAX_AUTOMATIC_VERIFICATION_CALLS, invalid: true })
  if (value.version !== 1 || value.invalid === true || !Array.isArray(value.attempts)
    || value.attempts.length > MAX_AUTOMATIC_VERIFICATION_CALLS) return invalid()
  const state = freshState()
  for (const key of ['generation', 'totalCalls', 'completedCalls', 'progressEvents', 'pendingCount', 'iterationLimit']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return invalid()
    state[key] = value[key]
  }
  if (state.totalCalls > MAX_AUTOMATIC_VERIFICATION_CALLS || state.completedCalls > state.totalCalls
    || state.progressEvents > state.completedCalls) return invalid()
  const seen = new Set()
  for (const entry of value.attempts) {
    if (!HASH.test(entry?.fingerprint || '') || seen.has(entry.fingerprint)
      || !Number.isInteger(entry.count) || entry.count < 1 || entry.count > MAX_TARGET_ATTEMPTS) return invalid()
    seen.add(entry.fingerprint)
    state.attempts.push({ fingerprint: entry.fingerprint, count: entry.count })
  }
  if (state.attempts.reduce((sum, entry) => sum + entry.count, 0) !== state.totalCalls) return invalid()
  const blocked = value.blockedFingerprints ?? []
  if (!Array.isArray(blocked) || blocked.length > MAX_AUTOMATIC_VERIFICATION_CALLS
    || blocked.some((fingerprint) => !HASH.test(fingerprint))) return invalid()
  state.blockedFingerprints = [...new Set(blocked)]
  return state
}

export function resetMutationVerificationRecovery(value) {
  const previous = restoreMutationVerificationRecovery(value)
  if (previous.generation >= Number.MAX_SAFE_INTEGER) return previous
  return freshState(previous.generation + 1)
}

function pendingCount(s) {
  return (s.pendingMutationTargets?.size || 0) + (s.pendingDeletionTargets?.size || 0)
}

function canonicalReadbackTool(s, name, args) {
  if (!['read_file', 'list_directory'].includes(name)) return false
  const userId = s?.job?.userId || null
  if (getDynamicToolRegistrationId(name, { userId })) return false
  const bound = getBoundRuntimeTool(name)
  if (bound && (bound.name !== name || bound.spec !== getBuiltinSpec(name) || typeof bound.exec === 'function')) return false
  const metadata = getToolMetadata(name, { args, userId })
  return metadata.origin === 'builtin' && metadata.isReadOnly === true
}

function canUseTool(s, name, args) {
  if (!s.activeToolSpecs?.some((spec) => s.d.toolNameFromSpec(spec) === name)
    || s.disabledToolValidationError?.(name)) return false
  try {
    return canonicalReadbackTool(s, name, args)
  } catch { return false }
}

function remainingCallBudget(s) {
  const budget = s.budget?.snapshot?.()
  if (!budget) return 0
  for (const key of ['used', 'maxTotalCalls', 'elapsed', 'maxWallMs', 'modelCalls', 'maxModelCalls', 'modelTokens', 'maxModelTokens']) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 0) return 0
  }
  if (budget.maxWallMs > 0 && budget.elapsed >= budget.maxWallMs) return 0
  if (budget.maxModelCalls > 0 && budget.modelCalls >= budget.maxModelCalls) return 0
  if (budget.maxModelTokens > 0 && budget.modelTokens >= budget.maxModelTokens) return 0
  return Math.max(0, Math.floor(budget.maxTotalCalls - budget.used))
}

function targetEpoch(s, target) {
  let epoch = 0
  for (const [candidate, value] of s.taskVerificationRepair?.mutationTargets || []) {
    if (candidate === s.d.PROJECT_SCOPE_TARGET || s.d.targetsMatch(candidate, target)) epoch = Math.max(epoch, value)
  }
  return epoch
}

function requestFingerprint(s, name, args, target) {
  return createHash('sha256').update(JSON.stringify([name, args, targetEpoch(s, target)])).digest('hex')
}

export function captureMutationVerificationIntent(call, state = null) {
  if (!call?.verificationRecoveryKey) return () => null
  const name = call.name
  const fingerprint = call.verificationRecoveryKey
  const argumentKey = (args) => JSON.stringify(Object.entries(args || {}).sort(([left], [right]) => left.localeCompare(right)))
  const expectedArgs = argumentKey(call.args)
  return (currentName, args) => currentName === name && argumentKey(args) === expectedArgs
    && (!state || state.mutationVerificationRecovery?.attempts.some((entry) => entry.fingerprint === fingerprint))
    && canonicalReadbackTool(state, name, args) ? null : {
    ok: false, denied: true, policyDenied: true, retryable: false,
    code: 'automatic_verification_scope_changed',
    error: 'An automatic readback must retain its canonical builtin implementation, exact tool, path and read scope. The changed call was not executed.',
  }
}

function recoveryPlan(s, state, limit) {
  const ceiling = Math.min(MAX_BATCH_CALLS, MAX_AUTOMATIC_VERIFICATION_CALLS - state.totalCalls, limit)
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) return []
  const proposed = new Map()
  const add = (name, target, args) => {
    if (!canUseTool(s, name, args)) return
    const fingerprint = requestFingerprint(s, name, args, target)
    if (state.blockedFingerprints.includes(fingerprint)) return
    if ((state.attempts.find((entry) => entry.fingerprint === fingerprint)?.count || 0) >= MAX_TARGET_ATTEMPTS) return
    proposed.set(fingerprint, { name, args, fingerprint })
  }
  for (const value of s.pendingMutationTargets || []) {
    const target = s.d.normalizeMutationTarget(value)
    if (!target || target === s.d.PROJECT_SCOPE_TARGET) continue
    add('read_file', target, { path: target })
    if (proposed.size >= ceiling) return [...proposed.values()]
  }
  for (const value of s.pendingDeletionTargets || []) {
    const target = s.d.normalizeMutationTarget(value)
    if (!target || target === s.d.PROJECT_SCOPE_TARGET || target.endsWith('/')) continue
    const separator = target.lastIndexOf('/')
    const parent = separator < 0 ? '.' : separator === 0 ? '/'
      : separator === 2 && /^[a-z]:\//iu.test(target) ? target.slice(0, 3) : target.slice(0, separator)
    // This is the existing schema's maximum, not an invented unbounded list.
    // A larger/truncated directory remains unverified in the outcome recorder.
    add('list_directory', target, { path: parent, limit: 500 })
    if (proposed.size >= ceiling) break
  }
  return [...proposed.values()]
}

/** Schedule host-owned reads through the ordinary checkpoint/permission/tool pipeline. */
export async function scheduleMutationVerificationRecovery(s, {
  content = '', steeringLeaseId = null, atBoundary = false,
} = {}) {
  if (s.signal?.aborted) throw s.signal.reason || Object.assign(new Error('Turn cancelled'), { name: 'AbortError' })
  const state = s.mutationVerificationRecovery
  if (!state || state.invalid || !pendingCount(s) || s.checkpointCalls?.length
    || s.hasPendingTaskVerificationRepair?.() || s.taskVerificationRepairExhausted?.()
    || s.restoredModelInvocation || s.modelInvocation?.status === 'in_flight'
    || s.compactionCheckpoint?.modelInvocation?.status === 'in_flight') return false
  const limit = Math.min(MAX_BATCH_CALLS, MAX_AUTOMATIC_VERIFICATION_CALLS - state.totalCalls, remainingCallBudget(s))
  if (!Number.isSafeInteger(limit) || limit < 1) return false
  const plan = recoveryPlan(s, state, limit)
  if (!plan.length) return false
  const calls = plan.map(({ name, args, fingerprint }) => {
    state.totalCalls += 1
    const entry = state.attempts.find((candidate) => candidate.fingerprint === fingerprint)
    if (entry) entry.count += 1
    else state.attempts.push({ fingerprint, count: 1 })
    const id = 'host_verify_' + createHash('sha256').update(JSON.stringify([
      s.job?.id, s.step?.id, state.generation, state.totalCalls, fingerprint,
    ])).digest('hex').slice(0, 32)
    return { id, type: 'function', function: { name, arguments: JSON.stringify(args) }, verificationRecoveryKey: fingerprint }
  })
  s.checkpointCalls = s.d.normalizeToolCalls(calls, { toolSpecs: s.activeToolSpecs }).map((call, index) => ({
    ...call,
    verificationRecoveryKey: calls[index].verificationRecoveryKey,
    idempotencyKey: s.d.buildJobToolIdempotencyKey({ jobId: s.job?.id, stepId: s.step?.id, toolCallId: call.id }),
    checkpointStatus: 'pending', checkpointApprovalId: null,
    checkpointPolicyProvenance: null, checkpointHookAuthorizationProvenance: null,
  }))
  state.pendingCount = pendingCount(s)
  const neededLimit = s.iter + (atBoundary ? 2 : 3)
  if (neededLimit > s.maxIters) {
    s.maxIters = neededLimit
    state.iterationLimit = neededLimit
  }
  s.finalText = ''
  s.finalCheckpointPersisted = false
  if (content) s.convo.push(modelAssistantHistoryMessage(content, s.iteration?.modelResult))
  s.convo.push({ role: 'system', content: '[POST-MUTATION VERIFICATION REQUIRED] [HOST POST-MUTATION READBACK] The host is checking the exact pending paths with authorized read-only tools. These are verification requests, not proof of success. Read failures, incomplete directory listings and format-validation failures remain pending; do not rerun generation scripts merely to verify an existing file. Pending readback request data: ' + JSON.stringify(plan.map(({ name, args }) => ({ name, args }))) })
  s.convo.push(s.d.buildAssistantToolCallsMessage(s.checkpointCalls, ''))
  s.d.observeToolCalls(s.progressState, s.checkpointCalls)
  // The planned calls and consumed recovery allowance are one durable fence.
  await s.persistTurn({ boundary: 'mutation-verification-scheduled' })
  if (steeringLeaseId) await s.steeringController.acknowledge(steeringLeaseId)
  if (typeof s.onToolCall === 'function') {
    for (const call of s.checkpointCalls) await s.onToolCall(call)
  }
  await s.emitToolProgress('tools_scheduled')
  return true
}

export function recordMutationVerificationRecoveryOutcome(s, call, result) {
  const state = s.mutationVerificationRecovery
  if (!state) return
  // A conclusive format/permission rejection is feedback for repair, not a
  // reason to repeat the same unchanged read. A later target mutation gets a
  // new fingerprint; an explicit manual retry gets a fresh bounded allowance.
  const blockedRead = result?.formatValidated === false || result?.denied === true
    || result?.policyDenied === true || result?.requiresUserVerification === true
    || (result?.extractionStatus && result.extractionStatus !== 'text')
  if (call?.name === 'read_file' && blockedRead) {
    for (const target of s.pendingMutationTargets || []) {
      if (!s.d.targetsMatch(target, call.args?.path)) continue
      const fingerprint = requestFingerprint(s, 'read_file', { path: s.d.normalizeMutationTarget(target) }, target)
      if (!state.blockedFingerprints.includes(fingerprint) && state.blockedFingerprints.length < MAX_AUTOMATIC_VERIFICATION_CALLS) {
        state.blockedFingerprints.push(fingerprint)
      }
    }
  }
  if (!HASH.test(call?.verificationRecoveryKey || '')
    || !state.attempts.some((entry) => entry.fingerprint === call.verificationRecoveryKey)) return
  state.completedCalls = Math.min(state.totalCalls, state.completedCalls + 1)
  const remaining = pendingCount(s)
  if (remaining < state.pendingCount) state.progressEvents += 1
  state.pendingCount = remaining
}
