import assert from 'node:assert/strict'
import test from 'node:test'
import { createCompactionArchivePort } from '../server/core/compactionArchivePort.js'
import { compactForModel, callModelWithContextRecovery, boundCompactionSummary, applyRollingToolResultBudget } from '../server/services/contextCompactionRuntime.js'
import { buildCompaction, validateCompactCheckpointSource, toolPairingBalanced } from '../server/services/compactionService.js'

function toolPair(id, content) {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: id + '.txt' }) } }] },
    { role: 'tool', name: 'read_file', tool_call_id: id, content: JSON.stringify({ ok: true, content }) },
  ]
}

function history() {
  return [
    { role: 'user', content: 'Preserve every heading, never publish externally, and update only the named paragraph.' },
    ...toolPair('original-evidence', 'BEGIN-' + 'original evidence '.repeat(3000) + '-MIDDLE-CONSTRAINT-' + 'more evidence '.repeat(1000) + '-END'),
    { role: 'user', content: 'Also retain the original citations and footnotes.' },
    { role: 'assistant', content: 'The requested edit remains pending.' },
    ...toolPair('latest-evidence', 'Complete recent evidence.'),
  ]
}

function archiveFixture({ fail = false } = {}) {
  const records = new Map()
  const port = createCompactionArchivePort({
    apiVersion: 1, id: 'test.compaction-integrity',
    async create(input) {
      if (fail) throw new Error('archive storage unavailable')
      const record = { id: 'archive-' + (records.size + 1), userId: input.userId,
        sessionId: input.sessionId, archivedMessages: input.archivedMessages,
        replacedMessageCount: input.archivedMessages.length, summaryText: input.summaryText, createdAt: 1 }
      records.set(record.id, structuredClone(record))
      return record
    },
    async get({ id }) { return records.get(id) || null },
    async cleanup() { return { removed: 0 } },
  })
  return { port, records }
}

test('real compaction archives the full source before provider-only tool reductions', async () => {
  const messages = history()
  const original = structuredClone(messages)
  const { port, records } = archiveFixture()
  const prepared = await compactForModel({ messages, contextWindow: 8192, userId: 'owner', sessionId: 'session', compactionArchivePort: port })
  assert.equal(prepared.compacted, true)
  assert.equal(prepared.archivePersisted, true)
  const archived = records.get(prepared.archiveId)
  assert.ok(archived.archivedMessages.some((message) => message.role === 'tool' && message.content.includes('MIDDLE-CONSTRAINT')))
  assert.equal(archived.archivedMessages.find((message) => message.tool_call_id === 'original-evidence').content, original[2].content)
  assert.equal(validateCompactCheckpointSource(prepared.compactCheckpointSource, archived.archivedMessages).ok, true)
  assert.equal(toolPairingBalanced(prepared.messages).ok, true)
  assert.equal(Object.keys(prepared).includes('canonicalMessages'), false)
  assert.deepEqual(messages, original)
})

test('archive failure keeps complete checkpoint history while the provider receives a bounded view', async () => {
  const messages = history()
  const { port } = archiveFixture({ fail: true })
  let sent = null
  const result = await callModelWithContextRecovery({
    messages, contextWindow: 8192, userId: 'owner', sessionId: 'session', compactionArchivePort: port,
    callModel: async ({ messages: outbound }) => { sent = structuredClone(outbound); return { content: 'Done.' } },
    isContextLengthError: () => false,
  })
  assert.equal(result.recovery.compacted, true)
  assert.equal(result.recovery.archivePersisted, false)
  assert.equal(result.recovery.archiveId, null)
  assert.deepEqual(result.messages, messages)
  assert.ok(JSON.stringify(sent).length < JSON.stringify(messages).length / 2)
  assert.equal(Object.hasOwn(result.recovery, 'canonicalMessages'), false)
})

test('a refused compaction cannot replace canonical history with its failed candidate', async () => {
  const messages = [
    { role: 'system', content: 'Keep the original constraints.' },
    ...history(),
    { role: 'assistant', content: '', tool_calls: [{ id: 'unknown-write', function: { name: 'write_file', arguments: '{"path":"result.txt"}' } }] },
  ]
  const original = structuredClone(messages)
  const prepared = await compactForModel({ messages, contextWindow: 8192, force: true })
  assert.equal(prepared.compacted, false)
  assert.deepEqual(prepared.canonicalMessages, original)
  assert.equal(prepared.messages.some((message) => message.meta?.compaction), false)
  assert.deepEqual(messages, original)
})

test('directions and host constraints survive repeated summary fitting intact', () => {
  const instructions = ['Keep all supplied citations verbatim.', 'Never upload or publish any file.', 'Update paragraph three only.']
  const messages = [
    ...Array.from({ length: 36 }, (_, index) => ({ role: 'system', content: 'Host constraint ' + index })),
    ...instructions.flatMap((content) => [{ role: 'user', content }, { role: 'assistant', content: 'Observed progress. '.repeat(500) }]),
    { role: 'assistant', content: 'Current work remains unfinished.' },
  ]
  const first = buildCompaction({ messages, keepMessages: 1, force: true })
  const compacted = boundCompactionSummary(first.summaryText, { maxTokens: 600 })
  for (const direction of instructions) assert.ok(compacted.includes(direction), direction)
  const second = buildCompaction({ messages: [
    ...first.outboundMessages.map((message) => message === first.summaryMessage ? { ...message, content: compacted } : message),
    { role: 'user', content: 'Continue without changing those requirements.' },
    { role: 'assistant', content: 'Latest working state.' },
  ], keepMessages: 1, force: true })
  const refitted = boundCompactionSummary(second.summaryText, { maxTokens: 600 })
  for (const direction of instructions) assert.ok(refitted.includes(direction), direction)
  assert.equal(second.outboundMessages.filter((message) => message.role === 'system').length, 36)
})

test('rolling views keep every result in the latest parallel tool batch complete', () => {
  const calls = ['a', 'b', 'c'].map((id) => ({ id, function: { name: 'read_file', arguments: '{}' } }))
  const messages = [...toolPair('old', 'x'.repeat(10000)),
    { role: 'assistant', content: '', tool_calls: calls },
    ...calls.map(({ id }) => ({ role: 'tool', tool_call_id: id, name: 'read_file', content: id.repeat(10000) })),
  ]
  const rolling = applyRollingToolResultBudget(messages, { maxTokens: 1000 })
  assert.ok(rolling.compactedCount > 0)
  for (const { id } of calls) assert.equal(rolling.messages.find((message) => message.tool_call_id === id).content, id.repeat(10000))
  assert.equal(toolPairingBalanced(rolling.messages).ok, true)
})

test('manual stop during compaction prevents any subsequent model request', async () => {
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(() => callModelWithContextRecovery({
    messages: history(), contextWindow: 8192, signal: controller.signal,
    compactionStrategyResolver: async (input) => {
      controller.abort()
      return { shouldCompact: true, keepMessages: input.defaultKeepMessages }
    },
    callModel: async () => { calls += 1; return { content: 'must not run' } },
  }), (error) => error.name === 'AbortError')
  assert.equal(calls, 0)
})

test('cancellation preserves a host request fence error identity instead of wrapping it', async () => {
  const controller = new AbortController()
  const fence = Object.assign(new Error('request ownership revoked'), { code: 'HOST_REQUEST_REVOKED' })
  await assert.rejects(() => callModelWithContextRecovery({
    messages: [{ role: 'user', content: 'One safe request.' }], signal: controller.signal,
    callModel: async () => { controller.abort(); throw fence },
  }), (error) => error === fence)
})
