import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_CONTEXT_WINDOW,
  MAX_COMPACTION_SUMMARY_CHARS,
  addSemanticCompactionSummary,
  applyRollingToolResultBudget,
  callModelWithContextRecovery,
  compactForModel,
  estimateContextTokens,
  getAutoCompactionThreshold,
  trimOldestContext,
} from '../server/services/contextCompactionRuntime.js'
import { buildCompaction, validateToolCallChain } from '../server/services/compactionService.js'
import { createUser, getDb } from '../server/db.js'
import { upsertSession } from '../server/services/sessionStore.js'
import { activateTestCompactionArchivePort } from './helpers/testCompactionArchivePort.js'

const compactionArchiveController = activateTestCompactionArchivePort({
  source: 'test.context-compaction-runtime',
})

test.after(() => {
  compactionArchiveController.release()
})

const TOOLS = [{
  type: 'function',
  function: { name: 'read_file', parameters: { type: 'object', properties: {} } },
}]

function contextError() {
  return Object.assign(new Error('maximum context length exceeded'), { status: 400, code: 'context_length_exceeded' })
}

test('token waterline uses 80% for smaller windows and a 128k active-context ceiling', () => {
  assert.equal(getAutoCompactionThreshold(100_000), 80_000)
  assert.equal(getAutoCompactionThreshold(1_000_000), 128_000)
  assert.equal(getAutoCompactionThreshold(1_000_000, 192_000), 192_000)
  assert.ok(estimateContextTokens([{ role: 'user', content: '中文 abc' }], TOOLS) > 0)
})

test('missing model metadata uses the conservative 128k compaction fallback', () => {
  assert.equal(DEFAULT_CONTEXT_WINDOW, 128_000)
  assert.equal(getAutoCompactionThreshold(), 102_400)
  assert.equal(getAutoCompactionThreshold(Number.NaN), 102_400)
})

test('server context estimate treats inline images as bounded visual input instead of base64 text', () => {
  const oneMegabyteImage = `data:image/png;base64,${'A'.repeat(1024 * 1024)}`
  const estimated = estimateContextTokens([{
    role: 'user',
    content: [
      { type: 'text', text: 'Inspect this screenshot.' },
      { type: 'image_url', image_url: { url: oneMegabyteImage } },
    ],
  }])

  assert.ok(estimated < 1_000)
})

test('rolling tool-result budget keeps newest evidence and compacts older large outputs', () => {
  const messages = [{ role: 'user', content: 'Build and verify the site.' }]
  for (let index = 0; index < 12; index += 1) {
    const callId = `read-${index}`
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: callId,
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: `page-${index}.html` }) },
      }],
    })
    messages.push({
      role: 'tool',
      tool_call_id: callId,
      name: 'read_file',
      content: JSON.stringify({ ok: true, path: `page-${index}.html`, content: `${index}:${'x'.repeat(20_000)}` }),
    })
  }

  const result = applyRollingToolResultBudget(messages, {
    contextWindow: 128_000,
    activeContextTokens: 32_000,
  })
  const toolMessages = result.messages.filter((message) => message.role === 'tool')

  assert.ok(result.compactedCount >= 10)
  assert.match(toolMessages.at(-1).content, /x{100}/, 'newest tool evidence must remain complete')
  assert.equal(JSON.parse(toolMessages[0].content).contextCompacted, true)
  assert.equal(JSON.parse(toolMessages[0].content).path, 'page-0.html')
  assert.equal(validateToolCallChain(result.messages).ok, true)
  assert.ok(estimateContextTokens(result.messages, TOOLS) < estimateContextTokens(messages, TOOLS) / 3)
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

