import { getDb } from '../db.js'
import { getIntegration, testProviderCredentials, upsertIntegration } from './integrationsStore.js'
import { openCredentialObject, sealCredentialObject } from '../utils/credentialVault.js'
import { fetchSafeOutbound } from '../utils/outboundNetworkGuard.js'
import {
  SESSION_TTL_MS,
  cleanupSessions,
  failSession,
  getOAuthConnectionStatus,
  oauthError,
  randomToken,
  sha256,
} from './integrationOAuthShared.js'

/**
 * Connect a connector by showing a QR code, for the providers that offer one.
 *
 * Feishu's is the interesting case: scanning does not merely hand back a token
 * for a pre-registered app, it *creates the app*. The reader scans, Feishu
 * provisions an application in their tenant, and the poll comes back carrying
 * `client_id` and `client_secret`. That is the whole reason this exists — the
 * alternative is walking them through the developer console to create an app by
 * hand and copy a secret out of it, which is the step people abandon.
 *
 * The registration endpoint is anonymous: unlike the device flow `larksuite/cli`
 * uses to sign a terminal in, this one carries no Authorization header at all,
 * so nothing has to be pre-registered for the flow to start. Confirmed against
 * `larksuite/node-sdk/scene/registration/index.ts`.
 */
const QR_REGISTRATION_PURPOSE = 'integration-qr-registration'

const REGISTRATION_ENDPOINTS = Object.freeze({
  feishu: 'https://accounts.feishu.cn/oauth/v1/app/registration',
  lark: 'https://accounts.larksuite.com/oauth/v1/app/registration',
})

/**
 * The endpoints are not in Feishu's prose documentation — they were read off the
 * published SDK — so the deployment can point them somewhere else without a code
 * change if they move.
 */
function registrationEndpoints(env = process.env) {
  return {
    feishu: String(env?.FEISHU_QR_REGISTRATION_URL || '').trim() || REGISTRATION_ENDPOINTS.feishu,
    lark: String(env?.FEISHU_QR_REGISTRATION_LARK_URL || '').trim() || REGISTRATION_ENDPOINTS.lark,
  }
}

function writeRegistration({ deviceCode, interval }) {
  return sealCredentialObject({
    deviceCode: String(deviceCode || ''),
    interval: Number(interval) || 5,
  }, { purpose: QR_REGISTRATION_PURPOSE })
}

function readRegistration(row) {
  if (!row?.code_verifier) return null
  try {
    const { value } = openCredentialObject(row.code_verifier, { purpose: QR_REGISTRATION_PURPOSE })
    const deviceCode = String(value?.deviceCode || '')
    if (!deviceCode) return null
    return { deviceCode, interval: Number(value.interval) || 5 }
  } catch {
    // Another flow's session.
    return null
  }
}

/**
 * RFC 8628 says these come back as errors, and Feishu does return them with a
 * 400. The body is the answer, so this reads it instead of throwing on status.
 */
async function registrationRequest(url, params, { fetchImpl = fetch, lookup } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const resolveDns = typeof lookup === 'function' || fetchImpl === globalThis.fetch
    const response = await fetchSafeOutbound(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    }, {
      fetchImpl,
      allowLocal: false,
      resolveDns,
      ...(typeof lookup === 'function' ? { lookup } : {}),
    })
    const text = await response.text()
    let data = {}
    try { data = text ? JSON.parse(text) : {} } catch { data = {} }
    return { status: response.status, data }
  } catch (error) {
    const wrapped = oauthError(
      error?.name === 'AbortError'
        ? 'The QR registration request timed out'
        : 'The QR registration request was blocked or unavailable',
      502,
      'QR_REGISTRATION_UNAVAILABLE',
    )
    wrapped.cause = error
    throw wrapped
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The page the QR opens. `createOnly` is the one that matters: the reader is
 * here to get a new app, not to reselect one they already have.
 */
function qrScanUrl(verificationUri) {
  const url = new URL(verificationUri)
  url.searchParams.set('source', 'gugo')
  url.searchParams.set('createOnly', 'true')
  return url.toString()
}

export async function startQrRegistration({
  userId,
  provider,
  env = process.env,
  fetchImpl = fetch,
  lookup,
  now = Date.now(),
} = {}) {
  if (!userId) throw oauthError('userId required', 401, 'OAUTH_UNAUTHORIZED')
  if (provider !== 'feishu') {
    throw oauthError(`QR registration is not supported for provider: ${provider}`, 400, 'QR_PROVIDER_UNSUPPORTED')
  }

  const { data } = await registrationRequest(registrationEndpoints(env).feishu, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  }, { fetchImpl, lookup })

  const deviceCode = String(data?.device_code || '').trim()
  const verificationUri = String(data?.verification_uri_complete || data?.verification_uri || '').trim()
  if (!deviceCode || !verificationUri) {
    throw oauthError('Feishu did not return a QR code', 502, 'QR_DEVICE_CODE_MISSING')
  }

  const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : SESSION_TTL_MS
  const interval = Number(data.interval) > 0 ? Number(data.interval) : 5
  const id = `oauth_${randomToken(18)}`
  const db = getDb()
  cleanupSessions(now)
  db.prepare(`
    INSERT INTO integration_oauth_sessions
      (id, state_hash, user_id, provider, integration_id, status, code_verifier,
       redirect_uri, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, NULL, 'pending', ?, '', ?, ?, ?)
  `).run(
    id,
    sha256(randomToken(32)),
    userId,
    provider,
    writeRegistration({ deviceCode, interval }),
    now,
    now,
    now + expiresIn,
  )

  return {
    session: getOAuthConnectionStatus({ userId, id, now }),
    qr: { url: qrScanUrl(verificationUri), expiresIn, interval },
  }
}

