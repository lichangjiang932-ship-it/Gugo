const TOOL_CALL_OPEN = /<tool_call\b[^>]*>/ig
const TOOL_CALL_CLOSE = /<\/tool_call\s*>/ig
const TOOL_CALL_MARKER = '<tool_call'

function markerPrefixSuffixLength(value) {
  const text = String(value || '').toLowerCase()
  const max = Math.min(text.length, TOOL_CALL_MARKER.length - 1)
  for (let length = max; length > 0; length -= 1) {
    if (TOOL_CALL_MARKER.startsWith(text.slice(-length))) return length
  }
  return 0
}

function parseJsonCall(body) {
  try {
    const parsed = JSON.parse(String(body || '').trim())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const name = String(parsed.function?.name || parsed.name || '').trim()
    if (!name) return null
    const args = parsed.function?.arguments ?? parsed.arguments ?? parsed.parameters ?? {}
    return { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
  } catch {
    return null
  }
}

function parseParameterValue(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try { return JSON.parse(text) } catch { return text }
}

function parseTaggedCall(body) {
  const functionMatch = String(body || '').match(
    /<function(?:\s+name\s*=\s*|=)\s*["']?([A-Za-z0-9_.:-]+)["']?\s*>/i,
  )
  if (!functionMatch) return null
  const name = functionMatch[1]
  const tail = String(body).slice((functionMatch.index || 0) + functionMatch[0].length)
  const params = {}
  const parameterPattern = /<parameter(?:\s+name\s*=\s*|=)\s*["']?([A-Za-z0-9_.:-]+)["']?\s*>([\s\S]*?)(?:<\/parameter\s*>|(?=<parameter(?:\s+name\s*=\s*|=)|<\/function\s*>|$))/gi
  let match
  while ((match = parameterPattern.exec(tail)) !== null) {
    params[match[1]] = parseParameterValue(match[2])
  }
  return { name, arguments: JSON.stringify(params) }
}

function parseCallBody(body) {
  return parseJsonCall(body) || parseTaggedCall(body)
}

/**
 * Convert the XML-like tool protocol emitted by some local chat templates
 * into the same OpenAI-compatible shape as native function calling.
 * Execution still goes through the ordinary schema, approval and trust gates.
 */
export function extractTextToolCalls(value) {
  const text = String(value || '')
  const calls = []
  const kept = []
  let cursor = 0
  let detected = false
  TOOL_CALL_OPEN.lastIndex = 0
  TOOL_CALL_CLOSE.lastIndex = 0

  let open
  while ((open = TOOL_CALL_OPEN.exec(text)) !== null) {
    detected = true
    kept.push(text.slice(cursor, open.index))
    TOOL_CALL_CLOSE.lastIndex = TOOL_CALL_OPEN.lastIndex
    const close = TOOL_CALL_CLOSE.exec(text)
    const bodyEnd = close ? close.index : text.length
    const body = text.slice(TOOL_CALL_OPEN.lastIndex, bodyEnd)
    const parsed = parseCallBody(body)
    if (parsed) {
      calls.push({
        id: `text-tool-${calls.length + 1}`,
        type: 'function',
        function: parsed,
      })
    } else {
      // A malformed protocol body must stay visible: dropping it silently would
      // leave the model believing it issued a call the host never answered.
      kept.push(body)
    }
    cursor = close ? TOOL_CALL_CLOSE.lastIndex : text.length
    TOOL_CALL_OPEN.lastIndex = cursor
    if (!close) break
  }
  kept.push(text.slice(cursor))
  return {
    detected,
    content: detected ? kept.join('').trim() : text,
    toolCalls: calls,
  }
}

/**
 * Keep a marker-sized suffix while streaming so a split `<tool_call>` token
 * is never painted into the chat before it can be recognized at completion.
 */
export function createTextToolCallDeltaFilter() {
  let pending = ''
  let suppressing = false

  return {
    push(delta) {
      pending += String(delta || '')
      if (suppressing) return ''
      const markerAt = pending.toLowerCase().indexOf(TOOL_CALL_MARKER)
      if (markerAt >= 0) {
        const visible = pending.slice(0, markerAt)
        pending = pending.slice(markerAt)
        suppressing = true
        return visible
      }
      const safeLength = pending.length - markerPrefixSuffixLength(pending)
      const visible = pending.slice(0, safeLength)
      pending = pending.slice(safeLength)
      return visible
    },
    finish({ discardProtocol = suppressing } = {}) {
      const visible = discardProtocol && suppressing ? '' : pending
      pending = ''
      return visible
    },
    get suppressing() { return suppressing },
  }
}

const FENCED_JSON_PATTERN = /^```(?:json|jsonc|json5)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```$/i
const BARE_JSON_MARKER = '<tool_call'

function normalizeAllowedToolNames(allowedToolNames) {
  if (!Array.isArray(allowedToolNames)) return []
  return allowedToolNames
    .map((name) => String(name || '').trim())
    .filter((name) => name.length > 0)
}

/**
 * Controlled salvage for local models that emit a bare JSON tool call with no
 * protocol markers. Accepted only when the whole response is a single JSON
 * object whose name exactly matches one of the tool names actually offered
 * this turn; mixed prose and JSON never salvages. Execution still crosses the
 * ordinary schema, approval and trust gates, so this adds no authorization.
 */
export function salvageBareJsonToolCall(value, { allowedToolNames } = {}) {
  const notDetected = (content = String(value || '')) => ({ detected: false, content, toolCalls: [] })
  const names = normalizeAllowedToolNames(allowedToolNames)
  if (names.length === 0) return notDetected()

  const text = String(value || '')
  if (text.toLowerCase().includes(BARE_JSON_MARKER)) return notDetected(text)

  const trimmed = text.trim()
  if (!trimmed) return notDetected('')
  const fenced = trimmed.match(FENCED_JSON_PATTERN)
  const candidate = (fenced ? fenced[1] : trimmed).trim()
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) return notDetected(text)

  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return notDetected(text)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return notDetected(text)

  const name = String(parsed.function?.name || parsed.name || '').trim()
  if (!name || !names.includes(name)) return notDetected(text)

  const args = parsed.function?.arguments ?? parsed.arguments ?? parsed.parameters
  if (args === undefined || args === null) return notDetected(text)
  if (typeof args !== 'object' && (typeof args !== 'string' || !args.trim())) return notDetected(text)

  return {
    detected: true,
    content: '',
    toolCalls: [{
      id: 'text-tool-1',
      type: 'function',
      function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
    }],
  }
}
