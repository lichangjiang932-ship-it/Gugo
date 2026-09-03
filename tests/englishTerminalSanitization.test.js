import assert from 'node:assert/strict'
import test from 'node:test'

import { createPartialResultFallback } from '../server/services/partialResultFallback.js'
import { runSubagentToolLoop } from '../server/services/subagentToolLoop.js'
import {
  budgetExceededCopy,
  localizedTerminalModelText,
} from '../server/services/loop/incompleteTerminalPresentation.js'
import { completeIteration } from '../server/services/loop/runtime-completeIteration.js'
import { runModelRequest } from '../server/services/loop/runtime-runModelRequest.js'

const EAST_ASIAN_TERMINAL_MARKER = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u

function makeCompleteIterationState({ locale = 'en', wrapUpText = '' } = {}) {
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
      budgetExceededCopy,
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
      return { response: { content: wrapUpText }, recovery: null }
    },
    finishTerminalResult: async (result) => result,
    budget: { consume: () => true },
  }
  return { prompts, state }
}

function makeRunModelRequestState({ locale = 'en', wrapUpText = '' } = {}) {
  const prompts = []
  let modelCalls = 0
  const budgetError = Object.assign(new Error('模型预算已用尽。'), {
    code: 'MODEL_BUDGET_EXCEEDED',
  })
  const state = {
    locale,
    iteration: {},
    d: {
      DIRECTORY_REVIEW_GUARD_MARKER: '[directory-review]',
      budgetExceededCopy,
      extractTextToolCalls: () => ({ detected: false }),
      filterCurrentDynamicToolSpecs: (specs) => specs,
      formatIncompleteTerminalText: () => '',
      getToolMetadata: () => ({ isReadOnly: true }),
      mergeCompactionRecovery: (current) => current,
      snapshotDynamicToolSpecRegistrations: () => new Map(),
      sourceHandoffViolation: () => false,
      toolNameFromSpec: (spec) => spec?.function?.name || '',
    },
    steeringController: {
      claimFresh: async () => ({ messages: [], leaseId: null }),
    },
    appliedSteeringIds: new Set(),
    appendSteeringMessages: () => {},
    hasCurrentFinalAnswerEvidenceReview: () => false,
    currentFinalAnswerEvidenceDigest: () => null,
    requiresFinalAnswerEvidenceReview: () => false,
    activeToolSpecs: [],
    job: { id: 'budget-terminal', userId: 'budget-terminal-user' },
    convo: [],
    recovery: null,
    iter: 0,
    callTrackedModel: async ({ messages }) => {
      modelCalls += 1
      prompts.push(String(messages.at(-1)?.content || ''))
      if (modelCalls === 1) throw budgetError
      return { response: { content: wrapUpText }, recovery: null }
    },
    needsDeliverableSelection: () => false,
    forcedArtifactRequestPending: () => false,
    budget: { consume: () => true },
    hasRequiredArtifacts: () => true,
    finishTerminalResult: async (result) => result,
    artifactIds: [],
  }
  return { prompts, state }
}

test('localized terminal model text enforces both locales when strict terminal copy is required', () => {
  for (const value of [
    '任务只完成了一部分。',
    '一部だけ完了しました。',
    '작업이 완료되지 않았습니다.',
    'Progress was saved。Retry to continue.',
  ]) {
    assert.equal(localizedTerminalModelText('en', value), '', value)
  }

  assert.equal(localizedTerminalModelText('en', 'Progress was saved.'), 'Progress was saved.')
  assert.equal(localizedTerminalModelText('zh', '任务只完成了一部分。'), '任务只完成了一部分。')
  assert.equal(localizedTerminalModelText('zh', 'Progress was saved.'), 'Progress was saved.')
  assert.equal(localizedTerminalModelText('zh', 'Progress was saved.', { strictLocale: true }), '')
  assert.equal(
    localizedTerminalModelText('zh', '进度已经保存。', { strictLocale: true }),
    '进度已经保存。',
  )
})

test('partial-result defaults, redaction, and path arrays follow the locale', () => {
  const english = createPartialResultFallback({ locale: 'en' })
  english.record({
    name: '工具',
    args: { path: ['first.txt', 'second.txt'] },
  }, {
    ok: true,
    summary: 'Saved token=private_value',
  })
  const englishText = english.apply({ interrupted: true }).text

  assert.match(englishText, /- tool: Saved \[credential redacted\]; Path: first\.txt, second\.txt/)
  assert.doesNotMatch(englishText, EAST_ASIAN_TERMINAL_MARKER)

  const localizedToolOutput = createPartialResultFallback({
    locale: 'en',
    entries: ['write_file: 文件已保存。'],
  })
  localizedToolOutput.record({
    name: 'write_file',
    args: { path: '输出/结果.txt' },
  }, {
    ok: true,
    summary: '文件已保存。',
    path: '输出/结果.txt',
  })
  const localizedToolText = localizedToolOutput.apply({ incomplete: true }).text

  assert.match(localizedToolText, /write_file: Files: 输出\/结果\.txt/u)
  assert.doesNotMatch(localizedToolText, /文件已保存/u)

  const snapshot = localizedToolOutput.snapshot()
  assert.deepEqual(snapshot, ['write_file: Files: 输出/结果.txt'])
  const restoredText = createPartialResultFallback({ locale: 'en', entries: snapshot })
    .apply({ incomplete: true }).text
  assert.match(restoredText, /write_file: Files: 输出\/结果\.txt/u)
  assert.doesNotMatch(restoredText, /文件已保存/u)

  const chinese = createPartialResultFallback({ locale: 'zh' })
  chinese.record({
    name: '工具',
    args: { path: ['first.txt', 'second.txt'] },
  }, {
    ok: true,
    summary: 'Saved token=private_value',
  })
  const chineseText = chinese.apply({ interrupted: true }).text

  assert.match(chineseText, /- 工具：Saved \[已隐藏凭据\]；路径：first\.txt、second\.txt/)

  const chineseTerminal = chinese.apply({
    incomplete: true,
    text: 'Progress was saved. Retry to continue.',
  }).text
  assert.match(chineseTerminal, /任务尚未完成/u)
  assert.doesNotMatch(chineseTerminal, /Progress was saved/u)
})

