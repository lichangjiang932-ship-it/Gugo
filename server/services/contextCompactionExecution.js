import {
  MAX_OUTBOUND_MESSAGES,
  buildCompaction,
  createCompactionArchive,
  getCompactionArchive,
  validateCompactCheckpointSource,
} from './compactionService.js'
import { addSemanticCompactionSummary } from './contextSemanticSummaryExecution.js'
import { resolveSemanticSummaryPolicy } from './contextSemanticSummaryPolicy.js'
import { storedMessageSourceId } from './turnMessageContext.js'
import { resolveRuntimeContextCompactionStrategy } from './contextCompactionStrategy.js'
import { assertContextRecoveryActive, withCanonicalContext } from './contextCompactionState.js'
import { fitCompactionResult } from './contextCompactionFit.js'
import {
  DEFAULT_ACTIVE_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  MAX_COMPACTION_PASSES,
  applyRollingToolResultBudget,
  estimateContextTokens,
  getAutoCompactionThreshold,
  getCompactionSummaryTokenLimit,
  textTokens,
} from './contextCompactionMetrics.js'

function chooseTailSize(messages, threshold) {
  const nonSystem = messages.filter((message) => message?.role !== 'system')
  if (nonSystem.length <= 1) return 1
  // ★ 原来是 Math.max(1024, ...) —— 一个 1024 token 的保留下限,
  // 在 2k/4k 窗口下光这个尾巴就能把预算吃光(还没算 system 块和 tools)。
  // 改成跟着阈值走,小窗口时下限也跟着变小。
  const target = Math.max(Math.min(1024, Math.floor(threshold * 0.5)), Math.floor(threshold * 0.35))
  let tokens = 0
  let count = 0
  for (let index = nonSystem.length - 1; index >= 0 && count < 40; index -= 1) {
    const next = 6 + textTokens(nonSystem[index])
    if (count > 0 && tokens + next > target) break
    tokens += next
    count += 1
  }
  return Math.max(1, Math.min(count, nonSystem.length - 1))
}

function contextRoleCounts(messages = []) {
  const counts = { system: 0, user: 0, assistant: 0, tool: 0, other: 0 }
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = typeof message?.role === 'string' ? message.role : ''
    if (Object.hasOwn(counts, role)) counts[role] += 1
    else counts.other += 1
  }
  return Object.freeze(counts)
}

export { addSemanticCompactionSummary } from './contextSemanticSummaryExecution.js'

async function archiveCompaction(result, { userId, sessionId, compactionArchivePort, priorArchive }) {
  if (!result?.compacted || !userId || !sessionId) return null
  try {
    if (priorArchive?.id && priorArchive.source?.sha256 === result.summaryMessage?.meta?.compactCheckpointSource?.sha256) {
      const existing = await getCompactionArchive({ userId, id: priorArchive.id }, { compactionArchivePort })
      if (existing?.sessionId === sessionId
        && validateCompactCheckpointSource(priorArchive.source, existing.archivedMessages).ok) return existing
    }
    return await createCompactionArchive({
      userId,
      sessionId,
      archivedMessages: result.archivedMessages,
      summaryText: result.summaryText,
    }, { compactionArchivePort })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return null
  }
}

function compactionMessageBoundary(result) {
  const archivedIds = (Array.isArray(result?.archivedMessages) ? result.archivedMessages : [])
    .map(storedMessageSourceId)
    .filter(Boolean)
  const retainedIds = (Array.isArray(result?.outboundMessages) ? result.outboundMessages : [])
    .filter((message) => message !== result?.summaryMessage && message?.role !== 'system')
    .map(storedMessageSourceId)
    .filter(Boolean)
  return {
    ...(retainedIds[0] ? { firstKeptMessageId: retainedIds[0] } : {}),
    ...(archivedIds.at(-1) ? { lastCompactedMessageId: archivedIds.at(-1) } : {}),
  }
}


function disabledSemanticTelemetry(reason = 'disabled_for_automatic_compaction') {
  return {
    attempted: false,
    used: false,
    modelCalls: 0,
    batchCount: 0,
    truncatedMessageCount: 0,
    outputTruncatedCount: 0,
    fallbackReason: reason,
  }
}

