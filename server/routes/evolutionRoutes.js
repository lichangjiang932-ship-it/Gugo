import { authenticateRequest } from '../middleware.js'
import {
  appendEvolutionFeedback,
  listEvolutionEvidence,
} from '../services/evolutionEvidenceStore.js'
import { readJson, sendJson } from '../utils.js'

function errorBody(code, message) {
  return { ok: false, error: { code, message } }
}

export async function handleEvolutionRequest(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, errorBody('UNAUTHORIZED', '请先登录'))
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname === '/api/evolution/feedback') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
      }
      const body = await readJson(req, { maxBytes: 16 * 1024 })
      const evidence = appendEvolutionFeedback({
        userId,
        sessionId: body.sessionId,
        feedback: body.feedback,
      })
      return sendJson(res, 201, { ok: true, evidence })
    }
    if (url.pathname === '/api/evolution/evidence') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
      }
      const evidence = listEvolutionEvidence({
        userId,
        limit: url.searchParams.get('limit'),
      })
      return sendJson(res, 200, { ok: true, schemaVersion: 1, evidence })
    }
    return sendJson(res, 404, errorBody('NOT_FOUND', '证据端点不存在'))
  } catch (error) {
    return sendJson(res, error?.statusCode || 500, errorBody(
      error?.code || 'EVOLUTION_EVIDENCE_FAILED',
      error?.statusCode && error.statusCode < 500 ? error.message : '证据操作失败',
    ))
  }
}
