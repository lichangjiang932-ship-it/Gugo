/**
 * /api/tools/agent/{reflect,clarify} — M3 思维型工具的 HTTP 端点。
 *
 * 这两个工具无副作用,但仍需鉴权(避免匿名滥发);
 * audit 入 origin='agent',便于追踪模型反思/求助习惯。
 */

import { authenticateRequest } from '../middleware.js'
import { reflectTool, requestClarificationTool } from './agenticTools.js'
import { writeToolAudit } from './audit.js'

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 200_000) req.destroy() })
    req.on('end', () => {
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('invalid JSON')) }
    })
    req.on('error', reject)
  })
}

export async function handleAgenticToolRequest(req, res) {
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
    if (url.startsWith('/api/tools/agent/reflect')) {
      toolName = 'reflect'
      result = reflectTool(body)
    } else if (url.startsWith('/api/tools/agent/clarify')) {
      toolName = 'request_clarification'
      result = requestClarificationTool(body)
    } else {
      sendJson(res, 404, { ok: false, error: '未知端点' })
      return
    }
    writeToolAudit({
      userId: req.userId,
      origin: 'agent',
      toolName,
      args: auditArgs,
      status: 'ok',
      durationMs: Date.now() - startedAt,
    })
    sendJson(res, 200, result)
  } catch (err) {
    writeToolAudit({
      userId: req.userId,
      origin: 'agent',
      toolName,
      args: auditArgs,
      status: 'error',
      durationMs: Date.now() - startedAt,
    })
    sendJson(res, err?.statusCode || 500, { ok: false, error: err?.message || 'agentic tool failed' })
  }
}
