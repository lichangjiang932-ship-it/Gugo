/**
 * Feature 3: 记忆系统 REST 路由
 *
 *   GET    /api/memory/list?type=&q=
 *   GET    /api/memory/by-ids?ids=a,b,c
 *   GET    /api/memory/index            → MEMORY.md 合成内容
 *   GET    /api/memory/get/:id
 *   POST   /api/memory/upsert
 *   DELETE /api/memory/:id
 *   GET    /api/memory/wikilink/:slug   → 解析 [[slug]] 到 memory
 */

import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import {
  listMemories,
  getMemory,
  upsertMemory,
  deleteMemory,
  buildMemoryIndex,
  findBySlug,
} from '../services/memoryStore.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function unauthorized(res) {
  sendJson(res, 401, { ok: false, error: '请先登录' })
}

export async function handleMemoryRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname

  try {
    if (req.method === 'GET' && pathname === '/api/memory/list') {
      const type = url.searchParams.get('type') || null
      const query = url.searchParams.get('q') || null
      const agentFilter = url.searchParams.get('agent') || null
      const memories = listMemories({ userId, type, query, limit: 200, agentFilter })
      return sendJson(res, 200, { ok: true, memories })
    }

    if (req.method === 'GET' && pathname === '/api/memory/index') {
      const content = buildMemoryIndex(userId)
      return sendJson(res, 200, { ok: true, content })
    }

    if (req.method === 'GET' && pathname === '/api/memory/by-ids') {
      const ids = (url.searchParams.get('ids') || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
        .slice(0, 60)
      const memories = ids
        .map((id) => getMemory(userId, id))
        .filter(Boolean)
      return sendJson(res, 200, { ok: true, memories })
    }

    if (req.method === 'GET' && pathname.startsWith('/api/memory/get/')) {
      const id = pathname.slice('/api/memory/get/'.length)
      const mem = getMemory(userId, id)
      if (!mem) return sendJson(res, 404, { ok: false, error: '记忆不存在' })
      return sendJson(res, 200, { ok: true, memory: mem })
    }

    if (req.method === 'GET' && pathname.startsWith('/api/memory/wikilink/')) {
      const slug = pathname.slice('/api/memory/wikilink/'.length)
      const mem = findBySlug(userId, decodeURIComponent(slug))
      if (!mem) return sendJson(res, 404, { ok: false, error: 'slug 未找到' })
      return sendJson(res, 200, { ok: true, memory: mem })
    }

    if (req.method === 'POST' && pathname === '/api/memory/upsert') {
      const body = await readJson(req)
      const mem = upsertMemory({
        id: body.id,
        userId,
        type: body.type,
        title: body.title,
        body: body.body,
        frontmatter: body.frontmatter || {},
        pinned: !!body.pinned,
        sourceSessionId: body.sourceSessionId || null,
        sourceMessageId: body.sourceMessageId || null,
        agentId: body.agentId || null,
      })
      return sendJson(res, 200, { ok: true, memory: mem })
    }

    if (req.method === 'DELETE' && pathname.startsWith('/api/memory/')) {
      const id = pathname.slice('/api/memory/'.length)
      if (!id || id.includes('/')) return sendJson(res, 400, { ok: false, error: '缺少 id' })
      const result = deleteMemory(userId, id)
      return sendJson(res, 200, { ok: true, ...result })
    }

    return sendJson(res, 404, { ok: false, error: '未知路由' })
  } catch (err) {
    return sendJson(res, err?.statusCode || 400, { ok: false, error: err?.message || String(err) })
  }
}
