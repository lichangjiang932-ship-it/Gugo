import { modelProviderResponseEvents } from './modelNonStreaming.js'
import {
  extractModelContentText,
  normalizeCompatibleFinishReason,
  normalizeCompatibleToolCall,
  stringifyToolArguments,
} from './modelProviderResponse.js'

function notifyObserver(observer) {
  if (typeof observer !== 'function') return
  try { observer() } catch { /* observability must not fail the request */ }
}

export async function readJsonModelResponseEvents(response, profile, { onFirstByte, providerRequest = null } = {}) {
  const contentType = String(response.headers?.get?.('content-type') || '')
  if (!/\bapplication\/(?:[^;\s]+\+)?json\b/i.test(contentType)) return null

  const text = await response.text()
  notifyObserver(onFirstByte)
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  return [...modelProviderResponseEvents(data, profile, { providerRequest })]
}

/**
 * Decode a model SSE body into complete lines. The final buffered data field is
 * emitted even when a lightweight local server closes without a trailing LF.
 */
export async function* readModelSseLines(reader, { onFirstByte, onChunk } = {}) {
  const decoder = new TextDecoder()
  let buffer = ''
  let sawFirstChunk = false
  let reachedEof = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        reachedEof = true
        buffer += decoder.decode()
        if (buffer) buffer += '\n'
      } else {
        if (!sawFirstChunk) {
          sawFirstChunk = true
          notifyObserver(onFirstByte)
        }
        if (typeof onChunk === 'function') onChunk(value)
        buffer += decoder.decode(value, { stream: true })
      }

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      yield* lines
      if (done) return
    }
  } finally {
    // Protocol completion can precede HTTP EOF. Cancel only when the owner
    // leaves this iterator, so trailing keepalives cannot retain an open body.
    // Cleanup must not replace a verified terminal or the original failure.
    if (!reachedEof) try { await reader.cancel?.() } catch { /* best-effort body disposal */ }
    try { reader.releaseLock?.() } catch { /* already released or failed reader */ }
  }
}

function malformedModelStreamFrame() {
  const error = new Error('模型流包含无法解析的 JSON 数据帧。')
  error.code = 'MODEL_STREAM_MALFORMED_FRAME'
  error.type = 'provider_error'
  error.fromUpstream = true
  error.retryable = false
  // Malformed bytes are not a verifiable upstream outcome. A tracked request
  // remains unknown; untracked callers still receive this protocol error.
  return error
}

function modelStreamFrame(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
    throw malformedModelStreamFrame()
  }
  return { done: false, data }
}

function parseModelStreamPayload(payload) {
  if (payload === '[DONE]') return { done: true, data: null }
  let data
  try { data = JSON.parse(payload) } catch { throw malformedModelStreamFrame() }
  return modelStreamFrame(data)
}

const SSE_IGNORED_BARE_FIELDS = new Set(['event', 'id', 'retry'])

/**
 * Stateful SSE/NDJSON frame decoder. Field lines follow the event-stream
 * rules: `:` starts a comment, a field without a colon has an empty value,
 * one space after the colon is stripped, `data` lines accumulate joined with
 * "\n", a blank line dispatches and unknown fields are ignored. A data buffer
 * that already holds one complete JSON value (or [DONE]) dispatches without
 * waiting for the blank line, so gateways that omit it keep working. A bare
 * line that is not an SSE field is an NDJSON frame.
 *
 * `push(line)` and `end()` return the frames completed by that input.
 */
