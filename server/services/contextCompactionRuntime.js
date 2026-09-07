import { logWarn } from '../utils/logger.js'
import { normalizeTurnLocale } from '../../shared/turnLocale.js'
import { resolveRuntimeContextCompactionStrategy } from './contextCompactionStrategy.js'
import { compactForModel } from './contextCompactionExecution.js'
import { toolPairingBalanced } from './compactionService.js'
import { assertContextRecoveryActive, canonicalContextMessages } from './contextCompactionState.js'
import {
  DEFAULT_ACTIVE_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  textTokens,
} from './contextCompactionMetrics.js'

export {
  addSemanticCompactionSummary,
  compactForModel,
} from './contextCompactionExecution.js'
export {
  DEFAULT_ACTIVE_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  MAX_AUTO_COMPACTION_TOKENS,
  MAX_COMPACTION_SUMMARY_CHARS,
  MAX_COMPACTION_SUMMARY_TOKENS,
  applyRollingToolResultBudget,
  boundCompactionSummary,
  estimateContextTokens,
  getAutoCompactionThreshold,
  getCompactionSummaryTokenLimit,
} from './contextCompactionMetrics.js'

// Compatibility-only lossy view helper; never use it for automatic recovery or checkpoints.
export function trimOldestContext(messages = [], fraction = 0.1) {
  const system = messages.filter((message) => message?.role === 'system')
  const nonSystem = messages.filter((message) => message?.role !== 'system')
  if (nonSystem.length <= 1) return messages

  // The most recent user message is the active objective for this turn. The
  // final overflow fallback may discard stale goals, but must retain the
  // request that the current tool work is actually trying to satisfy.
  const protectedIndexes = new Set()
  let latestUserIndex = -1
  for (let index = nonSystem.length - 1; index >= 0; index -= 1) {
    if (nonSystem[index]?.role === 'user') {
      latestUserIndex = index
      break
    }
  }
  if (latestUserIndex >= 0) protectedIndexes.add(latestUserIndex)

  // Keep the latest tool-call message and all of its matching results as one
  // unit.  Cutting through this boundary either breaks the provider protocol
  // or removes the most recent verified working state.
  let latestToolCallIndex = -1
  for (let index = nonSystem.length - 1; index >= 0; index -= 1) {
    const message = nonSystem[index]
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      latestToolCallIndex = index
      break
    }
  }
  if (latestToolCallIndex >= 0) {
    protectedIndexes.add(latestToolCallIndex)
    const latestToolCallIds = new Set(
      nonSystem[latestToolCallIndex].tool_calls.map((call) => call?.id).filter(Boolean),
    )
    for (let index = latestToolCallIndex + 1; index < nonSystem.length; index += 1) {
      const message = nonSystem[index]
      if (message?.role === 'tool' && latestToolCallIds.has(message.tool_call_id)) {
        protectedIndexes.add(index)
      }
    }
  }

  const requestedRemoveCount = Math.max(1, Math.ceil(nonSystem.length * fraction))
  const removableIndexes = nonSystem
    .map((_, index) => index)
    .filter((index) => !protectedIndexes.has(index))
    .slice(0, requestedRemoveCount)
  if (removableIndexes.length === 0) return messages
  const removedIndexes = new Set(removableIndexes)
  const kept = nonSystem.filter((_, index) => !removedIndexes.has(index))
  const seen = new Set()
  const repaired = []
  for (const message of kept) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) if (call?.id) seen.add(call.id)
      repaired.push(message)
    } else if (message?.role === 'tool') {
      if (message.tool_call_id && seen.has(message.tool_call_id)) repaired.push(message)
    } else {
      repaired.push(message)
    }
  }
  const trimmed = [...system, {
    role: 'system',
    content: `Context overflow recovery removed the oldest ${removedIndexes.size} non-system message(s). The latest user objective and latest tool state were preserved.`,
  }, ...repaired]
  return trimmed
}

function dynamicTextTokens(messages = []) {
  return (Array.isArray(messages) ? messages : []).reduce((total, message) => {
    if (!message || message.role === 'system') return total
    let tokens = 6
    if (typeof message.content === 'string') {
      tokens += textTokens(message.content)
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === 'string') tokens += textTokens(part)
        else if (part?.type === 'text') tokens += textTokens(part.text)
      }
    }
    if (Array.isArray(message.tool_calls)) tokens += textTokens(message.tool_calls)
    return total + tokens
  }, 0)
}

function assertPreparedDynamicContextFits(prepared, contextWindow, activeContextTokens) {
  const window = Number(contextWindow)
  const hardWindow = Number.isFinite(window) && window > 0 ? Math.floor(window) : DEFAULT_CONTEXT_WINDOW
  const configuredActiveLimit = Number(activeContextTokens)
  const activeLimit = Number.isFinite(configuredActiveLimit) && configuredActiveLimit > 0
    ? Math.floor(configuredActiveLimit)
    : DEFAULT_ACTIVE_CONTEXT_TOKENS
  // The 80% waterline is intentionally soft: it starts compaction but must not
  // reject a request merely because fixed system/tool schemas exceed it. Only
  // an unshrinkable dynamic text surface beyond the real active window is a
  // reliable preflight failure. Multimodal image bytes are deliberately not
  // priced as base64 text; providers tokenize those as images.
  const hardDynamicLimit = Math.min(hardWindow, activeLimit)
  const actualTokens = dynamicTextTokens(prepared?.messages)
  if (actualTokens <= hardDynamicLimit) return
  const error = new Error(
    `上下文压缩未能收敛：最终可变文本约 ${actualTokens} token，当前硬预算为 ${hardDynamicLimit} token。`
    + '请缩短本轮超长文本，或改用上下文窗口更大的模型。',
  )
  error.code = 'CONTEXT_COMPACTION_DID_NOT_CONVERGE'
  error.estimatedTokens = actualTokens
  error.threshold = hardDynamicLimit
  if (prepared?.error) error.cause = new Error(prepared.error)
  throw error
}

