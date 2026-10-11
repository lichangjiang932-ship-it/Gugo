import { getDb } from '../db.js'
import {
  getIntegration,
  getIntegrationByProvider,
  testProviderCredentials,
  upsertIntegration,
} from './integrationsStore.js'
import {
  SESSION_TTL_MS,
  cleanupSessions,
  connectorCredentials,
  failSession,
  fetchJson,
  getOAuthConnectionStatus,
  oauthError,
  providerSettings,
  randomToken,
  readDeviceFlow,
  sha256,
  writeDeviceFlow,
} from './integrationOAuthShared.js'

/**
 * The device flow: ask for a code, hand the reader the code and the page to
 * paste it into, and let them sign in to their own account there. Nothing about
 * the account comes back through this server until it is exchanged.
 *
 * When the provider has no client secret this is the flow that runs, which is
 * what lets a shipped public client id be a complete configuration.
 */
export async function startDeviceFlowConnection({
  userId, provider, settings, existing, fetchImpl, lookup, now,
}) {
  const body = new URLSearchParams({ client_id: settings.clientId })
  if (settings.scopes.length) body.set('scope', settings.scopes.join(settings.scopeSeparator || ' '))
  const data = await fetchJson(fetchImpl, settings.deviceCodeUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, { lookup })

  const deviceCode = String(data?.device_code || '').trim()
  const userCode = String(data?.user_code || '').trim()
  const verificationUri = String(data?.verification_uri || data?.verification_url || '').trim()
  if (!deviceCode || !userCode || !verificationUri) {
    throw oauthError(
      `${settings.label} did not return a device code. Check that the device flow is enabled on this OAuth app.`,
      502,
      'OAUTH_DEVICE_CODE_MISSING',
    )
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
    VALUES (?, ?, ?, ?, ?, 'pending', ?, '', ?, ?, ?)
  `).run(
    id,
    // No redirect comes back in this flow, so the state is never looked up; it
    // still needs a unique value because the column is the table's identity.
    sha256(randomToken(32)),
    userId,
    provider,
    existing?.id || null,
    writeDeviceFlow({ deviceCode, userCode, interval }),
    now,
    now,
    now + expiresIn,
  )

  return {
    session: getOAuthConnectionStatus({ userId, id, now }),
    deviceFlow: { userCode, verificationUri, expiresIn, interval },
  }
}

/**
 * Advance a device-flow session by one step: ask the provider whether the reader
 * has finished signing in yet.
 *
 * The provider answers `authorization_pending` until they do, so this is called
 * on the same poll loop the browser flow already used — the client's only new
 * job is to show the code. Nothing is written until the token comes back, and the
 * token is validated before the integration is enabled, exactly as the browser
 * flow does, so a token that cannot reach the API never shows as connected.
 */
export async function pollDeviceFlowConnection({
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
  if (!row || row.status !== 'pending') return row ? getOAuthConnectionStatus({ userId, id, now }) : null
  const device = readDeviceFlow(row)
  if (!device) return getOAuthConnectionStatus({ userId, id, now })
  if (row.expires_at <= now) {
    db.prepare('UPDATE integration_oauth_sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run('expired', now, row.id)
    return getOAuthConnectionStatus({ userId, id, now })
  }

  const settings = providerSettings(row.provider, env)
  const body = new URLSearchParams({
    client_id: settings.clientId,
    device_code: device.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })
  let data
  try {
    data = await fetchJson(fetchImpl, settings.tokenUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, { lookup })
  } catch (error) {
    failSession(row.id, error, now)
    return getOAuthConnectionStatus({ userId, id, now })
  }

  const reason = String(data?.error || '')
  if (reason === 'authorization_pending') return getOAuthConnectionStatus({ userId, id, now })
  if (reason === 'slow_down') {
    // Remember the longer interval so a caller that reads it can back off; the
    // poll itself stays a no-op.
    db.prepare('UPDATE integration_oauth_sessions SET code_verifier = ?, updated_at = ? WHERE id = ?')
      .run(writeDeviceFlow({ ...device, interval: device.interval + 5 }), now, row.id)
    return getOAuthConnectionStatus({ userId, id, now })
  }
  if (reason === 'expired_token') {
    db.prepare('UPDATE integration_oauth_sessions SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run('expired', 'The device code expired before it was approved', now, row.id)
    return getOAuthConnectionStatus({ userId, id, now })
  }
  if (reason) {
    failSession(row.id, data?.error_description || reason, now)
    return getOAuthConnectionStatus({ userId, id, now })
  }

  const claimed = db.prepare(`
    UPDATE integration_oauth_sessions
    SET status = 'exchanging', updated_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(now, row.id)
  if (claimed.changes !== 1) return getOAuthConnectionStatus({ userId, id, now })

  try {
    const existing = row.integration_id
      ? getIntegration({ userId, id: row.integration_id })
      : getIntegrationByProvider({ userId, provider: row.provider })
    const credentials = connectorCredentials({ provider: row.provider, tokenData: data, existing, now })
    const validation = await testProviderCredentials({
      provider: row.provider,
      config: credentials.config,
      secret: credentials.secret,
      fetchImpl,
      lookup,
    })
    if (validation?.ok !== true) {
      throw oauthError(validation?.message || 'OAuth credential validation failed', 502, 'OAUTH_CREDENTIAL_INVALID')
    }
    const integration = upsertIntegration({
      userId,
      id: existing?.id,
      provider: row.provider,
      name: existing?.name || settings.label,
      enabled: true,
      config: credentials.config,
      secret: credentials.secret,
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
