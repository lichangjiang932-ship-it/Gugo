import { registerModelProviderAdapter } from '../../adapters/modelProviderRegistry.js'

/**
 * The OpenAI Responses wire protocol (`POST /responses`) as a registered
 * adapter, so the rest of the pipeline needs no knowledge of it.
 *
 * The differences from chat-completions are structural, not cosmetic:
 *  - system messages become one `instructions` string;
 *  - turns become typed `input` items (input_text / input_image /
 *    function_call / function_call_output) instead of role+content blobs;
 *  - tools are flat (`{type:'function', name, description, parameters}`);
 *  - the stream is event-typed (`response.output_text.delta`,
 *    `response.function_call_arguments.delta`, `response.completed`).
 */
const KIND = 'openai-responses'

function textOf(part) {
  if (typeof part === 'string') return part
  if (!part || typeof part !== 'object') return ''
  return String(part.text || part.content || '')
}

function inputParts(content) {
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: content }]
  return parts.flatMap((part) => {
    if (typeof part === 'string') return [{ type: 'input_text', text: part }]
    if (part?.type === 'image_url' || part?.type === 'input_image') {
      const url = part.image_url?.url || part.image_url || part.url || ''
      return url ? [{ type: 'input_image', image_url: url }] : []
    }
    if (part?.type === 'text' || part?.text) return [{ type: 'input_text', text: textOf(part) }]
    return []
  })
}

/** Pipeline messages (OpenAI-flavoured) → Responses input items. */
export function toResponsesInput(messages = []) {
  const instructionLines = []
  for (const message of messages) {
    if (message?.role !== 'system') continue
    const text = textOf(message.content)
    if (text) instructionLines.push(text)
  }
  const input = []
  for (const message of messages) {
    if (!message || message.role === 'system') continue
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: String(message.tool_call_id || ''), output: textOf(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const text = textOf(message.content)
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        input.push({
          type: 'function_call',
          call_id: String(call?.id || ''),
          name: String(call?.function?.name || ''),
          arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call?.function?.arguments || {}),
        })
      }
      continue
    }
    const content = inputParts(message.content)
    if (content.length > 0) input.push({ role: 'user', content })
  }
  return { instructions: instructionLines.join('\n\n'), input }
}

export function buildOpenAIResponsesRequest({ config = {}, messages = [], stream = false, tools = [], toolChoice, profile = {} } = {}) {
  const { instructions, input } = toResponsesInput(messages)
  const headers = { 'Content-Type': 'application/json', ...(config.headers || {}) }
  if (config.apiKey && !headers.Authorization && !headers.authorization) headers.authorization = `Bearer ${config.apiKey}`
  const body = {
    model: config.modelName,
    input,
    max_output_tokens: Number(config.maxTokens) > 0 ? Number(config.maxTokens) : 8192,
    stream: !!stream,
  }
  if (instructions) body.instructions = instructions
  if (Number.isFinite(config.temperature)) body.temperature = config.temperature
  if (Array.isArray(tools) && tools.length > 0 && profile.supportsTools) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      name: tool.function?.name,
      description: tool.function?.description || '',
      parameters: tool.function?.parameters || { type: 'object', properties: {} },
    }))
    if (toolChoice === 'none') body.tool_choice = 'none'
  }
  const base = stripTrailingSlashes(config.baseUrl)
  const url = /\/responses$/u.test(base) ? base : `${stripV1(base)}/v1/responses`
  return { url, init: { method: 'POST', headers, body: JSON.stringify(body) } }
}

function stripTrailingSlashes(value) {
  let text = String(value || '')
  while (text.endsWith('/')) text = text.slice(0, -1)
  return text
}

function stripV1(base) {
  return base.endsWith('/v1') ? base.slice(0, -3) : base
}

function usageFrom(raw) {
  if (!raw) return null
  const prompt = Number(raw.input_tokens)
  const completion = Number(raw.output_tokens)
  const usage = {}
  if (Number.isFinite(prompt)) usage.promptTokens = Math.floor(prompt)
  if (Number.isFinite(completion)) usage.completionTokens = Math.floor(completion)
  const total = Number(raw.total_tokens)
  if (Number.isFinite(total)) usage.totalTokens = Math.floor(total)
  else if (usage.promptTokens !== undefined) usage.totalTokens = usage.promptTokens + (usage.completionTokens || 0)
  return Object.keys(usage).length > 0 ? usage : null
}

