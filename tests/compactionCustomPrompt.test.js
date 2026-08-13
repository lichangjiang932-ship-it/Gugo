import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCompactionSummaryMessages } from '../server/services/compactionService.js'

test('buildCompactionSummaryMessages passes a custom prompt as an extra instruction', () => {
  const messages = buildCompactionSummaryMessages({
    evidenceSummaries: ['digest-a'],
    customPrompt: 'Keep it under 200 words and emphasize unresolved risks.',
  })
  assert.equal(messages.length, 2)
  assert.match(messages[0].content, /Keep it under 200 words and emphasize unresolved risks\./)
  assert.match(messages[0].content, /Additional compaction instructions:/)
})

test('buildCompactionSummaryMessages omits the custom instruction when empty', () => {
  const messages = buildCompactionSummaryMessages({ evidenceSummaries: ['digest-a'] })
  assert.equal(messages[0].content.includes('Additional compaction instructions:'), false)
})
