import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addSemanticCompactionSummary,
  callModelWithContextRecovery,
  estimateContextTokens,
  getAutoCompactionThreshold,
  trimOldestContext,
} from '../server/services/contextCompactionRuntime.js'
import { buildCompaction, validateToolCallChain } from '../server/services/compactionService.js'

const TOOLS = [{
  type: 'function',
  function: { name: 'read_file', parameters: { type: 'object', properties: {} } },
}]

function contextError() {
  return Object.assign(new Error('maximum context length exceeded'), { status: 400, code: 'context_length_exceeded' })
}

test('token waterline uses 80% of the 1M window with an 800k ceiling', () => {
  assert.equal(getAutoCompactionThreshold(100_000), 80_000)
  assert.equal(getAutoCompactionThreshold(1_000_000), 800_000)
  assert.ok(estimateContextTokens([{ role: 'user', content: '中文 abc' }], TOOLS) > 0)
})

test('proactive waterline compacts before the engine model request', async () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `${index}:${'x'.repeat(1200)}`,
  }))
  let sentMessages = null
  const callModel = async ({ messages: outbound, tools }) => {
    if (!tools?.length) return { content: '' }
    sentMessages = outbound
    return { content: 'done', toolCalls: [] }
  }

  const result = await callModelWithContextRecovery({
    messages,
    tools: TOOLS,
    callModel,
    contextWindow: 4096,
    isContextLengthError: () => false,
  })

  assert.equal(result.response.content, 'done')
  assert.ok(sentMessages.length < messages.length)
  assert.equal(result.recovery.compacted, true)
  assert.match(sentMessages.find((message) => message?.meta?.compaction)?.content || '', /User direction/)
})

test('automatic compaction never makes hidden semantic-summary model calls', async () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `${index}:${'x'.repeat(1200)}`,
  }))
  const requests = []
  const result = await callModelWithContextRecovery({
    messages,
    tools: TOOLS,
    contextWindow: 4096,
    isContextLengthError: () => false,
    callModel: async (request) => {
      requests.push(request)
      return { content: 'done', toolCalls: [] }
    },
  })

  assert.equal(result.response.content, 'done')
  assert.equal(requests.length, 1, 'automatic recovery must not block on extra map/reduce calls')
  assert.equal(requests[0].tools.length, 1)
  assert.equal(result.recovery.semanticSummary.modelCalls, 0)
  assert.equal(result.recovery.semanticSummary.fallbackReason, 'disabled_for_automatic_compaction')
})

test('400 recovery force-compacts once, then trims oldest 10% for the final retry', async () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `message ${index}`,
  }))
  const mainRequestSizes = []
  const callModel = async ({ messages: outbound, tools }) => {
    if (!tools?.length) return { content: '' }
    mainRequestSizes.push(outbound.length)
    if (mainRequestSizes.length < 3) throw contextError()
    return { content: 'recovered', toolCalls: [] }
  }

  const result = await callModelWithContextRecovery({
    messages,
    tools: TOOLS,
    callModel,
    contextWindow: 1_000_000,
    isContextLengthError: (error) => error.status === 400 && /context/i.test(error.message),
  })

  assert.equal(result.response.content, 'recovered')
  assert.equal(mainRequestSizes.length, 3)
  assert.ok(mainRequestSizes[1] < mainRequestSizes[0], 'forced compaction must reduce the retry payload')
  assert.ok(mainRequestSizes[2] < mainRequestSizes[1], 'last retry must trim the oldest context')
  assert.equal(result.recovery.trimmed, true)
})

test('overflow trimming preserves the latest user objective and latest tool chain', () => {
  const staleObjective = { role: 'user', content: 'An obsolete request from an earlier turn.' }
  const activeObjective = { role: 'user', content: 'Create the requested deliverable exactly as specified.' }
  const latestCall = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'latest-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"result.txt"}' } }],
  }
  const latestResult = { role: 'tool', tool_call_id: 'latest-read', name: 'read_file', content: '{"ok":true}' }
  const messages = [
    { role: 'system', content: 'system' },
    staleObjective,
    ...Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `old ${index}`,
    })),
    activeObjective,
    latestCall,
    latestResult,
  ]

  const trimmed = trimOldestContext(messages, 0.75)

  assert.ok(!trimmed.includes(staleObjective), 'an obsolete earliest user request may be trimmed')
  assert.ok(trimmed.includes(activeObjective), 'the latest user objective must remain verbatim')
  assert.ok(trimmed.includes(latestCall), 'the latest assistant tool call must remain')
  assert.ok(trimmed.includes(latestResult), 'the matching latest tool result must remain')
  assert.equal(validateToolCallChain(trimmed).ok, true)
})

