import { getVisibleModelErrorMessage } from '../../../../lib/chatFlowGuards.js'

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
  model_call_interrupted: 'errors.turnModelInterrupted',
  model_request_outcome_unknown: 'chatMessages.modelRequestUnknownBody',
  pdf_layout_verification_missing: 'chatMessages.incompleteReasonPdfValidation',
  post_mutation_verification_missing: 'chatMessages.incompleteReasonMutationVerification',
  recovery_blocked: 'errors.turnRecoveryBlocked',
  recovery_attempts_exhausted: 'chatMessages.incompleteReasonRecoveryExhausted',
  reasoning_runaway: 'chatMessages.incompleteReasonReasoningRunaway',
  side_effect_outcome_unknown: 'chatMessages.sideEffectUnknownBody',
  task_verification_repair_exhausted: 'chatMessages.incompleteReasonVerificationExhausted',
  task_verification_repair_pending: 'chatMessages.incompleteReasonVerificationPending',
  tool_no_progress: 'chatMessages.incompleteReasonNoProgress',
})

const REQUIREMENT_KEYS = Object.freeze({
  authorized_directory: 'chatMessages.incompleteRequirementDirectory',
  bounded_model_response: 'chatMessages.incompleteRequirementBoundedModelResponse',
  deliverable_artifact: 'chatMessages.incompleteRequirementArtifact',
  deliverable_docx: 'chatMessages.incompleteRequirementDocx',
  deliverable_html: 'chatMessages.incompleteRequirementHtml',
  deliverable_image: 'chatMessages.incompleteRequirementImage',
  deliverable_pdf: 'chatMessages.incompleteRequirementPdf',
  deliverable_pptx: 'chatMessages.incompleteRequirementPptx',
  deliverable_xlsx: 'chatMessages.incompleteRequirementXlsx',
  deliverable_selection: 'chatMessages.incompleteRequirementSelection',
  diff_or_project_check: 'chatMessages.incompleteRequirementProjectCheck',
  execution_evidence: 'chatMessages.incompleteRequirementExecutionEvidence',
  final_answer_consistency_review: 'chatMessages.incompleteRequirementFinalAnswerReview',
  html_resource_validation: 'chatMessages.incompleteRequirementHtmlValidation',
  model_response: 'chatMessages.incompleteRequirementModelResponse',
  model_service_available: 'chatMessages.incompleteRequirementModelService',
  mutation_readback: 'chatMessages.incompleteRequirementReadback',
  operation_outcome_verification: 'chatMessages.incompleteRequirementOutcomeVerification',
  passing_project_check: 'chatMessages.incompleteRequirementPassingProjectCheck',
  pdf_layout_validation: 'chatMessages.incompleteRequirementPdfValidation',
  progress_after_last_checkpoint: 'chatMessages.incompleteRequirementProgress',
  execution_environment_repair: 'chatMessages.incompleteRequirementEnvironmentRepair',
  explicit_recovery_retry: 'chatMessages.incompleteRequirementExplicitRetry',
  remaining_task_steps: 'chatMessages.incompleteRequirementRemainingSteps',
  verification_failure_repair: 'chatMessages.incompleteRequirementVerificationRepair',
  conclusive_project_verification: 'chatMessages.incompleteRequirementConclusiveVerification',
  rerun_verification_scope: 'chatMessages.incompleteRequirementVerificationRerun',
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
  model_call_interrupted: ['model_response', 'remaining_task_steps'],
  model_request_outcome_unknown: ['operation_outcome_verification'],
  pdf_layout_verification_missing: ['pdf_layout_validation'],
  post_mutation_verification_missing: ['mutation_readback', 'diff_or_project_check'],
  recovery_blocked: ['execution_environment_repair', 'explicit_recovery_retry'],
  recovery_attempts_exhausted: ['execution_environment_repair', 'explicit_recovery_retry'],
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
})

const VERIFICATION_STATUS_KEYS = Object.freeze({
  failed: 'chatMessages.incompleteVerificationFailed',
  indeterminate: 'chatMessages.incompleteVerificationIndeterminate',
  rerun_required: 'chatMessages.incompleteVerificationRerunRequired',
  stale: 'chatMessages.incompleteVerificationStale',
})

const SUCCESS_VERIFICATION_STATUSES = new Set([
  'complete',
  'completed',
  'ok',
  'pass',
  'passed',
  'succeeded',
  'success',
])

const VERIFICATION_DIAGNOSTIC_KEYS = Object.freeze({
  PROCESS_TREE_CLEANUP_FAILED: 'chatMessages.incompleteVerificationProcessTreeCleanupFailed',
})

