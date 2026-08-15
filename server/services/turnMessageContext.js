import { normalizeModelUsage } from '../../shared/modelUsage.js'

const MAX_TOOL_CALLS_PER_GROUP = 8
// Historical tool arguments are audit/context hints, not an artifact source
// store. Successful artifact calls are reduced to references below; other
// calls retain a bounded preview so repeated turns cannot multiply large file
// bodies, commands, or payloads indefinitely.
const MAX_TOOL_ARGUMENT_CHARS = 12_000
const MAX_TOOL_RESULT_CHARS = 8_000
const MAX_TURN_TOOL_CONTEXT_CHARS = 96_000
const MAX_SESSION_TOOL_CONTEXT_CHARS = 128_000
const SOURCE_BEARING_ARTIFACT_TOOLS = new Set([
  'create_docx',
  'create_html_app',
  'create_pdf',
  'create_pptx',
  'create_xlsx',
  'generate_image',
])
const ARTIFACT_TYPE_BY_TOOL = Object.freeze({
  create_docx: 'docx',
  create_html_app: 'html',
  create_pdf: 'pdf',
  create_pptx: 'pptx',
  create_xlsx: 'xlsx',
  generate_image: 'image',
})
const MAX_TOOL_GROUPS_PER_TURN = 16
const MAX_MANAGED_ATTACHMENTS_PER_MESSAGE = 32
const MAX_HISTORICAL_ATTACHMENTS_PER_REQUEST = 4
const STORED_MESSAGE_SOURCE_ID = Symbol('gugoStoredMessageSourceId')
const HISTORICAL_ATTACHMENT_REFERENCE_PATTERN = /(?:attachment:\/\/|(?:刚才|之前|上次|前面|同一|同一个|那个|那张|这张|这份|上一张|原来).{0,16}(?:附件|图片|图像|照片|截图|图表|文件|文档|pdf)|(?:附件|图片|图像|照片|截图|图表|文档|pdf).{0,16}(?:重新|再|继续).{0,8}(?:看|读|分析|检查|查看)|(?:same|previous|earlier|that|the\s+attached)\s+(?:attachment|image|photo|screenshot|diagram|file|document|pdf)|(?:re-?inspect|re-?read|look\s+again\s+at).{0,24}(?:attachment|image|photo|file|document|pdf))/i

function tagStoredMessageSource(message, sourceId) {
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

export function selectStoredMessagesAfterCompaction(messages, boundary = null) {
  const source = Array.isArray(messages) ? messages : []
  const firstKeptMessageId = String(boundary?.firstKeptMessageId || '').trim()
  if (firstKeptMessageId) {
    const index = source.findIndex((message) => String(message?.id || '') === firstKeptMessageId)
    if (index >= 0) return source.slice(index)
  }

  const lastCompactedMessageId = String(boundary?.lastCompactedMessageId || '').trim()
  if (lastCompactedMessageId) {
    const index = source.findIndex((message) => String(message?.id || '') === lastCompactedMessageId)
    if (index >= 0) return source.slice(index + 1)
  }
  return source
}

function jsonLength(value) {
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

function parsedObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value ?? ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
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

function normalizeCall(call) {
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

function normalizeManagedAttachmentRefs(values) {
  const refs = []
  const seen = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    const id = String(value?.id || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    refs.push({
      id,
      name: String(value?.name || 'attachment').split(/[\\/]/).pop(),
      mimeType: String(value?.mimeType || 'application/octet-stream'),
      size: Math.max(0, Number(value?.size) || 0),
      sha256: String(value?.sha256 || ''),
      uri: String(value?.uri || `attachment://${id}`),
      downloadUrl: String(value?.downloadUrl || ''),
    })
    if (refs.length >= MAX_MANAGED_ATTACHMENTS_PER_MESSAGE) break
  }
  return refs
}

function normalizeAttachmentIds(values, limit = MAX_MANAGED_ATTACHMENTS_PER_MESSAGE) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value?.id || value || '').trim())
    .filter(Boolean))]
    .slice(0, limit)
}

