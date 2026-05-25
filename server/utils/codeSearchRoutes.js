/**
 * /api/tools/code/* HTTP handler。
 *
 * 三个只读端点:
 *   - POST /api/tools/code/grep          -> grepCodeTool
 *   - POST /api/tools/code/find-symbol   -> findSymbolTool
 *   - POST /api/tools/code/list-imports  -> listImportsTool
 *
 * 鉴权:复用 authenticateRequest(与 fs/shell 同等级,仅登录用户)。
 * 只读 + 路径沙箱 → 风险等级低于 bash_exec,无需 WORKSPACE_*_ENABLED。
 */

import { authenticateRequest } from '../middleware.js'
import { grepCodeTool, findSymbolTool, listImportsTool } from './codeSearch.js'
import { applyPatchTool } from './applyPatch.js'
import { writeToolAudit } from './audit.js'

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 1_000_000) req.destroy() })
    req.on('end', () => {
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('invalid JSON')) }
    })
    req.on('error', reject)
  })
}

export async function handleCodeSearchRequest(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '仅支持 POST' })
    return
  }
  if (!authenticateRequest(req)) {
    sendJson(res, 401, { ok: false, error: '请先登录' })
    return
  }
  const url = req.url || ''
  const startedAt = Date.now()
  let toolName = 'unknown'
  let auditArgs = null
  try {
    const body = await readJson(req)
    auditArgs = body
    let result
    if (url.startsWith('/api/tools/code/grep')) { toolName = 'grep_code'; result = await grepCodeTool(body) }
    else if (url.startsWith('/api/tools/code/find-symbol')) { toolName = 'find_symbol'; result = await findSymbolTool(body) }
    else if (url.startsWith('/api/tools/code/list-imports')) { toolName = 'list_imports'; result = await listImportsTool(body) }
    else if (url.startsWith('/api/tools/code/apply-patch')) { toolName = 'apply_patch'; result = await applyPatchTool({ ...body, userId: req.userId }) }
    else { sendJson(res, 404, { ok: false, error: '未知端点' }); return }
    writeToolAudit({
      userId: req.userId,
      origin: 'code',
      toolName,
      args: auditArgs,
      status: result?.ok === false ? 'error' : 'ok',
      durationMs: Date.now() - startedAt,
    })
    sendJson(res, 200, result)
  } catch (err) {
    writeToolAudit({
      userId: req.userId,
      origin: 'code',
      toolName,
      args: auditArgs,
      status: 'error',
      durationMs: Date.now() - startedAt,
    })
    const status = err?.statusCode || 500
    sendJson(res, status, { ok: false, error: err?.message || 'code search failed' })
  }
}
