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
    if (previous?.role === message.role) previous.content.push(...message.content)
    else merged.push({ ...message, content: [...message.content] })
  }
  return merged
}

function openAiParts(content) {
  return Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]
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

function anthropicMessages(messages = []) {
  const system = []
  const out = []
  for (const message of messages) {
    if (message?.role === 'system') {
      const text = openAiParts(message.content).filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
      if (text) system.push(text)
      continue
    }
    if (message?.role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(message.tool_call_id || ''),
          content: serializeToolResult(message.content),
        }],
      })
      continue
    }
    const content = openAiParts(message?.content).map(anthropicPart).filter(Boolean)
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: String(call?.id || ''),
          name: String(call?.function?.name || ''),
          input: json(call?.function?.arguments, {}),
        })
      }
    }
    if (content.length) out.push({ role: message?.role === 'assistant' ? 'assistant' : 'user', content })
  }
  return { system: system.join('\n\n'), messages: mergeAdjacent(out) }
}

function anthropicToolChoice(toolChoice) {
  if (toolChoice === 'required') return { type: 'any' }
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) {
    return { type: 'tool', name: toolChoice.function.name }
  }
  return { type: 'auto' }
}

function buildAnthropicRequest({ config, messages, stream, tools, toolChoice, profile }) {
  const converted = anthropicMessages(messages)
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
  const base = normalizeBase(config.baseUrl)
  const url = /\/v1\/messages$/i.test(base) ? base : `${base.replace(/\/v1$/i, '')}/v1/messages`
  return { url, init: { method: 'POST', headers, body: JSON.stringify(body) } }
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

function geminiMessages(messages = []) {
  const system = []
  const out = []
  const toolNames = new Map()
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) toolNames.set(call.id, call.function?.name || '')
    }
    if (message?.role === 'system') {
      const text = openAiParts(message.content).filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
      if (text) system.push(text)
      continue
    }
    if (message?.role === 'tool') {
      const name = message.name || toolNames.get(message.tool_call_id) || 'tool'
      out.push({ role: 'user', content: [{ functionResponse: { name, response: geminiToolResult(message.content) } }] })
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
  const converted = geminiMessages(messages)
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
  if (args.profile?.kind === 'anthropic') return buildAnthropicRequest(args)
  if (args.profile?.kind === 'gemini') return buildGeminiRequest(args)
  throw new Error(`Unsupported native provider kind: ${args.profile?.kind || 'unknown'}`)
}
