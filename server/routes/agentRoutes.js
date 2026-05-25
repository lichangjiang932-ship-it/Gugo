/**
 * Agents REST 路由
 *
 *   GET    /api/agents              列出当前用户所有 agent
 *   GET    /api/agents/default      取默认 agent（无则触发 ensureDefault）
 *   GET    /api/agents/:id          取详情
 *   GET    /api/agents/:id/export   导出为 .agent.md（frontmatter + SOUL + IDENTITY）
 *   POST   /api/agents/import       从 .agent.md 文本导入（body: { source }）
 *   POST   /api/agents              创建 { name, soulMd, identityMd?, avatarUrl?, isDefault? }
 *   PATCH  /api/agents/:id          部分更新
 *   DELETE /api/agents/:id          删除
 *
 * 全部需登录。
 */

import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import {
  listAgents,
  getAgent,
  getDefaultAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  ensureDefaultAgent,
  serializeAgentMarkdown,
  parseAgentMarkdown,
} from '../services/agentStore.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function unauthorized(res) {
  sendJson(res, 401, { ok: false, error: '请先登录' })
}

export async function handleAgentRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname

  try {
    // GET /api/agents
    if (req.method === 'GET' && pathname === '/api/agents') {
      return sendJson(res, 200, { ok: true, agents: listAgents({ userId }) })
    }

    // GET /api/agents/default
    if (req.method === 'GET' && pathname === '/api/agents/default') {
      let agent = getDefaultAgent({ userId })
      if (!agent) agent = ensureDefaultAgent({ userId })
      return sendJson(res, 200, { ok: true, agent })
    }

    // POST /api/agents
    if (req.method === 'POST' && pathname === '/api/agents') {
      const body = await readJson(req)
      const agent = createAgent({
        userId,
        name: body.name,
        soulMd: body.soulMd || '',
        identityMd: body.identityMd || '',
        avatarUrl: body.avatarUrl || null,
        isDefault: !!body.isDefault,
      })
      return sendJson(res, 200, { ok: true, agent })
    }

    // POST /api/agents/import
    if (req.method === 'POST' && pathname === '/api/agents/import') {
      const body = await readJson(req)
      const parsed = parseAgentMarkdown(String(body?.source || ''))
      const finalName = (body?.overrideName && String(body.overrideName).trim()) || parsed.name
      const agent = createAgent({
        userId,
        name: finalName,
        soulMd: parsed.soulMd,
        identityMd: parsed.identityMd,
        avatarUrl: parsed.avatarUrl,
        isDefault: false,
      })
      return sendJson(res, 200, { ok: true, agent })
    }

    // /api/agents/:id/export
    const exportMatch = pathname.match(/^\/api\/agents\/([A-Za-z0-9_-]+)\/export$/)
    if (exportMatch && req.method === 'GET') {
      const agent = getAgent({ userId, id: exportMatch[1] })
      if (!agent) return sendJson(res, 404, { ok: false, error: 'agent 不存在' })
      const text = serializeAgentMarkdown(agent)
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(agent.name)}.agent.md"`,
      })
      res.end(text)
      return undefined
    }

    // /api/agents/:id
    const idMatch = pathname.match(/^\/api\/agents\/([A-Za-z0-9_-]+)$/)
    if (idMatch) {
      const id = idMatch[1]
      if (req.method === 'GET') {
        const agent = getAgent({ userId, id })
        if (!agent) return sendJson(res, 404, { ok: false, error: 'agent 不存在' })
        return sendJson(res, 200, { ok: true, agent })
      }
      if (req.method === 'PATCH') {
        const body = await readJson(req)
        const agent = updateAgent({ userId, id, patch: body })
        if (!agent) return sendJson(res, 404, { ok: false, error: 'agent 不存在' })
        return sendJson(res, 200, { ok: true, agent })
      }
      if (req.method === 'DELETE') {
        const ok = deleteAgent({ userId, id })
        if (!ok) return sendJson(res, 404, { ok: false, error: 'agent 不存在' })
        return sendJson(res, 200, { ok: true })
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    }

    return sendJson(res, 404, { ok: false, error: 'unknown agent route' })
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message || String(err) })
  }
}
