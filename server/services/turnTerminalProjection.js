import {
  TURN_EVENT_PERSISTENCE_FAILURE_CODE,
} from './turnEventEmitter.js'
import { normalizePublicFailureCode } from '../../shared/turnEventProjection.js'

export const ARTIFACT_DELIVERY_INCOMPLETE_REASON = 'artifact_delivery_not_converged'

const INCOMPLETE_REASON_REQUIREMENTS = Object.freeze({
  [ARTIFACT_DELIVERY_INCOMPLETE_REASON]: ['deliverable_artifact'],
  deliverable_selection_missing: ['deliverable_selection'],
  directory_resume_not_converged: ['authorized_directory'],
  empty_model_response: ['model_response'],
  execution_evidence_missing: ['execution_evidence'],
  final_answer_evidence_review_missing: ['final_answer_consistency_review'],
  iteration_limit_reached: ['remaining_task_steps'],
  local_html_delivery_validation_failed: ['html_resource_validation'],
  model_call_interrupted: ['model_response', 'remaining_task_steps'],
  model_request_outcome_unknown: ['operation_outcome_verification'],
  pdf_layout_verification_missing: ['pdf_layout_validation'],
  post_mutation_verification_missing: ['mutation_readback', 'diff_or_project_check'],
  recovery_blocked: ['execution_environment_repair', 'explicit_recovery_retry'],
  reasoning_runaway: ['bounded_model_response'],
  side_effect_outcome_unknown: ['operation_outcome_verification'],
  task_verification_repair_exhausted: [
    'verification_failure_repair',
    'passing_project_check',
    'explicit_recovery_retry',
  ],
  task_verification_repair_pending: [
    'verification_failure_repair',
    'passing_project_check',
  ],
  tool_no_progress: ['progress_after_last_checkpoint'],
  turn_incomplete: ['remaining_task_steps'],
})

const TASK_VERIFICATION_INCOMPLETE_REASONS = new Set([
  'task_verification_repair_exhausted',
  'task_verification_repair_pending',
])

const TASK_VERIFICATION_STATUSES = new Set([
  'failed',
  'indeterminate',
  'rerun_required',
  'stale',
])
const TASK_VERIFICATION_KINDS = new Set(['test', 'lint', 'build', 'check', 'typecheck'])

function boundedPublicText(value, limit) {
  return [...String(value || '').trim()]
    .filter((character) => {
      const code = character.codePointAt(0)
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
    })
    .join('')
    .slice(0, limit)
}

export function normalizeTaskVerificationDetails(value) {
  if (!value || typeof value !== 'object' || Number(value.version) !== 1) return null
  const checks = (Array.isArray(value.checks) ? value.checks : [])
    .slice(0, 9)
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const status = String(entry.status || '').trim().toLowerCase()
      const kind = String(entry.kind || '').trim().toLowerCase()
      if (!TASK_VERIFICATION_STATUSES.has(status) || !TASK_VERIFICATION_KINDS.has(kind)) return null
      const cwd = boundedPublicText(entry.cwd, 1_000) || '.'
      const commandScope = boundedPublicText(entry.commandScope, 1_000)
      const diagnostic = boundedPublicText(entry.diagnostic, 1_200)
      const mutationTargets = [...new Set((Array.isArray(entry.mutationTargets)
        ? entry.mutationTargets
        : [])
        .map((target) => boundedPublicText(target, 2_000))
        .filter(Boolean))].slice(0, 16)
      return {
        status,
        kind,
        cwd,
        commandScope,
        coverage: entry.coverage === 'targeted' ? 'targeted' : 'cwd',
        code: normalizePublicFailureCode(entry.code, 'VERIFICATION_INDETERMINATE'),
        failures: Math.max(0, Math.min(3, Math.floor(Number(entry.failures) || 0))),
        requiredEpoch: Math.max(0, Math.floor(Number(entry.requiredEpoch) || 0)),
        ...(mutationTargets.length > 0 ? { mutationTargets } : {}),
        ...(diagnostic ? { diagnostic } : {}),
      }
    })
    .filter(Boolean)
  if (checks.length === 0) return null
  return {
    version: 1,
    maxFailures: Math.max(1, Math.min(3, Math.floor(Number(value.maxFailures) || 3))),
    consecutiveFailures: Math.max(
      0,
      Math.min(3, Math.floor(Number(value.consecutiveFailures) || 0)),
    ),
    checks,
  }
}

export function normalizeIncompleteReason(value, fallback = 'turn_incomplete') {
  const reason = String(value || '').trim().toLowerCase()
  if (Object.hasOwn(INCOMPLETE_REASON_REQUIREMENTS, reason)) return reason
  if (/^(?:model|tool)_[a-z0-9_]*(?:budget|limit)[a-z0-9_]*$/u.test(reason)) return 'execution_budget_exhausted'
  if (/^[a-z][a-z0-9_]{1,95}$/u.test(reason)) return reason
  return fallback
}

export function missingRequirementsForIncompleteReason(value) {
  const reason = normalizeIncompleteReason(value)
  if (reason === 'execution_budget_exhausted') return ['remaining_task_steps']
  if (reason.includes('no_progress')) return ['progress_after_last_checkpoint']
  return [...(INCOMPLETE_REASON_REQUIREMENTS[reason] || ['remaining_task_steps'])]
}

