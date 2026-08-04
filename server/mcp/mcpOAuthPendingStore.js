import { createHash } from 'node:crypto'
import { getDb } from '../db.js'
import { openCredentialObject, sealCredentialObject } from '../utils/credentialVault.js'

const OAUTH_PENDING_PURPOSE = 'mcp-oauth-pending-authorization'

function stateHash(state) {
  return createHash('sha256').update(String(state || ''), 'utf8').digest('hex')
}

function readPendingRow(row) {
  if (!row) return null
  return {
    ...openCredentialObject(row.pending_json, { purpose: OAUTH_PENDING_PURPOSE }).value,
    userId: row.user_id,
    serverId: row.server_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

export function pruneMcpOAuthPendingAuthorizations(now = Date.now()) {
  return getDb().prepare(
    'DELETE FROM mcp_oauth_pending_authorizations WHERE expires_at <= ?',
  ).run(now).changes
}

export function saveMcpOAuthPendingAuthorization({
  state,
  userId,
  serverId,
  pending,
  createdAt = Date.now(),
  expiresAt,
}) {
  if (!state || !userId || !serverId) throw new Error('state, userId and serverId are required')
  if (!Number.isFinite(expiresAt) || expiresAt <= createdAt) {
    throw new Error('pending OAuth authorization expiry is invalid')
  }
  const pendingJson = sealCredentialObject(pending || {}, { purpose: OAUTH_PENDING_PURPOSE })
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM mcp_oauth_pending_authorizations WHERE expires_at <= ?').run(createdAt)
    db.prepare(`
      INSERT INTO mcp_oauth_pending_authorizations
        (state_hash, user_id, server_id, pending_json, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(stateHash(state), userId, serverId, pendingJson, expiresAt, createdAt)
  })()
  return { expiresAt }
}

export function consumeMcpOAuthPendingAuthorization(state, now = Date.now()) {
  const db = getDb()
  return db.transaction(() => {
    const row = db.prepare(`
      DELETE FROM mcp_oauth_pending_authorizations
      WHERE state_hash = ? AND expires_at > ?
      RETURNING *
    `).get(stateHash(state), now)
    db.prepare('DELETE FROM mcp_oauth_pending_authorizations WHERE expires_at <= ?').run(now)
    return readPendingRow(row)
  })()
}

export const _mcpOAuthPendingStoreInternals = {
  OAUTH_PENDING_PURPOSE,
  stateHash,
}