const VERIFICATION_NEXT_STEP_KEYS = Object.freeze({
  task_verification_repair_exhausted: 'chatMessages.incompleteNextVerificationExhausted',
  task_verification_repair_pending: 'chatMessages.incompleteNextVerificationPending',
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

function defaultRequirementsForReason(reasonCode) {
  const explicit = DEFAULT_REQUIREMENTS[reasonCode]
  if (explicit) return explicit
  const code = String(reasonCode || '').trim().toUpperCase()
  if (/^(?:MODEL_|TURN_MODEL_)/u.test(code)) {
    return ['model_service_available', 'model_response', 'remaining_task_steps']
  }
  if (/^(?:TOOL_|REPEATED_TOOL_CALL)/u.test(code)) {
    return ['progress_after_last_checkpoint', 'remaining_task_steps']
  }
  if (/(?:PERSISTENCE|CHECKPOINT|RUNTIME|CONTEXT_DRIFT|STREAM_TRUNCATED|RECONNECT)/u.test(code)) {
    return ['execution_environment_repair', 'explicit_recovery_retry']
  }
  return []
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

function verificationCheckPresentations(failure, t) {
  const source = failure?.taskVerification
  if (!source || !Array.isArray(source.checks)) return []
  return source.checks.slice(0, 9).map((check) => {
    const status = String(check?.status || '').trim().toLowerCase()
    const kind = String(check?.kind || '').trim().toLowerCase()
    if (!status || !kind || SUCCESS_VERIFICATION_STATUSES.has(status)) return null
    const cwd = String(check?.cwd || '.').trim().slice(0, 1_000) || '.'
    const command = String(check?.commandScope || kind).trim().slice(0, 1_000) || kind
    const code = String(check?.code || 'VERIFICATION_INDETERMINATE').trim().toUpperCase()
    const rawDiagnostic = String(check?.diagnostic || '').trim().slice(0, 1_200)
    const diagnosticKey = VERIFICATION_DIAGNOSTIC_KEYS[code]
      || VERIFICATION_DIAGNOSTIC_KEYS[rawDiagnostic.toUpperCase()]
    const diagnostic = diagnosticKey
      ? translated(t, diagnosticKey)
      : rawDiagnostic
    return {
      code,
      diagnostic,
      scope: translated(t, 'chatMessages.incompleteVerificationScope', {
        command,
        cwd,
        kind,
        status: VERIFICATION_STATUS_KEYS[status]
          ? translated(t, VERIFICATION_STATUS_KEYS[status])
          : status.toUpperCase(),
      }),
      status,
    }
  }).filter(Boolean)
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
  const localizedFailureReason = failure.incompleteReason
    ? ''
    : getVisibleModelErrorMessage(failure, t)
  const specificFailureReason = reasonCode !== 'turn_incomplete' && localizedFailureReason
    && localizedFailureReason !== translated(t, 'errors.chatFailure')
      ? localizedFailureReason
      : ''
  const reason = reasonKey
    ? translated(t, reasonKey, { attempts: Number(failure.attempts) || 0 })
    : publicFailureDetail(failure) || specificFailureReason || translated(t, recordedUnknownReason
      ? 'chatMessages.incompleteReasonRecordedCode'
      : 'chatMessages.incompleteReasonFallback', { code: reasonCode.toUpperCase() })
  const rawRequirements = Array.isArray(failure.missingRequirements)
    ? failure.missingRequirements
    : []
  const requirementCodes = [...new Set((rawRequirements.length > 0
    ? rawRequirements
    : defaultRequirementsForReason(reasonCode))
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => /^[a-z][a-z0-9_]{1,95}$/u.test(value)))]
  const missing = requirementCodes.length > 0
    ? requirementCodes.map((code) => (
        REQUIREMENT_KEYS[code]
          ? translated(t, REQUIREMENT_KEYS[code])
          : translated(t, 'chatMessages.incompleteRequirementRecordedCode', {
              code: code.toUpperCase(),
            })
      ))
    : [translated(t,
        expectsFileReceipt && verifiedCount + retainedCount === 0
          ? 'chatMessages.incompleteRequirementArtifact'
          : recordedUnknownReason
            ? 'chatMessages.incompleteRequirementRecordedCode'
            : 'chatMessages.incompleteMissingFallback',
        { code: reasonCode.toUpperCase() },
      )]
  // Older retained records may predate the server-side retryability guard.
  // Never advertise a direct retry after the repair budget was exhausted.
  const retryable = reasonCode === 'task_verification_repair_exhausted'
    ? false
    : failure.retryable === true
  const manualRetryable = failure.manualRetryable === true
  const verificationNextStepKey = VERIFICATION_NEXT_STEP_KEYS[reasonCode]
  return {
    code: String(failure.incompleteReason || failure.code || 'TURN_INCOMPLETE').trim().toUpperCase(),
    missing,
    nextStep: translated(t, verificationNextStepKey || (retryable
      ? 'chatMessages.incompleteNextRetry'
      : manualRetryable
        ? 'chatMessages.incompleteNextManualRecovery'
        : 'chatMessages.incompleteNextAdjust')),
    reason,
    retainedCount,
    retryable,
    manualRetryable,
    verificationChecks: verificationCheckPresentations(failure, t),
    verifiedCount,
  }
}
