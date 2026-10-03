const TOOL_CALL_OPEN = /<tool_call\b[^>]*>/ig
const TOOL_CALL_OPEN_AT_START = /^<tool_call\b[^>]*>/i
const TOOL_CALL_CLOSE = /<\/tool_call\s*>/ig
const TOOL_CALL_MARKER = '<tool_call'
const TOOL_CALL_CLOSE_MARKER = '</tool_call'
// Bounded fail-open cap: a stream that never closes its tool block must not
// grow the filter buffer without limit. Beyond this the buffered protocol text
// is emitted and the filter returns to normal passthrough.
const MAX_TOOL_CALL_BODY_CHARS = 512 * 1024

function markerSuffixLength(value, marker) {
  const text = String(value || '').toLowerCase()
  const max = Math.min(text.length, marker.length - 1)
  for (let length = max; length > 0; length -= 1) {
    if (marker.startsWith(text.slice(-length))) return length
  }
  return 0
}

function markerPrefixSuffixLength(value) {
  return markerSuffixLength(value, TOOL_CALL_MARKER)
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
 * Incremental filter that hides the text tool protocol from live output while
 * keeping every non-protocol character in order.
 *
 * It mirrors `extractTextToolCalls`:
 * - a complete block with a parseable body is withheld;
 * - a block whose body fails to parse stays visible (the model must see its
 *   own malformed output);
 * - text before, between and after blocks is emitted unchanged.
 *
 * Once a block closes, normal text resumes. Buffer growth is bounded; an
 * unterminated block is handled at `finish()`, and `finish()` is idempotent.
 */
export function createTextToolCallDeltaFilter() {
  let pending = ''
  let body = ''
  let inside = false
  let sawProtocol = false
  let finished = false

  const flushBuffer = () => {
    // Keep only a marker-sized suffix so a split `<tool_call>` is never painted.
    const keep = markerPrefixSuffixLength(pending)
    const visible = pending.slice(0, pending.length - keep)
    pending = pending.slice(pending.length - keep)
    return visible
  }

  const resolveBlock = (out) => {
    const parsed = parseCallBody(body)
    // Malformed bodies stay visible, matching the full-response parser.
    const visible = parsed ? out : out + body
    body = ''
    inside = false
    return visible
  }

  return {
    push(delta) {
      if (finished) return ''
      let buffer = pending + String(delta || '')
      pending = ''
      let out = ''
      for (;;) {
        if (!inside) {
          const markerAt = buffer.toLowerCase().indexOf(TOOL_CALL_MARKER)
          if (markerAt < 0) {
            pending = buffer
            out += flushBuffer()
            break
          }
          const rest = buffer.slice(markerAt)
          const open = TOOL_CALL_OPEN_AT_START.exec(rest)
          if (!open) {
            if (!rest.includes('>')) {
              // Possibly a truncated open tag; wait for more input.
              out += buffer.slice(0, markerAt)
              pending = rest
              break
            }
            // Near-miss text such as `<tool_calls>` is literal content.
            out += buffer.slice(0, markerAt + 1)
            buffer = buffer.slice(markerAt + 1)
            continue
          }
          out += buffer.slice(0, markerAt)
          buffer = rest.slice(open[0].length)
          inside = true
          sawProtocol = true
          body = ''
          continue
        }
        const closeAt = buffer.toLowerCase().indexOf(TOOL_CALL_CLOSE_MARKER)
        if (closeAt < 0) {
          const keep = markerSuffixLength(buffer, TOOL_CALL_CLOSE_MARKER)
          body += buffer.slice(0, buffer.length - keep)
          pending = buffer.slice(buffer.length - keep)
          if (body.length <= MAX_TOOL_CALL_BODY_CHARS) break
          out += body
          body = ''
          inside = false
          buffer = pending
          pending = ''
          continue
        }
        const closeEnd = buffer.indexOf('>', closeAt + TOOL_CALL_CLOSE_MARKER.length)
        if (closeEnd < 0) {
          body += buffer.slice(0, closeAt)
          pending = buffer.slice(closeAt)
          if (body.length <= MAX_TOOL_CALL_BODY_CHARS) break
          out += body
          body = ''
          inside = false
          buffer = pending
          pending = ''
          continue
        }
        body += buffer.slice(0, closeAt)
        buffer = buffer.slice(closeEnd + 1)
        if (body.length > MAX_TOOL_CALL_BODY_CHARS) {
          // Fail open with a bounded buffer; the following text is normal again.
          out += body
          body = ''
          inside = false
          continue
        }
        out = resolveBlock(out)
        continue
      }
      return out
    },
    finish({ discardProtocol = false } = {}) {
      if (finished) return ''
      finished = true
      let out = ''
      if (inside) {
        if (body.length > MAX_TOOL_CALL_BODY_CHARS) out += body
        else if (!parseCallBody(body) && !discardProtocol) out += body
        body = ''
        inside = false
      }
      // A partial marker that never completed is literal text; the full parser
      // leaves it in content, so keep it visible unless explicitly discarded.
      if (pending && !(discardProtocol && pending.toLowerCase().startsWith(TOOL_CALL_MARKER))) {
        out += pending
      }
      pending = ''
      return out
    },
    get suppressing() { return sawProtocol || inside },
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
