import { anthropicCacheHeaders, anthropicPromptCacheControl, canonicalizeModelToolSet } from './modelRequestCache.js'
import { geminiReplayParts, providerReplayContext } from './providerReplayState.js'

function json(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function parseDataUrl(value = '') {
  const match = String(value || '').match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/is)
  return match ? { mimeType: match[1], data: match[2] } : null
}

function normalizeBase(baseUrl = '') {
  return String(baseUrl || '').trim().replace(/\/+$/, '')
}

function mergeAdjacent(messages = []) {
  const merged = []
  for (const message of messages) {
    const previous = merged.at(-1)
    // A controlBoundary message keeps its own turn so an in-position runtime
    // control message is never folded into an adjacent functionResponse list.
    const mergeable = previous?.role === message.role
      && previous.controlBoundary !== true
      && message.controlBoundary !== true
    if (mergeable) previous.content.push(...message.content)
    else merged.push({ ...message, content: [...message.content] })
  }
  return merged
}

function openAiParts(content) {
  return Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]
}

/** Text payload of an OpenAI-compatible message, including typed-content arrays. */
function messageText(content) {
  return openAiParts(content)
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text ?? ''))
    .filter(Boolean)
    .join('\n')
}

function jsonSafeToolResult(content) {
  const seen = new WeakSet()
  try {
    const encoded = JSON.stringify(content ?? null, (_key, value) => {
      if (typeof value === 'bigint') return String(value)
      if (value instanceof Error) {
        return { name: value.name, message: value.message, code: value.code, status: value.status }
      }
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]'
        seen.add(value)
      }
      return value
    })
    return encoded === undefined ? null : JSON.parse(encoded)
  } catch {
    return { error: 'tool_result_serialization_failed' }
  }
}

function serializeToolResult(content) {
  return typeof content === 'string' ? content : JSON.stringify(jsonSafeToolResult(content))
}

function geminiToolResult(content) {
  let value = content
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { result: value }
    }
  }
  value = jsonSafeToolResult(value)
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  return { result: value ?? null }
}

function anthropicPart(part) {
  if (part?.type === 'text') return { type: 'text', text: String(part.text || '') }
  if (part?.type === 'image_url') {
    const source = parseDataUrl(part.image_url?.url)
    return source ? { type: 'image', source: { type: 'base64', media_type: source.mimeType, data: source.data } } : null
  }
  if (part?.type === 'file') {
    const source = parseDataUrl(part.file?.file_data)
    return source ? { type: 'document', source: { type: 'base64', media_type: source.mimeType, data: source.data } } : null
  }
  return null
}

// SDK ContentBlockParam explicitly permits these cache targets. Thinking and
// redacted-thinking/signature state are not cacheable text blocks.
const ANTHROPIC_CACHEABLE_BLOCK_TYPES = new Set(['text', 'image', 'document', 'tool_use', 'tool_result'])

function cacheSafeSource(source) {
  if (Array.isArray(source)) return source.every(cacheSafeSource)
  if (!source || typeof source !== 'object') return true
  return !['thinking', 'redacted_thinking'].includes(source.type) && source.thought !== true
    && !Object.hasOwn(source, 'signature') && !Object.hasOwn(source, 'thoughtSignature')
}

function anthropicMessages(messages = [], { trackCacheTargets = false } = {}) {
  const system = []
  const out = []
  const cacheableBlocks = new WeakSet()
  let stableSystemPrefix = true
  let lastStableSystemIndex = -1
  const track = (block, source) => {
    if (trackCacheTargets && block && cacheSafeSource(source)
        && ANTHROPIC_CACHEABLE_BLOCK_TYPES.has(block.type)
        && (block.type !== 'text' || block.text.trim())) cacheableBlocks.add(block)
    return block
  }
  let leadingSystem = true
  const appendRuntimeControl = (text, source) => {
    // Anthropic has no mid-conversation system slot and enforces strict
    // user/assistant alternation. Keep the runtime control message in position
    // by appending a text block to the current user turn, so guidance still
    // arrives immediately after the tool result it applies to.
    const previous = out.at(-1)
    const block = track({ type: 'text', text }, source)
    if (previous?.role === 'user') previous.content.push(block)
    else out.push({ role: 'user', content: [block] })
  }
  for (const message of messages) {
    if (message?.role === 'system') {
      const text = messageText(message.content)
      if (!text) continue
      if (leadingSystem) {
        const block = track({ type: 'text', text }, message.content)
        system.push(block)
        stableSystemPrefix &&= message.__gugoPromptStability === 'stable' && cacheableBlocks.has(block)
        if (stableSystemPrefix) lastStableSystemIndex = system.length - 1
      } else appendRuntimeControl(text, message.content)
      continue
    }
    leadingSystem = false
    if (message?.role === 'tool') {
      out.push({
        role: 'user',
        content: [track({
          type: 'tool_result',
          tool_use_id: String(message.tool_call_id || ''),
          content: serializeToolResult(message.content),
        }, message)],
      })
      continue
    }
    const content = openAiParts(message?.content).map((part) => track(anthropicPart(part), part)).filter(Boolean)
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        content.push(track({
          type: 'tool_use',
          id: String(call?.id || ''),
          name: String(call?.function?.name || ''),
          input: json(call?.function?.arguments, {}),
        }, call))
      }
    }
    if (content.length) out.push({ role: message?.role === 'assistant' ? 'assistant' : 'user', content })
  }
  return {
    system: trackCacheTargets && system.length ? system : system.map((block) => block.text).join('\n\n'),
    messages: mergeAdjacent(out), cacheableBlocks, lastStableSystemIndex,
  }
}

