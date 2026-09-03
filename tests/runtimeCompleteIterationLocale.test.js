import assert from 'node:assert/strict'
import test from 'node:test'

import { completeIteration } from '../server/services/loop/runtime-completeIteration.js'

const CJK_TEXT = /[\u3400-\u9fff]/u

function makeState(locale = 'en') {
  const prompts = []
  const state = {
    locale,
    iteration: {
      toolCalls: [],
      batchSupersededBySteering: false,
      artifactRecoveryToolAtIterationStart: null,
      artifactRecoveryPhaseAtIterationStart: null,
      noProgressReason: null,
      noProgressCode: null,
      noProgressFailure: null,
      budgetExceeded: null,
      pausedByClarification: null,
      steeringLeaseId: null,
    },
    d: {
      ARTIFACT_RECOVERY_PHASE_FORCE: 'force',
      DELIVERABLE_SELECTION_FALLBACK_MARKER: '[selection]',
      MAX_ARTIFACT_DELIVERY_RETRIES: 4,
      MAX_ARTIFACT_RECOVERY_DIAGNOSTIC_ROUNDS: 2,
      MAX_DELIVERABLE_SELECTION_RETRIES: 2,
      mergeCompactionRecovery: (current) => current,
      writeToolAudit: () => {},
    },
    deliveredArtifactTools: new Set(),
    hasRequiredArtifacts: () => true,
    artifactRecoveryActive: () => false,
    missingArtifactTools: () => [],
    artifactDeliveryRetries: 0,
    artifactRecoveryDiagnosticRounds: 0,
    checkpointCalls: null,
    persistTurn: async () => {},
    emitToolProgress: async () => {},
    taskVerificationRepairExhausted: () => false,
    needsDeliverableSelection: () => false,
    applySafeDeliverableFallback: () => false,
    hasRequiredExecutionEvidence: () => false,
    hasPendingMutationVerification: () => false,
    iter: 0,
    maxIters: 2,
    artifactIds: [],
    convo: [],
    finalText: '',
    recovery: null,
    protectClarification: (value) => value,
    callTrackedModel: async ({ messages }) => {
      prompts.push(String(messages.at(-1)?.content || ''))
      throw new Error('wrap-up unavailable')
    },
    finishTerminalResult: async (result) => result,
    budget: { consume: () => true },
  }
  return { state, prompts }
}

test('English clarification fallback does not inject Chinese text', async () => {
  const { state } = makeState('en')
  state.iteration.pausedByClarification = {}

  const outcome = await completeIteration(state)

  assert.equal(outcome.kind, 'return')
  assert.equal(outcome.value.paused, true)
  assert.equal(outcome.value.text, 'More information is required before this task can continue.')
  assert.doesNotMatch(outcome.value.text, CJK_TEXT)
})

test('English no-progress prompt and fallback do not echo a Chinese internal reason', async () => {
  const { state, prompts } = makeState('en')
  state.iteration.noProgressReason = '内部工具重复调用'
  state.iteration.noProgressCode = 'repeated_tool_call'
  state.iteration.noProgressFailure = {
    retryable: false,
    hint: '请停止重复调用，改用已有结果收尾或换一种方法。',
  }

  const outcome = await completeIteration(state)

  assert.equal(outcome.kind, 'return')
  assert.equal(outcome.value.noProgress, true)
  assert.equal(outcome.value.code, 'repeated_tool_call')
  assert.doesNotMatch(prompts.at(-1), CJK_TEXT)
  assert.match(prompts.at(-1), /provide a partial conclusion in English/i)
  assert.doesNotMatch(outcome.value.text, CJK_TEXT)
  assert.match(outcome.value.text, /stopped after making no progress/i)
  assert.doesNotMatch(outcome.value.hint, CJK_TEXT)
  assert.match(outcome.value.hint, /Stop repeating the same tool call/i)
})

test('Chinese no-progress prompt and fallback do not echo an English internal reason', async () => {
  const { state, prompts } = makeState('zh')
  state.iteration.noProgressReason = 'internal tool loop repeated'
  state.iteration.noProgressCode = 'repeated_tool_call'
  state.iteration.noProgressFailure = {
    retryable: false,
    hint: 'Stop repeating the same tool call.',
  }

  const outcome = await completeIteration(state)

  assert.equal(outcome.kind, 'return')
  assert.equal(outcome.value.noProgress, true)
  assert.equal(outcome.value.code, 'repeated_tool_call')
  assert.doesNotMatch(prompts.at(-1), /internal tool loop repeated/i)
  assert.match(prompts.at(-1), CJK_TEXT)
  assert.doesNotMatch(outcome.value.text, /internal tool loop repeated/i)
  assert.match(outcome.value.text, CJK_TEXT)
  assert.match(outcome.value.hint, CJK_TEXT)
})
