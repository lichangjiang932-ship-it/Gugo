import assert from 'node:assert/strict'
import test from 'node:test'

import { startServerTurn } from '../src/lib/turnClient/turnRequests.js'
import { createPartialResultFallback } from '../server/services/partialResultFallback.js'
import {
  budgetExceededCopy,
  formatIncompleteTerminalText,
  localizedTerminalModelText,
  priorOutcomeStatusCopy,
  terminalProtectionCopy,
} from '../server/services/loop/incompleteTerminalPresentation.js'
import { taskVerificationRepairBlockerText } from '../server/services/loop/taskVerificationRepair.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { normalizeTurnLocale } from '../shared/turnLocale.js'

const CJK_TEXT = /[\u3400-\u9fff]/u

const ECHO_TOOL_SPEC = {
  type: 'function',
  function: {
    name: 'echo_tool',
    description: 'Echo a short value.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
}

async function runIterationLimitScenario({ locale, wrapUpText }) {
  let checkpoint = null
  let wrapUpPrompt = ''
  const result = await runToolLoop({
    job: {
      id: `iteration-limit-${locale}`,
      userId: `iteration-limit-${locale}-user`,
      origin: 'chat',
      locale,
      prompt: 'Use echo_tool, then summarize the result.',
    },
    step: { id: `iteration-limit-${locale}`, kind: 'chat' },
    messages: [{ role: 'user', content: 'Use echo_tool, then summarize the result.' }],
    toolSpecs: [ECHO_TOOL_SPEC],
    enableToolHooks: false,
    maxIters: 1,
    requestToolApproval: async ({ args }) => ({
      proceed: true,
      args,
      approvalId: `iteration-limit-${locale}-approval`,
    }),
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async ({ messages, toolChoice }) => {
      if (toolChoice === 'none') {
        wrapUpPrompt = String(messages.at(-1)?.content || '')
        return { content: wrapUpText, toolCalls: [] }
      }
      return {
        content: '',
        toolCalls: [{
          id: `iteration-limit-${locale}-echo`,
          type: 'function',
          function: { name: 'echo_tool', arguments: '{"text":"done"}' },
        }],
      }
    },
    executeTool: async () => ({ ok: true, echoed: 'done' }),
  })
  return { checkpoint, result, wrapUpPrompt }
}

test('turn locale normalizes the existing UI languages to the zh/en runtime contract', () => {
  assert.equal(normalizeTurnLocale(undefined), 'zh')
  assert.equal(normalizeTurnLocale('zh-CN'), 'zh')
  assert.equal(normalizeTurnLocale('zh-Hans'), 'zh')
  assert.equal(normalizeTurnLocale('zh-TW'), 'en')
  assert.equal(normalizeTurnLocale('en-US'), 'en')
  assert.equal(normalizeTurnLocale('ja'), 'en')
  assert.equal(normalizeTurnLocale('ko'), 'en')
  assert.equal(normalizeTurnLocale('', 'zh-TW'), 'en')
})

test('incomplete terminal copy is stable in Chinese and English', () => {
  const zh = formatIncompleteTerminalText('execution_evidence_missing', { locale: 'zh' })
  const en = formatIncompleteTerminalText('execution_evidence_missing', { locale: 'en' })
  const fallback = formatIncompleteTerminalText('execution_evidence_missing', { locale: 'ja' })

  assert.match(zh, CJK_TEXT)
  assert.doesNotMatch(en, CJK_TEXT)
  assert.equal(fallback, en)
  assert.match(en, /execution evidence/i)
})

test('strict Chinese terminal text rejects English prose but preserves commands and identifiers', () => {
  assert.equal(
    localizedTerminalModelText(
      'zh',
      '进度已保存。 The task is still incomplete.',
      { strictLocale: true },
    ),
    '',
  )
  const technical = '已运行 npm run build，并检查 ManagedAttachmentStoragePort v1。'
  assert.equal(
    localizedTerminalModelText('zh', technical, { strictLocale: true }),
    technical,
  )
})

test('artifact-delivery copy uses the runtime reason code in Chinese and English', () => {
  const zh = formatIncompleteTerminalText('artifact_delivery_not_converged', { locale: 'zh' })
  const en = formatIncompleteTerminalText('artifact_delivery_not_converged', { locale: 'en' })

  assert.match(zh, CJK_TEXT)
  assert.doesNotMatch(en, CJK_TEXT)
  assert.match(en, /required file/i)
})

test('budget-exhaustion completion, wrap-up, and fallback copy are bilingual', () => {
  const zh = budgetExceededCopy('zh', 'token_limit')
  const en = budgetExceededCopy('en', 'token_limit')
  const enFromChineseReason = budgetExceededCopy('en', '模型预算已用尽')
  const legacy = budgetExceededCopy('ja', 'token_limit')

  for (const value of Object.values(zh)) assert.match(value, CJK_TEXT)
  for (const value of Object.values(en)) assert.doesNotMatch(value, CJK_TEXT)
  for (const value of Object.values(enFromChineseReason)) assert.doesNotMatch(value, CJK_TEXT)
  assert.deepEqual(legacy, en)
  assert.match(en.wrapUpPrompt, /Do not call any tools/)
})

test('post-mutation copy distinguishes available and unavailable verification tools', () => {
  const available = formatIncompleteTerminalText('post_mutation_verification_missing', {
    locale: 'en',
    hasVerificationTools: true,
  })
  const unavailable = formatIncompleteTerminalText('post_mutation_verification_missing', {
    locale: 'en',
    hasVerificationTools: false,
  })

  assert.match(available, /readback, diff, or project checks/i)
  assert.match(unavailable, /no verification tool/i)
  assert.notEqual(available, unavailable)
})

test('English partial-result fallback does not inject Chinese framing', () => {
  const fallback = createPartialResultFallback({ locale: 'en' })
  fallback.record({ name: 'write_file', args: { path: 'src/result.js' } }, {
    ok: true,
    path: 'src/result.js',
  })

  const result = fallback.apply({ incomplete: true, reason: 'turn_incomplete' })
  assert.doesNotMatch(result.text, CJK_TEXT)
  assert.match(result.text, /Task interrupted/)
  assert.match(result.text, /Completed work/)
})

test('prior-outcome status framing follows the locale and rejects mismatched blocker copy', () => {
  const zh = priorOutcomeStatusCopy('zh', {
    blocker: 'final verification failed',
    verifiedFiles: ['result.txt'],
  })
  const en = priorOutcomeStatusCopy('en', {
    blocker: '最终验证没有通过',
    verifiedFiles: ['result.txt'],
  })

  assert.match(zh, /上一轮仍未完成：上一轮执行未完成/)
  assert.match(en, /prior turn is still incomplete: the prior execution did not complete/i)
  assert.match(en, /Verified files: result\.txt/)
  assert.doesNotMatch(en, CJK_TEXT)
})

test('terminal-protection fallback copy is complete in Chinese and English', () => {
  const zh = terminalProtectionCopy('zh')
  const en = terminalProtectionCopy('en')

  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const value of Object.values(zh)) assert.match(value, CJK_TEXT)
  for (const value of Object.values(en)) assert.doesNotMatch(value, CJK_TEXT)
  assert.match(en.filteredClarificationText, /More information is required/i)
  assert.match(en.unverifiedFileText, /verification status/i)
})