function anthropicToolChoice(toolChoice) {
  if (toolChoice === 'required') return { type: 'any' }
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) {
    return { type: 'tool', name: toolChoice.function.name }
  }
  return { type: 'auto' }
}

function applyAnthropicCacheControl(body, converted, cacheControl, lastBaseToolIndex) {
  if (!cacheControl) return false
  let applied = false
  if (Array.isArray(body.system)) {
    const lastIndex = body.system.findLastIndex((block) => converted.cacheableBlocks.has(block))
    body.system = body.system.map((block, index) => {
      if (index !== lastIndex && index !== converted.lastStableSystemIndex) return block
      applied = true
      return { ...block, cache_control: cacheControl }
    })
  }
  if (body.tools?.length) {
    // Dynamic tools are appended after the base set. Keep the base breakpoint
    // identical when they appear; an all-dynamic catalog has no earlier anchor.
    const index = lastBaseToolIndex >= 0 ? lastBaseToolIndex : body.tools.length - 1
    body.tools[index].cache_control = cacheControl
    applied = true
  }
  for (let messageIndex = body.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const content = body.messages[messageIndex].content
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex]
      if (!converted.cacheableBlocks.has(block)) continue
      content[blockIndex] = { ...block, cache_control: cacheControl }
      return true
    }
  }
  return applied
}

function buildAnthropicRequest({ config, messages, stream, tools, toolChoice, profile, env, lastBaseToolIndex }) {
  const cacheControl = anthropicPromptCacheControl(env)
  const converted = anthropicMessages(messages, { trackCacheTargets: !!cacheControl })
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(config?.headers || {}),
  }
  if (config?.apiKey && !headers['x-api-key'] && !headers.Authorization) headers['x-api-key'] = config.apiKey
  const body = {
    model: config.modelName,
    messages: converted.messages,
    max_tokens: Number(config.maxTokens) > 0 ? Number(config.maxTokens) : 8192,
    temperature: config.temperature ?? 0.7,
    stream: !!stream,
  }
  if (converted.system) body.system = converted.system
  if (Array.isArray(tools) && tools.length && profile.supportsTools && toolChoice !== 'none') {
    body.tools = tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description || '',
      input_schema: tool.function.parameters || { type: 'object', properties: {} },
    }))
    body.tool_choice = anthropicToolChoice(toolChoice)
  }
  const cacheApplied = applyAnthropicCacheControl(body, converted, cacheControl, lastBaseToolIndex)
  const wireHeaders = cacheApplied ? anthropicCacheHeaders(headers, cacheControl, profile) : headers
  const base = normalizeBase(config.baseUrl)
  const url = /\/v1\/messages$/i.test(base) ? base : `${base.replace(/\/v1$/i, '')}/v1/messages`
  return { url, init: { method: 'POST', headers: wireHeaders, body: JSON.stringify(body) } }
}

function geminiPart(part) {
  if (part?.type === 'text') return { text: String(part.text || '') }
  if (part?.type === 'image_url') {
    const source = parseDataUrl(part.image_url?.url)
    return source ? { inlineData: { mimeType: source.mimeType, data: source.data } } : null
  }
  if (part?.type === 'file') {
    const source = parseDataUrl(part.file?.file_data)
    return source ? { inlineData: { mimeType: source.mimeType, data: source.data } } : null
  }
  return null
}

