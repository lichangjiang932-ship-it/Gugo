import crypto from 'node:crypto'
import { getDb } from '../db.js'
import { getIntegration } from './integrationsStore.js'
import { openCredentialObject, sealCredentialObject } from '../utils/credentialVault.js'
import { fetchSafeOutbound } from '../utils/outboundNetworkGuard.js'

/**
 * What every OAuth flow — the browser one, the device one, and the token refresh
 * — has to agree on: which providers exist, what "configured" means, how a
 * session is read, and how a token becomes an integration.
 *
 * It lives apart from the flows themselves so that neither flow has to reach
 * into the other to borrow it. The two flows share a session table and a sealing
 * purpose scheme, not a call graph.
 */
export const SESSION_TTL_MS = 10 * 60 * 1000
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000
const OAUTH_CODE_VERIFIER_PURPOSE = 'integration-oauth-code-verifier'
const DEVICE_FLOW_PURPOSE = 'integration-oauth-device-flow'

export const PROVIDERS = Object.freeze({
  github: Object.freeze({
    label: 'GitHub',
    clientIdEnv: 'GITHUB_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GITHUB_OAUTH_CLIENT_SECRET',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    deviceCodeUrl: 'https://github.com/login/device/code',
    // The device flow authenticates as a public client: the token request carries
    // the client id and nothing else. That is what makes a shipped client id
    // enough to let someone sign in to their own GitHub account with no setup on
    // their side — the same trade gh, and every other desktop client, makes. The
    // id is public by construction; it is in the URL the browser is sent to.
    deviceFlow: true,
    defaultClientId: 'Ov23liDjJ2JknZkfVoyW',
    scopes: ['read:user'],
    scopesEnv: 'GITHUB_OAUTH_SCOPES',
    pkce: true,
  }),
  notion: Object.freeze({
    label: 'Notion',
    clientIdEnv: 'NOTION_OAUTH_CLIENT_ID',
    clientSecretEnv: 'NOTION_OAUTH_CLIENT_SECRET',
    authorizationUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: [],
    pkce: false,
  }),
  slack: Object.freeze({
    label: 'Slack',
    clientIdEnv: 'SLACK_OAUTH_CLIENT_ID',
    clientSecretEnv: 'SLACK_OAUTH_CLIENT_SECRET',
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['channels:read', 'channels:history'],
    scopesEnv: 'SLACK_OAUTH_SCOPES',
    scopeSeparator: ',',
    pkce: false,
  }),
  google_drive: Object.freeze({
    label: 'Google Drive',
    clientIdEnv: 'GOOGLE_DRIVE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_DRIVE_OAUTH_CLIENT_SECRET',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    scopesEnv: 'GOOGLE_DRIVE_OAUTH_SCOPES',
    scopeSeparator: ' ',
    pkce: true,
  }),
})

export function oauthError(message, statusCode = 400, code = 'OAUTH_ERROR') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

export function sha256(value, encoding = 'hex') {
  return crypto.createHash('sha256').update(value).digest(encoding)
}

export function writeCodeVerifier(value) {
  return sealCredentialObject({ codeVerifier: String(value || '') }, {
    purpose: OAUTH_CODE_VERIFIER_PURPOSE,
  })
}

export function readCodeVerifier(row) {
  const decoded = openCredentialObject(row?.code_verifier, {
    purpose: OAUTH_CODE_VERIFIER_PURPOSE,
    legacyDecoder: (raw) => ({ codeVerifier: String(raw || '') }),
  })
  const codeVerifier = String(decoded.value.codeVerifier || '')
  if (decoded.legacy && row?.id && codeVerifier) {
    getDb().prepare('UPDATE integration_oauth_sessions SET code_verifier = ? WHERE id = ?')
      .run(writeCodeVerifier(codeVerifier), row.id)
  }
  return codeVerifier
}

/**
 * A device-flow session has no code verifier and no redirect: what it has to
 * remember between the start and the poll is the device code GitHub handed out.
 * It rides in the same sealed column, under its own purpose, so the two flows
 * cannot be read as one another — the vault rejects a purpose mismatch outright.
 */
export function writeDeviceFlow({ deviceCode, userCode, interval }) {
  return sealCredentialObject({
    deviceCode: String(deviceCode || ''),
    userCode: String(userCode || ''),
    interval: Number(interval) || 5,
  }, { purpose: DEVICE_FLOW_PURPOSE })
}

export function readDeviceFlow(row) {
  if (!row?.code_verifier) return null
  try {
    const { value } = openCredentialObject(row.code_verifier, { purpose: DEVICE_FLOW_PURPOSE })
    const deviceCode = String(value?.deviceCode || '')
    if (!deviceCode) return null
    return { deviceCode, userCode: String(value.userCode || ''), interval: Number(value.interval) || 5 }
  } catch {
    // A web-flow session, or a session already failed and cleared.
    return null
  }
}

