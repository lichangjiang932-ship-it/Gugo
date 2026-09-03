import { TOOL_CALL_STATUS } from '../../store/taskStatus.js'

export function parseToolResult(content) {
  try { return JSON.parse(content) } catch { return null }
}

export function finiteTimestamp(value) {
  if (value == null || value === '') return null
  const normalized = Number(value)
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null
}

export function nonNegativeInteger(value) {
  if (value == null || value === '') return null
  const normalized = Number(value)
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : null
}

export function snapshotLastSequence(context) {
  if (!context || typeof context !== 'object') return null
  for (const key of [
    'serverLastSequence',
    'server_last_sequence',
    'lastSequence',
    'last_sequence',
    'eventSequence',
    'event_sequence',
    'pausedSequence',
    'paused_sequence',
  ]) {
    const sequence = nonNegativeInteger(context[key])
    if (sequence !== null) return sequence
  }
  return null
}

function snapshotText(value, fallback = '') {
  if (typeof value === 'string') return value
  if (value == null) return fallback
  try { return JSON.stringify(value) } catch { return String(value) }
}

function normalizeSnapshotToolCall(call) {
  const id = String(call?.id || '').trim()
  const name = String(call?.function?.name || call?.name || '').trim()
  if (!id || !name) return null
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: snapshotText(
        call?.function?.arguments ?? call?.arguments ?? call?.argumentsText ?? call?.args ?? {},
        '{}',
      ),
    },
  }
}

function unavailableToolResult(call) {
  return {
    role: 'tool',
    tool_call_id: call.id,
    name: call.function.name,
    content: JSON.stringify({
      ok: false,
      code: 'tool_result_unavailable',
      error: 'The prior tool result was not retained by the server.',
    }),
  }
}

export function importedToolTrace(message, messageIndex, resultRows, consumedRows) {
  const calls = (Array.isArray(message?.modelContext?.toolCalls) ? message.modelContext.toolCalls : [])
    .map(normalizeSnapshotToolCall)
    .filter(Boolean)
  if (!calls.length) return []

  const results = calls.map((call) => {
    const match = resultRows.get(call.id)?.find((entry) => (
      entry.index > messageIndex && !consumedRows.has(entry.index)
    ))
    if (!match) return unavailableToolResult(call)
    consumedRows.add(match.index)
    const context = match.message?.modelContext && typeof match.message.modelContext === 'object'
      ? match.message.modelContext
      : {}
    return {
      role: 'tool',
      tool_call_id: call.id,
      name: String(context.name || call.function.name),
      content: snapshotText(match.message?.content),
    }
  })
  return [{ role: 'assistant', content: '', tool_calls: calls }, ...results]
}

export function toolCallsFromContext(context) {
  const calls = []
  const byId = new Map()
  for (const message of Array.isArray(context?.toolTrace) ? context.toolTrace : []) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const entry = {
          id: call?.id,
          name: call?.function?.name || '',
          arguments: call?.function?.arguments || '{}',
          status: TOOL_CALL_STATUS.RUNNING,
        }
        if (!entry.id) continue
        calls.push(entry)
        byId.set(entry.id, entry)
      }
    } else if (message?.role === 'tool') {
      const entry = byId.get(message.tool_call_id)
      if (!entry) continue
      const parsed = parseToolResult(message.content)
      entry.status = parsed?.ok === false ? TOOL_CALL_STATUS.ERROR : TOOL_CALL_STATUS.SUCCESS
      entry.result = String(message.content || '')
      entry.error = parsed?.ok === false ? parsed?.error || 'Tool call failed' : undefined
      entry.errorCode = parsed?.ok === false && parsed?.code ? String(parsed.code) : undefined
      entry.errorStatus = parsed?.ok === false && Number.isInteger(parsed?.status)
        ? parsed.status
        : undefined
      entry.retryable = parsed?.ok === false ? parsed?.retryable === true : undefined
      entry.errorHint = parsed?.ok === false && parsed?.hint ? String(parsed.hint) : undefined
      entry.attempts = parsed?.ok === false && Number.isInteger(parsed?.attempts)
        ? parsed.attempts
        : undefined
      entry.approvalAuthorization = parsed?.approvalAuthorization || null
    }
  }
  return calls
}