function geminiMessages(messages = [], replayContext = null) {
  const system = []
  const out = []
  const toolNames = new Map()
  let leadingSystem = true
  for (const message of messages) {
    const replayParts = message?.role === 'assistant' ? geminiReplayParts(message, replayContext) : null
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const nativeCalls = replayParts?.filter((part) => part.functionCall) || []
      for (const [index, call] of message.tool_calls.entries()) toolNames.set(call.id, {
        name: call.function?.name || '', nativeId: nativeCalls[index]?.functionCall?.id,
      })
    }
    if (message?.role === 'system') {
      const text = messageText(message.content)
      if (!text) continue
      if (leadingSystem) {
        system.push(text)
        continue
      }
      // Gemini has one top-level systemInstruction. Keep runtime control
      // messages in position as their own user turn, and do not fold them into
      // an adjacent functionResponse part list.
      out.push({ role: 'user', content: [{ text }], controlBoundary: true })
      continue
    }
    leadingSystem = false
    if (message?.role === 'tool') {
      const reference = toolNames.get(message.tool_call_id)
      const name = message.name || reference?.name || 'tool'
      out.push({ role: 'user', content: [{ functionResponse: { name, ...(reference?.nativeId ? { id: reference.nativeId } : {}), response: geminiToolResult(message.content) } }] })
      continue
    }
    if (replayParts) {
      out.push({ role: 'model', content: replayParts })
      continue
    }
    const content = openAiParts(message?.content).map(geminiPart).filter(Boolean)
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        content.push({ functionCall: { name: call.function?.name || '', args: json(call.function?.arguments, {}) } })
      }
    }
    if (content.length) out.push({ role: message?.role === 'assistant' ? 'model' : 'user', content })
  }
  return {
    systemInstruction: system.length ? { parts: [{ text: system.join('\n\n') }] } : null,
    contents: mergeAdjacent(out).map((message) => ({ role: message.role, parts: message.content })),
  }
}

function geminiToolMode(toolChoice) {
  if (toolChoice === 'none') return 'NONE'
  if (toolChoice === 'required' || (toolChoice && typeof toolChoice === 'object')) return 'ANY'
  return 'AUTO'
}

function buildGeminiRequest({ config, messages, stream, tools, toolChoice, profile }) {
  const converted = geminiMessages(messages, providerReplayContext({ config, profile }))
  const headers = { 'Content-Type': 'application/json', ...(config?.headers || {}) }
  if (config?.apiKey && !headers['x-goog-api-key'] && !headers.Authorization) headers['x-goog-api-key'] = config.apiKey
  const body = {
    contents: converted.contents,
    generationConfig: { temperature: config.temperature ?? 0.7 },
  }
  if (converted.systemInstruction) body.systemInstruction = converted.systemInstruction
  if (Number(config.maxTokens) > 0) body.generationConfig.maxOutputTokens = Number(config.maxTokens)
  if (Array.isArray(tools) && tools.length && profile.supportsTools) {
    body.tools = [{ functionDeclarations: tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: tool.function.parameters || { type: 'object', properties: {} },
    })) }]
    body.toolConfig = { functionCallingConfig: { mode: geminiToolMode(toolChoice) } }
    const allowed = toolChoice && typeof toolChoice === 'object' ? toolChoice.function?.name : ''
    if (allowed) body.toolConfig.functionCallingConfig.allowedFunctionNames = [allowed]
  }
  const model = String(config.modelName || '').replace(/^models\//, '')
  let base = normalizeBase(config.baseUrl).replace(/\/models(?:\/.*)?$/i, '')
  try {
    const url = new URL(base)
    if (url.hostname === 'generativelanguage.googleapis.com' && (!url.pathname || url.pathname === '/')) {
      base = `${base}/v1beta`
    }
  } catch { /* fetch 会报告非法 URL */ }
  const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
  return {
    url: `${base}/models/${encodeURIComponent(model)}:${action}`,
    init: { method: 'POST', headers, body: JSON.stringify(body) },
  }
}

export function buildBuiltInNativeProviderRequest(args = {}) {
  const prepared = { ...args, ...canonicalizeModelToolSet(args.tools) }
  if (args.profile?.kind === 'anthropic') return buildAnthropicRequest(prepared)
  if (args.profile?.kind === 'gemini') return buildGeminiRequest(prepared)
  throw new Error(`Unsupported native provider kind: ${args.profile?.kind || 'unknown'}`)
}
