import assert from 'node:assert/strict'
import test from 'node:test'

import { startServerTurn } from '../src/lib/turnClient/turnRequests.js'
import { createPartialResultFallback } from '../server/services/partialResultFallback.js'
import {
  budgetExceededCopy,
  formatIncompleteTerminalText,
} from '../server/services/loop/incompleteTerminalPresentation.js'
import { taskVerificationRepairBlockerText } from '../server/services/loop/taskVerificationRepair.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { normalizeTurnLocale } from '../shared/turnLocale.js'

const CJK_TEXT = /[\u3400-\u9fff]/u

test('turn locale normalizes the existing UI languages to the zh/en runtime contract', () => {
  assert.equal(normalizeTurnLocale(undefined), 'zh')
  assert.equal(normalizeTurnLocale('zh-TW'), 'zh')
  assert.equal(normalizeTurnLocale('en-US'), 'en')
  assert.equal(normalizeTurnLocale('ja'), 'en')
  assert.equal(normalizeTurnLocale('ko'), 'en')
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

test('budget-exhaustion completion, wrap-up, and fallback copy are bilingual', () => {
  const zh = budgetExceededCopy('zh', 'token_limit')
  const en = budgetExceededCopy('en', 'token_limit')
  const legacy = budgetExceededCopy('ja', 'token_limit')

  for (const value of Object.values(zh)) assert.match(value, CJK_TEXT)
  for (const value of Object.values(en)) assert.doesNotMatch(value, CJK_TEXT)
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
