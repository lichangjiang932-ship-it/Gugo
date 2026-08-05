function textContent(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

function argumentsText(call) {
  const value = call?.function?.arguments ?? call?.arguments ?? call?.argumentsText ?? call?.args ?? {}
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return '{}' }
}

function normalizeToolCall(call, fallbackId) {
  const name = String(call?.function?.name || call?.name || '').trim()
  if (!name) return null
  return {
    id: String(call?.id || fallbackId),
    type: 'function',
    function: { name, arguments: argumentsText(call) },
  }
}

function sourceToolCalls(message) {
  return [
    ...(Array.isArray(message?.tool_calls) ? message.tool_calls : []),
    ...(Array.isArray(message?.meta?.toolCalls) ? message.meta.toolCalls : []),
  ]
}

function messageToolCalls(message, messageIndex) {
  const seen = new Set()
  return sourceToolCalls(message)
    .map((call, callIndex) => normalizeToolCall(call, `history_tool_${messageIndex}_${callIndex}`))
    .filter((call) => {
      if (!call || seen.has(call.id)) return false
      seen.add(call.id)
      return true
    })
}

function syntheticToolResult(sourceCall) {
  if (sourceCall && Object.prototype.hasOwnProperty.call(sourceCall, 'result')) {
    return textContent(sourceCall.result)
  }
  if (sourceCall?.error) return JSON.stringify({ ok: false, error: String(sourceCall.error) })
  return JSON.stringify({
    ok: false,
    code: 'tool_result_unavailable',
    error: 'The prior tool result was not retained by the browser.',
  })
}

function serializeToolMessage(message, fallback) {
  return {
    role: 'tool',
    tool_call_id: String(message?.tool_call_id || fallback.id),
    name: String(message?.name || fallback.function.name),
    content: textContent(message?.content),
  }
}

/**
 * Serialize the browser's complete local transcript for its one-time server import.
 * Tool traces live in assistant.meta, so expand them into the canonical
 * assistant tool_calls + tool result sequence expected by model providers.
 */
export function serializeServerTurnHistory(messages = []) {
  if (!Array.isArray(messages)) return []

  const explicitResults = new Map()
  messages.forEach((message, index) => {
    if (message?.role !== 'tool' || !message?.tool_call_id) return
    const id = String(message.tool_call_id)
    const queue = explicitResults.get(id) || []
    queue.push({ message, index })
    explicitResults.set(id, queue)
  })

  const consumedToolIndexes = new Set()
  const serialized = []
  messages.forEach((message, messageIndex) => {
    const role = ['user', 'assistant', 'system', 'tool'].includes(message?.role) ? message.role : null
    if (!role) return
    if (role === 'tool') {
      if (consumedToolIndexes.has(messageIndex)) return
      serialized.push({
        role,
        content: textContent(message.content),
        ...(message.name ? { name: String(message.name) } : {}),
        ...(message.tool_call_id ? { tool_call_id: String(message.tool_call_id) } : {}),
      })
      return
    }

    const content = textContent(message.content)
    if (role !== 'assistant') {
      serialized.push({ role, content })
      return
    }

    const toolCalls = messageToolCalls(message, messageIndex)
    if (!toolCalls.length) {
      serialized.push({ role, content })
      return
    }

    serialized.push({ role, content, tool_calls: toolCalls })
    const resultSources = [
      ...(Array.isArray(message?.meta?.toolCalls) ? message.meta.toolCalls : []),
      ...(Array.isArray(message?.tool_calls) ? message.tool_calls : []),
    ]
    toolCalls.forEach((call) => {
      const explicit = explicitResults.get(call.id)?.find((entry) => !consumedToolIndexes.has(entry.index))
      if (explicit) {
        consumedToolIndexes.add(explicit.index)
        serialized.push(serializeToolMessage(explicit.message, call))
        return
      }
      const sourceCall = resultSources.find((candidate) => String(candidate?.id || '') === call.id)
      serialized.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: syntheticToolResult(sourceCall),
      })
    })
  })
  return serialized
}
