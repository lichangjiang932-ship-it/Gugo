const MAX_TOOL_CALLS_PER_GROUP = 8
const MAX_TOOL_ARGUMENT_CHARS = 2_000
const MAX_TOOL_RESULT_CHARS = 8_000
const MAX_TURN_TOOL_CONTEXT_CHARS = 96_000
const MAX_SESSION_TOOL_CONTEXT_CHARS = 128_000
const MAX_TOOL_GROUPS_PER_TURN = 16

function jsonLength(value) {
  try { return JSON.stringify(value).length } catch { return Number.MAX_SAFE_INTEGER }
}

function boundedArguments(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {})
  if (text.length <= MAX_TOOL_ARGUMENT_CHARS) return text
  return JSON.stringify({
    __truncated: true,
    originalChars: text.length,
    preview: text.slice(0, MAX_TOOL_ARGUMENT_CHARS - 100),
  })
}

function boundedToolResult(value) {
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
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: boundedArguments(call?.function?.arguments ?? call?.argumentsText ?? call?.args ?? {}),
    },
  }
}

function normalizeGroups(messages, excludedCallIds) {
  const groups = []
  let active = null
  const flush = () => {
    if (!active?.assistant.tool_calls.length) return
    const resultsById = new Map(active.tools.map((message) => [message.tool_call_id, message]))
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
      active.tools.push({
        role: 'tool',
        tool_call_id: toolCallId,
        name: String(message.name || active.assistant.tool_calls.find((call) => call.id === toolCallId)?.function?.name || ''),
        content: boundedToolResult(message.content),
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

function storedMessageToWire(message) {
  const wire = { role: message.role, content: String(message.content ?? '') }
  const context = message.modelContext && typeof message.modelContext === 'object'
    ? message.modelContext
    : null
  if (message.role === 'assistant' && Array.isArray(context?.toolCalls)) {
    wire.tool_calls = context.toolCalls.map(normalizeCall).filter(Boolean)
  }
  if (message.role === 'tool') {
    if (context?.toolCallId) wire.tool_call_id = String(context.toolCallId)
    if (context?.name) wire.name = String(context.name)
  }
  return wire
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
      expanded.push(...message.modelContext.toolTrace.map((item) => ({ ...item })))
    }
    expanded.push(storedMessageToWire(message))
  })
  return expanded
}

export function buildAssistantModelContext({
  turnId,
  checkpointMessages,
  baselineToolCallIds,
  artifactIds = [],
  iterations = 0,
  paused = false,
  compactionArchiveId = null,
} = {}) {
  return {
    version: 1,
    turnId: String(turnId || ''),
    toolTrace: extractTurnToolTrace(checkpointMessages, {
      excludedCallIds: baselineToolCallIds || new Set(),
    }),
    artifactIds: Array.isArray(artifactIds) ? artifactIds.map(String) : [],
    iterations: Math.max(0, Number(iterations) || 0),
    paused: !!paused,
    ...(compactionArchiveId ? { compactionArchiveId: String(compactionArchiveId) } : {}),
  }
}

export const TURN_TOOL_CONTEXT_LIMITS = Object.freeze({
  maxArgumentChars: MAX_TOOL_ARGUMENT_CHARS,
  maxResultChars: MAX_TOOL_RESULT_CHARS,
  maxTurnChars: MAX_TURN_TOOL_CONTEXT_CHARS,
  maxSessionChars: MAX_SESSION_TOOL_CONTEXT_CHARS,
})
