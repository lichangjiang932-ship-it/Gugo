import { modelProviderResponseEvents } from './modelNonStreaming.js'
import {
  extractModelContentText,
  normalizeCompatibleToolCall,
  stringifyToolArguments,
} from './modelProviderResponse.js'

function notifyObserver(observer) {
  if (typeof observer !== 'function') return
  try { observer() } catch { /* observability must not fail the request */ }
}

export async function readJsonModelResponseEvents(response, profile, { onFirstByte } = {}) {
  const contentType = String(response.headers?.get?.('content-type') || '')
  if (!/\bapplication\/(?:[^;\s]+\+)?json\b/i.test(contentType)) return null

  const text = await response.text()
  notifyObserver(onFirstByte)
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  return [...modelProviderResponseEvents(data, profile)]
}

/**
 * Decode a model SSE body into complete lines. The final buffered data field is
 * emitted even when a lightweight local server closes without a trailing LF.
 */
export async function* readModelSseLines(reader, { onFirstByte, onChunk } = {}) {
  const decoder = new TextDecoder()
  let buffer = ''
  let sawFirstChunk = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      buffer += decoder.decode()
      if (buffer) buffer += '\n'
    } else {
      if (!sawFirstChunk) {
        sawFirstChunk = true
        notifyObserver(onFirstByte)
      }
      if (typeof onChunk === 'function') onChunk()
      buffer += decoder.decode(value, { stream: true })
    }

    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    yield* lines
    if (done) return
  }
}

export function decodeModelStreamLine(line) {
  const trimmed = String(line || '').trim()
  if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) return null
  const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trimStart() : trimmed
  if (payload === '[DONE]') return { done: true, data: null }
  try {
    return { done: false, data: JSON.parse(payload) }
  } catch {
    return null
  }
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

function normalizedFinishReason(value, sawToolCall = false) {
  if (sawToolCall || value === 'function_call' || value === 'tool_calls') return 'tool_calls'
  if (value === 'length' || value === 'max_tokens') return 'length'
  return value || 'stop'
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
    frame.finishReason = normalizedFinishReason(
      data.response?.incomplete_details?.reason || data.response?.status,
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
    if (choice.finish_reason) frame.finishReason = normalizedFinishReason(choice.finish_reason, state.sawToolCall)
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
      frame.finishReason = normalizedFinishReason(data.done_reason || data.stop_reason, state.sawToolCall)
    }
  }

  return frame
}
