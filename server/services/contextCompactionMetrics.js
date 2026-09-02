import { DEFAULT_CLOUD_CONTEXT_WINDOW } from '../utils/endpointProfile.js'

export const DEFAULT_ACTIVE_CONTEXT_TOKENS = 128_000
export const MAX_AUTO_COMPACTION_TOKENS = DEFAULT_ACTIVE_CONTEXT_TOKENS
// Context-aware callers pass the selected model's resolved window. Keep a
// conservative cloud-sized fallback for legacy/background entry points that
// do not yet carry model metadata; the former 1M fallback delayed compaction
// far beyond the capacity of most providers.
export const DEFAULT_CONTEXT_WINDOW = DEFAULT_CLOUD_CONTEXT_WINDOW

// A compaction checkpoint is a continuation aid, not a second transcript.
// Keep it substantially smaller than the active surface even when the model
// or the mechanical fallback returns an unexpectedly large body.
export const MAX_COMPACTION_SUMMARY_CHARS = 32_000
export const MAX_COMPACTION_SUMMARY_TOKENS = 8_000
export const MIN_COMPACTION_SUMMARY_TOKENS = 8
const COMPACTION_SUMMARY_CONTEXT_RATIO = 0.25
export const MAX_SEMANTIC_SUMMARY_INPUT_TOKENS = 64_000
export const COMPACTION_ARCHIVE_METADATA_RESERVE_TOKENS = 64
export const MAX_COMPACTION_PASSES = 2
const IMAGE_CONTEXT_TOKENS = 256
const DATA_IMAGE_URL_PATTERN = /data:image\/[a-z0-9.+-]+(?:;[^,\s]*)?;base64,[a-z0-9+/=\r\n]+/giu
const SUMMARY_TRUNCATION_MARKER = [
  '',
  '[Compaction checkpoint shortened to fit the active context budget.',
  'Exact prior content remains available in the canonical compaction archive.]',
  '',
].join('\n')

export function textTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  let ascii = 0
  let nonAscii = 0
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4) + nonAscii
}

function isImageContextPart(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const type = String(value.type || '').toLowerCase()
  return type === 'image_url'
    || type === 'input_image'
    || type === 'image'
    || Object.hasOwn(value, 'image_url')
}

function compactContextValueForEstimate(value, state) {
  if (typeof value === 'string') {
    return value.replace(DATA_IMAGE_URL_PATTERN, () => {
      state.imageCount += 1
      return '[inline image]'
    })
  }
  if (Array.isArray(value)) return value.map((item) => compactContextValueForEstimate(item, state))
  if (!value || typeof value !== 'object') return value
  if (isImageContextPart(value)) {
    state.imageCount += 1
    return { type: String(value.type || 'image_url'), image: '[image]' }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, compactContextValueForEstimate(item, state)]),
  )
}

function contextValueTokens(value) {
  const state = { imageCount: 0 }
  const compacted = compactContextValueForEstimate(value, state)
  return textTokens(compacted) + (state.imageCount * IMAGE_CONTEXT_TOKENS)
}

function takePrefixToTokenBudget(value, maxTokens) {
  const text = String(value || '')
  const budget = Math.max(0, Math.floor(Number(maxTokens) || 0))
  if (budget <= 0 || !text) return ''
  let ascii = 0
  let nonAscii = 0
  let end = 0
  for (const char of text) {
    const nextAscii = ascii + (char.charCodeAt(0) <= 0x7f ? 1 : 0)
    const nextNonAscii = nonAscii + (char.charCodeAt(0) <= 0x7f ? 0 : 1)
    if (Math.ceil(nextAscii / 4) + nextNonAscii > budget) break
    ascii = nextAscii
    nonAscii = nextNonAscii
    end += char.length
  }
  return text.slice(0, end)
}