test('task-verification blocker framing follows the selected runtime locale', () => {
  const state = {
    consecutiveFailures: 3,
    pending: new Map([['test', {
      kind: 'test',
      cwd: '.',
      commandScope: 'npm test',
      code: 'PROJECT_CHECK_FAILED',
      message: 'one assertion failed',
      failures: 3,
      requiredEpoch: 2,
    }]]),
    indeterminate: new Map(),
  }

  const zh = taskVerificationRepairBlockerText(state, { locale: 'zh' })
  const en = taskVerificationRepairBlockerText(state, { locale: 'en' })
  assert.match(zh, /任务验证连续失败 3 次/)
  assert.match(en, /did not pass after 3 verification failures/)
})

test('an empty English loop response persists and returns English incomplete copy', async () => {
  let checkpoint = null
  const result = await runToolLoop({
    job: {
      id: 'english-incomplete-copy',
      userId: 'english-incomplete-user',
      origin: 'chat',
      locale: 'en',
      prompt: 'Answer once.',
    },
    step: { id: 'english-incomplete-copy', kind: 'chat' },
    messages: [{ role: 'user', content: 'Answer once.' }],
    toolSpecs: [],
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async () => ({ content: '', toolCalls: [] }),
  })

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'empty_model_response')
  assert.doesNotMatch(result.text, CJK_TEXT)
  assert.equal(checkpoint.final.text, result.text)
})

