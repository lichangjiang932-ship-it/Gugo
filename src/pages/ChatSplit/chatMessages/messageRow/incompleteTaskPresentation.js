const REASON_KEYS = Object.freeze({
  artifact_delivery_not_converged: 'chatMessages.incompleteReasonArtifactDelivery',
  deliverable_selection_missing: 'chatMessages.incompleteReasonDeliverableSelection',
  directory_resume_not_converged: 'chatMessages.incompleteReasonDirectory',
  empty_model_response: 'chatMessages.incompleteReasonEmptyModelResponse',
  execution_budget_exhausted: 'chatMessages.incompleteReasonBudget',
  execution_evidence_missing: 'chatMessages.incompleteReasonExecutionEvidence',
  final_answer_evidence_review_missing: 'chatMessages.incompleteReasonFinalAnswerReview',
  iteration_limit_reached: 'chatMessages.incompleteReasonIterationLimit',
  local_html_delivery_validation_failed: 'chatMessages.incompleteReasonHtmlValidation',
  pdf_layout_verification_missing: 'chatMessages.incompleteReasonPdfValidation',
  post_mutation_verification_missing: 'chatMessages.incompleteReasonMutationVerification',
  recovery_attempts_exhausted: 'chatMessages.incompleteReasonRecoveryExhausted',
  reasoning_runaway: 'chatMessages.incompleteReasonReasoningRunaway',
  tool_no_progress: 'chatMessages.incompleteReasonNoProgress',
})

const REQUIREMENT_KEYS = Object.freeze({
  authorized_directory: 'chatMessages.incompleteRequirementDirectory',
  bounded_model_response: 'chatMessages.incompleteRequirementBoundedModelResponse',
  deliverable_artifact: 'chatMessages.incompleteRequirementArtifact',
  deliverable_selection: 'chatMessages.incompleteRequirementSelection',
  diff_or_project_check: 'chatMessages.incompleteRequirementProjectCheck',
  execution_evidence: 'chatMessages.incompleteRequirementExecutionEvidence',
  final_answer_consistency_review: 'chatMessages.incompleteRequirementFinalAnswerReview',
  html_resource_validation: 'chatMessages.incompleteRequirementHtmlValidation',
  model_response: 'chatMessages.incompleteRequirementModelResponse',
  model_service_available: 'chatMessages.incompleteRequirementModelService',
  mutation_readback: 'chatMessages.incompleteRequirementReadback',
  operation_outcome_verification: 'chatMessages.incompleteRequirementOutcomeVerification',
  pdf_layout_validation: 'chatMessages.incompleteRequirementPdfValidation',
  progress_after_last_checkpoint: 'chatMessages.incompleteRequirementProgress',
  execution_environment_repair: 'chatMessages.incompleteRequirementEnvironmentRepair',
  explicit_recovery_retry: 'chatMessages.incompleteRequirementExplicitRetry',
  remaining_task_steps: 'chatMessages.incompleteRequirementRemainingSteps',
})

const DEFAULT_REQUIREMENTS = Object.freeze({
  artifact_delivery_not_converged: ['deliverable_artifact'],
  deliverable_selection_missing: ['deliverable_selection'],
  directory_resume_not_converged: ['authorized_directory'],
  empty_model_response: ['model_response'],
  execution_budget_exhausted: ['remaining_task_steps'],
  execution_evidence_missing: ['execution_evidence'],
  final_answer_evidence_review_missing: ['final_answer_consistency_review'],
  iteration_limit_reached: ['remaining_task_steps'],
  local_html_delivery_validation_failed: ['html_resource_validation'],
  pdf_layout_verification_missing: ['pdf_layout_validation'],
  post_mutation_verification_missing: ['mutation_readback', 'diff_or_project_check'],
  recovery_attempts_exhausted: ['execution_environment_repair', 'explicit_recovery_retry'],
  reasoning_runaway: ['bounded_model_response'],
  tool_no_progress: ['progress_after_last_checkpoint'],
})

function translated(t, key, values) {
  return String(typeof t === 'function' ? t(key, values) : key)
}

function normalizeReason(failure) {
  const reason = String(failure?.incompleteReason || '').trim().toLowerCase()
  if (reason) return reason
  const code = String(failure?.code || '').trim().toLowerCase()
  return code === 'turn_incomplete' ? 'turn_incomplete' : code
}

function publicFailureDetail(failure) {
  const message = String(failure?.message || '').trim()
  const code = String(failure?.code || '').trim().toUpperCase()
  // TURN_INCOMPLETE messages from older runtimes were generic status copy
  // (for example, "saved files remain available"), not a causal diagnosis.
  // Present the explicit legacy-data fallback instead of repeating that copy
  // under the "Why" label.
  if (code === 'TURN_INCOMPLETE'
    || !message
    || /(?:^|\n)\s*(?:error|exception|typeerror|rangeerror)\s*:/iu.test(message)) return ''
  return message.slice(0, 600)
}

export function buildIncompleteTaskPresentation(msg, t, {
  expectsFileReceipt = false,
  retainedCount = 0,
  verifiedCount = 0,
} = {}) {
  const failure = msg?.meta?.serverFailure || {}
  const reasonCode = normalizeReason(failure)
  const reasonKey = REASON_KEYS[reasonCode]
  const recordedUnknownReason = Boolean(
    failure.incompleteReason
    && !reasonKey
    && reasonCode !== 'turn_incomplete'
    && /^[a-z][a-z0-9_]{1,95}$/u.test(reasonCode),
  )
  const reason = reasonKey
    ? translated(t, reasonKey, { attempts: Number(failure.attempts) || 0 })
    : publicFailureDetail(failure) || translated(t, recordedUnknownReason
      ? 'chatMessages.incompleteReasonRecordedCode'
      : 'chatMessages.incompleteReasonFallback', { code: reasonCode.toUpperCase() })
  const rawRequirements = Array.isArray(failure.missingRequirements)
    ? failure.missingRequirements
    : []
  const requirementCodes = [...new Set((rawRequirements.length > 0
    ? rawRequirements
    : DEFAULT_REQUIREMENTS[reasonCode] || [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => REQUIREMENT_KEYS[value]))]
  const missing = requirementCodes.length > 0
    ? requirementCodes.map((code) => translated(t, REQUIREMENT_KEYS[code]))
    : [translated(t,
        expectsFileReceipt && verifiedCount + retainedCount === 0
          ? 'chatMessages.incompleteRequirementArtifact'
          : recordedUnknownReason
            ? 'chatMessages.incompleteRequirementRecordedCode'
            : 'chatMessages.incompleteMissingFallback',
        { code: reasonCode.toUpperCase() },
      )]
  const retryable = failure.retryable === true
  const manualRetryable = failure.manualRetryable === true
  return {
    code: String(failure.incompleteReason || failure.code || 'TURN_INCOMPLETE').trim().toUpperCase(),
    missing,
    nextStep: translated(t, retryable
      ? 'chatMessages.incompleteNextRetry'
      : manualRetryable
        ? 'chatMessages.incompleteNextManualRecovery'
        : 'chatMessages.incompleteNextAdjust'),
    reason,
    retainedCount,
    retryable,
    manualRetryable,
    verifiedCount,
  }
}
