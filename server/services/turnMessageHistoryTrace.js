import { SOURCE_BEARING_ARTIFACT_TOOLS, parsedObject } from './turnMessageLocalFileEvidence.js'

const MAX_TOOL_CALLS_PER_GROUP = 8
// Historical tool arguments are audit/context hints, not an artifact source
// store. Successful artifact calls are reduced to references below; other
// calls retain a bounded preview so repeated turns cannot multiply large file
// bodies, commands, or payloads indefinitely.
const MAX_TOOL_ARGUMENT_CHARS = 12_000
const MAX_TOOL_RESULT_CHARS = 8_000
const MAX_TURN_TOOL_CONTEXT_CHARS = 96_000
export const MAX_SESSION_TOOL_CONTEXT_CHARS = 128_000
const ARTIFACT_TYPE_BY_TOOL = Object.freeze({
  create_docx: 'docx',
  create_html_app: 'html',
  create_pdf: 'pdf',
  create_pptx: 'pptx',
  create_xlsx: 'xlsx',
  generate_image: 'image',
  render_pdf_pages: 'image',
})
const MAX_TOOL_GROUPS_PER_TURN = 16
const STORED_MESSAGE_SOURCE_ID = Symbol('gugoStoredMessageSourceId')

export function tagStoredMessageSource(message, sourceId) {
  const id = String(sourceId || '').trim()
  if (!message || !id) return message
  Object.defineProperty(message, STORED_MESSAGE_SOURCE_ID, {
    value: id,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return message
}

export function storedMessageSourceId(message) {
  return String(message?.[STORED_MESSAGE_SOURCE_ID] || '').trim() || null
}

export function resolveStoredMessagesAfterCompaction(messages, boundary = null) {
  const source = Array.isArray(messages) ? messages : []
  const firstKeptMessageId = String(boundary?.firstKeptMessageId || '').trim()
  if (firstKeptMessageId) {
    const index = source.findIndex((message) => String(message?.id || '') === firstKeptMessageId)
    if (index >= 0) return { messages: source.slice(index), matched: true, boundary: 'first_kept' }
  }

  const lastCompactedMessageId = String(boundary?.lastCompactedMessageId || '').trim()
  if (lastCompactedMessageId) {
    const index = source.findIndex((message) => String(message?.id || '') === lastCompactedMessageId)
    if (index >= 0) return { messages: source.slice(index + 1), matched: true, boundary: 'last_compacted' }
  }

  // A stale canonical snapshot may no longer contain either exact compaction
  // boundary, while still containing the assistant message that references
  // the archive. Everything after that reference is newer than the archive
  // and must remain visible (most importantly, the active user request).
  const referenceMessageId = String(boundary?.referenceMessageId || '').trim()
  if (referenceMessageId) {
    const index = source.findIndex((message) => String(message?.id || '') === referenceMessageId)
    if (index >= 0) {
      return { messages: source.slice(index + 1), matched: false, boundary: 'archive_reference' }
    }
  }
  const referenceMessageIndex = Number(boundary?.referenceMessageIndex)
  if (Number.isInteger(referenceMessageIndex)
    && referenceMessageIndex >= 0
    && referenceMessageIndex < source.length) {
    return {
      messages: source.slice(referenceMessageIndex + 1),
      matched: false,
      boundary: 'archive_reference_index',
    }
  }
  const compacted = boundary?.compacted === true || Boolean(firstKeptMessageId || lastCompactedMessageId)
  return compacted
    ? { messages: [], matched: false, boundary: 'unmatched' }
    : { messages: source, matched: false, boundary: 'none' }
}

export function selectStoredMessagesAfterCompaction(messages, boundary = null) {
  return resolveStoredMessagesAfterCompaction(messages, boundary).messages
}

export function jsonLength(value) {
  try { return JSON.stringify(value).length } catch { return Number.MAX_SAFE_INTEGER }
}

function truncatedArguments(text, limit) {
  const note = `[tool arguments truncated: ${text.length} chars total]`
  const build = (headChars, tailChars) => JSON.stringify({
    __truncated: true,
    originalChars: text.length,
    note,
    previewHead: text.slice(0, headChars),
    previewTail: tailChars > 0 ? text.slice(-tailChars) : '',
  })
  let tailChars = Math.min(8_000, Math.floor(limit / 4))
  let headChars = Math.max(0, limit - tailChars - 240)
  let summary = build(headChars, tailChars)
  // JSON escaping can make a preview longer than its raw slices. Scale both
  // previews down until the persisted representation itself obeys the cap.
  for (let attempt = 0; summary.length > limit && attempt < 12; attempt += 1) {
    const ratio = Math.max(0, Math.min(0.95, (limit - 240) / summary.length))
    headChars = Math.floor(headChars * ratio)
    tailChars = Math.floor(tailChars * ratio)
    summary = build(headChars, tailChars)
  }
  return summary.length <= limit ? summary : build(0, 0)
}

function boundedArguments(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {})
  if (text.length <= MAX_TOOL_ARGUMENT_CHARS) return text
  return truncatedArguments(text, MAX_TOOL_ARGUMENT_CHARS)
}

function boundedToolResult(value, toolName = '') {
  if (toolName === 'read_artifact_source') {
    const parsed = parsedObject(value)
    if (parsed?.ok === true && typeof parsed.content === 'string') {
      const receipt = { ...parsed }
      delete receipt.content
      return JSON.stringify({
        ...receipt,
        sourceOmittedFromHistory: true,
        note: 'Editable source is loaded on demand with read_artifact_source.',
      })
    }
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {})
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text
  const tailChars = 1_000
  const marker = `\n[tool result truncated: ${text.length} chars total]\n`
  const headChars = Math.max(0, MAX_TOOL_RESULT_CHARS - tailChars - marker.length)
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`
}

export function normalizeCall(call) {
  const id = String(call?.id || '').trim()
  const name = String(call?.function?.name || call?.name || '').trim()
  if (!id || !name) return null
  const rawArguments = call?.function?.arguments ?? call?.argumentsText ?? call?.args ?? {}
  const normalized = {
    id,
    type: 'function',
    function: {
      name,
      arguments: boundedArguments(rawArguments),
    },
  }
  const original = parsedObject(rawArguments)
  if (original?.title) {
    Object.defineProperty(normalized, 'artifactTitle', {
      value: String(original.title).slice(0, 500),
      enumerable: false,
    })
  }
  return normalized
}

function artifactReferenceArguments(call, resultMessage) {
  const name = String(call?.function?.name || '')
  if (!SOURCE_BEARING_ARTIFACT_TOOLS.has(name)) return null
  const result = parsedObject(resultMessage?.content)
  const artifactId = String(result?.artifactId || '').trim()
  if (result?.ok !== true || !artifactId) return null
  const filename = String(result.filename || '').trim()
  const url = String(result.url || '').trim()
  return JSON.stringify({
    __artifactReference: true,
    artifactId,
    ...(filename ? { filename } : {}),
    type: ARTIFACT_TYPE_BY_TOOL[name] || '',
    ...(url ? { url } : {}),
    ...(call.artifactTitle ? { title: call.artifactTitle } : {}),
    source: {
      omittedFromHistory: true,
      readTool: 'read_artifact_source',
      artifact_id: artifactId,
      instruction: 'Call read_artifact_source from offset 0 through complete=true before revising this artifact.',
    },
  })
}

function normalizeGroups(messages, excludedCallIds) {
  const groups = []
  let active = null
  const flush = () => {
    if (!active?.assistant.tool_calls.length) return
    const resultsById = new Map(active.tools.map((message) => [message.tool_call_id, message]))
    for (const call of active.assistant.tool_calls) {
      const reference = artifactReferenceArguments(call, resultsById.get(call.id))
      if (reference) call.function.arguments = reference
    }
    const tools = active.assistant.tool_calls.map((call) => resultsById.get(call.id) || {
      role: 'tool',
      tool_call_id: call.id,
      name: call.function.name,
      content: JSON.stringify({
        ok: false,
        code: 'tool_result_unavailable',
        error: 'The prior tool result was not retained.',
      }),
    })
    groups.push([active.assistant, ...tools])
  }

  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      flush()
      const allCalls = message.tool_calls
        .map(normalizeCall)
        .filter((call) => call && !excludedCallIds.has(call.id))
      const omitted = Math.max(0, allCalls.length - MAX_TOOL_CALLS_PER_GROUP)
      const calls = allCalls.slice(-MAX_TOOL_CALLS_PER_GROUP)
      active = calls.length ? {
        assistant: {
          role: 'assistant',
          content: [
            String(message.content || ''),
            omitted ? `[${omitted} earlier tool calls omitted from retained context]` : '',
          ].filter(Boolean).join('\n'),
          tool_calls: calls,
        },
        callIds: new Set(calls.map((call) => call.id)),
        tools: [],
      } : null
    } else if (message?.role === 'tool' && active) {
      const toolCallId = String(message.tool_call_id || message.toolCallId || '').trim()
      if (!active.callIds.has(toolCallId)) continue
      const name = String(message.name || active.assistant.tool_calls.find((call) => call.id === toolCallId)?.function?.name || '')
      active.tools.push({
        role: 'tool',
        tool_call_id: toolCallId,
        name,
        content: boundedToolResult(message.content, name),
      })
    }
  }
  flush()
  return groups
}

export function collectToolCallIds(messages) {
  const ids = new Set()
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      const id = String(call?.id || '').trim()
      if (id) ids.add(id)
    }
  }
  return ids
}

export function extractTurnToolTrace(messages, { excludedCallIds = new Set() } = {}) {
  const groups = normalizeGroups(messages, excludedCallIds).slice(-MAX_TOOL_GROUPS_PER_TURN)
  const retained = []
  let retainedChars = 0
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]
    const size = jsonLength(group)
    if (retained.length > 0 && retainedChars + size > MAX_TURN_TOOL_CONTEXT_CHARS) break
    retained.unshift(...group)
    retainedChars += size
  }
  return retained
}

export const TURN_TOOL_CONTEXT_LIMITS = Object.freeze({
  maxArgumentChars: MAX_TOOL_ARGUMENT_CHARS,
  maxArtifactArgumentChars: MAX_TOOL_ARGUMENT_CHARS,
  maxResultChars: MAX_TOOL_RESULT_CHARS,
  maxTurnChars: MAX_TURN_TOOL_CONTEXT_CHARS,
  maxSessionChars: MAX_SESSION_TOOL_CONTEXT_CHARS,
})
