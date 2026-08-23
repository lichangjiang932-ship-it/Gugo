import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import {
  deleteIntegration,
  getIntegrationByProvider,
  getIntegrationCredentialsById,
  listIntegrations,
  listProviderRegistry,
  setIntegrationEnabled,
  testIntegration,
  upsertIntegration,
} from '../services/integrationsStore.js'
import { socialBridgeManager } from '../services/socialBridgeManager.js'
import { isWebConnectorProvider } from '../../shared/webConnectorCatalog.js'
import { closeBrowserSession } from '../adapters/browserAutomation.js'
import {
  completeOAuthConnection,
  getOAuthConnectionStatus,
  listOAuthProviders,
  oauthCompletionRedirect,
  startOAuthConnection,
} from '../services/integrationOAuthService.js'

function unauthorized(res) { return sendJson(res, 401, { ok: false, error: 'Unauthorized' }) }

function statusForError(err) {
  if (err?.statusCode) return err.statusCode
  return 400
}

async function refreshBridgeIntegration(integration) {
  if (!integration || integration.kind !== 'social') return
  try {
    const full = getIntegrationCredentialsById({ userId: integration.userId, id: integration.id })
    if (full?.enabled) await socialBridgeManager.startIntegration(full)
    else await socialBridgeManager.stopIntegration(integration.id, integration.provider)
  } catch (err) {
    console.error('[bridge] refresh integration failed:', err?.message || err)
  }
}

export async function handleIntegrationsRequest(req, res, { env = process.env, fetchImpl = fetch } = {}) {
  const url = new URL(req.url, 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  // 路由：/api/integrations[/providers | /vision_assist/status | /:id | /:id/test | /:id/enabled]

  // 公共：GET /api/integrations/providers — 列出可用 provider 元数据
  if (req.method === 'GET' && parts[2] === 'providers') {
    return sendJson(res, 200, { ok: true, providers: listProviderRegistry() })
  }

  // OAuth provider callbacks cannot carry the app bearer token. The one-time state
  // binds the callback to the authenticated user who started the handshake.
  if (req.method === 'GET' && parts[2] === 'oauth' && parts[3] === 'callback' && parts[4]) {
    try {
      const session = await completeOAuthConnection({
        provider: decodeURIComponent(parts[4]),
        state: url.searchParams.get('state') || '',
        code: url.searchParams.get('code') || '',
        providerError: url.searchParams.get('error_description') || url.searchParams.get('error') || '',
        env,
        fetchImpl,
      })
      res.writeHead(302, {
        Location: oauthCompletionRedirect(session),
        'Cache-Control': 'no-store',
      })
      res.end()
      return undefined
    } catch (err) {
      return sendJson(res, statusForError(err), {
        ok: false,
        error: err.message || 'OAuth callback failed',
        code: err.code || 'OAUTH_CALLBACK_FAILED',
      })
    }
  }

  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)

  // GET /api/integrations/vision_assist/status — 视觉副驾就绪探针。
  // MODEL_NAMES_VISION 描述主模型自身的视觉能力，不是副驾配置。
  // 副驾只依赖当前用户已保存、启用且完整的本地 BYOK integration。
  if (req.method === 'GET' && parts[2] === 'vision_assist' && parts[3] === 'status') {
    const integration = getIntegrationByProvider({ userId, provider: 'vision_assist' })
    const modelName = String(integration?.config?.modelName || '').trim()
    const configured = !!(
      integration?.enabled
      && String(integration.config?.baseUrl || '').trim()
      && modelName
    )
    return sendJson(res, 200, {
      ok: true,
      configured,
      hasIntegration: !!integration,
      enabled: integration?.enabled === true,
      modelName: modelName || null,
      models: modelName ? [modelName] : [],
    })
  }

  try {
    if (req.method === 'GET' && parts[2] === 'oauth' && parts[3] === 'providers') {
      return sendJson(res, 200, { ok: true, providers: listOAuthProviders({ env }) })
    }

    if (req.method === 'POST' && parts[2] === 'oauth' && parts[3] === 'start') {
      const body = await readJson(req)
      const result = startOAuthConnection({
        userId,
        provider: body.provider,
        integrationId: body.integrationId || null,
        origin: req.headers.origin || '',
        env,
      })
      return sendJson(res, 200, { ok: true, ...result })
    }

    if (req.method === 'GET' && parts[2] === 'oauth' && parts[3] === 'sessions' && parts[4]) {
      const session = getOAuthConnectionStatus({
        userId,
        id: decodeURIComponent(parts[4]),
      })
      if (!session) return sendJson(res, 404, { ok: false, error: 'OAuth session not found' })
      return sendJson(res, 200, { ok: true, session })
    }

    if (req.method === 'GET' && parts.length === 2) {
      const kind = url.searchParams.get('kind') || null
      return sendJson(res, 200, { ok: true, integrations: listIntegrations({ userId, kind }) })
    }

    if (req.method === 'POST' && parts.length === 2) {
      const body = await readJson(req)
      if (isWebConnectorProvider(body.provider)) {
        return sendJson(res, 400, { ok: false, error: 'Use /api/connectors/apps/connect for Browser apps' })
      }
      const integration = upsertIntegration({
        userId,
        provider: body.provider,
        name: body.name,
        enabled: body.enabled,
        config: body.config,
        secret: body.secret,
      })
      await refreshBridgeIntegration(integration)
      return sendJson(res, 200, { ok: true, integration })
    }

    if (req.method === 'PATCH' && parts.length === 3) {
      const id = decodeURIComponent(parts[2])
      const body = await readJson(req)
      if (isWebConnectorProvider(body.provider)) {
        return sendJson(res, 400, { ok: false, error: 'Browser app connections are managed by the dedicated connector route' })
      }
      const integration = upsertIntegration({
        userId,
        id,
        provider: body.provider,
        name: body.name,
        enabled: body.enabled,
        config: body.config,
        secret: body.secret,
      })
      await refreshBridgeIntegration(integration)
      return sendJson(res, 200, { ok: true, integration })
    }

    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'enabled') {
      const id = decodeURIComponent(parts[2])
      const body = await readJson(req)
      const integration = setIntegrationEnabled({ userId, id, enabled: !!body.enabled })
      await refreshBridgeIntegration(integration)
      if (!integration.enabled && (integration.kind === 'browser_app' || integration.provider === 'browser')) {
        closeBrowserSession(userId)
      }
      return sendJson(res, 200, { ok: true, integration })
    }

    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'test') {
      const id = decodeURIComponent(parts[2])
      const result = await testIntegration({ userId, id, env })
      return sendJson(res, 200, { ok: true, result })
    }

    if (req.method === 'DELETE' && parts.length === 3) {
      const id = decodeURIComponent(parts[2])
      const integration = getIntegrationCredentialsById({ userId, id })
      const removed = deleteIntegration({ userId, id })
      if (removed) await socialBridgeManager.stopIntegration(id, integration?.provider)
      if (removed && (integration?.kind === 'browser_app' || integration?.provider === 'browser')) {
        closeBrowserSession(userId)
      }
      return sendJson(res, removed ? 200 : 404, { ok: removed })
    }
  } catch (err) {
    return sendJson(res, statusForError(err), {
      ok: false,
      error: err.message || 'integration error',
      code: err.code || undefined,
    })
  }

  return sendJson(res, 404, { ok: false, error: 'unknown integrations route' })
}
