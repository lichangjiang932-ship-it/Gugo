import { shouldInheritExecutionIntent } from '../chatToolSelection.js'
import { STATUS_INQUIRY_PROMPT } from '../../utils/executionIntent.js'
import {
  extractMutationTargets,
  isLocalMutationCall,
  isMutationExecutionCall,
  isSuccessfulToolResult,
  looksLikeDeletionCommand,
  staticDeletionTargets,
} from '../toolLoopHeuristics.js'

const PRIOR_TURN_OUTCOME_MARKER = '[PRIOR TURN OUTCOME]'

export { STATUS_INQUIRY_PROMPT }
const TERSE_COMPLETION_CLAIM = String.raw`(?:(?:yes[\s,，:：-]*)?(?:done|complete|completed|finished)|yes[\s,，:：-]+it\s+(?:is|was))`
const COMPLETION_SUBJECT = String.raw`(?:everything|it|(?:the\s+)?(?:requested\s+)?(?:task|work|changes?|deliverables?|files?))`
const COMPLETION_OBJECT = String.raw`(?:it|this|everything|(?:the\s+)?(?:requested\s+)?(?:task|work|changes?|deliverables?|files?))`
const EXPLICIT_COMPLETION_CLAIM = String.raw`(?:没有(?:任何)?(?:问题|错误|异常)|(?:已经|已|任务)(?:顺利|成功)?完成|完成了|all\s+(?:good|done|complete|completed|finished)|completed\s+successfully|it['’]s\s+(?:complete|completed|done|finished)|this\s+is\s+(?:complete|completed|done|finished)|(?:the\s+)?(?:task|work)\s+(?:complete|completed|done|finished)|${COMPLETION_SUBJECT}\s+(?:(?:is|was|are|were)\s+(?:now\s+)?(?:complete|completed|done|finished)|(?:has|have)\s+(?:finished|been\s+(?:complete|completed|done|finished)))|we(?:['’]re|\s+are)\s+(?:all\s+)?(?:complete|completed|done|finished)|(?:i|we)(?:(?:\s+have|['’]ve))?\s+(?:completed|finished)\s+${COMPLETION_OBJECT}(?:\s+successfully)?)`
const DECLARATIVE_COMPLETION_BOUNDARY = String.raw`(?=\s*(?:[.!！。](?:\s|$)|$))`
const NON_COMPLETION_CONTEXT = String.raw`(?:(?:actually|however|but)\s*[,，:]?\s*)?(?:if|unless|not\b|i\s+(?:(?:do\s+not|don['’]t)\s+think|doubt|question|(?:am|['’]m)\s+(?:not\s+)?(?:sure|certain))\b|it\s+(?:does|did)\s+not\s+(?:look|seem|appear)\b|(?:none|some)\s+of\b|not\s+all\b|only\s+(?:one|some|part\s+of)\b|(?:the\s+)?(?:logs?|report|model|assistant)\s+(?:claim(?:s|ed)?|(?:say|says|said)|report(?:s|ed)?|state(?:s|d)?)\b|according\s+to\b)`
export const FALSE_SUCCESS_STATUS = new RegExp(
  String.raw`^(?!\s*${NON_COMPLETION_CONTEXT})(?:\s*${TERSE_COMPLETION_CLAIM}${DECLARATIVE_COMPLETION_BOUNDARY}|[\s\S]*?${EXPLICIT_COMPLETION_CLAIM}${DECLARATIVE_COMPLETION_BOUNDARY})`,
  'i',
)
export const INCOMPLETE_STATUS = /(?:尚未完成|仍未完成|还没(?:有)?完成|没有完成|未完成|任务尚未|incomplete|not\s+(?:yet\s+)?complete)/i
const INTERNAL_TERMINAL_FAILURE_PATTERNS = [
  /Model call failed\s*:/i,
  /This reply could not be completed/i,
  /The requested (?:file|artifact|mutation).*?(?:was not|could not|failed)/i,
  /ARTIFACT_NOT_CREATED/i,
  /(?:tool|artifact|model)[_-](?:execution|write|call)?[_-]?failed/i,
  /(?:^|\n)\s*(?:Error|Exception|TypeError|RangeError|AbortError)\s*:/i,
  /(?:任务中断|模型预算已用尽)\s*[:：][^\n]*[A-Za-z]/,
  /任务未完全完成[^\n]*(?:保留|保存)/,
  /(?:已保留|保存当前)[^\n]*(?:残缺|文件|进展|工具结果)/,
  /(?:上面的工具结果|当前工具结果)[^\n]*(?:部分进展|已包含)/,
]

export function latestPriorTurnOutcome(messages = []) {
  const history = Array.isArray(messages) ? messages : []
  let currentUserIndex = -1
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'user') {
      currentUserIndex = index
      break
    }
  }
  if (currentUserIndex < 0) return null

  let previousUserIndex = -1
  for (let index = currentUserIndex - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'user') {
      previousUserIndex = index
      break
    }
  }
  const turnStart = previousUserIndex + 1
  for (let index = currentUserIndex - 1; index >= turnStart; index -= 1) {
    const message = history[index]
    const content = String(message?.content || '')
    if (message?.role !== 'system' || !content.startsWith(PRIOR_TURN_OUTCOME_MARKER)) continue
    const jsonLine = content.split(/\r?\n/, 3)[1]
    try {
      const parsed = JSON.parse(jsonLine || '{}')
      if (['failed', 'interrupted'].includes(String(parsed?.state || ''))) return parsed
    } catch { /* trusted marker with malformed legacy payload: ignore */ }
  }
  return null
}

