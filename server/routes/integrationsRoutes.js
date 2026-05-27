import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import {
  deleteIntegration,
  listIntegrations,
  listProviderRegistry,
  setIntegrationEnabled,
  testIntegration,
  upsertIntegration,
} from '../services/integrationsStore.js'

function unauthorized(res) { return sendJson(res, 401, { ok: false, error: 'Unauthorized' }) }

function statusForError(err) {
  if (err?.statusCode) return err.statusCode
  return 400
}

export async function handleIntegrationsRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  // 路由：/api/integrations[/providers | /:id | /:id/test | /:id/enabled]

  // 公共：GET /api/integrations/providers — 列出可用 provider 元数据
  if (req.method === 'GET' && parts[2] === 'providers') {
    return sendJson(res, 200, { ok: true, providers: listProviderRegistry() })
  }

  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)

  try {
    if (req.method === 'GET' && parts.length === 2) {
      const kind = url.searchParams.get('kind') || null
      return sendJson(res, 200, { ok: true, integrations: listIntegrations({ userId, kind }) })
    }

    if (req.method === 'POST' && parts.length === 2) {
      const body = await readJson(req)
      const integration = upsertIntegration({
        userId,
        provider: body.provider,
        name: body.name,
        enabled: body.enabled,
        config: body.config,
        secret: body.secret,
      })
      return sendJson(res, 200, { ok: true, integration })
    }

    if (req.method === 'PATCH' && parts.length === 3) {
      const id = decodeURIComponent(parts[2])
      const body = await readJson(req)
      const integration = upsertIntegration({
        userId,
        id,
        provider: body.provider,
        name: body.name,
        enabled: body.enabled,
        config: body.config,
        secret: body.secret,
      })
      return sendJson(res, 200, { ok: true, integration })
    }

    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'enabled') {
      const id = decodeURIComponent(parts[2])
      const body = await readJson(req)
      const integration = setIntegrationEnabled({ userId, id, enabled: !!body.enabled })
      return sendJson(res, 200, { ok: true, integration })
    }

    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'test') {
      const id = decodeURIComponent(parts[2])
      const result = await testIntegration({ userId, id })
      return sendJson(res, 200, { ok: true, result })
    }

    if (req.method === 'DELETE' && parts.length === 3) {
      const id = decodeURIComponent(parts[2])
      const removed = deleteIntegration({ userId, id })
      return sendJson(res, removed ? 200 : 404, { ok: removed })
    }
  } catch (err) {
    return sendJson(res, statusForError(err), { ok: false, error: err.message || 'integration error' })
  }

  return sendJson(res, 404, { ok: false, error: 'unknown integrations route' })
}
