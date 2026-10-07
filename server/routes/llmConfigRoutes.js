import { readJson } from '../utils.js'
import { importLegacyProviders } from '../llm/importLegacyProviders.js'
import { authenticateRequest } from '../middleware.js'
import {
  addModel,
  listCatalog,
  listProviders,
  probeDraftModels,
  probeModels,
  removeModel,
  removeProvider,
  setCredential,
  setDefaultModel,
  upsertProvider,
} from '../llm/llmProviderService.js'
import { allStoredSecrets, readCredentials, redactSecrets, resolveGugoHome, settingsPath, credentialsPath } from '../llm/llmConfigStore.js'
import { openConfigFile } from '../llm/openConfigFile.js'
import { modelsDevStatus, refreshModelsDev } from '../llm/modelsDevCache.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function errorPayload(error) {
  const code = String(error?.code || 'LLM_CONFIG_FAILED')
  const secrets = allStoredSecrets(readCredentials())
  const message = redactSecrets(error?.message || code, secrets)
  return { error: { code, message } }
}

function statusFor(error) {
  if (['LLM_PROVIDER_NOT_FOUND'].includes(error?.code)) return 404
  if (['LLM_PROVIDER_ID_INVALID', 'LLM_PROTOCOL_UNSUPPORTED', 'LLM_PROVIDER_KEY_IN_FORBIDDEN', 'LLM_DEFAULT_MODEL_INVALID'].includes(error?.code)) return 400
  return 500
}

/**
 * `/api/llm/*` — the configuration surface the models settings page drives.
 * Every response is a public view: descriptors, never keys.
 */
export async function handleLlmConfigRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: '请先登录' } })
  const url = new URL(req.url, 'http://localhost')
  const suffix = url.pathname.slice('/api/llm'.length).replace(/^\//u, '')
  const [section, id, action] = suffix.split('/')
  try {
    if (req.method === 'GET' && section === 'catalog') {
      return sendJson(res, 200, { ok: true, catalog: listCatalog(), home: resolveGugoHome(), settingsPath: settingsPath(), credentialsPath: credentialsPath(), modelsDev: modelsDevStatus() })
    }
    if (req.method === 'POST' && section === 'open-config') {
      const body = await readJson(req)
      return sendJson(res, 200, { ok: true, ...openConfigFile(body?.target) })
    }
    if (req.method === 'POST' && section === 'models-dev') {
      return sendJson(res, 200, { ok: true, ...(await refreshModelsDev()) })
    }
    if (req.method === 'GET' && section === 'providers' && !id) {
      return sendJson(res, 200, { ok: true, ...listProviders() })
    }
    if (req.method === 'POST' && section === 'providers' && !id) {
      return sendJson(res, 200, { ok: true, provider: upsertProvider(await readJson(req)) })
    }
    if (req.method === 'DELETE' && section === 'providers' && id && !action) {
      const removed = removeProvider(id)
      return sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: { code: 'LLM_PROVIDER_NOT_FOUND', message: id } })
    }
    if (req.method === 'PUT' && section === 'providers' && id && action === 'credential') {
      const body = await readJson(req)
      return sendJson(res, 200, { ok: true, descriptor: setCredential(id, body?.apiKey) })
    }
    if (req.method === 'POST' && section === 'probe' && !id) {
      return sendJson(res, 200, { ok: true, ...(await probeDraftModels(await readJson(req))) })
    }
    if (req.method === 'POST' && section === 'providers' && id && action === 'probe') {
      return sendJson(res, 200, { ok: true, ...(await probeModels(id)) })
    }
    if (req.method === 'POST' && section === 'providers' && id && action === 'models') {
      const body = await readJson(req)
      return sendJson(res, 200, { ok: true, provider: addModel(id, body?.model) })
    }
    if (req.method === 'DELETE' && section === 'providers' && id && action === 'models') {
      return sendJson(res, 200, { ok: true, provider: removeModel(id, decodeURIComponent(suffix.split('/').slice(3).join('/'))) })
    }
    if (req.method === 'POST' && section === 'import') {
      return sendJson(res, 200, { ok: true, ...importLegacyProviders({ userId }) })
    }
    if (req.method === 'PUT' && section === 'default-model') {
      return sendJson(res, 200, { ok: true, defaultModel: setDefaultModel(await readJson(req)) })
    }
    return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' } })
  } catch (error) {
    return sendJson(res, statusFor(error), errorPayload(error))
  }
}
