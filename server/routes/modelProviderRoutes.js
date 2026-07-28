import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import {
  deleteModelProvider,
  getModelProvider,
  listModelProviders,
  upsertModelProvider,
} from '../services/modelProviderStore.js'
import {
  callBackgroundModel,
  formatProxyError,
  getRuntimeEnv,
  getSystemDiagnostics,
} from '../adapters/modelProxy.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function buildProviderTestEnv(provider) {
  return {
    ...getRuntimeEnv(),
    MODEL_PROVIDERS: 'selected',
    MODEL_PROVIDER_SELECTED_BASE_URL: provider.baseUrl,
    MODEL_PROVIDER_SELECTED_API_KEY: provider.apiKey || '',
    MODEL_PROVIDER_SELECTED_MODELS: (provider.models || []).join(','),
    MODEL_PROVIDER_SELECTED_HEADERS: JSON.stringify(provider.headers || {}),
    MODEL_NAME: provider.defaultModel,
    MODEL_TEMPERATURE: '0',
    MODEL_MAX_TOKENS: '32',
  }
}

export async function handleModelProviderRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: '请先登录' } })
  const url = new URL(req.url, 'http://localhost')
  const base = '/api/model/providers'
  const suffix = url.pathname.slice(base.length).replace(/^\//, '')
  const [id, action] = suffix.split('/')
  try {
    if (req.method === 'POST' && id === 'discover' && !action) {
      const body = await readJson(req)
      const existing = body?.id ? getModelProvider({ userId, id: body.id, includeSecrets: true }) : null
      const submittedHeaders = body?.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)
        ? body.headers
        : {}
      const headers = Object.keys(submittedHeaders).length ? submittedHeaders : (existing?.headers || {})
      const env = {
        MODEL_PROVIDERS: 'probe',
        MODEL_PROVIDER_PROBE_BASE_URL: String(body?.baseUrl || '').trim(),
        MODEL_PROVIDER_PROBE_API_KEY: String(body?.apiKey || '').trim() || existing?.apiKey || '',
        MODEL_PROVIDER_PROBE_MODELS: 'probe-model',
        MODEL_PROVIDER_PROBE_HEADERS: JSON.stringify(headers),
        MODEL_NAME: 'probe-model',
      }
      const diagnostics = await getSystemDiagnostics({ env, checkEndpoint: true })
      return sendJson(res, diagnostics.endpoint?.ok ? 200 : 502, {
        ok: !!diagnostics.endpoint?.ok,
        endpoint: diagnostics.endpoint,
        models: diagnostics.endpoint?.remoteModels || [],
      })
    }
    if (req.method === 'GET' && !id) {
      return sendJson(res, 200, { ok: true, providers: listModelProviders({ userId }) })
    }
    if (req.method === 'POST' && !id) {
      const provider = upsertModelProvider({ userId, provider: await readJson(req) })
      return sendJson(res, 200, { ok: true, provider })
    }
    if (req.method === 'DELETE' && id && !action) {
      const deleted = deleteModelProvider({ userId, id })
      return sendJson(res, deleted ? 200 : 404, deleted
        ? { ok: true }
        : { error: { code: 'NOT_FOUND', message: '模型 Provider 不存在' } })
    }
    if (req.method === 'POST' && id && action === 'test') {
      const provider = getModelProvider({ userId, id, includeSecrets: true })
      if (!provider) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '模型 Provider 不存在' } })
      const started = Date.now()
      try {
        const reply = await callBackgroundModel({
          env: buildProviderTestEnv(provider),
          modelName: provider.defaultModel,
          messages: [{ role: 'user', content: 'Reply with only: pong' }],
        })
        return sendJson(res, 200, {
          ok: true,
          endpoint: {
            checked: true,
            ok: true,
            latency: Date.now() - started,
            model: provider.defaultModel,
          },
          reply: String(reply || '').slice(0, 200),
        })
      } catch (error) {
        return sendJson(res, 502, {
          ok: false,
          error: { code: 'PROVIDER_TEST_FAILED', message: formatProxyError(error) },
        })
      }
    }
    return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' } })
  } catch (error) {
    return sendJson(res, error?.statusCode || 400, { error: { code: 'INVALID_PROVIDER', message: error?.message || String(error) } })
  }
}
