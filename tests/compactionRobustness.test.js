import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCompaction,
  buildCompactionEvidenceMessages,
  buildCompactionSummaryBatches,
  extractCompactionState,
  MAX_OUTBOUND_MESSAGES,
  validateToolCallChain,
} from '../server/services/compactionService.js'

function estimatedTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  let ascii = 0
  let nonAscii = 0
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4) + nonAscii
}

test('compaction keeps canonical history untouched and preserves archived user text verbatim', () => {
  const messages = []
  for (let index = 0; index < 30; index += 1) {
    messages.push({ role: 'user', content: `用户原文 ${index}：保留标点，A/B & C。` })
    messages.push({ role: 'assistant', content: `progress ${index}` })
  }
  const snapshot = structuredClone(messages)
  const result = buildCompaction({ messages, keepMessages: 4 })

  assert.equal(result.ok, true)
  assert.equal(result.canonicalMessages, messages)
  assert.deepEqual(messages, snapshot)
  assert.notEqual(result.outboundMessages, messages)
  assert.match(result.summaryText, /用户原文 0：保留标点，A\/B & C。/)
  assert.match(result.summaryText, /## 8\. Open work/)
})

test('compaction extracts files, commands, exit codes, and unresolved tool calls', () => {
  const state = extractCompactionState([
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'shell-1', type: 'function', function: { name: 'bash_exec', arguments: '{"command":"npm test"}' } },
        { id: 'command-1', type: 'function', function: { name: 'run_command', arguments: '{"cmd":"python -V"}' } },
        { id: 'write-1', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/a.js"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'shell-1', name: 'bash_exec', content: '{"ok":false,"exitCode":1}' },
    { role: 'tool', tool_call_id: 'command-1', name: 'run_command', content: '{"ok":true,"exitCode":0}' },
  ])
  assert.deepEqual(state.files, ['src/a.js'])
  assert.deepEqual(state.commands, [
    { command: 'npm test', exitCode: 1 },
    { command: 'python -V', exitCode: 0 },
  ])
  assert.equal(state.pendingToolCalls.length, 1)
  assert.equal(state.pendingToolCalls[0].id, 'write-1')
})

test('overflow fallback keeps outbound view under its hard message limit with a valid tool chain', () => {
  const messages = []
  for (let index = 0; index < MAX_OUTBOUND_MESSAGES + 500; index += 1) {
    messages.push({ role: index % 2 ? 'assistant' : 'user', content: `message ${index}` })
  }
  const result = buildCompaction({ messages, keepMessages: MAX_OUTBOUND_MESSAGES })
  assert.equal(result.ok, true)
  assert.equal(result.forced, true)
  assert.ok(result.outboundMessages.length <= MAX_OUTBOUND_MESSAGES)
  assert.equal(validateToolCallChain(result.outboundMessages).ok, true)
})

test('semantic summary input is split into bounded batches instead of serializing the whole archive', () => {
  const archivedMessages = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `${index}:${'中'.repeat(1800)}`,
  }))
  const plan = buildCompactionSummaryBatches({ archivedMessages, inputTokenBudget: 4096 })

  assert.ok(plan.batches.length > 1)
  assert.equal(plan.truncatedMessageCount, 24)
  for (const batch of plan.batches) {
    const request = buildCompactionEvidenceMessages({ serializedMessages: batch })
    assert.ok(estimatedTokens(request) <= 4096, `batch exceeded budget: ${estimatedTokens(request)}`)
  }
})