test('iteration-limit completion follows the turn locale and persists the localized text', async (t) => {
  await t.test('English rejects a Chinese wrap-up response', async () => {
    const { checkpoint, result, wrapUpPrompt } = await runIterationLimitScenario({
      locale: 'en',
      wrapUpText: '工具执行了，但任务没有完成。',
    })

    assert.equal(result.incomplete, true)
    assert.equal(result.reason, 'iteration_limit_reached')
    assert.doesNotMatch(wrapUpPrompt, CJK_TEXT)
    assert.match(wrapUpPrompt, /tool-call limit/i)
    assert.doesNotMatch(result.text, CJK_TEXT)
    assert.match(result.text, /tool-call limit/i)
    assert.equal(checkpoint.final.text, result.text)
    assert.equal(checkpoint.final.reason, result.reason)
  })

  await t.test('English rejects Japanese and Korean wrap-up text', async () => {
    const { checkpoint, result } = await runIterationLimitScenario({
      locale: 'en',
      wrapUpText: 'ツールは実行済みですが、작업이 완료되지 않았습니다.',
    })

    assert.equal(result.incomplete, true)
    assert.equal(result.reason, 'iteration_limit_reached')
    assert.doesNotMatch(result.text, /[\u3040-\u30ff\uac00-\ud7af]/u)
    assert.match(result.text, /tool-call limit/i)
    assert.equal(checkpoint.final.text, result.text)
  })

  await t.test('English rejects a wrap-up containing full-width punctuation', async () => {
    const { checkpoint, result } = await runIterationLimitScenario({
      locale: 'en',
      wrapUpText: 'Progress saved。Retry to continue.',
    })

    assert.equal(result.incomplete, true)
    assert.equal(result.reason, 'iteration_limit_reached')
    assert.match(result.text, /tool-call limit/i)
    assert.doesNotMatch(result.text, /。/u)
    assert.equal(checkpoint.final.text, result.text)
  })

  await t.test('Chinese rejects an English wrap-up response', async () => {
    const { checkpoint, result, wrapUpPrompt } = await runIterationLimitScenario({
      locale: 'zh',
      wrapUpText: 'The tool ran, but the task is incomplete.',
    })

    assert.equal(result.incomplete, true)
    assert.equal(result.reason, 'iteration_limit_reached')
    assert.match(wrapUpPrompt, CJK_TEXT)
    assert.match(result.text, CJK_TEXT)
    assert.doesNotMatch(result.text, /The tool ran, but the task is incomplete\./)
    assert.equal(checkpoint.final.text, result.text)
    assert.equal(checkpoint.final.reason, result.reason)
  })

  await t.test('Chinese rejects a mixed English-prose wrap-up response', async () => {
    const { checkpoint, result } = await runIterationLimitScenario({
      locale: 'zh',
      wrapUpText: '进度已保存。 The task is still incomplete.',
    })

    assert.equal(result.incomplete, true)
    assert.equal(result.reason, 'iteration_limit_reached')
    assert.match(result.text, CJK_TEXT)
    assert.doesNotMatch(result.text, /The task is still incomplete\./)
    assert.equal(checkpoint.final.text, result.text)
  })
})

test('startServerTurn sends the selected UI locale with the initial request', async () => {
  let requestBody = null
  await startServerTurn({
    sessionId: 'locale-session',
    content: 'hello',
    locale: 'en',
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body)
      return new Response(JSON.stringify({
        turn: { sessionId: 'locale-session', turnId: 'locale-turn', status: 'running' },
      }), { status: 202, headers: { 'content-type': 'application/json' } })
    },
  })

  assert.equal(requestBody.locale, 'en')
})