export function providerSettings(provider, env = process.env) {
  const metadata = PROVIDERS[provider]
  if (!metadata) throw oauthError(`OAuth is not supported for provider: ${provider}`, 400, 'OAUTH_PROVIDER_UNSUPPORTED')
  const clientId = String(env?.[metadata.clientIdEnv] || metadata.defaultClientId || '').trim()
  const clientSecret = String(env?.[metadata.clientSecretEnv] || '').trim()
  const configuredScopes = metadata.scopesEnv
    ? String(env?.[metadata.scopesEnv] || '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean)
    : []
  const scopes = configuredScopes.length ? [...new Set(configuredScopes)] : [...metadata.scopes]
  // A device-flow provider is a public client: the code exchange carries no
  // secret, so a client id alone — usually the one the app ships — is a complete
  // configuration. Requiring a secret there would demand one nobody can keep.
  const needsSecret = metadata.deviceFlow !== true
  const configured = !!clientId && (!needsSecret || !!clientSecret)
  return { ...metadata, scopes, clientId, clientSecret, configured }
}

export function publicBaseUrl({ env = process.env, origin }) {
  const raw = String(env?.APP_PUBLIC_URL || origin || '').trim()
  if (!raw) throw oauthError('APP_PUBLIC_URL is required for OAuth', 503, 'OAUTH_PUBLIC_URL_REQUIRED')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw oauthError('APP_PUBLIC_URL must be a valid http(s) URL', 503, 'OAUTH_PUBLIC_URL_INVALID')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw oauthError('APP_PUBLIC_URL must be a valid http(s) origin', 503, 'OAUTH_PUBLIC_URL_INVALID')
  }
  return url.origin
}

export function cleanupSessions(now) {
  const db = getDb()
  db.prepare(`
    UPDATE integration_oauth_sessions
    SET status = 'expired', error = 'OAuth session expired', code_verifier = '', updated_at = ?
    WHERE status IN ('pending','exchanging') AND expires_at <= ?
  `).run(now, now)
  db.prepare(`
    DELETE FROM integration_oauth_sessions
    WHERE status IN ('completed','failed','expired') AND updated_at < ?
  `).run(now - TERMINAL_RETENTION_MS)
}

function sessionView(row, integration = null) {
  if (!row) return null
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    integrationId: row.integration_id || null,
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at || null,
    integration,
  }
}

export function getOAuthConnectionStatus({ userId, id, now = Date.now() } = {}) {
  if (!userId || !id) return null
  cleanupSessions(now)
  const row = getDb().prepare(
    'SELECT * FROM integration_oauth_sessions WHERE id = ? AND user_id = ?',
  ).get(id, userId)
  if (!row) return null
  const integration = row.integration_id
    ? getIntegration({ userId, id: row.integration_id })
    : null
  return sessionView(row, integration)
}

export async function fetchJson(fetchImpl, url, init, { lookup } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const resolveDns = typeof lookup === 'function' || fetchImpl === globalThis.fetch
    let response
    let text
    try {
      response = await fetchSafeOutbound(url, {
        ...init,
        signal: controller.signal,
      }, {
        fetchImpl,
        allowLocal: false,
        resolveDns,
        ...(typeof lookup === 'function' ? { lookup } : {}),
      })
      text = await response.text()
    } catch (error) {
      const wrapped = oauthError(
        error?.name === 'AbortError'
          ? 'OAuth token request timed out'
          : 'OAuth token request was blocked or unavailable',
        502,
        'OAUTH_TOKEN_EXCHANGE_FAILED',
      )
      wrapped.cause = error
      throw wrapped
    }
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = {}
    }
    if (!response.ok) {
      throw oauthError(
        data?.error_description || data?.error || `OAuth token exchange failed (${response.status})`,
        502,
        'OAUTH_TOKEN_EXCHANGE_FAILED',
      )
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

export function connectorCredentials({ provider, tokenData, existing, now = Date.now() }) {
  const accessToken = String(tokenData?.access_token || '').trim()
  if (!accessToken) {
    throw oauthError(
      tokenData?.error_description || tokenData?.error || 'OAuth response did not include an access token',
      502,
      'OAUTH_TOKEN_MISSING',
    )
  }
  const config = { ...(existing?.config || {}), authSource: 'oauth' }
  if (provider === 'github') {
    config.oauthScopes = String(tokenData.scope || '')
  } else if (provider === 'notion') {
    if (tokenData.workspace_id) config.workspaceId = String(tokenData.workspace_id)
    if (tokenData.workspace_name) config.workspace = String(tokenData.workspace_name)
    if (tokenData.bot_id) config.botId = String(tokenData.bot_id)
  } else if (provider === 'slack') {
    if (tokenData.team?.id) config.teamId = String(tokenData.team.id)
    if (tokenData.team?.name) config.workspace = String(tokenData.team.name)
    if (tokenData.bot_user_id) config.botUserId = String(tokenData.bot_user_id)
    config.oauthScopes = String(tokenData.scope || '')
  } else if (provider === 'google_drive') {
    config.oauthScopes = String(tokenData.scope || '')
  }
  const secret = provider === 'slack' ? { botToken: accessToken } : { token: accessToken }
  if (tokenData.refresh_token) secret.refreshToken = String(tokenData.refresh_token)
  if (tokenData.token_type) secret.tokenType = String(tokenData.token_type)
  if (Number(tokenData.expires_in) > 0) {
    secret.expiresAt = String(now + (Number(tokenData.expires_in) * 1000))
  }
  return { config, secret }
}

export function failSession(id, error, now) {
  getDb().prepare(`
    UPDATE integration_oauth_sessions
    SET status = 'failed', error = ?, code_verifier = '', updated_at = ?, completed_at = ?
    WHERE id = ?
  `).run(String(error?.message || error || 'OAuth failed').slice(0, 500), now, now, id)
}
