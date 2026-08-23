import { authenticateRequest } from '../middleware.js'
import { randomUUID } from 'node:crypto'
import { readJson } from '../utils.js'
import { callBackgroundModel, getModelContextWindow } from '../adapters/modelProxy.js'
import {
  buildCompaction,
  createCompactionArchive,
  getCompactionArchive,
  replaceCompactionSummary,
  validateToolCallChain,
} from '../services/compactionService.js'
import {
  addSemanticCompactionSummary,
  boundCompactionSummary,
  estimateContextTokens,
  getAutoCompactionThreshold,
  getCompactionSummaryTokenLimit,
} from '../services/contextCompactionRuntime.js'
import { dispatchHooks } from '../services/hooksService.js'
import {
  describeModelReadinessFailure,
  isModelReadinessError,
  resolveChatModelRuntimeBinding,
} from '../services/modelReadinessService.js'
import {
  acquireCompactionArchivePort as acquireActiveCompactionArchivePort,
} from '../core/compactionArchivePort.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }
const MANUAL_COMPACTION_RESERVE_TOKENS = 64
const MIN_MANUAL_SUMMARY_TOKENS = 8

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function estimateMessageSurface(messages) {
  // estimateContextTokens includes a fixed 16-token request allowance. Remove
  // it when comparing one message surface with another.
  return Math.max(0, estimateContextTokens(messages, []) - 16)
}

/**
 * Apply the same bounded-summary and final outbound remeasurement rules used
 * by automatic compaction. Manual compaction must never treat "a summary was
 * produced" as proof that the resulting request actually fits.
 */
export function fitManualCompactionResult(result, {
  tools = [],
  contextWindow,
  activeContextTokens,
} = {}) {
  const threshold = getAutoCompactionThreshold(contextWindow, activeContextTokens)
  const target = Math.max(1, threshold - MANUAL_COMPACTION_RESERVE_TOKENS)
  const summaryTokenLimit = getCompactionSummaryTokenLimit(contextWindow, activeContextTokens)
  const archivedTokens = estimateMessageSurface(result?.archivedMessages || [])
  const emptySummaryTokens = estimateMessageSurface([{ ...result?.summaryMessage, content: '' }])
  let budget = Math.min(
    summaryTokenLimit,
    Math.max(0, archivedTokens - emptySummaryTokens - 1),
  )
  let bestResult = result
  let bestEstimate = estimateContextTokens(result?.outboundMessages || [], tools)
  let bestSummaryTokens = estimateMessageSurface(result?.summaryMessage ? [result.summaryMessage] : [])
  let summaryTruncated = false

  for (let attempt = 0; attempt < 5 && budget >= MIN_MANUAL_SUMMARY_TOKENS; attempt += 1) {
    const summaryText = boundCompactionSummary(result.summaryText, { maxTokens: budget })
    const candidate = replaceCompactionSummary(result, summaryText)
    const estimatedTokens = estimateContextTokens(candidate.outboundMessages, tools)
    const summaryTokens = estimateMessageSurface([candidate.summaryMessage])
    const chain = validateToolCallChain(candidate.outboundMessages)
    summaryTruncated ||= summaryText !== result.summaryText
    if (estimatedTokens < bestEstimate) {
      bestResult = candidate
      bestEstimate = estimatedTokens
      bestSummaryTokens = summaryTokens
    }
    if (chain.ok && estimatedTokens < target && summaryTokens < archivedTokens) {
      return {
        ok: true,
        result: candidate,
        estimatedTokens,
        summaryTokens,
        summaryTruncated,
        threshold,
      }
    }
    const overflow = Math.max(
      1,
      estimatedTokens - target + 1,
      summaryTokens - archivedTokens + 1,
    )
    budget = Math.floor(budget - overflow - 4)
  }

  return {
    ok: false,
    result: bestResult,
    estimatedTokens: bestEstimate,
    summaryTokens: bestSummaryTokens,
    summaryTruncated,
    threshold,
    error: bestEstimate >= target
      ? `compacted outbound context still needs ${bestEstimate} tokens (budget ${target})`
      : 'compaction summary was not smaller than the archived surface',
  }
}

