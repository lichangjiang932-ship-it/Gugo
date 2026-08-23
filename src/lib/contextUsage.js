const MESSAGE_OVERHEAD_TOKENS = 6
const FIXED_CONTEXT_OVERHEAD_TOKENS = 16
const IMAGE_CONTEXT_TOKENS = 256
const DATA_IMAGE_URL_PATTERN = /data:image\/[a-z0-9.+-]+(?:;[^,\s]*)?;base64,[a-z0-9+/=\r\n]+/giu

export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000

export function normalizeOptionalTokenCount(value) {
  if (
    value === null
    || value === undefined
    || typeof value === 'boolean'
    || (typeof value === 'string' && value.trim() === '')
  ) return null

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export function normalizeContextWindow(value, fallback = DEFAULT_MODEL_CONTEXT_WINDOW) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)

  const parsedFallback = Number(fallback)
  return Number.isFinite(parsedFallback) && parsedFallback > 0
    ? Math.floor(parsedFallback)
    : DEFAULT_MODEL_CONTEXT_WINDOW
}

export function resolveModelContextWindow(
  models = [],
  modelName = '',
  fallback = DEFAULT_MODEL_CONTEXT_WINDOW,
  modelProviderId = '',
) {
  const selectedProviderId = String(modelProviderId || '').trim()
  const selected = Array.isArray(models)
    ? models.find((model) => (
        model?.name === modelName
        && (!selectedProviderId || model?.provider === selectedProviderId)
      ))
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

export function sumSessionModelUsage(messages = []) {
  if (!Array.isArray(messages)) return null
  let total = 0
  let measured = false
  for (const message of messages) {
    if (message?.role !== 'assistant') continue
    const candidates = [message?.meta?.turnModelUsage, message?.meta?.modelUsage]
    for (const usage of candidates) {
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue
      const directTotal = normalizeOptionalTokenCount(usage.totalTokens)
      const prompt = normalizeOptionalTokenCount(usage.promptTokens)
      const completion = normalizeOptionalTokenCount(usage.completionTokens)
      if (directTotal === null && prompt === null && completion === null) continue
      total += directTotal ?? (prompt || 0) + (completion || 0)
      measured = true
      break
    }
  }
  return measured ? Math.floor(total) : null
}

function textContentOf(value) {
  if (typeof value === 'string') return value.replace(DATA_IMAGE_URL_PATTERN, '')
  if (Array.isArray(value)) return value.map(textContentOf).filter(Boolean).join('\n')
  if (!value || typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text.replace(DATA_IMAGE_URL_PATTERN, '')
  if (typeof value.content === 'string') return value.content.replace(DATA_IMAGE_URL_PATTERN, '')
  return ''
}

function normalizedComparableText(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim()
}

function isDuplicateAttachmentText(attachmentText, messageText) {
  const attachment = normalizedComparableText(attachmentText)
  const content = normalizedComparableText(messageText)
  return Boolean(attachment && content && content.includes(attachment))
}

function compactAttachment(attachment, messageText = '') {
  if (!attachment || typeof attachment !== 'object') return attachment
  const text = attachment.text || ''
  return {
    name: attachment.name || '',
    type: attachment.type || attachment.kind || '',
    size: attachment.size ?? attachment.sizeKB ?? null,
    text: isDuplicateAttachmentText(text, messageText) ? '' : text,
  }
}

function isImageContentPart(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const type = String(value.type || '').toLowerCase()
  return type === 'image_url'
    || type === 'input_image'
    || type === 'image'
    || Object.hasOwn(value, 'image_url')
}

function compactContextValue(value, state) {
  if (typeof value === 'string') {
    return value.replace(DATA_IMAGE_URL_PATTERN, () => {
      state.imageCount += 1
      return '[inline image]'
    })
  }
  if (Array.isArray(value)) return value.map((item) => compactContextValue(item, state))
  if (!value || typeof value !== 'object') return value
  if (isImageContentPart(value)) {
    state.imageCount += 1
    return { type: String(value.type || 'image_url'), image: '[image]' }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, compactContextValue(item, state)]),
  )
}

function estimateContextValue(value) {
  const state = { imageCount: 0 }
  const compacted = compactContextValue(value, state)
  const imageTokens = state.imageCount * IMAGE_CONTEXT_TOKENS
  return {
    tokens: estimateTextTokens(compacted) + imageTokens,
    imageTokens,
  }
}

function contextPayload(message) {
  const toolCalls = message?.tool_calls || message?.meta?.toolCalls || []
  const attachments = message?.attachments || message?.meta?.attachments || []
  const messageText = textContentOf(message?.content)
  return {
    role: message?.role || '',
    content: message?.content ?? '',
    toolCalls: Array.isArray(toolCalls) ? toolCalls.map(compactToolCall) : toolCalls,
    attachments: Array.isArray(attachments)
      ? attachments.map((attachment) => compactAttachment(attachment, messageText))
      : attachments,
    visibleText: messageText,
  }
}

export function estimateClientContextUsage({
  messages = [],
  tools = [],
  systemPrompt = '',
  contextWindow = DEFAULT_MODEL_CONTEXT_WINDOW,
  actualPromptTokens = null,
  serverEstimatedPromptTokens = null,
} = {}) {
  const safeMessages = Array.isArray(messages) ? messages : []
  let messageTokens = 0
  let toolCallTokens = 0
  let attachmentTokens = 0
  let imageTokens = 0
  let visibleCharacters = 0

  for (const message of safeMessages) {
    const payload = contextPayload(message)
    const messageEstimate = estimateContextValue({ role: payload.role, content: payload.content })
    const toolCallEstimate = estimateContextValue(payload.toolCalls)
    const attachmentEstimate = estimateContextValue(payload.attachments)
    visibleCharacters += payload.visibleText.length
    messageTokens += MESSAGE_OVERHEAD_TOKENS
      + messageEstimate.tokens
    toolCallTokens += toolCallEstimate.tokens
    attachmentTokens += attachmentEstimate.tokens
    imageTokens += messageEstimate.imageTokens
      + toolCallEstimate.imageTokens
      + attachmentEstimate.imageTokens
  }

  const toolSpecTokens = estimateContextValue(Array.isArray(tools) ? tools : []).tokens
  const systemTokens = FIXED_CONTEXT_OVERHEAD_TOKENS + estimateTextTokens(systemPrompt)
  const estimatedTokens = messageTokens + toolCallTokens + attachmentTokens + toolSpecTokens + systemTokens
  const safeWindow = normalizeContextWindow(contextWindow)
  const percent = Math.min(100, Math.round((estimatedTokens / safeWindow) * 100))
  const measuredPromptTokens = normalizeOptionalTokenCount(actualPromptTokens)
  const hasMeasuredPromptTokens = measuredPromptTokens !== null
  const serverPromptEstimate = normalizeOptionalTokenCount(serverEstimatedPromptTokens)

  return {
    estimatedTokens,
    percent,
    contextWindow: safeWindow,
    messageCount: safeMessages.length,
    visibleCharacters,
    messageTokens,
    toolCallTokens,
    attachmentTokens,
    imageTokens,
    toolSpecTokens,
    systemTokens,
    ...(hasMeasuredPromptTokens ? { actualPromptTokens: Math.floor(measuredPromptTokens) } : {}),
    ...(serverPromptEstimate !== null
      ? { serverEstimatedPromptTokens: Math.floor(serverPromptEstimate) }
      : {}),
  }
}
