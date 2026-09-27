import assert from 'node:assert/strict'
import test from 'node:test'

import { characterTokenWeight, textTokens } from '../shared/textTokenEstimate.js'
import { textTokens as serverTokens } from '../server/services/contextCompactionMetrics.js'
import { estimateTextTokens } from '../src/lib/contextUsage.js'

test('ASCII keeps its historical four-characters-per-token cost', () => {
  assert.equal(textTokens(''), 0)
  assert.equal(textTokens(undefined), 0)
  assert.equal(textTokens('abcd'), 1)
  assert.equal(textTokens('abcde'), 2)
  assert.equal(textTokens('SELECT 1 FROM t'), 4)
  // Objects are measured as the JSON they will be serialized into.
  assert.equal(textTokens({ role: 'user', content: 'hi' }), textTokens(JSON.stringify({ role: 'user', content: 'hi' })))
})

test('written Chinese is charged the way tokenizers actually charge it', () => {
  // The old rule charged one token per character, so a Chinese conversation
  // looked about twice its real size to the compaction planner — which is what
  // refused a request the endpoint had already been answering.
  const sentence = '请把表一的信息填入表二中保持格式不变'
  const characters = [...sentence].length
  const estimated = textTokens(sentence)
  const oldEstimate = characters
  assert.ok(estimated < oldEstimate, `${estimated} should beat the old ${oldEstimate}`)
  // Still conservative: never below half a token per character, and never above
  // the old one-for-one count.
  assert.ok(estimated >= Math.ceil(characters * 0.5), `too optimistic: ${estimated} for ${characters} characters`)
  assert.ok(estimated <= oldEstimate)
  assert.equal(characterTokenWeight('中'), 0.6)
  assert.equal(characterTokenWeight('a'), 0.25)
})

test('everything else non-ASCII is charged in full, on purpose', () => {
  for (const character of ['あ', '한', 'Ñ', 'ё', '🙂', 'ﷺ']) {
    assert.equal(characterTokenWeight(character), 1, `${character} should cost a whole token`)
  }
  // Astral characters count as one code point, not two surrogate halves.
  assert.equal(textTokens('🙂🙂'), 2)
  assert.equal(textTokens('中'.repeat(10)), 6)
})

test('the planner and the interface meter cannot drift apart', () => {
  const samples = ['plain ascii text', '中文说明', '混合 mixed 内容', '🙂', '', '换行\n中文']
  for (const sample of samples) {
    // Two entry points, one rule: a meter that disagreed with the planner would
    // report a different context usage for the same conversation.
    assert.equal(serverTokens(sample), estimateTextTokens(sample), sample)
  }
})
