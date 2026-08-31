import assert from 'node:assert/strict'
import test from 'node:test'

import { translations } from '../src/i18n/translations.js'
import { buildIncompleteTaskPresentation } from '../src/pages/ChatSplit/chatMessages/messageRow/incompleteTaskPresentation.js'
import { missingArtifactBlocker } from '../server/services/loop/runtime-initializeCompletion.js'
import {
  ARTIFACT_DELIVERY_INCOMPLETE_REASON,
  normalizeTurnFailure,
} from '../server/services/turnTerminalProjection.js'

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

test('missing artifact completion uses a stable reason code and client-localized copy', () => {
  const blocker = missingArtifactBlocker()
  assert.deepEqual(blocker, { reason: ARTIFACT_DELIVERY_INCOMPLETE_REASON })
  assert.equal(Object.hasOwn(blocker, 'text'), false)

  const failure = normalizeTurnFailure({
    code: 'TURN_INCOMPLETE',
    incompleteReason: blocker.reason,
  })
  assert.deepEqual(failure, {
    code: 'TURN_INCOMPLETE',
    retryable: false,
    incompleteReason: ARTIFACT_DELIVERY_INCOMPLETE_REASON,
    missingRequirements: ['deliverable_artifact'],
  })

  const value = buildIncompleteTaskPresentation({
    meta: { serverFailure: failure },
  }, t)
  assert.equal(value.reason, 'chatMessages.incompleteReasonArtifactDelivery')
  assert.deepEqual(value.missing, ['chatMessages.incompleteRequirementArtifact'])

  const localizedReasons = ['zh', 'en', 'ja', 'ko', 'zh-TW'].map((locale) => (
    translations[locale].chatMessages.incompleteReasonArtifactDelivery
  ))
  assert.equal(localizedReasons.every((reason) => typeof reason === 'string' && reason.trim()), true)
  assert.equal(new Set(localizedReasons).size, localizedReasons.length)
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

test('an unknown recorded recovery reason is disclosed with safe categorical requirements', () => {
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
    'chatMessages.incompleteRequirementEnvironmentRepair:',
    'chatMessages.incompleteRequirementExplicitRetry:',
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

test('task verification failures require repair plus a passing project check before completion', () => {
  const taskVerification = {
    version: 1,
    maxFailures: 3,
    consecutiveFailures: 1,
    checks: [{
      status: 'failed',
      kind: 'test',
      cwd: 'packages/core',
      commandScope: 'npm test',
      coverage: 'cwd',
      code: 'TASK_TEST_FAILED',
      failures: 1,
      requiredEpoch: 2,
      diagnostic: 'index.test.js: expected 2, received 1',
    }],
  }
  const pendingFailure = normalizeTurnFailure({
    code: 'TASK_VERIFICATION_REPAIR_PENDING',
    incompleteReason: 'task_verification_repair_pending',
    missingRequirements: [
      'conclusive_project_verification',
      'rerun_verification_scope',
    ],
    retryable: true,
    taskVerification,
  })
  assert.equal(pendingFailure.retryable, true)
  assert.deepEqual(pendingFailure.missingRequirements, [
    'verification_failure_repair',
    'passing_project_check',
  ])

  const pending = buildIncompleteTaskPresentation({
    meta: { serverFailure: pendingFailure },
  }, (key, values = {}) => key === 'chatMessages.incompleteVerificationScope'
    ? `${values.status}|${values.kind}|${values.cwd}|${values.command}`
    : key)
  assert.equal(pending.reason, 'chatMessages.incompleteReasonVerificationPending')
  assert.deepEqual(pending.missing, [
    'chatMessages.incompleteRequirementVerificationRepair',
    'chatMessages.incompleteRequirementPassingProjectCheck',
  ])
  assert.equal(pending.nextStep, 'chatMessages.incompleteNextVerificationPending')
  assert.equal(pending.retryable, true)
  assert.deepEqual(pending.verificationChecks, [{
    code: 'TASK_TEST_FAILED',
    diagnostic: 'index.test.js: expected 2, received 1',
    scope: 'chatMessages.incompleteVerificationFailed|test|packages/core|npm test',
    status: 'failed',
  }])

  const exhaustedFailure = normalizeTurnFailure({
    code: 'TASK_VERIFICATION_REPAIR_EXHAUSTED',
    incompleteReason: 'task_verification_repair_exhausted',
    missingRequirements: [
      'verification_failure_repair',
      'conclusive_project_verification',
      'explicit_recovery_retry',
    ],
    retryable: true,
    manualRetryable: true,
  })
  assert.equal(exhaustedFailure.retryable, false)
  assert.equal(exhaustedFailure.manualRetryable, true)
  assert.deepEqual(exhaustedFailure.missingRequirements, [
    'verification_failure_repair',
    'passing_project_check',
    'explicit_recovery_retry',
  ])

  const exhausted = buildIncompleteTaskPresentation({
    meta: { serverFailure: exhaustedFailure },
  }, t)
  assert.equal(exhausted.reason, 'chatMessages.incompleteReasonVerificationExhausted')
  assert.deepEqual(exhausted.missing, [
    'chatMessages.incompleteRequirementVerificationRepair',
    'chatMessages.incompleteRequirementPassingProjectCheck',
    'chatMessages.incompleteRequirementExplicitRetry',
  ])
  assert.equal(exhausted.nextStep, 'chatMessages.incompleteNextVerificationExhausted')
  assert.equal(exhausted.retryable, false)
  assert.equal(exhausted.manualRetryable, true)
})

test('task verification recovery guidance is localized in all supported languages', () => {
  const locales = ['zh', 'en', 'ja', 'ko', 'zh-TW']
  const keys = [
    'incompleteReasonVerificationPending',
    'incompleteReasonVerificationExhausted',
    'incompleteRequirementVerificationRepair',
    'incompleteRequirementPassingProjectCheck',
    'incompleteNextVerificationPending',
    'incompleteNextVerificationExhausted',
    'incompleteVerificationDetailsLabel',
    'incompleteVerificationScope',
    'incompleteVerificationDiagnosticLabel',
    'incompleteVerificationProcessTreeCleanupFailed',
  ]

  for (const key of keys) {
    const values = locales.map((locale) => translations[locale].chatMessages[key])
    assert.equal(values.every((value) => typeof value === 'string' && value.trim()), true, key)
    assert.equal(new Set(values).size, locales.length, key)
  }
})

test('stable process cleanup diagnostics are localized by the client', () => {
  const value = buildIncompleteTaskPresentation({
    meta: {
      serverFailure: {
        code: 'TASK_VERIFICATION_REPAIR_PENDING',
        incompleteReason: 'task_verification_repair_pending',
        taskVerification: {
          version: 1,
          checks: [{
            status: 'indeterminate',
            kind: 'test',
            cwd: '.',
            commandScope: 'npm test',
            code: 'PROCESS_TREE_CLEANUP_FAILED',
            diagnostic: 'partial stdout/stderr that must not replace the stable cleanup diagnosis',
          }],
        },
      },
    },
  }, t)

  assert.equal(
    value.verificationChecks[0].diagnostic,
    'chatMessages.incompleteVerificationProcessTreeCleanupFailed',
  )
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