test('Chinese budget wrap-up falls back when the model returns English', async () => {
  const { prompts, state } = makeCompleteIterationState({
    locale: 'zh',
    wrapUpText: 'Progress was saved, but the task is incomplete.',
  })
  state.iteration.budgetExceeded = '模型预算已用尽。'

  const outcome = await completeIteration(state)

  assert.equal(outcome.kind, 'return')
  assert.equal(outcome.value.budgetExceeded, true)
  assert.match(outcome.value.text, /任务预算已用尽/u)
  assert.doesNotMatch(outcome.value.text, /Progress was saved/u)
  assert.match(prompts.at(-1), /任务预算已用尽/u)
})

test('English subagent incomplete output receives the locale and contains no Chinese fallback', async () => {
  let loopLocale = null
  const result = await runSubagentToolLoop({
    locale: 'en',
    messages: [{ role: 'user', content: 'Inspect the project.' }],
    tools: [],
    modelRuntimeEnv: {},
    executeTool: async () => ({ ok: true }),
    runToolLoop: async (options) => {
      loopLocale = options.job.locale
      options.onToolCompleted({
        call: { name: 'write_file', args: { path: '输出/结果.txt' } },
        result: { ok: true, summary: '文件已保存。', path: '输出/结果.txt' },
      })
      return {
        incomplete: true,
        text: 'Progress saved。Retry to continue.',
      }
    },
  })

  assert.equal(loopLocale, 'en')
  assert.equal(result.incomplete, true)
  assert.match(result.text, /Exploration interrupted/)
  assert.match(result.text, /write_file: Files: 输出\/结果\.txt/u)
  assert.doesNotMatch(result.text, /文件已保存/u)
})

test('English complete-iteration budget wrap-up falls back when the model returns Chinese', async () => {
  const { prompts, state } = makeCompleteIterationState({
    locale: 'en',
    wrapUpText: '已保存部分结果，但任务尚未完成。',
  })
  state.iteration.budgetExceeded = '模型预算已用尽。'

  const outcome = await completeIteration(state)

  assert.equal(outcome.kind, 'return')
  assert.equal(outcome.value.budgetExceeded, true)
  assert.match(outcome.value.text, /Task budget exhausted/i)
  assert.doesNotMatch(outcome.value.text, EAST_ASIAN_TERMINAL_MARKER)
  assert.doesNotMatch(prompts.at(-1), EAST_ASIAN_TERMINAL_MARKER)
})

test('English no-progress wrap-up falls back when the model returns East Asian text', async () => {
  const { prompts, state } = makeCompleteIterationState({
    locale: 'en',
    wrapUpText: 'ツール結果はありますが、작업이 완료되지 않았습니다.',
  })
  state.iteration.noProgressReason = '内部工具重复调用'
  state.iteration.noProgressCode = 'repeated_tool_call'
  state.iteration.noProgressFailure = {
    retryable: false,
    hint: 'Retry with a different approach。',
  }

  const outcome = await completeIteration(state)

  assert.equal(outcome.kind, 'return')
  assert.equal(outcome.value.noProgress, true)
  assert.match(outcome.value.text, /stopped after making no progress/i)
  assert.match(outcome.value.hint, /Stop repeating the same tool call/i)
  assert.doesNotMatch(outcome.value.text, EAST_ASIAN_TERMINAL_MARKER)
  assert.doesNotMatch(outcome.value.hint, EAST_ASIAN_TERMINAL_MARKER)
  assert.doesNotMatch(prompts.at(-1), EAST_ASIAN_TERMINAL_MARKER)
})

test('English direct budget failure rejects a Chinese wrap-up and returns English copy', async () => {
  const { prompts, state } = makeRunModelRequestState({
    locale: 'en',
    wrapUpText: '任务被中断，请稍后重试。',
  })

  const outcome = await runModelRequest(state)

  assert.equal(outcome.kind, 'return')
  assert.equal(outcome.value.budgetExceeded, true)
  assert.match(outcome.value.text, /Task budget exhausted/i)
  assert.equal(Object.hasOwn(outcome.value, 'partialText'), false)
  assert.doesNotMatch(outcome.value.text, EAST_ASIAN_TERMINAL_MARKER)
  assert.doesNotMatch(prompts.at(-1), EAST_ASIAN_TERMINAL_MARKER)
})
