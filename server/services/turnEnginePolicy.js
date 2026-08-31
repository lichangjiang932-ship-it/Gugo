import {
  TURN_EXECUTION_ENVIRONMENT_MISSING,
  TURN_MODEL_BINDING_DRIFT,
  TURN_PERMISSION_CONTEXT_DRIFT,
  TURN_POLICY_CONTEXT_DRIFT,
  TURN_RUNTIME_PLUGIN_RELEASE_DRIFT,
  TURN_RUNTIME_PLUGIN_RELEASE_UNPINNED,
  TURN_TOOL_CATALOG_DRIFT,
  TURN_TOOL_IMPLEMENTATION_DRIFT,
} from './turnExecutionEnvironment.js'
import { TOOL_IMPLEMENTATION_REVISION_UNAVAILABLE } from './toolImplementationRevision.js'
import { normalizeResolutionPath } from './turnRecoveryProjection.js'
import { createTurnResolutionRuntime, TurnEngineError } from './turnResolutionRuntime.js'
import { normalizeTurnOptionalId as normalizeOptionalId } from './turnStartRuntime.js'

export const MANUAL_RECOVERY_BLOCK_CODES = new Set([
  TURN_EXECUTION_ENVIRONMENT_MISSING,
  TURN_MODEL_BINDING_DRIFT,
  TURN_PERMISSION_CONTEXT_DRIFT,
  TURN_POLICY_CONTEXT_DRIFT,
  TURN_TOOL_CATALOG_DRIFT,
  TURN_TOOL_IMPLEMENTATION_DRIFT,
  TURN_RUNTIME_PLUGIN_RELEASE_DRIFT,
  TURN_RUNTIME_PLUGIN_RELEASE_UNPINNED,
  TOOL_IMPLEMENTATION_REVISION_UNAVAILABLE,
  'PLUGIN_RELEASE_CORRUPT',
  'SIDE_EFFECT_LEDGER_CONFLICT',
  'SIDE_EFFECT_LEDGER_OUTCOME_INVALID',
  'SIDE_EFFECT_OUTCOME_UNKNOWN',
  'MODEL_REQUEST_OUTCOME_UNKNOWN',
  'MODEL_REQUEST_CONTEXT_DRIFT',
])

const resolutionRuntime = createTurnResolutionRuntime({ normalizePath: normalizeResolutionPath })

export const checkpointStateForResolution = resolutionRuntime.applyToCheckpoint
export const publicStatus = resolutionRuntime.publicStatus

export function rejectResumeApprovalModeOverride(value) {
  if (value === null || value === undefined) return
  throw new TurnEngineError(
    'TURN_APPROVAL_MODE_OVERRIDE_FORBIDDEN',
    'approvalMode cannot be changed while resuming a turn; the persisted turn mode is restored',
    409,
  )
}

export function activeKey(userId, sessionId, turnId) {
  return `${userId}\u0000${sessionId}\u0000${turnId}`
}

export function sessionKey(userId, sessionId) {
  return `${userId}\u0000${sessionId}`
}

export function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizePromptContextIds(values, limit = 64) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeOptionalId(value))
    .filter(Boolean))]
    .slice(0, limit)
}

function normalizeCanaryAssignmentSnapshot(value) {
  if (!isRecord(value)) return null
  const id = normalizeOptionalId(value.id)
  const releaseId = normalizeOptionalId(value.releaseId)
  const variant = String(value.variant || '').trim()
  if (!id || !releaseId || !['baseline', 'candidate'].includes(variant)) return null
  return {
    id,
    releaseId,
    variant,
    decisionReason: normalizeOptionalId(value.decisionReason),
    target: normalizeOptionalId(value.target),
  }
}

export function normalizePromptContextSnapshot(value) {
  if (!isRecord(value)) return null
  return {
    version: 1,
    effectiveAgentId: normalizeOptionalId(value.effectiveAgentId),
    skillIds: normalizePromptContextIds(value.skillIds, 32),
    memoryIds: normalizePromptContextIds(value.memoryIds),
    pluginPromptBlockIds: normalizePromptContextIds(value.pluginPromptBlockIds),
    canaryAssignment: normalizeCanaryAssignmentSnapshot(value.canaryAssignment),
  }
}

export function isManualRecoveryBlock(error) {
  const code = String(error?.code || '').trim()
  if (code === 'SIDE_EFFECT_OUTCOME_UNKNOWN') {
    return error?.unsafeToReplay === true
      && error?.retryable === false
      && error?.requiresUserVerification === true
  }
  return error?.unsafeToReplay === true
    && error?.retryable === false
    && MANUAL_RECOVERY_BLOCK_CODES.has(code)
}

export function recoveryCandidateVersion(event) {
  return [event.sequence, event.type, event.createdAt].join(':')
}

export function normalizePositiveInteger(value) {
  const normalized = Number(value)
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null
}

export function abortError(code, message) {
  return Object.assign(new Error(message), { name: 'AbortError', code })
}

export function isExplicitTurnCancellation(signal, error) {
  if (signal?.aborted) return true
  const codes = [error?.code, error?.cause?.code, signal?.reason?.code]
    .map((value) => String(value || '').trim().toUpperCase())
  return codes.includes('TURN_CANCEL_REQUESTED') || codes.includes('USER_STOPPED')
}

export function isTemporaryTurnEvidence(message, turnId) {
  return message?.id === `${turnId}:assistant`
    && message?.modelContext?.turnEvidence === true
}

export function lostTurnLease(signal, error = null) {
  const terminalCodes = new Set([
    'TURN_LEASE_LOST',
    'TURN_ENGINE_SHUTDOWN',
    'TURN_ALREADY_TERMINAL',
    'TURN_EXECUTION_LEASE_STALE',
  ])
  const hasTerminalCode = (candidate) => {
    const seen = new Set()
    let current = candidate
    for (let depth = 0; current && depth < 8 && !seen.has(current); depth += 1) {
      if (terminalCodes.has(String(current?.code || '').trim().toUpperCase())) return true
      seen.add(current)
      current = current?.cause
    }
    return false
  }
  return hasTerminalCode(error) || hasTerminalCode(signal?.reason)
}

export function missingTurnModelRuntime() {
  const error = new TurnEngineError(
    'TURN_MODEL_RUNTIME_NOT_CONFIGURED',
    'TurnEngine requires its host to provide a model runtime',
    503,
  )
  error.retryable = false
  throw error
}

export function missingTurnPromptRuntime() {
  const error = new TurnEngineError(
    'TURN_PROMPT_RUNTIME_NOT_CONFIGURED',
    'TurnEngine requires its host to provide a prompt runtime',
    503,
  )
  error.retryable = false
  throw error
}