/**
 * Advance a QR registration by one step. Returns null when the session is not a
 * QR one, so the caller can hand it to another flow.
 *
 * Feishu answers `authorization_pending` until the reader scans, then either
 * `access_denied`, `expired_token`, or — the success case — an object carrying
 * the new app's credentials.
 */
export async function pollQrRegistration({
  userId,
  id,
  env = process.env,
  fetchImpl = fetch,
  lookup,
  now = Date.now(),
} = {}) {
  if (!userId || !id) return null
  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM integration_oauth_sessions WHERE id = ? AND user_id = ?',
  ).get(id, userId)
  if (!row) return null
  const registration = readRegistration(row)
  if (!registration) return null
  if (row.status !== 'pending') return getOAuthConnectionStatus({ userId, id, now })

  if (row.expires_at <= now) {
    db.prepare('UPDATE integration_oauth_sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run('expired', now, row.id)
    return getOAuthConnectionStatus({ userId, id, now })
  }

  const endpoints = registrationEndpoints(env)
  let endpoint = endpoints.feishu
  let result
  try {
    result = await registrationRequest(endpoint, { action: 'poll', device_code: registration.deviceCode }, { fetchImpl, lookup })
  } catch (error) {
    failSession(row.id, error, now)
    return getOAuthConnectionStatus({ userId, id, now })
  }

  // A tenant that turns out to live on Lark answers with its brand instead of an
  // error; the same request then belongs to the other host.
  if (String(result.data?.tenant_brand || '') === 'lark') {
    endpoint = endpoints.lark
    try {
      result = await registrationRequest(endpoint, { action: 'poll', device_code: registration.deviceCode }, { fetchImpl, lookup })
    } catch (error) {
      failSession(row.id, error, now)
      return getOAuthConnectionStatus({ userId, id, now })
    }
  }

  const data = result.data || {}
  const clientId = String(data.client_id || '').trim()
  const clientSecret = String(data.client_secret || '').trim()
  if (!clientId || !clientSecret) {
    const reason = String(data.error || '')
    if (reason === 'slow_down') {
      db.prepare('UPDATE integration_oauth_sessions SET code_verifier = ?, updated_at = ? WHERE id = ?')
        .run(writeRegistration({ deviceCode: registration.deviceCode, interval: registration.interval + 5 }), now, row.id)
      return getOAuthConnectionStatus({ userId, id, now })
    }
    if (reason === 'authorization_pending' || !reason) return getOAuthConnectionStatus({ userId, id, now })
    if (reason === 'expired_token') {
      db.prepare('UPDATE integration_oauth_sessions SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run('expired', 'The QR code expired before it was scanned', now, row.id)
      return getOAuthConnectionStatus({ userId, id, now })
    }
    failSession(row.id, data.error_description || reason, now)
    return getOAuthConnectionStatus({ userId, id, now })
  }

  const claimed = db.prepare(`
    UPDATE integration_oauth_sessions
    SET status = 'exchanging', updated_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(now, row.id)
  if (claimed.changes !== 1) return getOAuthConnectionStatus({ userId, id, now })

  try {
    // The new app is only worth keeping if it can actually reach Feishu, so it is
    // probed before it is enabled — the same rule the OAuth flows follow.
    const config = { appId: clientId, authSource: 'qr' }
    const secret = { appSecret: clientSecret }
    const validation = await testProviderCredentials({
      provider: row.provider,
      config,
      secret,
      fetchImpl,
      lookup,
    })
    if (validation?.ok !== true) {
      throw oauthError(validation?.message || 'The new Feishu app could not be verified', 502, 'QR_CREDENTIAL_INVALID')
    }
    const existing = getIntegration({ userId, provider: row.provider })
    const integration = upsertIntegration({
      userId,
      id: existing?.id,
      provider: row.provider,
      name: existing?.name || 'Feishu / Lark',
      enabled: true,
      config,
      secret,
    })
    const completedAt = Date.now()
    db.prepare(`
      UPDATE integration_oauth_sessions
      SET status = 'completed', integration_id = ?, error = NULL,
          code_verifier = '', updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(integration.id, completedAt, completedAt, row.id)
    return getOAuthConnectionStatus({ userId, id: row.id, now: completedAt })
  } catch (error) {
    failSession(row.id, error, now)
    return getOAuthConnectionStatus({ userId, id, now })
  }
}