function unrecoverableContextError(cause, prepared, contextWindow, locale) {
  const message = normalizeTurnLocale(locale) === 'en'
    ? `Context recovery could not fit the current task within the configured ${contextWindow}-token window without discarding instructions or tool history. `
      + "Check that the provider's context-window configuration matches the model's supported limit, then shorten this turn's input or use a model with a larger context window."
    : `上下文恢复未能在保留指令和工具历史的前提下适配当前 ${contextWindow} token 的上下文窗口。`
      + '请确认服务提供商的上下文窗口配置与模型实际支持范围一致，并缩短本轮输入，或改用上下文窗口更大的模型。'
  const error = new Error(message, { cause })
  error.code = 'CONTEXT_UNRECOVERABLE'
  if (prepared.errorCode) error.compactionErrorCode = prepared.errorCode
  if (prepared.error) error.compactionError = prepared.error
  return error
}

export async function callModelWithContextRecovery({
  messages = [],
  ephemeralMessages = [],
  tools = [],
  callModel,
  isContextLengthError,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  locale = 'zh',
  semanticSummary = 'auto',
  callSummaryModel = callModel,
  onCompactionProgress,
  recoveryCheckpoint,
  signal,
  userId = null,
  sessionId = null,
  consumeBudget,
  activeContextTokens,
  compactionStrategyResolver = resolveRuntimeContextCompactionStrategy,
  compactionArchivePort,
  ...modelOptions
} = {}) {
  if (typeof callModel !== 'function') throw new Error('callModel is required')
  assertContextRecoveryActive(signal)
  // Provider-only media and rolling reductions never become checkpoint history.
  const ephemeralSuffix = Array.isArray(ephemeralMessages) ? [...ephemeralMessages] : []
  const compactionOptions = {
    tools, contextWindow, semanticSummary, callModel: callSummaryModel, signal, userId, sessionId,
    consumeBudget, activeContextTokens, compactionStrategyResolver, compactionArchivePort,
    onCompactionProgress,
  }
  const resumeAttempt = recoveryCheckpoint?.begin({ messages, tools, contextWindow, activeContextTokens, semanticSummary }) || 0
  let prepared
  let sourceMessages = messages
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const restored = recoveryCheckpoint?.restorePrepared(attempt, sourceMessages, { contextWindow, activeContextTokens })
    if (attempt < resumeAttempt) {
      if (!restored) throw Object.assign(new Error('Missing prepared compaction state during recovery'), { code: 'MODEL_REQUEST_CONTEXT_DRIFT', retryable: false })
      sourceMessages = canonicalContextMessages(restored)
      continue
    }
    recoveryCheckpoint?.enterAttempt(attempt)
    prepared = restored || await compactForModel({
        ...compactionOptions,
        ...recoveryCheckpoint?.preparationOptions?.(),
        messages: sourceMessages,
        force: attempt > 0,
        priorArchive: recoveryCheckpoint?.priorArchive(attempt),
        ...(attempt === 2 ? { maxRetainedMessages: 1 } : {}),
      })
    if (!restored) await recoveryCheckpoint?.savePrepared(attempt, prepared)
    if (attempt > 0) {
      if (!prepared.compacted && prepared.error) {
        logWarn('compaction.refused', new Error(prepared.error), {
          userId, sessionId, estimatedTokens: prepared.estimatedTokens, threshold: prepared.threshold,
        })
        if (!toolPairingBalanced(canonicalContextMessages(prepared)).ok) {
          throw unrecoverableContextError(lastError, prepared, contextWindow, locale)
        }
      }
    }
    assertContextRecoveryActive(signal)
    const requestMessages = ephemeralSuffix.length
      ? [...prepared.messages, ...ephemeralSuffix] : prepared.messages
    assertPreparedDynamicContextFits({ messages: requestMessages }, contextWindow, activeContextTokens)
    try {
      const response = await callModel({ ...modelOptions, messages: requestMessages, tools, signal })
      assertContextRecoveryActive(signal)
      return {
        response,
        messages: canonicalContextMessages(prepared),
        recovery: {
          ...prepared,
          ...(attempt > 0 ? { forced: true } : {}),
          ...(attempt === 2 ? { recoveryStage: 'aggressive_compaction' } : {}),
        },
      }
    } catch (error) {
      if (signal?.aborted) throw error
      if (!isContextLengthError?.(error)) throw error
      lastError = error
      sourceMessages = canonicalContextMessages(prepared)
    }
  }
  throw unrecoverableContextError(lastError, prepared, contextWindow, locale)
}
