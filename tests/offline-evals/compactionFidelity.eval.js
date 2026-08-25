import assert from 'node:assert/strict'
import {
  buildCompaction,
  MAX_OUTBOUND_MESSAGES,
} from '../../server/services/compactionService.js'
import { defineOfflineEvalCase, defineOfflineEvalSuite } from '../helpers/offlineEvalHarness.js'

/**
 * Compaction-fidelity eval: when long conversations are compressed, the
 * protocol-critical structure (system prompt, tool-call/result pairing,
 * checkpoint marker) and task-relevant facts must survive. These cases are
 * the regression gate for any future semantic-compaction change.
 */

const SYSTEM_PROMPT = 'You are a careful workspace agent.'

const KEY_FACT = 'deployment window is Friday 14:00 UTC'

function user(text) {
  return { role: 'user', content: text }
}

function assistantText(text) {
  return { role: 'assistant', content: text }
}

function assistantToolCall(id, name, args) {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args ?? {}) } }],
  }
}

function toolResult(callId, text) {
  return { role: 'tool', tool_call_id: callId, content: text }
}

function case_(id, title, run) {
  return defineOfflineEvalCase({ id, category: 'compaction-fidelity', title, run })
}

const CASES = [
  case_(
    'tool-round-boundary-stays-paired',
    'a keep-window that would cut a parallel tool round moves back to its assistant turn',
    async () => {
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        user('first request'),
        assistantToolCall('call_early', 'read_file', { path: 'a.txt' }),
        toolResult('call_early', 'alpha contents'),
        user('second request'),
        assistantToolCall('call_late', 'read_file', { path: 'b.txt' }),
        toolResult('call_late', 'beta contents'),
        user('third request'),
      ]
      const result = buildCompaction({ messages, keepMessages: 2 })
      assert.equal(result.ok, true)
      assert.equal(result.compacted, true)
      // The late tool round must not be split: assistant precedes its result in the outbound view.
      const outbound = result.outboundMessages
      const lateAssistantIndex = outbound.findIndex((message) =>
        message.role === 'assistant' && message.tool_calls?.some((call) => call.id === 'call_late'))
      const lateResultIndex = outbound.findIndex((message) => message.role === 'tool' && message.tool_call_id === 'call_late')
      assert.ok(lateAssistantIndex >= 0, 'late assistant turn missing from outbound')
      assert.ok(lateResultIndex >= 0, 'late tool result missing from outbound')
      assert.ok(lateAssistantIndex < lateResultIndex, 'tool round was split across the boundary')
    },
  ),
  case_(
    'summary-and-tail-carry-task-facts-forward',
    'the checkpoint summary keeps key facts visible while the raw head is archived',
    async () => {
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        user(`remember: ${KEY_FACT}`),
        assistantText('noted.'),
        user('do some work'),
        assistantToolCall('call_w', 'write_file', { path: 'x.txt' }),
        toolResult('call_w', 'written'),
        user('final question'),
      ]
      const summaryText = `Checkpoint: ${KEY_FACT}. Work completed so far: wrote x.txt.`
      const result = buildCompaction({ messages, keepMessages: 2, summaryText })
      assert.equal(result.ok, true)
      assert.ok(result.summaryMessage.content.includes(KEY_FACT), 'key fact lost from checkpoint summary')
      assert.equal(result.replacedMessageCount, result.archivedMessages.length)
      // Canonical conversation stays untouched (archive remains recoverable).
      assert.equal(result.canonicalMessages, messages)
      assert.ok(messages.some((message) => message.content === `remember: ${KEY_FACT}`))
      // The final user turn must remain in the outbound view verbatim.
      assert.deepEqual(result.outboundMessages.at(-1), user('final question'))
    },
  ),
  case_(
    'outbound-view-respects-message-budget',
    'even after compaction the outbound projection stays inside the transport budget',
    async () => {
      const messages = [{ role: 'system', content: SYSTEM_PROMPT }]
      for (let index = 0; index < 80; index += 1) {
        messages.push(user(`turn ${index}`))
        messages.push(assistantText(`ack ${index}`))
      }
      const result = buildCompaction({ messages, keepMessages: 10, force: true })
      assert.equal(result.ok, true)
      assert.ok(
        result.outboundMessages.length <= Math.max(20, MAX_OUTBOUND_MESSAGES),
        `outbound view exceeded budget: ${result.outboundMessages.length}`,
      )
    },
  ),
  case_(
    'unbalanced-tool-chain-refused',
    'compaction fails closed instead of emitting a protocol-broken history',
    async () => {
      const broken = [
        { role: 'system', content: SYSTEM_PROMPT },
        user('request'),
        // Tool result without its assistant call breaks the pairing contract.
        toolResult('orphan_call', 'no matching call'),
        user('next'),
      ]
      const result = buildCompaction({ messages: broken, keepMessages: 1, force: true })
      assert.equal(result.ok, false)
      assert.ok(String(result.error).length > 0)
    },
  ),
  case_(
    'mechanical-fallback-summary-always-present',
    'without a model summary, a structured mechanical checkpoint still replaces the head',
    async () => {
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        user('alpha task'),
        assistantToolCall('call_m', 'grep_code', { pattern: 'alpha' }),
        toolResult('call_m', 'matches in src/a.js'),
        user('beta question'),
      ]
      const result = buildCompaction({ messages, keepMessages: 2, force: true })
      assert.equal(result.ok, true)
      assert.ok(typeof result.summaryText === 'string' && result.summaryText.trim().length > 0)
      assert.equal(result.summaryMessage.meta.compaction, true)
      assert.ok(result.summaryMessage.meta.compactCheckpointSource, 'checkpoint source marker missing')
    },
  ),
]

assert.ok(CASES.length >= 5)

export default defineOfflineEvalSuite({
  id: 'compaction-fidelity',
  title: 'Context compaction preserves protocol structure and task facts under compression',
  version: 1,
  cases: CASES,
})