function takeSuffixToTokenBudget(value, maxTokens) {
  const chars = Array.from(String(value || ''))
  const budget = Math.max(0, Math.floor(Number(maxTokens) || 0))
  if (budget <= 0 || chars.length === 0) return ''
  let ascii = 0
  let nonAscii = 0
  let start = chars.length
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index]
    const nextAscii = ascii + (char.charCodeAt(0) <= 0x7f ? 1 : 0)
    const nextNonAscii = nonAscii + (char.charCodeAt(0) <= 0x7f ? 0 : 1)
    if (Math.ceil(nextAscii / 4) + nextNonAscii > budget) break
    ascii = nextAscii
    nonAscii = nextNonAscii
    start = index
  }
  return chars.slice(start).join('')
}

function truncateHeadAndTailByChars(value, maxChars) {
  const text = String(value || '')
  const limit = Math.max(1, Math.floor(Number(maxChars) || 1))
  if (text.length <= limit) return text
  if (limit <= SUMMARY_TRUNCATION_MARKER.length + 2) {
    return SUMMARY_TRUNCATION_MARKER.slice(0, limit)
  }
  const available = limit - SUMMARY_TRUNCATION_MARKER.length
  const prefixChars = Math.ceil(available * 0.55)
  return `${text.slice(0, prefixChars)}${SUMMARY_TRUNCATION_MARKER}${text.slice(-(available - prefixChars))}`
}

/**
 * Bound a checkpoint while retaining both its opening objective and its most
 * recent continuation state. The canonical archive remains lossless.
 */
export function boundCompactionSummary(value, {
  maxTokens = MAX_COMPACTION_SUMMARY_TOKENS,
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
} = {}) {
  const tokenLimit = Math.max(1, Math.floor(Number(maxTokens) || 1))
  const charLimit = Math.max(1, Math.floor(Number(maxChars) || 1))
  let text = truncateHeadAndTailByChars(String(value || '').trim(), charLimit)
  if (textTokens(text) <= tokenLimit) return text

  const markerTokens = textTokens(SUMMARY_TRUNCATION_MARKER)
  if (markerTokens + 2 >= tokenLimit) {
    return takePrefixToTokenBudget('[Compacted context; see canonical archive.]', tokenLimit)
  }
  // Leave a two-token rounding margin because ASCII token estimates are
  // rounded independently for the prefix, marker, and suffix.
  const available = Math.max(0, tokenLimit - markerTokens - 2)
  const prefixTokens = Math.ceil(available * 0.55)
  const suffixTokens = Math.max(0, available - prefixTokens)
  text = `${takePrefixToTokenBudget(text, prefixTokens)}${SUMMARY_TRUNCATION_MARKER}${takeSuffixToTokenBudget(text, suffixTokens)}`
  if (textTokens(text) <= tokenLimit) return text
  return takePrefixToTokenBudget(text, tokenLimit)
}

const TOOL_RESULT_CONTEXT_RATIO = 0.25
const MAX_ROLLING_TOOL_RESULT_TOKENS = 24_000
const MIN_ROLLING_TOOL_RESULT_TOKENS = 256
const COMPACTED_TOOL_ERROR_CHARS = 600
const COMPACTED_TOOL_PREVIEW_CHARS = 160

function boundedSummaryValue(value, maxChars = 320) {
  if (typeof value === 'string') return value.slice(0, maxChars)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  return undefined
}

function compactToolResultContent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* non-JSON tool output */ }

  const summary = {
    ok: parsed && typeof parsed === 'object' ? parsed.ok !== false : true,
    contextCompacted: true,
    originalChars: text.length,
    note: 'Earlier tool output was compacted. Re-read the source if exact content is needed.',
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const key of ['code', 'artifactId', 'filename', 'path', 'url', 'sha256', 'scope']) {
      const bounded = boundedSummaryValue(parsed[key])
      if (bounded !== undefined && bounded !== '') summary[key] = bounded
    }
    if (parsed.ok === false && parsed.error) {
      summary.error = String(parsed.error).slice(0, COMPACTED_TOOL_ERROR_CHARS)
    }
    if (Array.isArray(parsed.artifactIds)) {
      summary.artifactIds = parsed.artifactIds.map(String).slice(0, 8)
    }
    if (Array.isArray(parsed.artifacts)) {
      summary.artifacts = parsed.artifacts.slice(0, 8).map((artifact) => ({
        ...(artifact?.id ? { id: String(artifact.id) } : {}),
        ...(artifact?.filename ? { filename: String(artifact.filename).slice(0, 240) } : {}),
        ...(artifact?.type ? { type: String(artifact.type).slice(0, 80) } : {}),
        ...(artifact?.url ? { url: String(artifact.url).slice(0, 320) } : {}),
      }))
    }
  } else if (text) {
    summary.preview = text.slice(0, COMPACTED_TOOL_PREVIEW_CHARS)
  }
  return JSON.stringify(summary)
}

