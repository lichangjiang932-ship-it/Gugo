import { WEB_SEARCH_PROVIDERS } from '../../shared/webSearchProviders.js'
import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import { deleteWebSearchConfig, getWebSearchConfig } from '../services/webSearchConfigStore.js'
import { configureWebSearch, testWebSearch } from '../services/webSearchService.js'

function statusForError(error) {
  return Number(error?.statusCode) || 400
}

export async function handleWebSearchRequest(req, res, { fetchImpl = fetch } = {}) {
  const url = new URL(req.url, 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  if (req.method === 'GET' && parts[2] === 'providers') {
    return sendJson(res, 200, { ok: true, providers: WEB_SEARCH_PROVIDERS })
  }
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { ok: false, error: 'Unauthorized' })
  try {
    if (req.method === 'GET' && parts.length === 2) {
      return sendJson(res, 200, { ok: true, config: getWebSearchConfig({ userId }) })
    }
    if (req.method === 'PUT' && parts.length === 2) {
      const body = await readJson(req)
      const config = configureWebSearch({
        userId,
        enabled: body.enabled !== false,
        ...(Array.isArray(body.connections)
          ? { connections: body.connections, strategy: body.strategy }
          : {
              provider: body.provider,
              config: body.config,
              ...(Object.hasOwn(body, 'apiKey') ? { apiKey: body.apiKey } : {}),
            }),
      })
      return sendJson(res, 200, { ok: true, config })
    }
    if (req.method === 'POST' && parts[2] === 'test') {
      const body = await readJson(req)
      return sendJson(res, 200, {
        ok: true,
        result: await testWebSearch({ userId, connectionId: body.connectionId, fetchImpl }),
      })
    }
    if (req.method === 'DELETE' && parts.length === 2) {
      return sendJson(res, 200, { ok: true, removed: deleteWebSearchConfig({ userId }) })
    }
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' })
  } catch (error) {
    return sendJson(res, statusForError(error), {
      ok: false,
      error: error?.message || 'Web search configuration failed',
      code: error?.code || 'WEB_SEARCH_ERROR',
    })
  }
}
