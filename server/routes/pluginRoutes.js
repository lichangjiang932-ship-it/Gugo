/**
 * server/routes/pluginRoutes.js
 *
 * 公开 GET 端点 + 受控登录 POST：
 *   GET /api/plugins              → 列出所有 plugin（可选 ?type=ppt-theme 过滤）
 *   GET /api/plugins/:id          → plugin 详情 + entry 内容预览（限 50KB）
 *   POST /api/plugins/:id/run-sandbox → 登录后运行 transformer 沙箱
 *   POST /api/plugins/:id/install-as-skill → 登录后安装 skill-bundle
 */

import fs from 'node:fs'
import { isIP } from 'node:net'
import { getPlugin, listPlugins } from '../plugins/pluginRegistry.js'
import { runTransformer } from '../plugins/pluginSandbox.js'
import { isLocalOwnerUser } from '../adapters/authAccount.js'
import { authenticateRequest } from '../middleware.js'
import { installPluginAsSkill } from '../services/pluginToSkill.js'
import { listAllRuntimeSkillIds } from '../services/skillRegistry.js'
import {
  disableRuntimePlugin,
  enableRuntimePlugin,
  listRuntimePluginInventory,
} from '../services/runtimePluginControlService.js'
import { readJson, sendJson } from '../utils.js'

const ENTRY_PREVIEW_LIMIT = 50 * 1024
const SANDBOX_INPUT_LIMIT = 64 * 1024

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

function isSandboxInput(input) {
  return typeof input === 'string' || (input !== null && typeof input === 'object')
}

function serializedInputSize(input) {
  return Buffer.byteLength(JSON.stringify(input), 'utf8')
}

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || '').trim().toLowerCase()
  if (isIP(address) === 4) return Number(address.split('.')[0]) === 127
  if (isIP(address) !== 6) return false
  try {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
    if (normalized === '::1') return true
    const mapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    return mapped ? (Number.parseInt(mapped[1], 16) >> 8) === 127 : false
  } catch {
    return false
  }
}

function authorizeRuntimeControl(req, res, env) {
  const userId = authenticateRequest(req)
  if (!userId) {
    sendJson(res, 401, {
      ok: false,
      error: { code: 'UNAUTHORIZED', message: '请先登录' },
    })
    return null
  }
  if (!isLoopbackRequest(req) || !isLocalOwnerUser(userId, env)) {
    sendJson(res, 403, {
      ok: false,
      error: {
        code: 'LOCAL_OWNER_ONLY',
        message: '运行时插件只能由服务宿主机的本地所有者管理',
      },
    })
    return null
  }
  return userId
}

function runtimeControlError(res, error) {
  const status = Number(error?.statusCode) || 500
  return sendJson(res, status, {
    ok: false,
    error: {
      code: error?.code || 'RUNTIME_PLUGIN_CONTROL_FAILED',
      message: status >= 500 ? '运行时插件操作失败' : error?.message || '运行时插件操作失败',
    },
  })
}

export async function handlePluginRequest(req, res, { env = process.env } = {}) {
  const url = new URL(req.url, 'http://localhost')

  const runtimeAction = url.pathname.match(
    /^\/api\/plugins\/runtime\/([a-z0-9][a-z0-9-]*)\/(enable|disable)$/i,
  )
  if (url.pathname === '/api/plugins/runtime' || runtimeAction) {
    if (!authorizeRuntimeControl(req, res, env)) return
    if (url.pathname === '/api/plugins/runtime') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, {
          ok: false,
          error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' },
        })
      }
      return sendJson(res, 200, { ok: true, plugins: listRuntimePluginInventory() })
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, {
        ok: false,
        error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' },
      })
    }
    try {
      const plugin = runtimeAction[2].toLowerCase() === 'enable'
        ? await enableRuntimePlugin(runtimeAction[1])
        : await disableRuntimePlugin(runtimeAction[1])
      return sendJson(res, 200, { ok: true, plugin })
    } catch (error) {
      return runtimeControlError(res, error)
    }
  }

  // POST /api/plugins/:id/run-sandbox — 需登录，运行 transformer plugin 的受限入口
  const sandboxMatch = url.pathname.match(/^\/api\/plugins\/([a-z0-9][a-z0-9-]*)\/run-sandbox$/i)
  if (sandboxMatch && req.method === 'POST') {
    const userId = authenticateRequest(req)
    if (!userId) return sendJson(res, 401, { error: 'Unauthorized' })

    const internal = getPlugin(sandboxMatch[1])
    if (!internal) return sendJson(res, 404, { error: 'plugin not found' })
    if (internal.type !== 'transformer') {
      return sendJson(res, 400, { error: 'plugin type must be transformer' })
    }

    let body
    try {
      body = await readJson(req, { maxBytes: 128 * 1024 })
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'invalid json' })
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'input') || !isSandboxInput(body.input)) {
      return sendJson(res, 400, { error: 'input must be string or object' })
    }
    if (serializedInputSize(body.input) > SANDBOX_INPUT_LIMIT) {
      return sendJson(res, 400, { error: 'input exceeds 64KB' })
    }

    try {
      const source = fs.readFileSync(internal.entryPath, 'utf8')
      const result = await runTransformer({
        plugin: { ...internal, source },
        input: body.input,
        capabilities: internal.capabilities || [],
      })
      return sendJson(res, 200, result)
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message || 'sandbox internal error' })
    }
  }

  // POST /api/plugins/:id/install-as-skill — 需登录，将 skill-bundle plugin 装为用户 skill
  const installMatch = url.pathname.match(/^\/api\/plugins\/([a-z0-9][a-z0-9-]*)\/install-as-skill$/i)
  if (installMatch && req.method === 'POST') {
    const userId = authenticateRequest(req)
    if (!userId) return sendJson(res, 401, { error: 'Unauthorized' })
    const existingIds = listAllRuntimeSkillIds()
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