async function runCompactionPasses({
  preparedMessages,
  initialKeepMessages,
  semanticSummary,
  callModel,
  contextWindow,
  signal,
  userId,
  consumeBudget,
  tools,
  threshold,
  summaryTokenLimit,
  onCompactionProgress,
}) {
  const policy = resolveSemanticSummaryPolicy(semanticSummary)
  let result = null
  let semanticTelemetry = disabledSemanticTelemetry()
  let fit = null
  let passes = 0
  let buildError = null
  for (let pass = 0; pass < MAX_COMPACTION_PASSES; pass += 1) {
    assertContextRecoveryActive(signal)
    passes = pass + 1
    const keepMessages = pass === 0 ? initialKeepMessages : 1
    let candidate = buildCompaction({ messages: preparedMessages, keepMessages, force: true })
    if (!candidate.ok || !candidate.compacted || candidate.replacedMessageCount === 0) {
      buildError = candidate.error || 'compaction did not replace any messages'
      break
    }
    const mechanicalFit = fitCompactionResult(candidate, { tools, threshold, summaryTokenLimit })
    const needsSemantic = mechanicalFit.summaryTruncated || candidate.archivedMessages.some((message) => message?.meta?.semanticSummary === true)
    if (pass === 0 && policy.mode !== 'off' && (policy.mode === 'always' || needsSemantic)) {
      const semantic = await addSemanticCompactionSummary({
        result: candidate,
        callModel,
        contextWindow,
        signal,
        userId,
        consumeBudget,
        compactUserDirections: needsSemantic,
        policy,
        summaryTokenLimit: Math.max(64, Math.min(summaryTokenLimit, textTokens(mechanicalFit.result.summaryText))),
        onProgress: onCompactionProgress,
      })
      candidate = semantic.result
      semanticTelemetry = semantic.telemetry
    } else if (pass === 0) {
      semanticTelemetry = disabledSemanticTelemetry(policy.mode === 'off' ? 'disabled_for_automatic_compaction' : 'not_needed')
    } else if (pass > 0 && semanticTelemetry.used) {
      semanticTelemetry = {
        ...semanticTelemetry,
        used: false,
        fallbackReason: 'semantic_summary_replaced_for_convergence',
      }
    }
    fit = fitCompactionResult(candidate, { tools, threshold, summaryTokenLimit })
    result = fit.result
    if (fit.ok) break
  }
  return { result, semanticTelemetry, fit, passes, buildError }
}

async function finalizeCompactionResult(convergence, {
  sourceMessages,
  tools,
  contextWindow,
  activeContextTokens,
  threshold,
  estimatedTokens,
  userId,
  sessionId,
  compactionArchivePort,
  signal,
  strategy,
  priorArchive,
}) {
  let { result } = convergence
  const { fit, passes, semanticTelemetry } = convergence
  const messageBoundary = compactionMessageBoundary(result)
  const archive = await archiveCompaction(result, {
    userId,
    sessionId,
    compactionArchivePort,
    priorArchive,
  })
  assertContextRecoveryActive(signal)
  if (archive) {
    const summaryIndex = result.outboundMessages.indexOf(result.summaryMessage)
    if (summaryIndex >= 0) {
      const outbound = [...result.outboundMessages]
      outbound[summaryIndex] = {
        ...result.summaryMessage,
        content: result.summaryMessage.content + `\n\nExact history (owner-authorized): /api/compaction/archive/${encodeURIComponent(archive.id)}`,
        meta: { ...result.summaryMessage.meta, archiveId: archive.id },
      }
      const summaryMessage = outbound[summaryIndex]
      result = { ...result, summaryMessage, outboundMessages: outbound, messages: outbound }
    }
  }
  const outbound = applyRollingToolResultBudget(result.outboundMessages, { contextWindow, activeContextTokens })
  const postCompactionEstimatedTokens = estimateContextTokens(outbound.messages, tools)
  const withinThreshold = postCompactionEstimatedTokens < threshold
  return withCanonicalContext({
    messages: outbound.messages,
    compacted: true,
    converged: withinThreshold,
    thresholdExceeded: !withinThreshold,
    estimatedTokens,
    postCompactionEstimatedTokens,
    threshold,
    convergencePasses: passes,
    summaryTokens: fit.summaryTokens,
    summaryTruncated: fit.summaryTruncated,
    replacedMessageCount: result.replacedMessageCount,
    archiveId: archive?.id || null,
    archivePersisted: Boolean(archive),
    compactCheckpointSource: result.summaryMessage?.meta?.compactCheckpointSource || null,
    ...messageBoundary,
    semanticSummary: semanticTelemetry,
    rollingToolResultsCompacted: outbound.compactedCount,
    runtimeStrategy: strategy.provenance,
  }, archive ? result.outboundMessages : sourceMessages)
}

