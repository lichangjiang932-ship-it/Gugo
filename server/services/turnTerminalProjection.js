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
  pdf_layout_verification_missing: ['pdf_layout_validation'],
  post_mutation_verification_missing: ['mutation_readback', 'diff_or_project_check'],
  reasoning_runaway: ['bounded_model_response'],
  tool_no_progress: ['progress_after_last_checkpoint'],
})

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
  return [...(INCOMPLETE_REASON_REQUIREMENTS[reason] || [])]
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
  if (incompleteReason) failure.incompleteReason = incompleteReason
  const explicitMissingRequirements = Array.isArray(error?.missingRequirements)
    ? [...new Set(error.missingRequirements.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 16)
    : []
  const missingRequirements = explicitMissingRequirements.length > 0
    ? explicitMissingRequirements
    : (incompleteReason ? missingRequirementsForIncompleteReason(incompleteReason) : [])
  if (missingRequirements.length > 0) failure.missingRequirements = missingRequirements
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