export function attachManualCompactionArchive(result, archiveId) {
  const summaryMessage = {
    ...result.summaryMessage,
    meta: { ...result.summaryMessage.meta, archiveId },
  }
  const outboundMessages = result.outboundMessages.map((message) => (
    message === result.summaryMessage ? summaryMessage : message
  ))
  return { summaryMessage, outboundMessages }
}

export function resolveCompactionModelContext({
  userId,
  modelName,
  modelProviderId = '',
  modelConfigRevision = null,
  env = process.env,
  resolveBinding = resolveChatModelRuntimeBinding,
  resolveContextWindow = getModelContextWindow,
  invokeModel = callBackgroundModel,
} = {}) {
  const selectedModel = String(modelName || '').trim() || undefined
  const selectedProviderId = String(modelProviderId || '').trim()
  const revision = Number(modelConfigRevision)
  const selectedRevision = Number.isInteger(revision) && revision > 0 ? revision : null
  const binding = resolveBinding({
    userId,
    providerId: selectedProviderId,
    modelName: selectedModel,
    configRevision: selectedRevision,
    env,
  })
  const runtimeProviderId = binding.source === 'environment'
    ? String(binding.providerId || '').trim()
    : ''
  const runtimeRequest = {
    userId: null,
    usageOwnerId: userId,
    modelName: binding.modelName,
    ...(runtimeProviderId ? { modelProviderId: runtimeProviderId } : {}),
    env: binding.env,
  }
  return {
    modelName: binding.modelName,
    modelProviderId: binding.providerId || null,
    modelConfigRevision: binding.configRevision ?? null,
    contextWindow: resolveContextWindow(runtimeRequest),
    callModel: ({ messages, signal }) => invokeModel({
      ...runtimeRequest,
      messages,
      signal,
    }),
  }
}

