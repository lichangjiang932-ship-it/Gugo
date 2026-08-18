import { authenticateRequest } from '../middleware.js'
import { listToolAudit } from '../services/toolAuditStore.js'
import { sendJson } from '../utils.js'

function errorBody(code, message) {
  return { error: { code, message } }
}

export function handleAuditRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, errorBody('unauthorized', '请先登录'))
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/api/audit') {
    return sendJson(res, 404, errorBody('not_found', '审计端点不存在'))
  }
  if (req.method !== 'GET') {
    return sendJson(res, 405, errorBody('method_not_allowed', '仅支持 GET'))
  }
  try {
    const entries = listToolAudit({
      userId,
      tool: url.searchParams.get('tool'),
      stage: url.searchParams.get('stage'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      limit: url.searchParams.get('limit'),
    })
    return sendJson(res, 200, { entries })
  } catch (error) {
    return sendJson(
      res,
      error?.statusCode || 500,
      errorBody(error?.code || 'audit_query_failed', error?.message || '审计查询失败'),
    )
  }
}
