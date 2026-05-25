/**
 * Agents REST 路由
 *
 *   GET    /api/agents              列出当前用户所有 agent
 *   GET    /api/agents/default      取默认 agent（无则触发 ensureDefault）
 *   GET    /api/agents/:id          取详情
 *   GET    /api/agents/:id/export   导出为 .agent.md（frontmatter + SOUL + IDENTITY）
 *   GET    /api/agents/:id/export.zip 导出角色卡 zip（agent.md + manifest.json + 可选 memories）
 *   POST   /api/agents/import       从 .agent.md 文本导入（body: { source }）
 *   POST   /api/agents/import.zip   从角色卡 zip 导入（multipart/octet-stream: 原始 zip 二进制）
 *   POST   /api/agents              创建 { name, soulMd, identityMd?, avatarUrl?, isDefault? }
 *   PATCH  /api/agents/:id          部分更新
 *   DELETE /api/agents/:id          删除
 *
 * 全部需登录。
 */

import { readJson } from '../utils.js'
import JSZip from 'jszip'
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
import {
  listMemories,
  upsertMemory,
} from '../services/memoryStore.js'

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

    // /api/agents/:id/export.zip — 角色卡 zip (对齐 openhanako)
    const exportZipMatch = pathname.match(/^\/api\/agents\/([A-Za-z0-9_-]+)\/export\.zip$/)
    if (exportZipMatch && req.method === 'GET') {
      const agent = getAgent({ userId, id: exportZipMatch[1] })
      if (!agent) return sendJson(res, 404, { ok: false, error: 'agent 不存在' })
      const includeMemories = url.searchParams.get('memories') !== '0'
      const zip = new JSZip()
      // manifest.json: v0.1 格式说明
      zip.file('manifest.json', JSON.stringify({
        format: 'yma-agent-card',
        version: '0.1',
        exportedAt: new Date().toISOString(),
        agent: {
          name: agent.name,
          isDefault: false, // import 时不抢默认
          hasAvatar: !!agent.avatarUrl,
        },
        memoriesIncluded: includeMemories,
      }, null, 2))
      // agent.md: 主说明 + SOUL + IDENTITY
      zip.file('agent.md', serializeAgentMarkdown(agent))
      // memories/*.md: 只导出该 agent 专属记忆（agent_id 等于本 agent）
      if (includeMemories) {
        const memos = listMemories({ userId, agentFilter: agent.id, limit: 500 })
        memos.forEach((m, idx) => {
          const slug = m.slug || String(idx)
          const fm = JSON.stringify({
            type: m.type,
            title: m.title,
            pinned: !!m.pinned,
            frontmatter: m.frontmatter || {},
          })
          zip.file(`memories/${slug}.md`, `---\n${fm}\n---\n${m.body || ''}\n`)
        })
      }
      const buf = await zip.generateAsync({ type: 'nodebuffer' })
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(agent.name)}.agent.zip"`,
        'Content-Length': buf.length,
      })
      res.end(buf)
      return undefined
    }

    // POST /api/agents/import.zip
    if (req.method === 'POST' && pathname === '/api/agents/import.zip') {
      const overrideName = url.searchParams.get('overrideName') || null
      const chunks = []
      for await (const c of req) chunks.push(c)
      const raw = Buffer.concat(chunks)
      if (raw.length === 0) return sendJson(res, 400, { ok: false, error: 'empty body' })
      if (raw.length > 10 * 1024 * 1024) return sendJson(res, 413, { ok: false, error: 'zip > 10MB' })
      let zip
      try { zip = await JSZip.loadAsync(raw) } catch (e) {
        return sendJson(res, 400, { ok: false, error: `zip parse: ${e.message}` })
      }
      const agentMdFile = zip.file('agent.md')
      if (!agentMdFile) return sendJson(res, 400, { ok: false, error: 'agent.md missing in zip' })
      const source = await agentMdFile.async('string')
      const parsed = parseAgentMarkdown(source)
      const finalName = (overrideName && overrideName.trim()) || parsed.name
      let agent
      try {
        agent = createAgent({
          userId, name: finalName,
          soulMd: parsed.soulMd,
          identityMd: parsed.identityMd,
          avatarUrl: parsed.avatarUrl,
          isDefault: false,
        })
      } catch (e) {
        return sendJson(res, 409, { ok: false, error: e.message })
      }
      // 导入 memories/*.md，绑定到新 agent
      const memoryFiles = []
      zip.folder('memories')?.forEach((rel, file) => {
        if (!file.dir && rel.endsWith('.md')) memoryFiles.push(file)
      })
      let importedCount = 0
      for (const mf of memoryFiles) {
        try {
          const text = await mf.async('string')
          const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
          if (!m) continue
          const meta = JSON.parse(m[1])
          const body = m[2].replace(/\n$/, '')
          if (!meta?.title || !body) continue
          upsertMemory({
            userId,
            type: meta.type || 'reference',
            title: meta.title,
            body,
            pinned: !!meta.pinned,
            frontmatter: meta.frontmatter || {},
            agentId: agent.id,
          })
          importedCount += 1
        } catch { /* skip bad memory file */ }
      }
      return sendJson(res, 200, { ok: true, agent, memoriesImported: importedCount })
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