function attachmentReferenceLine(attachment) {
  const name = String(attachment?.name || 'attachment').replace(/["\\\r\n]/g, '_')
  return `[GUGO_MANAGED_ATTACHMENT id="${attachment.id}" uri="${attachment.uri || `attachment://${attachment.id}`}" name="${name}" mime="${attachment.mimeType || 'application/octet-stream'}" size=${Math.max(0, Number(attachment.size) || 0)}]`
}

function contentWithAttachmentReferences(content, refs) {
  const text = textContent(content).trim()
  const references = normalizeManagedAttachmentRefs(refs).map(attachmentReferenceLine).join('\n')
  return [text, references].filter(Boolean).join('\n\n')
}

/**
 * New uploads are sent to the model once. Older binary attachments are only
 * revisited when the user's prompt explicitly refers back to them; ordinary
 * follow-up turns retain lightweight attachment:// references instead.
 */
export function selectAttachmentIdsForModelRequest(messages, {
  currentAttachmentIds = [],
  prompt = '',
  maxHistorical = MAX_HISTORICAL_ATTACHMENTS_PER_REQUEST,
} = {}) {
  const current = normalizeAttachmentIds(currentAttachmentIds)
  if (current.length) return current
  if (!HISTORICAL_ATTACHMENT_REFERENCE_PATTERN.test(String(prompt || ''))) return []

  const source = Array.isArray(messages) ? messages : []
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (source[index]?.role !== 'user') continue
    const refs = normalizeManagedAttachmentRefs(source[index]?.managedAttachments)
    if (!refs.length) continue
    return refs.slice(0, Math.max(1, Number(maxHistorical) || 1)).map((attachment) => attachment.id)
  }
  return []
}

function textContent(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return String(value ?? '')
  return value
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function storedMessageToWire(message) {
  const context = message.modelContext && typeof message.modelContext === 'object'
    ? message.modelContext
    : null
  const wire = {
    role: message.role,
    content: String(context?.modelContent ?? message.content ?? ''),
  }
  const managedAttachments = message.role === 'user'
    ? normalizeManagedAttachmentRefs(context?.attachments)
    : []
  if (managedAttachments.length) wire.managedAttachments = managedAttachments
  if (message.role === 'assistant' && Array.isArray(context?.toolCalls)) {
    wire.tool_calls = context.toolCalls.map(normalizeCall).filter(Boolean)
  }
  if (message.role === 'tool') {
    if (context?.toolCallId) wire.tool_call_id = String(context.toolCallId)
    if (context?.name) wire.name = String(context.name)
  }
  return wire
}

/**
 * Materialize managed attachment references only for the provider request.
 * The tool loop and its checkpoints keep the original lightweight messages,
 * while the returned copy may contain extracted text or inline media.
 */
export async function materializeManagedAttachmentMessages(messages, {
  userId,
  sessionId,
  prepareAttachments,
  inlineAttachmentIds,
} = {}) {
  const requestedInlineIds = inlineAttachmentIds === undefined
    ? null
    : new Set(normalizeAttachmentIds(inlineAttachmentIds))
  const materialized = []
  for (const source of Array.isArray(messages) ? messages : []) {
    const { managedAttachments: rawRefs, ...wire } = source || {}
    const refs = normalizeManagedAttachmentRefs(rawRefs)
    if (wire.role !== 'user' || refs.length === 0) {
      materialized.push({ ...wire })
      continue
    }
    const inlineRefs = requestedInlineIds === null
      ? refs
      : refs.filter((attachment) => requestedInlineIds.has(attachment.id))
    const referenceRefs = inlineRefs.length === refs.length
      ? []
      : refs.filter((attachment) => !inlineRefs.some((candidate) => candidate.id === attachment.id))
    if (inlineRefs.length === 0) {
      materialized.push({
        ...wire,
        content: contentWithAttachmentReferences(wire.content, refs),
      })
      continue
    }
    if (typeof prepareAttachments !== 'function') {
      throw new TypeError('prepareAttachments is required for managed attachment messages')
    }
    const prepared = await prepareAttachments({
      userId,
      sessionId,
      attachmentIds: inlineRefs.map((attachment) => attachment.id),
      text: contentWithAttachmentReferences(wire.content, referenceRefs),
    })
    materialized.push({
      ...wire,
      content: prepared?.content ?? wire.content,
    })
  }
  return materialized
}

export function expandStoredMessages(messages) {
  const includeTraceAt = new Set()
  let retainedChars = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const trace = messages[index]?.modelContext?.toolTrace
    if (!Array.isArray(trace) || trace.length === 0) continue
    const size = jsonLength(trace)
    if (retainedChars + size > MAX_SESSION_TOOL_CONTEXT_CHARS) continue
    retainedChars += size
    includeTraceAt.add(index)
  }

  const expanded = []
  messages.forEach((message, index) => {
    if (includeTraceAt.has(index)) {
      expanded.push(...message.modelContext.toolTrace.map((item) => (
        tagStoredMessageSource({ ...item }, message.id)
      )))
    }
    expanded.push(tagStoredMessageSource(storedMessageToWire(message), message.id))
  })
  return expanded
}

export function buildAssistantModelContext({
  turnId,
  checkpointMessages,
  baselineToolCallIds,
  artifactIds = [],
  deliveryArtifactIds,
  iterations = 0,
  paused = false,
  compactionArchiveId = null,
  compactionRecovery = null,
  usage = null,
  turnStartedAt = null,
  turnCompletedAt = null,
} = {}) {
  const normalizedUsage = normalizeModelUsage(usage)
  const normalizedStartedAt = Number.isFinite(Number(turnStartedAt))
    ? Math.max(0, Number(turnStartedAt))
    : null
  const normalizedCompletedAt = Number.isFinite(Number(turnCompletedAt))
    ? Math.max(0, Number(turnCompletedAt))
    : null
  const latency = normalizedStartedAt !== null && normalizedCompletedAt !== null
    ? Math.max(0, normalizedCompletedAt - normalizedStartedAt)
    : null
  return {
    version: 1,
    turnId: String(turnId || ''),
    toolTrace: extractTurnToolTrace(checkpointMessages, {
      excludedCallIds: baselineToolCallIds || new Set(),
    }),
    artifactIds: Array.isArray(artifactIds) ? artifactIds.map(String) : [],
    ...(Array.isArray(deliveryArtifactIds)
      ? { deliveryArtifactIds: deliveryArtifactIds.map(String) }
      : {}),
    iterations: Math.max(0, Number(iterations) || 0),
    paused: !!paused,
    ...(normalizedUsage ? { usage: normalizedUsage } : {}),
    ...(normalizedStartedAt !== null ? { turnStartedAt: normalizedStartedAt } : {}),
    ...(normalizedCompletedAt !== null ? { turnCompletedAt: normalizedCompletedAt } : {}),
    ...(latency !== null ? { latency } : {}),
    ...(compactionArchiveId || compactionRecovery?.archiveId
      ? { compactionArchiveId: String(compactionArchiveId || compactionRecovery.archiveId) }
      : {}),
    ...(compactionRecovery?.firstKeptMessageId
      ? { compactionFirstKeptMessageId: String(compactionRecovery.firstKeptMessageId) }
      : {}),
    ...(compactionRecovery?.lastCompactedMessageId
      ? { compactionLastCompactedMessageId: String(compactionRecovery.lastCompactedMessageId) }
      : {}),
  }
}

export const TURN_TOOL_CONTEXT_LIMITS = Object.freeze({
  maxArgumentChars: MAX_TOOL_ARGUMENT_CHARS,
  maxArtifactArgumentChars: MAX_TOOL_ARGUMENT_CHARS,
  maxResultChars: MAX_TOOL_RESULT_CHARS,
  maxTurnChars: MAX_TURN_TOOL_CONTEXT_CHARS,
  maxSessionChars: MAX_SESSION_TOOL_CONTEXT_CHARS,
})