export function createModelStreamDecoder() {
  let dataLines = null
  const flush = () => {
    if (dataLines === null) return []
    const payload = dataLines.join('\n').trim()
    dataLines = null
    return payload ? [parseModelStreamPayload(payload)] : []
  }
  const appendData = (value) => {
    dataLines = dataLines === null ? [value] : [...dataLines, value]
    const payload = dataLines.join('\n').trim()
    if (payload === '[DONE]') return flush()
    let data
    try { data = JSON.parse(payload) } catch { return [] }
    dataLines = null
    return [modelStreamFrame(data)]
  }
  return {
    push(line) {
      const trimmed = String(line ?? '').trim()
      if (!trimmed) return flush()
      if (trimmed.startsWith(':')) return []
      const colon = trimmed.indexOf(':')
      const name = (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase()
      if (name === 'data') {
        const value = colon === -1 ? '' : trimmed.slice(colon + 1)
        return appendData(value.startsWith(' ') ? value.slice(1) : value)
      }
      if (colon === -1 ? SSE_IGNORED_BARE_FIELDS.has(name) : /^[a-z][a-z0-9_-]*$/.test(name)) return []
      return [...flush(), parseModelStreamPayload(trimmed)]
    },
    end: flush,
  }
}

/** Decode a stream of SSE/NDJSON lines into frames, flushing a final event at EOF. */
export async function* readModelStreamFrames(lines) {
  const decoder = createModelStreamDecoder()
  for await (const line of lines) yield* decoder.push(line)
  yield* decoder.end()
}

/** Decode one self-contained line; multi-line SSE events need createModelStreamDecoder. */
export function decodeModelStreamLine(line) {
  const decoder = createModelStreamDecoder()
  return [...decoder.push(line), ...decoder.end()][0] || null
}

export function createCompatibleModelStreamState() {
  return {
    itemIndexes: new Map(),
    nextItemIndex: 0,
    sawToolCall: false,
  }
}

function responseItemIndex(data, state, item = {}) {
  const explicit = Number(data?.output_index ?? item?.output_index)
  const key = String(data?.item_id || item?.id || item?.call_id || '')
  if (Number.isInteger(explicit) && explicit >= 0) {
    if (key) state.itemIndexes.set(key, explicit)
    state.nextItemIndex = Math.max(state.nextItemIndex, explicit + 1)
    return explicit
  }
  if (key && state.itemIndexes.has(key)) return state.itemIndexes.get(key)
  const next = state.nextItemIndex++
  if (key) state.itemIndexes.set(key, next)
  return next
}

function toolDelta(call, index, argumentsMode = 'append') {
  const normalized = normalizeCompatibleToolCall(call, index)
  return {
    index,
    id: call?.call_id || call?.id || '',
    name: normalized.function.name,
    arguments: normalized.function.arguments,
    argumentsMode,
  }
}

export function normalizeCompatibleModelStreamPayload(data, state = createCompatibleModelStreamState()) {
  const frame = {
    text: '',
    reasoning: '',
    toolCallDeltas: [],
    finishReason: null,
    terminal: false,
  }
  if (!data || typeof data !== 'object') return frame

  const eventType = String(data.type || '')
  if (eventType === 'response.output_text.delta') frame.text = extractModelContentText(data.delta)
  if (eventType === 'response.reasoning_text.delta' || eventType === 'response.reasoning_summary_text.delta') {
    frame.reasoning = extractModelContentText(data.delta)
  }
  if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
    const item = data.item || {}
    if (item.type === 'function_call') {
      const index = responseItemIndex(data, state, item)
      frame.toolCallDeltas.push(toolDelta(item, index, 'replace'))
      state.sawToolCall = true
    }
  }
  if (eventType === 'response.function_call_arguments.delta' || eventType === 'response.function_call_arguments.done') {
    const index = responseItemIndex(data, state, { id: data.item_id })
    const argumentsValue = data.arguments ?? data.delta ?? ''
    frame.toolCallDeltas.push({
      index,
      id: '',
      name: '',
      arguments: stringifyToolArguments(argumentsValue),
      argumentsMode: eventType.endsWith('.done') ? 'replace' : 'append',
    })
    state.sawToolCall = true
  }
  if (eventType === 'response.completed' || eventType === 'response.failed' || eventType === 'response.incomplete') {
    frame.terminal = true
    frame.finishReason = normalizeCompatibleFinishReason(
      data.response?.incomplete_details?.reason || data.response?.status || eventType.slice('response.'.length),
      state.sawToolCall,
    )
  }

  const choice = data?.choices?.[0]
  if (choice) {
    const delta = choice.delta || choice.message || {}
    frame.text ||= extractModelContentText(delta.content)
      || extractModelContentText(choice.text)
      || extractModelContentText(choice.message?.content)
    frame.reasoning ||= delta.reasoning_content || delta.reasoning || delta.thinking || ''
    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (const call of calls) {
      const index = Number.isInteger(call.index) ? call.index : 0
      frame.toolCallDeltas.push(toolDelta(call, index, choice.message ? 'replace' : 'append'))
      state.sawToolCall = true
    }
    if (delta.function_call) {
      frame.toolCallDeltas.push(toolDelta(delta.function_call, 0, choice.message ? 'replace' : 'append'))
      state.sawToolCall = true
    }
    if (choice.finish_reason) {
      frame.finishReason = normalizeCompatibleFinishReason(choice.finish_reason, state.sawToolCall)
      frame.terminal = true
    }
  } else if (!eventType.startsWith('response.')) {
    frame.text = extractModelContentText(data?.message?.content)
      || extractModelContentText(data?.content)
      || extractModelContentText(data?.token)
      || extractModelContentText(data?.text)
      || extractModelContentText(data?.response)
    frame.reasoning = data?.message?.thinking
      || data?.message?.reasoning
      || data?.reasoning_content
      || data?.reasoning
      || data?.thinking
      || ''
    const calls = Array.isArray(data?.message?.tool_calls)
      ? data.message.tool_calls
      : Array.isArray(data?.tool_calls) ? data.tool_calls : []
    for (const [index, call] of calls.entries()) {
      frame.toolCallDeltas.push(toolDelta(call, index, 'replace'))
      state.sawToolCall = true
    }
    if (data?.message?.function_call || data?.function_call) {
      frame.toolCallDeltas.push(toolDelta(data.message?.function_call || data.function_call, 0, 'replace'))
      state.sawToolCall = true
    }
    if (data.done === true) {
      frame.terminal = true
      frame.finishReason = normalizeCompatibleFinishReason(data.done_reason || data.stop_reason, state.sawToolCall)
    }
  }

  return frame
}
