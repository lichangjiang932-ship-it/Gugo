/**
 * server/routes/pluginRoutes.js
 *
 * 只读公开端点：
 *   GET /api/plugins              → 列出所有 plugin（可选 ?type=ppt-theme 过滤）
 *   GET /api/plugins/:id          → plugin 详情 + entry 内容预览（限 50KB）
 *
 * 严格只读：不实现 POST/PUT/DELETE。匿名可访问（plugin 元数据是公开静态资源）。
 */

import fs from 'node:fs'
import { getPlugin, listPlugins } from '../plugins/pluginRegistry.js'
import { authenticateRequest } from '../middleware.js'
import { installPluginAsSkill } from '../services/pluginToSkill.js'
import { listAllSkillIds } from '../services/skillStore.js'
import { sendJson } from '../utils.js'

const ENTRY_PREVIEW_LIMIT = 50 * 1024

function publicView(p) {
  if (!p) return null
  // 不暴露绝对路径
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    type: p.type,
    entry: p.entry,
    description: p.description,
    author: p.author,
    license: p.license,
    tags: p.tags,
    dir: p.dir,
  }
}

function readEntryPreview(p) {
  try {
    const stat = fs.statSync(p.entryPath)
    const size = stat.size
    const fd = fs.openSync(p.entryPath, 'r')
    const readBytes = Math.min(size, ENTRY_PREVIEW_LIMIT)
    const buf = Buffer.alloc(readBytes)
    fs.readSync(fd, buf, 0, readBytes, 0)
    fs.closeSync(fd)
    return {
      size,
      truncated: size > ENTRY_PREVIEW_LIMIT,
      bytes: readBytes,
      content: buf.toString('utf8'),
    }
  } catch (err) {
    return { error: err.message }
  }
}

export async function handlePluginRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')

  // POST /api/plugins/:id/install-as-skill — 需登录，将 skill-bundle plugin 装为用户 skill
  const installMatch = url.pathname.match(/^\/api\/plugins\/([a-z0-9][a-z0-9-]*)\/install-as-skill$/i)
  if (installMatch && req.method === 'POST') {
    const userId = authenticateRequest(req)
    if (!userId) return sendJson(res, 401, { error: 'Unauthorized' })
    const existingIds = listAllSkillIds()
    const result = installPluginAsSkill({ pluginId: installMatch[1], userId, existingIds })
    if (!result.ok) {
      const status = /not found/i.test(result.reason) ? 404
        : /类型必须|缺少|路径越界|文件过大|超限/.test(result.reason) ? 400
        : 409
      return sendJson(res, status, { ok: false, error: result.reason })
    }
    return sendJson(res, 200, { ok: true, skill: result.skill })
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'method not allowed' })
  }

  if (url.pathname === '/api/plugins') {
    const type = url.searchParams.get('type') || undefined
    const plugins = listPlugins({ type }).map(publicView)
    return sendJson(res, 200, { plugins })
  }

  const m = url.pathname.match(/^\/api\/plugins\/([a-z0-9][a-z0-9-]*)$/i)
  if (m) {
    const internal = getPlugin(m[1])
    if (!internal) return sendJson(res, 404, { error: 'plugin not found' })
    return sendJson(res, 200, {
      plugin: publicView(internal),
      entryPreview: readEntryPreview(internal),
    })
  }

  return sendJson(res, 404, { error: 'not found' })
}
