import { getDb } from '../db.js'
import { openCredentialObject, sealCredentialObject } from '../utils/credentialVault.js'

const OAUTH_PURPOSE = 'mcp-oauth-credentials'

function parseMetadata(raw) {
  try {
    const value = JSON.parse(String(raw || '{}'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function readRow(row) {
  if (!row) return null
  const credentials = openCredentialObject(row.credential_json, { purpose: OAUTH_PURPOSE }).value
  return {
    serverId: row.server_id,
    userId: row.user_id,
    metadata: parseMetadata(row.metadata_json),
    credentials,
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getMcpOAuthCredential(userId, serverId) {
  if (!userId || !serverId) return null
  return readRow(getDb().prepare(
    'SELECT * FROM mcp_oauth_credentials WHERE user_id = ? AND server_id = ?',
  ).get(userId, serverId))
}

export function upsertMcpOAuthCredential({
  userId,
  serverId,
  metadata = {},
  credentials = {},
  expiresAt = null,
  now = Date.now(),
}) {
  if (!userId || !serverId) throw new Error('userId and serverId are required')
  const credentialJson = sealCredentialObject(credentials, { purpose: OAUTH_PURPOSE })
  getDb().prepare(`
    INSERT INTO mcp_oauth_credentials
      (server_id, user_id, metadata_json, credential_json, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id) DO UPDATE SET
      metadata_json = excluded.metadata_json,
      credential_json = excluded.credential_json,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
    WHERE mcp_oauth_credentials.user_id = excluded.user_id
  `).run(
    serverId,
    userId,
    JSON.stringify(metadata || {}),
    credentialJson,
    Number.isFinite(expiresAt) ? expiresAt : null,
    now,
    now,
  )
  return getMcpOAuthCredential(userId, serverId)
}

export function deleteMcpOAuthCredential(userId, serverId) {
  if (!userId || !serverId) return false
  return getDb().prepare(
    'DELETE FROM mcp_oauth_credentials WHERE user_id = ? AND server_id = ?',
  ).run(userId, serverId).changes > 0
}

export function getMcpOAuthStatus(userId, serverId) {
  const record = getMcpOAuthCredential(userId, serverId)
  if (!record) return { configured: false, connected: false }
  const hasAccessToken = !!record.credentials?.accessToken
  return {
    configured: true,
    connected: hasAccessToken && (!record.expiresAt || record.expiresAt > Date.now()),
    refreshable: !!record.credentials?.refreshToken,
    expiresAt: record.expiresAt,
    clientId: record.metadata?.clientId || '',
    scopes: Array.isArray(record.metadata?.scopes) ? record.metadata.scopes : [],
    authorizationEndpoint: record.metadata?.authorizationEndpoint || '',
    tokenEndpoint: record.metadata?.tokenEndpoint || '',
  }
}

export const _mcpOAuthStoreInternals = { OAUTH_PURPOSE }
