import { authenticateRequest } from '../middleware.js'
import { installValidatedSkillPack } from '../services/skillImport.js'
import { listRuntimeSkillIds, listRuntimeSkills } from '../services/skillRegistry.js'
import { getImportedSkill } from '../services/skillStore.js'
import { readJson, sendJson } from '../utils.js'

const ASSET_MIME = {
  '.svg': 'image/svg+xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function pickMime(p) {
  const m = p.match(/\.[a-z0-9]+$/i)
  return (m && ASSET_MIME[m[0].toLowerCase()]) || 'text/plain; charset=utf-8'
}

function sendAsset(res, content, assetPath) {
  res.writeHead(200, {
    'Content-Type': pickMime(assetPath),
    'Cache-Control': 'public, max-age=3600',
  })
  res.end(content)
}

export async function handleSkillRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')

  // 系统级技能 (user_id IS NULL) 公开匿名可读，其余路由要求登录
  const userId = authenticateRequest(req)
  const isReadPath = req.method === 'GET' && /^\/api\/skills\/[a-z0-9_-]+\/(manifest|assets\/.+)$/i.test(url.pathname)
  if (!userId && !isReadPath) return sendJson(res, 401, { error: 'Unauthorized' })

  if (req.method === 'GET' && url.pathname === '/api/skills') {
    return sendJson(res, 200, { skills: listRuntimeSkills({ userId }) })
  }

  // GET /api/skills/<id>/manifest  ⇒  list 文件清单 + skill.json
  let m = url.pathname.match(/^\/api\/skills\/([a-z0-9_-]+)\/manifest$/i)
  if (req.method === 'GET' && m) {
    const skill = getImportedSkill(m[1], { userId })
    if (!skill) return sendJson(res, 404, { error: 'skill not found' })
    let manifest = null
    try {
      manifest = JSON.parse(skill.files['skill.json'] || '{}')
    } catch { /* ignore */ }
    return sendJson(res, 200, {
      id: skill.id,
      system: skill.userId == null,
      manifest,
      files: Object.keys(skill.files).sort(),
    })
  }

  // GET /api/skills/<id>/assets/<...>  ⇒  返回单个素材
  m = url.pathname.match(/^\/api\/skills\/([a-z0-9_-]+)\/assets\/(.+)$/i)
  if (req.method === 'GET' && m) {
    const [, skillId, rawAssetPath] = m
    const assetPath = decodeURIComponent(rawAssetPath).replace(/\\/g, '/')
    if (assetPath.includes('..')) return sendJson(res, 400, { error: 'bad path' })
    const skill = getImportedSkill(skillId, { userId })
    if (!skill) return sendJson(res, 404, { error: 'skill not found' })
    const content = skill.files[assetPath]
    if (content == null) return sendJson(res, 404, { error: 'asset not found' })
    return sendAsset(res, content, assetPath)
  }

  if (req.method === 'POST' && url.pathname === '/api/skills/import') {
    const body = await readJson(req)
    const result = installValidatedSkillPack({
      files: body.files || {},
      existingIds: listRuntimeSkillIds({ userId }),
      userId,
    })
    if (!result.ok) return sendJson(res, 400, { error: result.reason })
    return sendJson(res, 201, { skill: result.skill })
  }

  return sendJson(res, 404, { error: 'not found' })
}
