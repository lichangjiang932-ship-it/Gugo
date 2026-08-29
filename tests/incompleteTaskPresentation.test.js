import assert from 'node:assert/strict'
import test from 'node:test'

import { buildIncompleteTaskPresentation } from '../src/pages/ChatSplit/chatMessages/messageRow/incompleteTaskPresentation.js'
import { normalizeTurnFailure } from '../server/services/turnTerminalProjection.js'

const t = (key) => key

test('known incomplete reasons produce deterministic reasons, requirements, and recovery actions', () => {
  const cases = [
    ['artifact_delivery_not_converged', 'chatMessages.incompleteReasonArtifactDelivery', 'chatMessages.incompleteRequirementArtifact'],
    ['execution_evidence_missing', 'chatMessages.incompleteReasonExecutionEvidence', 'chatMessages.incompleteRequirementExecutionEvidence'],
    ['final_answer_evidence_review_missing', 'chatMessages.incompleteReasonFinalAnswerReview', 'chatMessages.incompleteRequirementFinalAnswerReview'],
    ['post_mutation_verification_missing', 'chatMessages.incompleteReasonMutationVerification', 'chatMessages.incompleteRequirementReadback'],
    ['reasoning_runaway', 'chatMessages.incompleteReasonReasoningRunaway', 'chatMessages.incompleteRequirementBoundedModelResponse'],
    ['local_html_delivery_validation_failed', 'chatMessages.incompleteReasonHtmlValidation', 'chatMessages.incompleteRequirementHtmlValidation'],
    ['pdf_layout_verification_missing', 'chatMessages.incompleteReasonPdfValidation', 'chatMessages.incompleteRequirementPdfValidation'],
    ['deliverable_selection_missing', 'chatMessages.incompleteReasonDeliverableSelection', 'chatMessages.incompleteRequirementSelection'],
    ['empty_model_response', 'chatMessages.incompleteReasonEmptyModelResponse', 'chatMessages.incompleteRequirementModelResponse'],
    ['iteration_limit_reached', 'chatMessages.incompleteReasonIterationLimit', 'chatMessages.incompleteRequirementRemainingSteps'],
    ['execution_budget_exhausted', 'chatMessages.incompleteReasonBudget', 'chatMessages.incompleteRequirementRemainingSteps'],
    ['tool_no_progress', 'chatMessages.incompleteReasonNoProgress', 'chatMessages.incompleteRequirementProgress'],
  ]
  for (const [incompleteReason, reason, requirement] of cases) {
    const value = buildIncompleteTaskPresentation({
      meta: { serverFailure: { incompleteReason, retryable: true } },
    }, t)
    assert.equal(value.reason, reason, incompleteReason)
    assert.ok(value.missing.includes(requirement), incompleteReason)
    assert.equal(value.nextStep, 'chatMessages.incompleteNextRetry', incompleteReason)
    assert.equal(value.code, incompleteReason.toUpperCase(), incompleteReason)
  }
})

test('legacy incomplete failures disclose the retained public reason without exposing stacks', () => {
  const legacy = buildIncompleteTaskPresentation({
    meta: { serverFailure: { code: 'TURN_FAILED', message: 'Validation stopped after the final write.', retryable: false } },
  }, t, { retainedCount: 1 })
  assert.equal(legacy.reason, 'Validation stopped after the final write.')
  assert.equal(legacy.nextStep, 'chatMessages.incompleteNextAdjust')

  const stack = buildIncompleteTaskPresentation({
    meta: { serverFailure: { code: 'TURN_FAILED', message: 'TypeError: secret internal stack' } },
  }, t)
  assert.equal(stack.reason, 'chatMessages.incompleteReasonFallback')
})

test('legacy TURN_INCOMPLETE status copy is not presented as a causal diagnosis', () => {
  const value = buildIncompleteTaskPresentation({
    meta: {
      serverFailure: {
        code: 'TURN_INCOMPLETE',
        message: '任务未全部完成，但已保存的文件仍可打开；请按文件旁的状态确认结果。',
        retryable: true,
      },
    },
  }, t, { expectsFileReceipt: true })

  assert.equal(value.reason, 'chatMessages.incompleteReasonFallback')
  assert.deepEqual(value.missing, ['chatMessages.incompleteRequirementArtifact'])
  assert.equal(value.nextStep, 'chatMessages.incompleteNextRetry')
})

test('an unknown recorded reason is disclosed instead of being described as missing', () => {
  const interpolate = (key, values = {}) => `${key}:${values.code || ''}`
  const value = buildIncompleteTaskPresentation({
    meta: {
      serverFailure: {
        code: 'TURN_INCOMPLETE',
        incompleteReason: 'checkpoint_missing',
        retryable: false,
      },
    },
  }, interpolate)

  assert.equal(value.reason, 'chatMessages.incompleteReasonRecordedCode:CHECKPOINT_MISSING')
  assert.deepEqual(value.missing, [
    'chatMessages.incompleteRequirementRecordedCode:CHECKPOINT_MISSING',
  ])
})

test('server failure normalization derives missing requirements from a known incomplete reason', () => {
  const failure = normalizeTurnFailure({
    code: 'TURN_INCOMPLETE',
    incompleteReason: 'empty_model_response',
  })

  assert.equal(failure.incompleteReason, 'empty_model_response')
  assert.deepEqual(failure.missingRequirements, ['model_response'])
  assert.equal(Object.hasOwn(failure, 'message'), false)
  assert.equal(JSON.stringify(failure).includes('任务尚未'), false)

  const finalAnswerReviewFailure = normalizeTurnFailure({
    code: 'TURN_INCOMPLETE',
    incompleteReason: 'final_answer_evidence_review_missing',
  })
  assert.deepEqual(finalAnswerReviewFailure.missingRequirements, [
    'final_answer_consistency_review',
  ])
  assert.equal(Object.hasOwn(finalAnswerReviewFailure, 'message'), false)
})

test('a recovery dead letter explains why automation stopped and what must be repaired', () => {
  const value = buildIncompleteTaskPresentation({
    meta: {
      serverFailure: {
        code: 'MODEL_HTTP_503',
        retryable: false,
        manualRetryable: true,
        attempts: 5,
        incompleteReason: 'recovery_attempts_exhausted',
        missingRequirements: ['model_service_available', 'explicit_recovery_retry'],
      },
    },
  }, t)

  assert.equal(value.reason, 'chatMessages.incompleteReasonRecoveryExhausted')
  assert.deepEqual(value.missing, [
    'chatMessages.incompleteRequirementModelService',
    'chatMessages.incompleteRequirementExplicitRetry',
  ])
  assert.equal(value.nextStep, 'chatMessages.incompleteNextManualRecovery')
  assert.equal(value.manualRetryable, true)
})
