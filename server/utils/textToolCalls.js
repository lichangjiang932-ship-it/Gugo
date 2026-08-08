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
    const parsed = parseCallBody(text.slice(TOOL_CALL_OPEN.lastIndex, bodyEnd))
    if (parsed) {
      calls.push({
        id: `text-tool-${calls.length + 1}`,
        type: 'function',
        function: parsed,
      })
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