/**
 * Keep the newest tool evidence verbatim while replacing older large results
 * with protocol-safe structured summaries. This bounds long tool loops before
 * a full conversation compaction is necessary.
 */
export function applyRollingToolResultBudget(messages = [], {
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  activeContextTokens,
  maxTokens,
} = {}) {
  const source = Array.isArray(messages) ? messages : []
  const threshold = getAutoCompactionThreshold(contextWindow, activeContextTokens)
  const configuredMax = Number(maxTokens)
  const budgetTokens = Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.floor(configuredMax)
    : Math.max(
        MIN_ROLLING_TOOL_RESULT_TOKENS,
        Math.min(MAX_ROLLING_TOOL_RESULT_TOKENS, Math.floor(threshold * TOOL_RESULT_CONTEXT_RATIO)),
      )
  const output = source.slice()
  let remainingTokens = budgetTokens
  let retainedFullCount = 0
  let compactedCount = 0

  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index]
    if (message?.role !== 'tool') continue
    const originalTokens = 6 + textTokens(message.content)
    if (originalTokens <= remainingTokens || retainedFullCount === 0) {
      remainingTokens = Math.max(0, remainingTokens - originalTokens)
      retainedFullCount += 1
      continue
    }

    const compactedContent = compactToolResultContent(message.content)
    const compactedTokens = 6 + textTokens(compactedContent)
    if (compactedTokens >= originalTokens) {
      remainingTokens = Math.max(0, remainingTokens - originalTokens)
      continue
    }
    output[index] = { ...message, content: compactedContent }
    remainingTokens = Math.max(0, remainingTokens - compactedTokens)
    compactedCount += 1
  }

  return {
    messages: compactedCount > 0 ? output : source,
    compactedCount,
    retainedFullCount,
    budgetTokens,
  }
}

export function estimateContextTokens(messages = [], tools = []) {
  const messageTokens = (Array.isArray(messages) ? messages : [])
    .reduce((total, message) => total + 6 + contextValueTokens(message), 0)
  return messageTokens + contextValueTokens(Array.isArray(tools) ? tools : []) + 16
}

export function getAutoCompactionThreshold(
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  activeContextTokens = process.env.MODEL_ACTIVE_CONTEXT_TOKENS,
) {
  const window = Number(contextWindow)
  // ★ 原来 `>= 4096` 的硬下限,会把「真的只有 2k/4k 窗口的小模型」
  // 悄悄换成 DEFAULT_CONTEXT_WINDOW —— 阈值算出来比实际窗口大好几倍,
  // 于是压缩永远不触发,每个请求都必然溢出。
  // 现在只要是正数就认(下限统一在 endpointProfile.MIN_CONTEXT_WINDOW 兜底)。
  const safeWindow = Number.isFinite(window) && window > 0 ? window : DEFAULT_CONTEXT_WINDOW
  const configuredActiveLimit = Number(activeContextTokens)
  const activeLimit = Number.isFinite(configuredActiveLimit) && configuredActiveLimit > 0
    ? Math.floor(configuredActiveLimit)
    : DEFAULT_ACTIVE_CONTEXT_TOKENS
  return Math.min(Math.floor(safeWindow * 0.8), activeLimit)
}

export function getCompactionSummaryTokenLimit(
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  activeContextTokens,
) {
  const threshold = getAutoCompactionThreshold(contextWindow, activeContextTokens)
  return Math.max(
    MIN_COMPACTION_SUMMARY_TOKENS,
    Math.min(MAX_COMPACTION_SUMMARY_TOKENS, Math.floor(threshold * COMPACTION_SUMMARY_CONTEXT_RATIO)),
  )
}
