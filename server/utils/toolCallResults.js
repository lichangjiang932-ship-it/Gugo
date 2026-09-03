import { safeStringify } from './toolCallPrimitives.js'

/**
 * 单个工具结果喂回模型时的字符上限。
 *
 * 这个值只控制单个结果的上限；工具循环还会在下一次模型请求前，
 * 按真实上下文窗口为同批结果分配总预算。
 */
export const DEFAULT_TOOL_OUTPUT_CHARS = (() => {
  const raw = Number(process.env.TOOL_OUTPUT_MAX_CHARS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 24_000
})()

const MIN_TOOL_OUTPUT_CHARS = 500
export const TRUNCATED_TOOL_RESULT_METADATA_KEY = '_gugoResultMetadata'
const TRUNCATED_TOOL_RESULT_METADATA_VERSION = 1
const MAX_RECEIPT_PATH_CHARS = 4_096
const MAX_RECEIPT_PATHS = 64

// Reserve most of the model window for instructions, history, tool-call
// protocol, and the next answer. At 0.75 chars per context token, four tool
// results in an 8k window share about 6k characters, while a 128k window still
// preserves the existing 24k-per-result ceiling for the same batch.
export const TOOL_OUTPUT_CONTEXT_CHARS_PER_TOKEN = 0.75

export function resolveToolResultMaxChars({
  contextWindow,
  resultCount = 1,
  maxChars = DEFAULT_TOOL_OUTPUT_CHARS,
} = {}) {
  const count = Math.max(1, Math.floor(Number(resultCount) || 1))
  const perResultCeiling = Math.max(
    MIN_TOOL_OUTPUT_CHARS,
    Math.floor(Number(maxChars) || DEFAULT_TOOL_OUTPUT_CHARS),
  )
  const window = Number(contextWindow)
  if (!Number.isFinite(window) || window <= 0) return perResultCeiling

  const batchBudget = Math.max(
    MIN_TOOL_OUTPUT_CHARS * count,
    Math.floor(window * TOOL_OUTPUT_CONTEXT_CHARS_PER_TOKEN),
  )
  return Math.max(
    MIN_TOOL_OUTPUT_CHARS,
    Math.min(perResultCeiling, Math.floor(batchBudget / count)),
  )
}

function receiptPath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text.length <= MAX_RECEIPT_PATH_CHARS ? text : null
}

function receiptInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : null
}

function truncatedToolResultMetadata(value, limit) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const metadata = { version: TRUNCATED_TOOL_RESULT_METADATA_VERSION }
  const metadataBudget = Math.max(180, Math.min(8_000, Math.floor(limit * 0.45)))
  const directPath = receiptPath(value.path)
  if (directPath) metadata.path = directPath
  for (const key of ['size', 'totalLines', 'offset', 'returnedLines']) {
    const number = receiptInteger(value[key])
    if (number !== null) metadata[key] = number
  }
  if (typeof value.content === 'string') {
    metadata.contentPresent = true
    metadata.sourceTruncated = value.truncated === true
  }
  if (typeof value.dry_run === 'boolean') metadata.dry_run = value.dry_run

  const appendWithinBudget = (key, item) => {
    const nextItems = [...(metadata[key] || []), item]
    const candidate = { ...metadata, [key]: nextItems }
    if ((safeStringify(candidate) || '').length > metadataBudget) return false
    metadata[key] = nextItems
    return true
  }
  for (const valuePath of Array.isArray(value.changedPaths)
    ? value.changedPaths.slice(0, MAX_RECEIPT_PATHS)
    : []) {
    const normalized = receiptPath(valuePath)
    if (normalized && !appendWithinBudget('changedPaths', normalized)) break
  }
  for (const change of Array.isArray(value.changes)
    ? value.changes.slice(0, MAX_RECEIPT_PATHS)
    : []) {
    const normalized = receiptPath(change?.path)
    if (!normalized) continue
    const compact = {
      path: normalized,
      ...(typeof change?.op === 'string' && change.op.length <= 32 ? { op: change.op } : {}),
    }
    if (!appendWithinBudget('changes', compact)) break
  }

  return Object.keys(metadata).length > 1 ? metadata : null
}

