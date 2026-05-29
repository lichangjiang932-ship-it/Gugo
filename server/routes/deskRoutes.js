/**
 * Desk Notes 路由 (Hanako 平行：书桌便笺)
 *
 *   GET    /api/desk/notes?agent=<id|null|all>   - null=全局未绑定；all=不过滤
 *   POST   /api/desk/notes                       - { agentId?, title?, body?, pinned? }
 *   GET    /api/desk/notes/:id
 *   PATCH  /api/desk/notes/:id                   - { title?, body?, pinned?, agentId? }
 *   DELETE /api/desk/notes/:id
 */

import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import {
  listDeskNotes,
  getDeskNote,
  createDeskNote,
  updateDeskNote,
  deleteDeskNote,
} from '../services/deskStore.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function unauthorized(res) {
  sendJson(res, 401, { ok: false, error: '请先登录' })
}

export async function handleDeskRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname

  try {
    if (req.method === 'GET' && pathname === '/api/desk/notes') {
      const agentParam = url.searchParams.get('agent')
      // 语义：未传 → 全部；'all' → 全部；空串/'null' → 仅未绑定 agent 的；其它 → 该 agent
      let agentId
      if (agentParam === null || agentParam === 'all') agentId = undefined
      else if (agentParam === '' || agentParam === 'null') agentId = null
      else agentId = agentParam
      const notes =
        agentId === undefined
          ? listDeskNotes({ userId })
          : listDeskNotes({ userId, agentId })
      return sendJson(res, 200, { ok: true, notes })
    }

    if (req.method === 'POST' && pathname === '/api/desk/notes') {
      const body = await readJson(req)
      const note = createDeskNote({
        userId,
        agentId: body?.agentId || null,
        title: body?.title || '',
        body: body?.body || '',
        pinned: !!body?.pinned,
      })
      return sendJson(res, 200, { ok: true, note })
    }

    if (pathname.startsWith('/api/desk/notes/')) {
      const id = pathname.slice('/api/desk/notes/'.length)
      if (!id || id.includes('/')) return sendJson(res, 400, { ok: false, error: '缺少 id' })

      if (req.method === 'GET') {
        const note = getDeskNote({ userId, id })
        if (!note) return sendJson(res, 404, { ok: false, error: '便笺不存在' })
        return sendJson(res, 200, { ok: true, note })
      }
      if (req.method === 'PATCH') {
        const body = await readJson(req)
        const note = updateDeskNote({ userId, id, patch: body || {} })
        if (!note) return sendJson(res, 404, { ok: false, error: '便笺不存在' })
        return sendJson(res, 200, { ok: true, note })
      }
      if (req.method === 'DELETE') {
        const removed = deleteDeskNote({ userId, id })
        if (!removed) return sendJson(res, 404, { ok: false, error: '便笺不存在' })
        return sendJson(res, 200, { ok: true })
      }
    }

    return sendJson(res, 404, { ok: false, error: '未知路由' })
  } catch (err) {
    return sendJson(res, err?.statusCode || 400, { ok: false, error: err?.message || String(err) })
  }
}