const INTERNAL_TERMINAL_FAILURE_PATTERNS = [
  /Model call failed\s*:/i,
  /This reply could not be completed/i,
  /The requested (?:file|artifact|mutation).*?(?:was not|could not|failed)/i,
  /ARTIFACT_NOT_CREATED/i,
  /(?:tool|artifact|model)[_-](?:execution|write|call)?[_-]?failed/i,
  /(?:^|\n)\s*(?:Error|Exception|TypeError|RangeError|AbortError)\s*:/i,
  /任务未完全完成[^\n]*(?:保留|保存)/,
  /(?:已保留|保存当前)[^\n]*(?:残缺|文件|进展|工具结果)/,
]

function containsInternalTerminalFailure(value) {
  return INTERNAL_TERMINAL_FAILURE_PATTERNS.some((pattern) => pattern.test(String(value || '')))
}

export function finalClarificationText(result) {
  if (result?.text) return String(result.text)
  const clarification = result?.clarification
  if (typeof clarification === 'string') return clarification
  return String(clarification?.question || clarification?.message || '')
}

export function normalizeArtifactIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
}

export function sameArtifactIds(left, right) {
  const normalizedLeft = normalizeArtifactIds(left)
  const normalizedRight = normalizeArtifactIds(right)
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((id, index) => id === normalizedRight[index])
}

export function optionalDeliveryArtifactIds(value, fallback = undefined) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'deliveryArtifactIds')) {
    return normalizeArtifactIds(value.deliveryArtifactIds)
  }
  return fallback
}

export function deliveryArtifactFields(deliveryArtifactIds) {
  return Array.isArray(deliveryArtifactIds)
    ? { deliveryArtifactIds: [...deliveryArtifactIds] }
    : {}
}

export function publicIncompleteText(value, fallback = '') {
  const text = String(value || '').trim()
  if (!text || containsInternalTerminalFailure(text)) return fallback
  return text
}

export function normalizeTurnFailure(error, {
  code = 'TURN_FAILED',
  retryable,
} = {}) {
  const normalizedCode = normalizePublicFailureCode(error?.code, code)
  const rawStatus = Number(error?.status ?? error?.statusCode)
  const status = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus
    : null
  const inferredRetryable = status !== null
    ? status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
    : error?.name === 'AbortError' || /(?:TIMEOUT|TEMPORAR|UNAVAILABLE|INTERRUPT)/i.test(normalizedCode)
  const failure = {
    code: normalizedCode,
    retryable: typeof error?.retryable === 'boolean'
      ? error.retryable
      : (typeof retryable === 'boolean' ? retryable : inferredRetryable),
  }
  if (typeof error?.manualRetryable === 'boolean') {
    failure.manualRetryable = error.manualRetryable
  }
  const incompleteReason = error?.incompleteReason
    ? normalizeIncompleteReason(error.incompleteReason)
    : ''
  if (incompleteReason) {
    failure.incompleteReason = incompleteReason
    // Exhausting the automatic repair budget is not a transient failure. A
    // direct retry would restore the same checkpoint and immediately fail
    // again; the caller must repair the code/environment first.
    if (incompleteReason === 'task_verification_repair_exhausted') {
      failure.retryable = false
    }
  }
  const explicitMissingRequirements = Array.isArray(error?.missingRequirements)
    ? [...new Set(error.missingRequirements.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 16)
    : []
  // Keep task-verification terminal records on one stable recovery contract,
  // including records produced by loop code that still sends older aliases.
  const missingRequirements = TASK_VERIFICATION_INCOMPLETE_REASONS.has(incompleteReason)
    ? missingRequirementsForIncompleteReason(incompleteReason)
    : explicitMissingRequirements.length > 0
      ? explicitMissingRequirements
      : (incompleteReason ? missingRequirementsForIncompleteReason(incompleteReason) : [])
  if (missingRequirements.length > 0) failure.missingRequirements = missingRequirements
  const taskVerification = normalizeTaskVerificationDetails(error?.taskVerification)
  if (taskVerification) failure.taskVerification = taskVerification
  if (status !== null) failure.status = status
  const attempts = Number(error?.attempts)
  if (Number.isInteger(attempts) && attempts > 0) failure.attempts = attempts
  if (normalizedCode === TURN_EVENT_PERSISTENCE_FAILURE_CODE) {
    const failedEventCount = Number(error?.failedEventCount)
    const blockedEventCount = Number(error?.blockedEventCount)
    const firstFailedSequence = Number(error?.firstFailedSequence)
    const lastFailedSequence = Number(error?.lastFailedSequence)
    const failedAt = Number(error?.failedAt)
    failure.persistence = {
      failedEventCount: Number.isInteger(failedEventCount) && failedEventCount >= 0 ? failedEventCount : 0,
      blockedEventCount: Number.isInteger(blockedEventCount) && blockedEventCount >= 0 ? blockedEventCount : 0,
      failedEventTypes: [...new Set((Array.isArray(error?.failedEventTypes) ? error.failedEventTypes : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean))].slice(0, 32),
      ...(Number.isInteger(firstFailedSequence) && firstFailedSequence >= 0 ? { firstFailedSequence } : {}),
      ...(Number.isInteger(lastFailedSequence) && lastFailedSequence >= 0 ? { lastFailedSequence } : {}),
      ...(Number.isInteger(failedAt) && failedAt >= 0 ? { failedAt } : {}),
    }
  }
  return failure
}