test('post-compaction measurement performs one bounded second pass and keeps a legal tool chain', async () => {
  const tools = [{
    type: 'function',
    function: {
      name: 'large_schema_tool',
      description: 't'.repeat(4_000),
      parameters: { type: 'object', properties: {} },
    },
  }]
  const messages = [{ role: 'system', content: 's'.repeat(5_000) }]
  for (let index = 0; index < 18; index += 1) {
    const id = `call-${index}`
    messages.push({ role: 'user', content: `request ${index} ${'x'.repeat(360)}` })
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{
        id,
        type: 'function',
        function: { name: 'large_schema_tool', arguments: '{}' },
      }],
    })
    messages.push({ role: 'tool', tool_call_id: id, name: 'large_schema_tool', content: '{"ok":true}' })
  }

  const result = await compactForModel({ messages, tools, contextWindow: 4_096 })

  assert.equal(result.compacted, true)
  assert.equal(result.convergencePasses, 2)
  assert.ok(result.postCompactionEstimatedTokens < result.threshold)
  assert.equal(result.postCompactionEstimatedTokens, estimateContextTokens(result.messages, tools))
  assert.equal(validateToolCallChain(result.messages).ok, true)
  assert.ok(result.messages.find((message) => message?.meta?.compaction).content.length <= MAX_COMPACTION_SUMMARY_CHARS)
})

test('two ephemeral screenshots survive a context retry but never enter second-pass compaction or archive', async (t) => {
  const userId = `ephemeral-compaction-user-${process.pid}`
  const sessionId = `ephemeral-compaction-session-${process.pid}`
  const db = getDb()
  db.prepare('DELETE FROM compaction_archive WHERE user_id = ?').run(userId)
  db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  createUser({ id: userId, email: `ephemeral-compaction-${process.pid}@example.com` })
  upsertSession({ id: sessionId, userId, title: 'Ephemeral compaction isolation' })
  t.after(() => {
    db.prepare('DELETE FROM compaction_archive WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  })

  const tools = [{
    type: 'function',
    function: {
      name: 'large_schema_tool',
      description: 't'.repeat(6_000),
      parameters: { type: 'object', properties: {} },
    },
  }]
  const messages = [
    { role: 'system', content: 's'.repeat(5_000) },
    ...Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `history ${index} ${'x'.repeat(360)}`,
    })),
  ]
  const ephemeralMessages = ['FIRST_SCREENSHOT_BYTES', 'SECOND_SCREENSHOT_BYTES'].map((data, index) => ({
    role: 'user',
    content: [
      { type: 'text', text: `Inspect screenshot ${index + 1}.` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
    ],
    meta: { type: 'ephemeral_tool_media', toolCallId: `shot-${index + 1}` },
  }))
  const requests = []

  const result = await callModelWithContextRecovery({
    messages,
    ephemeralMessages,
    tools,
    contextWindow: 4_096,
    userId,
    sessionId,
    isContextLengthError: (error) => error?.code === 'context_length_exceeded',
    callModel: async ({ messages: outbound }) => {
      requests.push(structuredClone(outbound))
      if (requests.length === 1) throw contextError()
      return { content: 'recovered', toolCalls: [] }
    },
  })

  assert.equal(result.response.content, 'recovered')
  assert.equal(result.recovery.convergencePasses, 2)
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.match(JSON.stringify(request.at(-2)), /FIRST_SCREENSHOT_BYTES/u)
    assert.match(JSON.stringify(request.at(-1)), /SECOND_SCREENSHOT_BYTES/u)
  }
  assert.doesNotMatch(JSON.stringify(result.messages), /data:image|base64|SCREENSHOT_BYTES/u)
  const archive = db.prepare(`
    SELECT archived_messages_json, summary_text
    FROM compaction_archive
    WHERE id = ?
  `).get(result.recovery.archiveId)
  assert.ok(archive)
  assert.doesNotMatch(JSON.stringify(archive), /data:image|base64|SCREENSHOT_BYTES/u)
})

test('non-converging oversized dynamic text fails before any main-model request', async () => {
  let calls = 0
  await assert.rejects(
    callModelWithContextRecovery({
      messages: [
        { role: 'system', content: 'fixed instructions' },
        { role: 'user', content: `latest objective ${'x'.repeat(40_000)}` },
      ],
      tools: TOOLS,
      contextWindow: 4_096,
      isContextLengthError: () => false,
      callModel: async () => {
        calls += 1
        return { content: 'must not run' }
      },
    }),
    (error) => error?.code === 'CONTEXT_COMPACTION_DID_NOT_CONVERGE',
  )
  assert.equal(calls, 0)
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
