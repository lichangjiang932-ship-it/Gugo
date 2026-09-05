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
import {
  listImportedSkills,
  getImportedSkill,
  installSkill,
} from '../services/skillStore.js'
import { resolveImportedSkillId } from '../services/skillImport.js'
import { listAllRuntimeSkillIds } from '../services/skillRegistry.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function unauthorized(res) {
  sendJson(res, 401, { ok: false, error: '请先登录' })
}

async function exportAgentZip(req, res, url, userId, agentId) {
  const agent = getAgent({ userId, id: agentId })
  if (!agent) return sendJson(res, 404, { ok: false, error: 'agent 不存在' })
  const includeMemories = url.searchParams.get('memories') !== '0'
  const includeSkills = url.searchParams.get('skills') !== '0'
  const includeAvatar = url.searchParams.get('avatar') !== '0'
  const zip = new JSZip()
  let avatarFile = null
  if (includeAvatar && agent.avatarUrl && agent.avatarUrl.startsWith('data:')) {
    const match = agent.avatarUrl.match(/^data:(image\/(png|jpeg|jpg|webp|gif));base64,(.+)$/)
    if (match) {
      const ext = match[2] === 'jpeg' ? 'jpg' : match[2]
      const bytes = Buffer.from(match[3], 'base64')
      if (bytes.length <= 2 * 1024 * 1024) {
        avatarFile = `avatar.${ext}`
        zip.file(avatarFile, bytes)
      }
    }
  }
  const exportedSkills = []
  if (includeSkills) {
    const userSkills = listImportedSkills({ userId }).filter((skill) => !skill.system)
    for (const skill of userSkills) {
      const full = getImportedSkill(skill.id, { userId })
      if (!full) continue
      const dir = `skills/${skill.id}`
      zip.file(`${dir}/skill.json`, JSON.stringify({
        id: full.id,
        name: full.name,
        description: full.description,
        version: full.version,
        icon: full.icon,
        permissions: full.permissions || [],
      }, null, 2))
      for (const [path, content] of Object.entries(full.files || {})) {
        if (path !== 'skill.json') zip.file(`${dir}/${path}`, content)
      }
      exportedSkills.push(skill.id)
    }
  }
  zip.file('manifest.json', JSON.stringify({
    format: 'yma-agent-card',
    version: '0.3',
    exportedAt: new Date().toISOString(),
    agent: {
      name: agent.name,
      personaTemplate: agent.personaTemplate || '',
      personaManifest: agent.personaManifest,
      isDefault: false,
      hasAvatar: !!agent.avatarUrl,
    },
    avatarFile,
    skills: exportedSkills,
    memoriesIncluded: includeMemories,
  }, null, 2))
  zip.file('agent.md', serializeAgentMarkdown(agent))
  if (includeMemories) {
    const memories = listMemories({ userId, agentFilter: agent.id, limit: 500 })
    memories.forEach((memory, index) => {
      const slug = memory.slug || String(index)
      const frontmatter = JSON.stringify({
        type: memory.type,
        title: memory.title,
        pinned: !!memory.pinned,
        frontmatter: memory.frontmatter || {},
      })
      zip.file(`memories/${slug}.md`, `---\n${frontmatter}\n---\n${memory.body || ''}\n`)
    })
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(agent.name)}.agent.zip"`,
    'Content-Length': bytes.length,
  })
  res.end(bytes)
  return undefined
}

async function readAgentZipRequest(req, res) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)
  if (raw.length === 0) {
    sendJson(res, 400, { ok: false, error: 'empty body' })
    return null
  }
  if (raw.length > 10 * 1024 * 1024) {
    sendJson(res, 413, { ok: false, error: 'zip > 10MB' })
    return null
  }
  try {
    return await JSZip.loadAsync(raw)
  } catch (error) {
    sendJson(res, 400, { ok: false, error: `zip parse: ${error.message}` })
    return null
  }
}