export async function handleCompactionRequest(req, res, {
  compactionArchivePort,
  acquireCompactionArchivePort = acquireActiveCompactionArchivePort,
  resolveModelContext = resolveCompactionModelContext,
} = {}) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { ok: false, error: 'Unauthorized' })

  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname

  let compactionArchiveLease = null
  let requestCompactionArchivePort = compactionArchivePort
  const acquireRequestCompactionArchivePort = () => {
    if (requestCompactionArchivePort) return requestCompactionArchivePort
    compactionArchiveLease = acquireCompactionArchivePort()
    requestCompactionArchivePort = compactionArchiveLease.port
    return requestCompactionArchivePort
  }

  try {
    if (req.method === 'POST' && pathname === '/api/compaction/compress') {
      const body = await readJson(req)
      const idempotencyHeader = req.headers?.['idempotency-key']
      const hookInvocationId = String(
        (Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader)
          || body.requestId
          || randomUUID(),
      ).trim()
      // pre_compact hooks may veto compaction or override the semantic summary
      // prompt before any archive/summary work runs.
      const preCompact = await dispatchHooks({
        userId,
        event: 'pre_compact',
        tool: null,
        args: { keepMessages: body.keepMessages, messageCount: Array.isArray(body.messages) ? body.messages.length : 0 },
        sessionId: body.sessionId || null,
        requestId: body.requestId || hookInvocationId,
        hookInvocationId: `${hookInvocationId}:pre_compact`,
        payload: { customPrompt: typeof body.compactPrompt === 'string' ? body.compactPrompt : null },
      })
      if (!preCompact.allow) {
        return sendJson(res, 200, {
          ok: true,
          compacted: false,
          messages: Array.isArray(body.messages) ? body.messages : [],
          outboundMessages: Array.isArray(body.messages) ? body.messages : [],
          hookVeto: true,
          hookReason: preCompact.reason || 'pre_compact hook rejected compaction',
        })
      }
      const compactPrompt = typeof preCompact.replacementArgs?.customPrompt === 'string'
        ? preCompact.replacementArgs.customPrompt
        : typeof body.compactPrompt === 'string' ? body.compactPrompt : ''
      const inputMessages = Array.isArray(body.messages) ? body.messages : []
      let result = buildCompaction({
        messages: inputMessages,
        keepMessages: Number(body.keepMessages) || undefined,
      })
      if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error })
      if (!result.compacted) {
        return sendJson(res, 200, {
          ok: true,
          compacted: false,
          messages: result.outboundMessages,
          outboundMessages: result.outboundMessages,
        })
      }

      acquireRequestCompactionArchivePort()

      const modelContext = resolveModelContext({
        userId,
        modelName: body.modelName,
        modelProviderId: body.modelProviderId,
        modelConfigRevision: body.modelConfigRevision,
      })
      let semanticSummary = {
        attempted: false,
        used: false,
        modelCalls: 0,
        batchCount: 0,
        truncatedMessageCount: 0,
        fallbackReason: body.semantic === false ? 'disabled' : null,
      }
      if (body.semantic !== false) {
        const semantic = await addSemanticCompactionSummary({
          result,
          callModel: modelContext.callModel,
          contextWindow: modelContext.contextWindow,
          userId,
          customPrompt: compactPrompt,
        })
        result = semantic.result
        semanticSummary = semantic.telemetry
      }

      let convergencePasses = 1
      let fit = fitManualCompactionResult(result, {
        tools: Array.isArray(body.tools) ? body.tools : [],
        contextWindow: modelContext.contextWindow,
      })
      if (!fit.ok) {
        // A large retained tail cannot be fixed by shortening the summary.
        // Retry once with the smallest legal tail, matching automatic
        // compaction's convergence strategy.
        const retry = buildCompaction({
          messages: inputMessages,
          keepMessages: 1,
          force: true,
        })
        if (retry.ok && retry.compacted && retry.replacedMessageCount > 0) {
          convergencePasses = 2
          result = retry
          fit = fitManualCompactionResult(result, {
            tools: Array.isArray(body.tools) ? body.tools : [],
            contextWindow: modelContext.contextWindow,
          })
          if (semanticSummary.used) {
            semanticSummary = {
              ...semanticSummary,
              used: false,
              fallbackReason: 'semantic_summary_replaced_for_convergence',
            }
          }
        }
      }
      if (!fit.ok) {
        return sendJson(res, 422, {
          ok: false,
          code: 'CONTEXT_COMPACTION_DID_NOT_CONVERGE',
          error: fit.error,
          estimatedTokens: fit.estimatedTokens,
          threshold: fit.threshold,
          convergencePasses,
        })
      }
      result = fit.result

      const archive = await createCompactionArchive({
        userId,
        sessionId: body.sessionId || 'unknown',
        archivedMessages: result.archivedMessages,
        summaryText: result.summaryText,
      }, { compactionArchivePort: requestCompactionArchivePort })
      const { summaryMessage, outboundMessages } = attachManualCompactionArchive(result, archive.id)
      return sendJson(res, 200, {
        ok: true,
        compacted: true,
        archiveId: archive.id,
        summaryMessage,
        messages: outboundMessages,
        outboundMessages,
        replacedMessageCount: result.replacedMessageCount,
        forced: result.forced,
        postCompactionEstimatedTokens: fit.estimatedTokens,
        threshold: fit.threshold,
        convergencePasses,
        summaryTruncated: fit.summaryTruncated,
        semanticSummary,
      })
    }

    const match = pathname.match(/^\/api\/compaction\/archive\/([^/]+)$/)
    if (req.method === 'GET' && match) {
      acquireRequestCompactionArchivePort()
      const archive = await getCompactionArchive(
        { userId, id: match[1] },
        { compactionArchivePort: requestCompactionArchivePort },
      )
      if (!archive) return sendJson(res, 404, { ok: false, error: 'archive not found' })
      return sendJson(res, 200, { ok: true, archive })
    }

    return sendJson(res, 404, { ok: false, error: 'unknown compaction route' })
  } catch (err) {
    if (isModelReadinessError(err)) {
      const failure = describeModelReadinessFailure(err)
      return sendJson(res, failure.statusCode, {
        ok: false,
        error: failure.error,
      })
    }
    return sendJson(res, err?.statusCode || 400, { ok: false, error: err?.message || String(err) })
  } finally {
    compactionArchiveLease?.release()
  }
}