export async function compactForModel({
  messages = [],
  tools = [],
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  force = false,
  semanticSummary = 'auto',
  callModel,
  signal,
  userId = null,
  sessionId = null,
  consumeBudget,
  activeContextTokens,
  compactionStrategyResolver = resolveRuntimeContextCompactionStrategy,
  compactionArchivePort,
  maxRetainedMessages,
  onCompactionProgress,
  priorArchive,
} = {}) {
  assertContextRecoveryActive(signal)
  const sourceMessages = Array.isArray(messages) ? messages : []
  const threshold = getAutoCompactionThreshold(contextWindow, activeContextTokens)
  const rollingToolResults = applyRollingToolResultBudget(messages, {
    contextWindow,
    activeContextTokens,
  })
  const preparedMessages = rollingToolResults.messages
  const estimatedTokens = estimateContextTokens(preparedMessages, tools)
  const messageEstimatedTokens = estimateContextTokens(sourceMessages, [])
  const overMessageLimit = preparedMessages.length > MAX_OUTBOUND_MESSAGES
  const nonSystemCount = preparedMessages.filter((message) => message?.role !== 'system').length
  const adaptiveTail = chooseTailSize(sourceMessages, threshold)
  const desiredKeepMessages = force && nonSystemCount > 1
    ? Math.min(adaptiveTail, Math.max(1, Math.floor(nonSystemCount / 2)))
    : adaptiveTail
  const defaultKeepMessages = Number.isSafeInteger(maxRetainedMessages) && maxRetainedMessages > 0
    ? Math.min(desiredKeepMessages, maxRetainedMessages) : desiredKeepMessages
  const hostCompactionRequired = force || overMessageLimit || messageEstimatedTokens >= threshold
  const configuredActiveContextTokens = Number(activeContextTokens)
  const activeContextTokenLimit = Number.isFinite(configuredActiveContextTokens)
    && configuredActiveContextTokens > 0
    ? Math.floor(configuredActiveContextTokens)
    : DEFAULT_ACTIVE_CONTEXT_TOKENS
  const strategy = await compactionStrategyResolver({
    contextWindow,
    activeContextTokens: activeContextTokenLimit,
    threshold,
    estimatedTokens,
    messageEstimatedTokens,
    messageCount: preparedMessages.length,
    roleCounts: contextRoleCounts(preparedMessages),
    toolCount: Array.isArray(tools) ? tools.length : 0,
    overMessageLimit,
    force,
    hostCompactionRequired,
    defaultKeepMessages,
    // A plugin may compact more aggressively, but it cannot retain more
    // history than the built-in strategy selected for this safety boundary.
    maxKeepMessages: defaultKeepMessages,
    rollingToolResultsCompacted: rollingToolResults.compactedCount,
  })
  assertContextRecoveryActive(signal)
  // Tool schemas are a fixed capability surface: compacting conversation
  // history cannot make them smaller. Let a real provider overflow trigger the
  // forced recovery path instead of deleting a fresh, protocol-linked tool
  // batch merely because the selected schema set is large.
  if (!strategy.shouldCompact) {
    return withCanonicalContext({
      messages: preparedMessages,
      compacted: false,
      estimatedTokens,
      messageEstimatedTokens,
      postCompactionEstimatedTokens: estimatedTokens,
      threshold,
      rollingToolResultsCompacted: rollingToolResults.compactedCount,
      runtimeStrategy: strategy.provenance,
    }, sourceMessages)
  }

  const initialKeepMessages = strategy.keepMessages
  const summaryTokenLimit = getCompactionSummaryTokenLimit(contextWindow, activeContextTokens)
  const convergence = await runCompactionPasses({
    preparedMessages: sourceMessages,
    initialKeepMessages,
    semanticSummary,
    callModel,
    contextWindow,
    signal,
    userId,
    consumeBudget,
    tools,
    threshold,
    summaryTokenLimit,
    onCompactionProgress,
  })
  const { result } = convergence
  assertContextRecoveryActive(signal)
  const { semanticTelemetry, fit, passes, buildError } = convergence

  if (!result || (!fit?.ok && !fit?.reduced)) {
    const failedMessages = preparedMessages
    const postCompactionEstimatedTokens = estimateContextTokens(failedMessages, tools)
    return withCanonicalContext({
      messages: failedMessages,
      compacted: false,
      attemptedCompaction: true,
      estimatedTokens,
      postCompactionEstimatedTokens,
      threshold,
      convergencePasses: passes,
      errorCode: postCompactionEstimatedTokens >= threshold
        ? 'CONTEXT_COMPACTION_DID_NOT_CONVERGE'
        : 'CONTEXT_COMPACTION_REFUSED',
      error: buildError || fit?.error || 'context compaction did not converge',
      semanticSummary: semanticTelemetry,
      rollingToolResultsCompacted: rollingToolResults.compactedCount,
      runtimeStrategy: strategy.provenance,
    }, sourceMessages)
  }
  return finalizeCompactionResult(convergence, {
    sourceMessages,
    tools,
    contextWindow,
    activeContextTokens,
    threshold,
    estimatedTokens,
    userId,
    sessionId,
    compactionArchivePort,
    signal,
    strategy,
    priorArchive,
  })
}