async function importAgentZipMemories(zip, { userId, agentId }) {
  const memoryFiles = []
  zip.folder('memories')?.forEach((relativePath, file) => {
    if (!file.dir && relativePath.endsWith('.md')) memoryFiles.push(file)
  })
  let importedCount = 0
  for (const file of memoryFiles) {
    try {
      const text = await file.async('string')
      const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
      if (!match) continue
      const metadata = JSON.parse(match[1])
      const body = match[2].replace(/\n$/, '')
      if (!metadata?.title || !body) continue
      upsertMemory({
        userId,
        type: metadata.type || 'reference',
        title: metadata.title,
        body,
        pinned: !!metadata.pinned,
        frontmatter: metadata.frontmatter || {},
        agentId,
      })
      importedCount += 1
    } catch { /* skip bad memory file */ }
  }
  return importedCount
}

async function importAgentZipSkills(zip, userId) {
  const skillPaths = new Map()
  zip.folder('skills')?.forEach((relativePath, file) => {
    if (file.dir) return
    const parts = relativePath.split('/')
    if (parts.length < 2) return
    const skillId = parts[0]
    const inner = parts.slice(1).join('/')
    if (!skillPaths.has(skillId)) skillPaths.set(skillId, [])
    skillPaths.get(skillId).push({ inner, file })
  })
  let importedSkills = 0
  const skillImportErrors = []
  for (const [originalId, entries] of skillPaths) {
    try {
      const files = {}
      for (const { inner, file } of entries) files[inner] = await file.async('string')
      if (!files['skill.json']) continue
      const metadata = JSON.parse(files['skill.json'])
      if (!metadata?.id || !metadata?.name || !metadata?.version
        || !metadata?.icon || !metadata?.description) {
        skillImportErrors.push(`${originalId}: skill.json 缺字段`)
        continue
      }
      const finalId = resolveImportedSkillId(metadata.id, listAllRuntimeSkillIds())
      const rewrittenFiles = {
        ...files,
        'skill.json': JSON.stringify({ ...metadata, id: finalId }, null, 2),
      }
      installSkill({
        id: finalId,
        userId,
        name: metadata.name,
        description: metadata.description,
        version: metadata.version,
        icon: metadata.icon,
        permissions: Array.isArray(metadata.permissions) ? metadata.permissions : [],
        files: rewrittenFiles,
      })
      importedSkills += 1
    } catch (error) {
      skillImportErrors.push(`${originalId}: ${error.message}`)
    }
  }
  return { importedSkills, skillImportErrors }
}

async function importAgentZip(req, res, url, userId) {
  const zip = await readAgentZipRequest(req, res)
  if (!zip) return undefined
  const agentMdFile = zip.file('agent.md')
  if (!agentMdFile) return sendJson(res, 400, { ok: false, error: 'agent.md missing in zip' })
  const parsed = parseAgentMarkdown(await agentMdFile.async('string'))
  const overrideName = url.searchParams.get('overrideName') || null
  const finalName = (overrideName && overrideName.trim()) || parsed.name
  let manifest = null
  const manifestFile = zip.file('manifest.json')
  if (manifestFile) {
    try { manifest = JSON.parse(await manifestFile.async('string')) }
    catch { /* ignore bad legacy manifest */ }
  }
  let finalAvatarUrl = parsed.avatarUrl
  const avatarName = manifest?.avatarFile
  if (avatarName && typeof avatarName === 'string'
    && /^avatar\.(png|jpg|jpeg|webp|gif)$/i.test(avatarName)) {
    const avatar = zip.file(avatarName)
    if (avatar) {
      const bytes = await avatar.async('nodebuffer')
      if (bytes.length <= 2 * 1024 * 1024) {
        const ext = avatarName.split('.').pop().toLowerCase()
        const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
        finalAvatarUrl = `data:${mime};base64,${bytes.toString('base64')}`
      }
    }
  }
  let agent
  try {
    agent = createAgent({
      userId,
      name: finalName,
      soulMd: parsed.soulMd,
      identityMd: parsed.identityMd,
      personaTemplate: parsed.personaTemplate || '',
      personaManifest: manifest?.agent?.personaManifest || parsed.personaManifest,
      avatarUrl: finalAvatarUrl,
      isDefault: false,
    })
  } catch (error) {
    return sendJson(res, 409, { ok: false, error: error.message })
  }
  const memoriesImported = await importAgentZipMemories(zip, { userId, agentId: agent.id })
  const { importedSkills } = await importAgentZipSkills(zip, userId)
  return sendJson(res, 200, {
    ok: true,
    agent,
    memoriesImported,
    skillsImported: importedSkills,
  })
}