/** 始终返回合法 JSON；超长结果变为带长度和预览的说明对象。 */
export function serializeToolResult(value, { maxChars = DEFAULT_TOOL_OUTPUT_CHARS } = {}) {
  const limit = Math.max(MIN_TOOL_OUTPUT_CHARS, Number(maxChars) || DEFAULT_TOOL_OUTPUT_CHARS)
  const json = safeStringify(value) ?? 'null'
  if (json.length <= limit) return json

  const metadata = truncatedToolResultMetadata(value, limit)
  const base = {
    ok: value?.ok ?? true,
    truncated: true,
    _truncated: true,
    originalChars: json.length,
    _originalChars: json.length,
    ...(metadata ? { [TRUNCATED_TOOL_RESULT_METADATA_KEY]: metadata } : {}),
    hint: '结果过长。请缩小查询范围、使用分页/offset，或只读取相关片段。',
  }
  const baseChars = (safeStringify({ ...base, preview: '' }) || '').length
  let previewChars = Math.max(0, limit - baseChars - 8)
  let clipped
  do {
    clipped = safeStringify({
      ...base,
      preview: json.slice(0, previewChars),
    })
    previewChars = Math.max(0, previewChars - 100)
  } while (clipped.length > limit && previewChars > 0)
  if (clipped.length <= limit) return clipped

  const fallback = safeStringify({
    ok: value?.ok ?? true,
    truncated: true,
    _truncated: true,
    originalChars: json.length,
    _originalChars: json.length,
    ...(metadata ? { [TRUNCATED_TOOL_RESULT_METADATA_KEY]: metadata } : {}),
  })
  return fallback.length <= limit
    ? fallback
    : safeStringify({
        truncated: true,
        _truncated: true,
        originalChars: json.length,
        _originalChars: json.length,
      })
}

export function buildToolResultMessage(call, result, options) {
  return {
    role: 'tool',
    tool_call_id: call.id,
    name: call.name || undefined,
    content: serializeToolResult(result, options),
  }
}

const EPHEMERAL_TOOL_MEDIA_TYPE = 'ephemeral_tool_media'

function inlineImageDataUrl(message) {
  if (message?.role !== 'user' || !Array.isArray(message.content)) return false
  return message.content.some((part) => (
    part?.type === 'image_url'
    && /^data:image\/(?:png|jpe?g|webp|gif);base64,/iu.test(String(part?.image_url?.url || ''))
  ))
}

/**
 * Tool-produced media is request-scoped context. The marker lets the runtime
 * remove it from the durable conversation after the next logical model call.
 * The text check also recognizes checkpoints written by versions predating the
 * marker so a resumed turn cannot replay a legacy screenshot indefinitely.
 */
export function isEphemeralToolMediaMessage(message) {
  if (message?.meta?.type === EPHEMERAL_TOOL_MEDIA_TYPE) return true
  if (!inlineImageDataUrl(message)) return false
  const text = message.content
    .filter((part) => part?.type === 'text')
    .map((part) => String(part?.text || ''))
    .join(' ')
  return /Browser screenshot captured by browser_screenshot|produced the image below\. Inspect it to verify the result before continuing\./u.test(text)
}

export function stripEphemeralToolMediaMessages(messages = []) {
  const source = Array.isArray(messages) ? messages : []
  return source.filter((message) => !isEphemeralToolMediaMessage(message))
}

/**
 * Tool-produced images need to be visible to the next model response, not
 * embedded as an enormous base64 string inside JSON. Keep a compact tool
 * result for protocol pairing, then add the image as a normal multimodal user
 * message so native vision and vision-assist use the existing image path.
 */
export function buildToolResultMessageBundle(call, result, options) {
  const image = result?.image ?? null
  const data = typeof image?.data === 'string' ? image.data.trim() : ''
  const mimeType = String(image?.mimeType || '').trim().toLowerCase()
  if (!data || !/^image\/(?:png|jpe?g|webp|gif)$/u.test(mimeType)) {
    return {
      durableMessages: [buildToolResultMessage(call, result, options)],
      ephemeralMessages: [],
    }
  }
  const compactResult = {
    ...result,
    image: {
      captured: true,
      mimeType,
      ...(Number.isFinite(Number(image?.bytes)) ? { bytes: Number(image.bytes) } : {}),
    },
  }
  const inspectionText = call?.name === 'browser_screenshot'
    ? 'Browser screenshot captured by browser_screenshot. Inspect this image before continuing.'
    : `${call?.name || 'tool'} produced the image below. Inspect it to verify the result before continuing.`
  return {
    durableMessages: [buildToolResultMessage(call, compactResult, options)],
    ephemeralMessages: [{
      role: 'user',
      content: [
        { type: 'text', text: inspectionText },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } },
      ],
      meta: {
        type: EPHEMERAL_TOOL_MEDIA_TYPE,
        toolCallId: call?.id || null,
        consume: 'next_model_call',
      },
    }],
  }
}

/** Backward-compatible flattened view for callers that do not persist it. */
export function buildToolResultMessages(call, result, options) {
  const bundle = buildToolResultMessageBundle(call, result, options)
  return [...bundle.durableMessages, ...bundle.ephemeralMessages]
}
