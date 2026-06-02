/**
 * Per-user 工具权限路由(功能补全 — PermissionsDashboard 真 gate)。
 *
 *   GET  /api/tool-permissions          → { ok, permissions: { toolName: bool } }(仅显式覆盖)
 *   POST /api/tool-permissions          → body { toolName, enabled } 设置单个
 *
 * 后端是权威:工具执行入口(fsShellTools)会查这张表;前端开关只是同步到这里。
 */
import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import { getUserToolPermissions, setUserToolPermission } from '../db.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }
function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

// 可被 gate 的真实后端工具(仅这些允许写覆盖,防止前端塞任意名字)。
export const GATEABLE_TOOLS = ['bash_exec', 'write_file', 'edit_file']

export async function handleToolPermissionsRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { ok: false, error: '请先登录' })
  const url = new URL(req.url, 'http://localhost')

  try {
    if (req.method === 'GET' && url.pathname === '/api/tool-permissions') {
      return sendJson(res, 200, {
        ok: true,
        gateable: GATEABLE_TOOLS,
        permissions: getUserToolPermissions(userId),
      })
    }

    if (req.method === 'POST' && url.pathname === '/api/tool-permissions') {
      const body = await readJson(req)
      const toolName = String(body.toolName || '')
      if (!GATEABLE_TOOLS.includes(toolName)) {
        return sendJson(res, 400, { ok: false, error: `不支持 gate 的工具: ${toolName}` })
      }
      setUserToolPermission({ userId, toolName, enabled: !!body.enabled })
      return sendJson(res, 200, { ok: true, permissions: getUserToolPermissions(userId) })
    }

    return sendJson(res, 404, { ok: false, error: '未知路由' })
  } catch (err) {
    return sendJson(res, err?.statusCode || 400, { ok: false, error: err?.message || String(err) })
  }
}