function finishReasonOf(response = {}) {
  if (response.status === 'incomplete') return 'length'
  const hasCalls = (Array.isArray(response.output) ? response.output : []).some((item) => item?.type === 'function_call')
  return hasCalls ? 'tool_calls' : 'stop'
}

export function parseOpenAIResponsesResponse(data = {}) {
  const output = Array.isArray(data.output) ? data.output : []
  const texts = []
  const toolCalls = []
  for (const item of output) {
    if (item?.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === 'output_text' || part?.type === 'text') texts.push(String(part.text || ''))
      }
    }
    if (item?.type === 'function_call') {
      toolCalls.push({
        id: String(item.call_id || item.id || ''),
        type: 'function',
        function: { name: String(item.name || ''), arguments: String(item.arguments || '') },
      })
    }
  }
  return {
    content: texts.join(''),
    toolCalls,
    usage: usageFrom(data.usage),
    finishReason: finishReasonOf(data),
  }
}

export function createOpenAIResponsesStreamState() {
  return { finishReason: 'stop', toolCalls: new Map(), usage: null, finished: false }
}

function lastCall(state) {
  const values = [...state.toolCalls.values()]
  return values.length > 0 ? values[values.length - 1] : null
}

export function consumeOpenAIResponsesStreamPayload(data = {}, state) {
  const events = []
  switch (data.type) {
    case 'response.output_text.delta':
      if (data.delta) events.push({ type: 'text', delta: String(data.delta) })
      return events
    case 'response.reasoning_summary_text.delta':
      if (data.delta) events.push({ type: 'reasoning', delta: String(data.delta) })
      return events
    case 'response.output_item.added':
      if (data.item?.type === 'function_call') {
        state.toolCalls.set(data.output_index ?? state.toolCalls.size, {
          id: String(data.item.call_id || data.item.id || ''),
          type: 'function',
          function: { name: String(data.item.name || ''), arguments: '' },
        })
      }
      return events
    case 'response.function_call_arguments.delta': {
      const call = state.toolCalls.get(data.output_index ?? 0) || lastCall(state)
      if (call) call.function.arguments += String(data.delta || '')
      return events
    }
    case 'response.output_item.done': {
      if (data.item?.type === 'function_call') {
        const call = state.toolCalls.get(data.output_index ?? 0) || lastCall(state)
        if (call) events.push({ type: 'tool_call_ready', toolCall: { ...call, function: { ...call.function } }, index: data.output_index ?? 0 })
      }
      return events
    }
    case 'response.completed': {
      const usage = usageFrom(data.response?.usage)
      if (usage) {
        state.usage = usage
        events.push({ type: 'usage', usage })
      }
      state.finishReason = finishReasonOf(data.response || {})
      events.push(...finishOpenAIResponsesStream(state))
      return events
    }
    case 'response.failed':
    case 'error': {
      state.finishReason = 'error'
      events.push(...finishOpenAIResponsesStream(state))
      return events
    }
    default:
      return events
  }
}

export function finishOpenAIResponsesStream(state) {
  if (state.finished) return []
  state.finished = true
  return [{ type: 'finish', finishReason: state.finishReason || 'stop', ...(state.usage ? { usage: state.usage } : {}) }]
}

export const openAIResponsesAdapter = Object.freeze({
  buildRequest: buildOpenAIResponsesRequest,
  parseResponse: parseOpenAIResponsesResponse,
  extractUsage: (data) => usageFrom(data?.usage),
  createStreamState: () => createOpenAIResponsesStreamState(),
  consumeStreamPayload: consumeOpenAIResponsesStreamPayload,
  finishStream: finishOpenAIResponsesStream,
})

let registered = false

/** Idempotent: the LLM layer calls it once; tests may call it directly. */
export function registerOpenAIResponsesAdapter() {
  if (registered) return false
  registerModelProviderAdapter(KIND, openAIResponsesAdapter)
  registered = true
  return true
}
