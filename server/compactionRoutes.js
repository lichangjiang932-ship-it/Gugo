import { authenticateRequest } from './middleware.js'
import { readJson } from './utils.js'
import { buildCompaction, createCompactionArchive, getCompactionArchive } from './compactionService.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

export async function handleCompactionRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { ok: false, error: 'Unauthorized' })

  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname

  try {
    if (req.method === 'POST' && pathname === '/api/compaction/compress') {
      const body = await readJson(req)
      const result = buildCompaction({
        messages: Array.isArray(body.messages) ? body.messages : [],
        keepMessages: Number(body.keepMessages) || undefined,
      })
      if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error })
      if (!result.compacted) return sendJson(res, 200, { ok: true, compacted: false, messages: result.messages })

      const archive = createCompactionArchive({
        userId,
        sessionId: body.sessionId || 'unknown',
        archivedMessages: result.archivedMessages,
        summaryText: result.summaryText,
      })
      return sendJson(res, 200, {
        ok: true,
        compacted: true,
        archiveId: archive.id,
        summaryMessage: { ...result.summaryMessage, meta: { ...result.summaryMessage.meta, archiveId: archive.id } },
        messages: result.messages,
        replacedMessageCount: result.replacedMessageCount,
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
