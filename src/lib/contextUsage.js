const MESSAGE_OVERHEAD_TOKENS = 6
const FIXED_CONTEXT_OVERHEAD_TOKENS = 16

export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000

export function normalizeContextWindow(value, fallback = DEFAULT_MODEL_CONTEXT_WINDOW) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)

  const parsedFallback = Number(fallback)
  return Number.isFinite(parsedFallback) && parsedFallback > 0
    ? Math.floor(parsedFallback)
    : DEFAULT_MODEL_CONTEXT_WINDOW
}

export function resolveModelContextWindow(models = [], modelName = '', fallback = DEFAULT_MODEL_CONTEXT_WINDOW) {
  const selected = Array.isArray(models)
    ? models.find((model) => model?.name === modelName)
    : null
  return normalizeContextWindow(selected?.contextWindow, fallback)
}

export function estimateTextTokens(value) {
  if (value === undefined || value === null || value === '') return 0
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  let ascii = 0
  let nonAscii = 0
  for (const char of text || '') {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4) + nonAscii
}

function compactToolCall(call) {
  if (!call || typeof call !== 'object') return call
  return {
    name: call.name || call.function?.name || '',
    args: call.args ?? call.arguments ?? call.function?.arguments ?? null,
    result: call.result ?? call.output ?? null,
    error: call.error ?? null,
  }
}

function compactAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return attachment
  return {
    name: attachment.name || '',
    type: attachment.type || attachment.kind || '',
    size: attachment.size ?? attachment.sizeKB ?? null,
    text: attachment.text || '',
  }
}

function contextPayload(message) {
  const toolCalls = message?.tool_calls || message?.meta?.toolCalls || []
  const attachments = message?.attachments || message?.meta?.attachments || []
  return {
    role: message?.role || '',
    content: message?.content ?? '',
    toolCalls: Array.isArray(toolCalls) ? toolCalls.map(compactToolCall) : toolCalls,
    attachments: Array.isArray(attachments) ? attachments.map(compactAttachment) : attachments,
  }
}

export function estimateClientContextUsage({
  messages = [],
  tools = [],
  systemPrompt = '',
  contextWindow = DEFAULT_MODEL_CONTEXT_WINDOW,
} = {}) {
  const safeMessages = Array.isArray(messages) ? messages : []
  let messageTokens = 0
  let toolCallTokens = 0
  let attachmentTokens = 0
  let visibleCharacters = 0

  for (const message of safeMessages) {
    const payload = contextPayload(message)
    visibleCharacters += typeof message?.content === 'string' ? message.content.length : 0
    messageTokens += MESSAGE_OVERHEAD_TOKENS
      + estimateTextTokens({ role: payload.role, content: payload.content })
    toolCallTokens += estimateTextTokens(payload.toolCalls)
    attachmentTokens += estimateTextTokens(payload.attachments)
  }

  const toolSpecTokens = estimateTextTokens(Array.isArray(tools) ? tools : [])
  const systemTokens = FIXED_CONTEXT_OVERHEAD_TOKENS + estimateTextTokens(systemPrompt)
  const estimatedTokens = messageTokens + toolCallTokens + attachmentTokens + toolSpecTokens + systemTokens
  const safeWindow = normalizeContextWindow(contextWindow)
  const percent = Math.min(100, Math.round((estimatedTokens / safeWindow) * 100))

  return {
    estimatedTokens,
    percent,
    contextWindow: safeWindow,
    visibleCharacters,
    messageTokens,
    toolCallTokens,
    attachmentTokens,
    toolSpecTokens,
    systemTokens,
  }
}