async function handleAgentItem(req, res, userId, id) {
  if (req.method === 'GET') {
    const agent = getAgent({ userId, id })
    if (!agent) return sendJson(res, 404, { ok: false, error: 'agent 不存在' })
    return sendJson(res, 200, { ok: true, agent })
  }
  if (req.method === 'PATCH') {
    const agent = updateAgent({ userId, id, patch: await readJson(req) })
    if (!agent) return sendJson(res, 404, { ok: false, error: 'agent 不存在' })
    return sendJson(res, 200, { ok: true, agent })
  }
  if (req.method === 'DELETE') {
    if (!deleteAgent({ userId, id })) {
      return sendJson(res, 404, { ok: false, error: 'agent 不存在' })
    }
    return sendJson(res, 200, { ok: true })
  }
  return sendJson(res, 405, { ok: false, error: 'method not allowed' })
}

export async function handleAgentRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname
  try {
    if (req.method === 'GET' && pathname === '/api/agents') {
      return sendJson(res, 200, { ok: true, agents: listAgents({ userId }) })
    }
    if (req.method === 'GET' && pathname === '/api/agents/default') {
      const agent = getDefaultAgent({ userId }) || ensureDefaultAgent({ userId })
      return sendJson(res, 200, { ok: true, agent })
    }
    if (req.method === 'POST' && pathname === '/api/agents') {
      const body = await readJson(req)
      const agent = createAgent({
        userId,
        name: body.name,
        soulMd: body.soulMd || '',
        identityMd: body.identityMd || '',
        personaTemplate: body.personaTemplate || body.persona_template || '',
        personaManifest: body.personaManifest || body.persona_manifest || null,
        avatarUrl: body.avatarUrl || null,
        isDefault: !!body.isDefault,
      })
      return sendJson(res, 200, { ok: true, agent })
    }
    if (req.method === 'POST' && pathname === '/api/agents/import') {
      const body = await readJson(req)
      const parsed = parseAgentMarkdown(String(body?.source || ''))
      const agent = createAgent({
        userId,
        name: (body?.overrideName && String(body.overrideName).trim()) || parsed.name,
        soulMd: parsed.soulMd,
        identityMd: parsed.identityMd,
        personaTemplate: parsed.personaTemplate || '',
        personaManifest: parsed.personaManifest,
        avatarUrl: parsed.avatarUrl,
        isDefault: false,
      })
      return sendJson(res, 200, { ok: true, agent })
    }
    const exportZipMatch = pathname.match(/^\/api\/agents\/([A-Za-z0-9_-]+)\/export\.zip$/)
    if (exportZipMatch && req.method === 'GET') {
      return await exportAgentZip(req, res, url, userId, exportZipMatch[1])
    }
    if (req.method === 'POST' && pathname === '/api/agents/import.zip') {
      return await importAgentZip(req, res, url, userId)
    }
    const exportMatch = pathname.match(/^\/api\/agents\/([A-Za-z0-9_-]+)\/export$/)
    if (exportMatch && req.method === 'GET') {
      const agent = getAgent({ userId, id: exportMatch[1] })
      if (!agent) return sendJson(res, 404, { ok: false, error: 'agent 不存在' })
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(agent.name)}.agent.md"`,
      })
      res.end(serializeAgentMarkdown(agent))
      return undefined
    }
    const idMatch = pathname.match(/^\/api\/agents\/([A-Za-z0-9_-]+)$/)
    if (idMatch) return await handleAgentItem(req, res, userId, idMatch[1])
    return sendJson(res, 404, { ok: false, error: 'unknown agent route' })
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: error.message || String(error) })
  }
}
