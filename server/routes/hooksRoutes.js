/**
 * Feature 7: Hooks REST 路由
 *
 *   GET    /api/hooks
 *   POST   /api/hooks
 *   PATCH  /api/hooks/:id
 *   DELETE /api/hooks/:id
 *   POST   /api/hooks/:id/test
 */

import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import {
  listHooks,
  getHook,
  upsertHook,
  deleteHook,
  testHook,
} from '../services/hooksService.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }
function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

export async function handleHooksRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { ok: false, error: '请先登录' })
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname

  try {
    if (req.method === 'GET' && pathname === '/api/hooks') {
      return sendJson(res, 200, { ok: true, hooks: listHooks({ userId }) })
    }

    if (req.method === 'POST' && pathname === '/api/hooks') {
      const body = await readJson(req)
      const hook = upsertHook({ userId, ...body })
      return sendJson(res, 200, { ok: true, hook })
    }

    const idMatch = pathname.match(/^\/api\/hooks\/([^/]+)(\/test)?$/)
    if (idMatch) {
      const id = idMatch[1]
      const isTest = !!idMatch[2]
      if (isTest && req.method === 'POST') {
        const result = await testHook({ userId, id })
        return sendJson(res, 200, { ok: true, result })
      }
      if (req.method === 'PATCH') {
        const body = await readJson(req)
        const current = getHook(userId, id)
        if (!current) return sendJson(res, 404, { ok: false, error: 'hook 不存在' })
        const hook = upsertHook({ ...current, ...body, id, userId })
        return sendJson(res, 200, { ok: true, hook })
      }
      if (req.method === 'DELETE') {
        return sendJson(res, 200, { ok: true, ...deleteHook(userId, id) })
      }
      if (req.method === 'GET') {
        const hook = getHook(userId, id)
        if (!hook) return sendJson(res, 404, { ok: false, error: 'hook 不存在' })
        return sendJson(res, 200, { ok: true, hook })
      }
    }

    return sendJson(res, 404, { ok: false, error: '未知路由' })
  } catch (err) {
    return sendJson(res, err?.statusCode || 400, { ok: false, error: err?.message || String(err) })
  }
}