export function restoreNamedToolSpecs(currentSpecs = [], fallbackSpecs = [], names = []) {
  const wanted = new Set(Array.from(names || [], (name) => String(name || '').trim()).filter(Boolean))
  const restored = new Map()
  for (const spec of Array.isArray(currentSpecs) ? currentSpecs : []) {
    const name = String(spec?.function?.name || '').trim()
    if (name) restored.set(name, spec)
  }
  for (const spec of Array.isArray(fallbackSpecs) ? fallbackSpecs : []) {
    const name = String(spec?.function?.name || '').trim()
    if (wanted.has(name) && !restored.has(name)) restored.set(name, spec)
  }
  return [...restored.values()]
}

export function isForcedToolChoiceCompatibilityError(error) {
  const status = Number(error?.status ?? error?.statusCode)
  if (Number.isFinite(status) && ![400, 422].includes(status)) return false

  const parameter = String(error?.param || error?.parameter || error?.error?.param || '')
  const code = String(error?.code || error?.type || error?.error?.code || error?.error?.type || '')
  const message = [
    error?.message,
    error?.reason,
    error?.responseBody,
    parameter,
    code,
  ].filter(Boolean).join(' ')
  const namesToolChoice = /tool[_ -]?choice|function[_ -]?(?:choice|call)|specific[_ -]?function/i.test(message)
    || /tool[_ -]?choice/i.test(parameter)
  const rejectsForcedChoice = /(?:not|isn't|is not)\s+supported|unsupported|invalid|unknown|unrecognized|not allowed|only\s+(?:auto|none)|must\s+be\s+(?:auto|none)|extra inputs?|不支持|无效|非法|未知|不允许|仅支持|只能/i.test(message)
  return namesToolChoice && rejectsForcedChoice
}

export function sanitizeIncompleteTerminalText(value, fallback = '') {
  const text = String(value || '').trim()
  if (!text) return fallback
  return INTERNAL_TERMINAL_FAILURE_PATTERNS.some((pattern) => pattern.test(text))
    ? fallback
    : text
}

export function sourceHandoffViolation(text) {
  const value = String(text || '').trim()
  if (!value) return null

  if (/```[^\n]*\n[\s\S]*?```/.test(value)) return 'fenced_code'
  if (/<(?:!doctype\s+html|html\b|head\b|body\b|script\b|style\b)/i.test(value)) return 'document_source'

  const manualHandoff = [
    /\b(?:copy|paste)\b[\s\S]{0,80}\b(?:this|the following|code|source|snippet)\b/i,
    /\b(?:save|create|rename|convert|run|execute|open|edit|modify)\b[\s\S]{0,60}\b(?:this|the following|the code|the script|the command|the file|the document|the image)\b/i,
    /(?:请|你需要|需要你|你可以|自行|手动)[\s\S]{0,60}(?:运行|执行|保存|复制|粘贴|创建|新建|打开|编辑|修改|改名|转换)/i,
    /(?:复制|粘贴)[\s\S]{0,60}(?:代码|源码|脚本)/i,
  ]
  if (manualHandoff.some((pattern) => pattern.test(value))) return 'manual_handoff'

  const sourceLikeLines = value.split(/\r?\n/).filter((line) => (
    /^\s*(?:import\s+.+|export\s+.+|(?:const|let|var)\s+[\w$]+\s*=|(?:async\s+)?function\s+\w+\s*\(|class\s+\w+|def\s+\w+\s*\(|#include\s*[<"]|public\s+static\s+|<\/?[a-z][^>]*>|[.#][\w-]+\s*\{)/i.test(line)
  )).length
  return value.length >= 600 && sourceLikeLines >= 4 ? 'source_like' : null
}

export function normalizeArtifactIdList(ids) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))]
}

export function sameArtifactIdList(left, right) {
  const a = normalizeArtifactIdList(left)
  const b = normalizeArtifactIdList(right)
  return a.length === b.length && a.every((id) => b.includes(id))
}

export function synchronizeCheckpointToolCallMessages(messages, calls) {
  const argumentsById = new Map((Array.isArray(calls) ? calls : [])
    .map((call) => [String(call?.id || '').trim(), String(call?.argumentsText || '{}')])
    .filter(([id]) => id))
  if (argumentsById.size === 0) return messages
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) return message
    let changed = false
    const toolCalls = message.tool_calls.map((toolCall) => {
      const argumentsText = argumentsById.get(String(toolCall?.id || '').trim())
      if (argumentsText == null || toolCall?.function?.arguments === argumentsText) return toolCall
      changed = true
      return {
        ...toolCall,
        function: { ...toolCall.function, arguments: argumentsText },
      }
    })
    return changed ? { ...message, tool_calls: toolCalls } : message
  })
}

function parseHistoricalToolObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function normalizeRepeatedUserRequest(value) {
  const text = typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value
          .filter((part) => ['text', 'input_text'].includes(part?.type) && typeof part?.text === 'string')
          .map((part) => part.text)
          .join('\n')
      : ''
  return text.trim().replace(/\s+/g, ' ')
}

export function isExplicitLocalMutationRetryRequest(value) {
  const text = normalizeRepeatedUserRequest(value)
  return /^(?:(?:继续|接着)(?:$|[\s,，:：。.!！?？]|刚才|之前|上次|原来|未完成|修改|处理|修复|完成|执行|做|这个|那个|上述)|continue(?:$|\s+(?:the|that|this|previous|unfinished|same|work|task|change|edit|fix))|go\s+ahead|proceed)(?:[\s\S]{0,80})$/i.test(text)
}

export function isLocalMutationContinuationRequest(value, previousValue = '', { intentMode = 'auto' } = {}) {
  const text = normalizeRepeatedUserRequest(value)
  const previous = normalizeRepeatedUserRequest(previousValue)
  return isExplicitLocalMutationRetryRequest(text)
    || shouldInheritExecutionIntent(text, previous, { intentMode })
}

export function recoverPriorLocalMutationTargets(messages, currentUserMessage, { intentMode = 'auto' } = {}) {
  const history = Array.isArray(messages) ? messages : []
  const currentUserIndex = history.lastIndexOf(currentUserMessage)
  if (currentUserIndex <= 0) return { mutationTargets: [], deletionTargets: [] }
  let priorUserIndex = -1
  for (let index = currentUserIndex - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'user') {
      priorUserIndex = index
      break
    }
  }
  const currentRequest = normalizeRepeatedUserRequest(currentUserMessage?.content)
  const previousRequest = normalizeRepeatedUserRequest(history[priorUserIndex]?.content)
  if (priorUserIndex < 0
    || !currentRequest
    || (currentRequest !== previousRequest
      && !isLocalMutationContinuationRequest(currentRequest, previousRequest, { intentMode }))) {
    return { mutationTargets: [], deletionTargets: [] }
  }

  const callsById = new Map()
  const resultsById = new Map()
  const duplicateCallIds = new Set()
  const duplicateResultIds = new Set()
  for (const message of history.slice(priorUserIndex + 1, currentUserIndex)) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const rawCall of message.tool_calls) {
        const id = String(rawCall?.id || '').trim()
        const name = String(rawCall?.function?.name || rawCall?.name || '').trim()
        const args = parseHistoricalToolObject(rawCall?.function?.arguments ?? rawCall?.arguments ?? rawCall?.args)
        if (!id || !name || !args) continue
        if (callsById.has(id)) duplicateCallIds.add(id)
        else callsById.set(id, { id, name, args })
      }
    } else if (message?.role === 'tool') {
      const id = String(message?.tool_call_id || '').trim()
      const result = parseHistoricalToolObject(message.content)
      if (!id || !result) continue
      if (resultsById.has(id)) duplicateResultIds.add(id)
      else resultsById.set(id, { name: String(message?.name || '').trim(), result })
    }
  }

  const mutationTargets = new Set()
  const deletionTargets = new Set()
  for (const [id, call] of callsById) {
    if (duplicateCallIds.has(id)
      || duplicateResultIds.has(id)
      || !isMutationExecutionCall(call)
      || !isLocalMutationCall(call)) continue
    const paired = resultsById.get(id)
    if (!paired
      || paired.name !== call.name
      || paired.result?.ok !== true
      || !isSuccessfulToolResult(paired.result)) continue
    const deleted = looksLikeDeletionCommand(call?.args?.command)
      ? staticDeletionTargets(call, paired.result)
      : null
    if (deleted?.size) {
      for (const target of deleted) deletionTargets.add(target)
    } else {
      for (const target of extractMutationTargets(call, paired.result)) mutationTargets.add(target)
    }
  }
  return { mutationTargets: [...mutationTargets], deletionTargets: [...deletionTargets] }
}

export function normalizeCompactionRecovery(value) {
  const archiveId = String(value?.archiveId || '').trim()
  if (!archiveId) return null
  const firstKeptMessageId = String(value?.firstKeptMessageId || '').trim()
  const lastCompactedMessageId = String(value?.lastCompactedMessageId || '').trim()
  const compactCheckpointSource = value?.compactCheckpointSource
  return {
    archiveId,
    ...(firstKeptMessageId ? { firstKeptMessageId } : {}),
    ...(lastCompactedMessageId ? { lastCompactedMessageId } : {}),
    ...(compactCheckpointSource && typeof compactCheckpointSource === 'object'
      ? { compactCheckpointSource }
      : {}),
  }
}

export function mergeCompactionRecovery(previous, next) {
  const normalizedNext = normalizeCompactionRecovery(next)
  if (!normalizedNext) return normalizeCompactionRecovery(previous)
  return {
    ...normalizeCompactionRecovery(previous),
    ...normalizedNext,
    archiveId: normalizedNext.archiveId,
  }
}
