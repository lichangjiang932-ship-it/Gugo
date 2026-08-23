import { authenticateRequest } from '../middleware.js'
import { listEffectiveCapabilityInventory } from '../services/capabilityInventoryService.js'
import { CAPABILITY_INVENTORY_SCHEMA_VERSION } from '../../shared/capabilityInventory.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, { ...JSON_HEADERS, ...headers })
  res.end(JSON.stringify(body))
}

export function handleCapabilityInventoryRequest(req, res, {
  listCapabilities = listEffectiveCapabilityInventory,
} = {}) {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/api/capabilities/effective') {
    return sendJson(res, 404, {
      ok: false,
      error: { code: 'NOT_FOUND', message: '能力清单接口不存在' },
    }, { 'Cache-Control': 'private, no-store' })
  }
  const userId = authenticateRequest(req)
  if (!userId) {
    return sendJson(res, 401, {
      ok: false,
      error: { code: 'UNAUTHORIZED', message: '请先登录' },
    }, { 'Cache-Control': 'private, no-store' })
  }
  if (req.method !== 'GET') {
    return sendJson(res, 405, {
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET 请求' },
    }, { Allow: 'GET', 'Cache-Control': 'private, no-store' })
  }
  if ([...url.searchParams.keys()].length > 0) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'INVALID_QUERY', message: '该接口不接受查询参数' },
    }, { 'Cache-Control': 'private, no-store' })
  }
  try {
    const capabilities = listCapabilities({ userId })
    return sendJson(res, 200, {
      ok: true,
      schemaVersion: CAPABILITY_INVENTORY_SCHEMA_VERSION,
      capabilities,
    }, { 'Cache-Control': 'private, no-store' })
  } catch {
    return sendJson(res, 500, {
      ok: false,
      error: { code: 'CAPABILITY_INVENTORY_FAILED', message: '读取能力清单失败' },
    }, { 'Cache-Control': 'private, no-store' })
  }
}
