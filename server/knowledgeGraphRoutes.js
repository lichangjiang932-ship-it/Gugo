/**
 * 知识图谱 API 路由。
 * 对标 Reasonix 的 memory_* 工具集，通过 REST API 暴露给前端。
 *
 * 端点:
 *   POST /api/knowledge/entities          — createEntities
 *   DELETE /api/knowledge/entities        — deleteEntities
 *   POST /api/knowledge/relations         — createRelations
 *   DELETE /api/knowledge/relations       — deleteRelations
 *   POST /api/knowledge/observations      — addObservations
 *   DELETE /api/knowledge/observations    — deleteObservations
 *   GET  /api/knowledge/search?q=         — searchNodes
 *   GET  /api/knowledge/graph             — readGraph
 *   POST /api/knowledge/open              — openNodes
 */

import { authenticateRequest } from './middleware.js'
import {
  createEntities,
  deleteEntities,
  createRelations,
  deleteRelations,
  addObservations,
  deleteObservations,
  searchNodes,
  readGraph,
  openNodes,
} from './knowledgeGraph.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

export async function handleKnowledgeGraphRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { error: 'Unauthorized' })

  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname

  try {
    // ── Entities ──
    if (req.method === 'POST' && path === '/api/knowledge/entities') {
      const body = await readJson(req)
      if (!Array.isArray(body.entities)) return sendJson(res, 400, { error: 'entities must be an array' })
      const created = createEntities({ userId, entities: body.entities })
      return sendJson(res, 201, { entities: created })
    }

    if (req.method === 'DELETE' && path === '/api/knowledge/entities') {
      const body = await readJson(req)
      if (!Array.isArray(body.entityNames)) return sendJson(res, 400, { error: 'entityNames must be an array' })
      deleteEntities({ userId, entityNames: body.entityNames })
      return sendJson(res, 200, { ok: true })
    }

    // ── Relations ──
    if (req.method === 'POST' && path === '/api/knowledge/relations') {
      const body = await readJson(req)
      if (!Array.isArray(body.relations)) return sendJson(res, 400, { error: 'relations must be an array' })
      createRelations({ userId, relations: body.relations })
      return sendJson(res, 201, { ok: true })
    }

    if (req.method === 'DELETE' && path === '/api/knowledge/relations') {
      const body = await readJson(req)
      if (!Array.isArray(body.relations)) return sendJson(res, 400, { error: 'relations must be an array' })
      deleteRelations({ userId, relations: body.relations })
      return sendJson(res, 200, { ok: true })
    }

    // ── Observations ──
    if (req.method === 'POST' && path === '/api/knowledge/observations') {
      const body = await readJson(req)
      if (!Array.isArray(body.observations)) return sendJson(res, 400, { error: 'observations must be an array' })
      addObservations({ userId, observations: body.observations })
      return sendJson(res, 201, { ok: true })
    }

    if (req.method === 'DELETE' && path === '/api/knowledge/observations') {
      const body = await readJson(req)
      if (!Array.isArray(body.deletions)) return sendJson(res, 400, { error: 'deletions must be an array' })
      deleteObservations({ userId, deletions: body.deletions })
      return sendJson(res, 200, { ok: true })
    }

    // ── Search / Read / Open ──
    if (req.method === 'GET' && path === '/api/knowledge/search') {
      const query = url.searchParams.get('q') || ''
      const result = searchNodes({ userId, query })
      return sendJson(res, 200, result)
    }

    if (req.method === 'GET' && path === '/api/knowledge/graph') {
      const result = readGraph({ userId })
      return sendJson(res, 200, result)
    }

    if (req.method === 'POST' && path === '/api/knowledge/open') {
      const body = await readJson(req)
      if (!Array.isArray(body.names)) return sendJson(res, 400, { error: 'names must be an array' })
      const result = openNodes({ userId, names: body.names })
      return sendJson(res, 200, result)
    }

    return sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    return sendJson(res, 500, { error: err?.message || 'internal error' })
  }
}
