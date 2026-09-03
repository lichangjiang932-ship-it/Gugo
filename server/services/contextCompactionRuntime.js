import { logWarn } from '../utils/logger.js'
import { resolveRuntimeContextCompactionStrategy } from './contextCompactionStrategy.js'
import { compactForModel } from './contextCompactionExecution.js'
import {
  DEFAULT_ACTIVE_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  getAutoCompactionThreshold,
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

export async function callModelWithContextRecovery({
  messages = [],
  ephemeralMessages = [],
  tools = [],
  callModel,
  isContextLengthError,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  semanticSummary = false,
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
  // Ephemeral media is a provider-call suffix, never conversation history.
  // Keeping it outside compactForModel prevents an earlier item in the same
  // screenshot batch from being summarized or written to the canonical
  // archive during a convergence pass. The stable local copy is deliberately
  // reused by every context-length retry for this one logical model call.
  const ephemeralSuffix = Array.isArray(ephemeralMessages) ? [...ephemeralMessages] : []
  let prepared = await compactForModel({
    messages,
    tools,
    contextWindow,
    semanticSummary,
    callModel,
    signal,
    userId,
    sessionId,
    consumeBudget,
    activeContextTokens,
    compactionStrategyResolver,
    compactionArchivePort,
  })
  const invoke = () => {
    const requestMessages = ephemeralSuffix.length > 0
      ? [...prepared.messages, ...ephemeralSuffix]
      : prepared.messages
    assertPreparedDynamicContextFits(
      { ...prepared, messages: requestMessages },
      contextWindow,
      activeContextTokens,
    )
    return callModel({ ...modelOptions, messages: requestMessages, tools, signal })
  }
  try {
    return { response: await invoke(), messages: prepared.messages, recovery: prepared }
  } catch (error) {
    if (!isContextLengthError?.(error)) throw error
  }

  prepared = await compactForModel({
    messages: prepared.messages,
    tools,
    contextWindow,
    force: true,
    semanticSummary,
    callModel,
    signal,
    userId,
    sessionId,
    consumeBudget,
    activeContextTokens,
    compactionStrategyResolver,
    compactionArchivePort,
  })
  // ★ compactForModel 拒绝压缩时会带一个 error 说明原因(工具调用链断了之类),
  // 而原来**每个调用方都把它丢掉** —— 于是「压缩没生效」和「压缩成功了」
  // 走一模一样的后续路径:原样再发一次,再次以同样的方式失败,
  // 日志里一个字都没有。至少要让这个原因跟着最终错误一起冒上去。
  if (!prepared.compacted && prepared.error) {
    logWarn('compaction.refused', new Error(prepared.error), {
      userId,
      sessionId,
      estimatedTokens: prepared.estimatedTokens,
      threshold: prepared.threshold,
    })
  }
  try {
    return { response: await invoke(), messages: prepared.messages, recovery: { ...prepared, forced: true } }
  } catch (error) {
    if (!isContextLengthError?.(error)) throw error
  }

  const runtimeStrategy = prepared.runtimeStrategy
  prepared = {
    messages: trimOldestContext(prepared.messages, 0.1),
    compacted: true,
    forced: true,
    trimmed: true,
    threshold: getAutoCompactionThreshold(contextWindow, activeContextTokens),
    ...(runtimeStrategy ? { runtimeStrategy } : {}),
  }
  try {
    return { response: await invoke(), messages: prepared.messages, recovery: prepared }
  } catch (error) {
    // ★ 第三级也失败 = 这个上下文在当前窗口下无论如何都塞不下。
    // 原来这里没有 catch,抛出去的是上游那句看不懂的原文。
    // 给一句能操作的话:多半是窗口配小了、或者工具 schema 本身就超窗。
    if (isContextLengthError?.(error)) {
      const hint = new Error(
        `上下文经过三级压缩后仍然超出模型窗口（当前按 ${contextWindow} token 计算）。`
        + `如果这个模型的实际窗口更大，请在 provider 设置里把「上下文窗口」调大；`
        + `如果窗口确实很小，请减少启用的工具或换一个窗口更大的模型。`,
      )
      hint.cause = error
      hint.code = 'CONTEXT_UNRECOVERABLE'
      throw hint
    }
    throw error
  }
}
