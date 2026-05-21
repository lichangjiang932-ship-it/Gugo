import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'

const DEFAULT_KEEP_MESSAGES = 40

export function validateToolCallChain(messages = []) {
  const seen = new Set()
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call?.id) seen.add(call.id)
      }
    }
    if (message?.role === 'tool' && message.tool_call_id && !seen.has(message.tool_call_id)) {
      return { ok: false, error: `tool message without prior assistant tool_call: ${message.tool_call_id}` }
    }
  }
  return { ok: true }
}

function textOf(message) {
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => part?.text || (part?.type === 'image_url' ? '[image]' : '')).join(' ')
  }
  return ''
}

function summarizeHead(messages) {
  const bullets = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-12)
    .map((message) => `- ${message.role}: ${textOf(message).replace(/\s+/g, ' ').slice(0, 180)}`)
    .join('\n')
  return [
    'Earlier conversation was compacted.',
    '',
    'Key recent context:',
    bullets || '- No textual context was available.',
  ].join('\n')
}

export function buildCompaction({ messages = [], keepMessages = DEFAULT_KEEP_MESSAGES } = {}) {
  const chain = validateToolCallChain(messages)
  if (!chain.ok) return { ok: false, error: chain.error }
  if (messages.length <= keepMessages) {
    return { ok: true, compacted: false, messages, replacedMessageCount: 0 }
  }

  const system = messages.filter((message) => message.role === 'system')
  const nonSystem = messages.filter((message) => message.role !== 'system')
  const tail = nonSystem.slice(-keepMessages)
  let head = nonSystem.slice(0, -keepMessages)

  const tailToolCallIds = new Set()
  const satisfiedInTail = new Set()
  for (const message of tail) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call?.id) satisfiedInTail.add(call.id)
      }
    }
    if (message?.role === 'tool' && message.tool_call_id) {
      tailToolCallIds.add(message.tool_call_id)
    }
  }

  const hoisted = []
  const hoistedIndexes = new Set()
  for (const id of tailToolCallIds) {
    if (satisfiedInTail.has(id)) continue
    const idx = head.findIndex((message) =>
      message?.role === 'assistant' &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.some((call) => call?.id === id)
    )
    if (idx >= 0 && !hoistedIndexes.has(idx)) {
      hoisted.push({
        ...head[idx],
        tool_calls: head[idx].tool_calls.filter((call) => tailToolCallIds.has(call?.id)),
      })
      hoistedIndexes.add(idx)
    }
  }
  head = head.filter((_, index) => !hoistedIndexes.has(index))

  const summaryText = summarizeHead(head)
  const summaryMessage = {
    role: 'assistant',
    content: summaryText,
    meta: {
      type: 'context_summary',
      compaction: true,
      compressedCount: head.length,
    },
  }
  const compactedMessages = [...system, summaryMessage, ...hoisted, ...tail]
  const compactedChain = validateToolCallChain(compactedMessages)
  if (!compactedChain.ok) {
    return { ok: false, error: compactedChain.error }
  }
  return {
    ok: true,
    compacted: true,
    messages: compactedMessages,
    archivedMessages: head,
    summaryMessage,
    summaryText,
    replacedMessageCount: head.length,
  }
}

export function createCompactionArchive({ userId, sessionId, archivedMessages, summaryText }) {
  const id = `cmp-${randomUUID()}`
  getDb().prepare(
    `INSERT INTO compaction_archive (id, user_id, session_id, replaced_message_count, archived_messages_json, summary_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    sessionId,
    archivedMessages.length,
    JSON.stringify(archivedMessages),
    summaryText,
    Date.now()
  )
  return getCompactionArchive({ userId, id })
}

export function getCompactionArchive({ userId, id }) {
  const row = getDb().prepare('SELECT * FROM compaction_archive WHERE user_id = ? AND id = ?').get(userId, id)
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    replacedMessageCount: row.replaced_message_count,
    archivedMessages: JSON.parse(row.archived_messages_json || '[]'),
    summaryText: row.summary_text,
    createdAt: row.created_at,
  }
}