test('third-stage recovery keeps the latest objective when forced compaction is refused', async () => {
  const staleObjective = 'Explain an unrelated topic from an earlier turn.'
  const objective = 'Build the webpage now and verify every requested step.'
  const latestCall = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'latest-write', type: 'function', function: { name: 'write_file', arguments: '{"path":"index.html"}' } }],
  }
  const latestResult = { role: 'tool', tool_call_id: 'latest-write', name: 'write_file', content: '{"ok":true}' }
  const requests = []
  const result = await callModelWithContextRecovery({
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: staleObjective },
      { role: 'tool', tool_call_id: 'orphaned-old-call', content: 'invalid old chain' },
      ...Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: `history ${index}`,
      })),
      { role: 'user', content: objective },
      latestCall,
      latestResult,
    ],
    tools: TOOLS,
    contextWindow: 1_000_000,
    isContextLengthError: (error) => error?.code === 'context_length_exceeded',
    callModel: async ({ messages: outbound }) => {
      requests.push(outbound)
      if (requests.length < 3) throw contextError()
      return { content: 'recovered with objective', toolCalls: [] }
    },
  })

  const finalRequest = requests.at(-1)
  assert.equal(result.response.content, 'recovered with objective')
  assert.ok(finalRequest.some((message) => message?.role === 'user' && message.content === objective))
  assert.ok(finalRequest.includes(latestCall))
  assert.ok(finalRequest.includes(latestResult))
  assert.equal(validateToolCallChain(finalRequest).ok, true)
})

test('semantic compaction map-reduces large archives, preserves user text, audits, and consumes budget', async () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: index % 2 ? `progress ${index}` : `用户原文 ${index}:${'中'.repeat(900)}`,
  }))
  const compaction = buildCompaction({ messages, keepMessages: 2, force: true })
  const requests = []
  const audits = []
  let consumed = 0
  const semantic = await addSemanticCompactionSummary({
    result: compaction,
    contextWindow: 8192,
    userId: 'u_semantic',
    consumeBudget: (cost) => {
      consumed += cost
      return { ok: true }
    },
    audit: (entry) => audits.push(entry),
    callModel: async ({ messages: outbound }) => {
      requests.push(outbound)
      if (/exactly seven numbered Markdown sections/.test(outbound[0].content)) {
        return {
          content: [
            '## 2. Objective and success criteria', '- Continue the requested work.',
            '## 3. Decisions and constraints', '- Preserve constraints.',
            '## 4. Completed work', '- Evidence was reviewed.',
            '## 5. Current working state', '- Compaction is active.',
            '## 6. Files read or changed', '- None.',
            '## 7. Commands and tool outcomes', '- None.',
            '## 8. Open work, risks, and next actions', '- Continue.',
          ].join('\n'),
        }
      }
      return { content: 'Concise evidence digest.' }
    },
  })

  assert.equal(semantic.telemetry.used, true)
  assert.ok(semantic.telemetry.batchCount > 1)
  assert.equal(consumed, semantic.telemetry.modelCalls)
  assert.equal(audits.filter((entry) => entry.status === 'ok').length, semantic.telemetry.modelCalls)
  assert.match(semantic.result.summaryText, /用户原文 0:/)
  assert.match(semantic.result.summaryText, /## 8\. Open work, risks, and next actions/)
  assert.ok(requests.every((request) => estimateContextTokens(request) <= 4096))
})

test('semantic compaction exposes audited fallback when the summarizer fails', async () => {
  const compaction = buildCompaction({
    messages: [
      { role: 'user', content: 'keep me verbatim' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: 'tail' },
    ],
    keepMessages: 1,
    force: true,
  })
  const audits = []
  const semantic = await addSemanticCompactionSummary({
    result: compaction,
    callModel: async () => { throw new Error('summarizer unavailable') },
    audit: (entry) => audits.push(entry),
  })

  assert.equal(semantic.result, compaction)
  assert.equal(semantic.telemetry.used, false)
  assert.match(semantic.telemetry.fallbackReason, /summarizer unavailable/)
  assert.ok(audits.some((entry) => entry.toolName === 'semantic_summary_fallback' && entry.status === 'error'))
})
