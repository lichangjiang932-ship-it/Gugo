import { authenticateRequest } from '../middleware.js'
import { readJson } from '../utils.js'
import { callBackgroundModel, getModelContextWindow } from '../adapters/modelProxy.js'
import {
  buildCompaction,
  createCompactionArchive,
  getCompactionArchive,
} from '../services/compactionService.js'
import { addSemanticCompactionSummary } from '../services/contextCompactionRuntime.js'
import { dispatchHooks } from '../services/hooksService.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

export function resolveCompactionModelContext({
  userId,
  modelName,
  resolveContextWindow = getModelContextWindow,
  invokeModel = callBackgroundModel,
} = {}) {
  const selectedModel = String(modelName || '').trim() || undefined
  return {
    modelName: selectedModel,
    contextWindow: resolveContextWindow({ userId, modelName: selectedModel }),
    callModel: ({ messages, signal }) => invokeModel({
      userId,
      modelName: selectedModel,
      messages,
      signal,
    }),
  }
}

export async function handleCompactionRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { ok: false, error: 'Unauthorized' })

  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname

  try {
    if (req.method === 'POST' && pathname === '/api/compaction/compress') {
      const body = await readJson(req)
      // pre_compact hooks may veto compaction or override the semantic summary
      // prompt before any archive/summary work runs.
      const preCompact = await dispatchHooks({
        userId,
        event: 'pre_compact',
        tool: null,
        args: { keepMessages: body.keepMessages, messageCount: Array.isArray(body.messages) ? body.messages.length : 0 },
        sessionId: body.sessionId || null,
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
      let result = buildCompaction({
        messages: Array.isArray(body.messages) ? body.messages : [],
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

      let semanticSummary = {
        attempted: false,
        used: false,
        modelCalls: 0,
        batchCount: 0,
        truncatedMessageCount: 0,
        fallbackReason: body.semantic === false ? 'disabled' : null,
      }
      if (body.semantic !== false) {
        const modelContext = resolveCompactionModelContext({
          userId,
          modelName: body.modelName,
        })
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

      const archive = createCompactionArchive({
        userId,
        sessionId: body.sessionId || 'unknown',
        archivedMessages: result.archivedMessages,
        summaryText: result.summaryText,
      })
      const summaryMessage = {
        ...result.summaryMessage,
        meta: { ...result.summaryMessage.meta, archiveId: archive.id },
      }
      const outboundMessages = result.outboundMessages.map((message) => (
        message?.id === result.summaryMessage?.id ? summaryMessage : message
      ))
      return sendJson(res, 200, {
        ok: true,
        compacted: true,
        archiveId: archive.id,
        summaryMessage,
        messages: outboundMessages,
        outboundMessages,
        replacedMessageCount: result.replacedMessageCount,
        forced: result.forced,
        semanticSummary,
      })
    }

    const match = pathname.match(/^\/api\/compaction\/archive\/([^/]+)$/)
    if (req.method === 'GET' && match) {
      const archive = getCompactionArchive({ userId, id: match[1] })
      if (!archive) return sendJson(res, 404, { ok: false, error: 'archive not found' })
      return sendJson(res, 200, { ok: true, archive })
    }

    return sendJson(res, 404, { ok: false, error: 'unknown compaction route' })
  } catch (err) {
    return sendJson(res, err?.statusCode || 400, { ok: false, error: err?.message || String(err) })
  }
}
