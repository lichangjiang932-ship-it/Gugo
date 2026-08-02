import crypto from 'node:crypto'
import { getDb } from '../db.js'

function id() {
  return `parked-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

function parse(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}

function mapMessage(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    integrationId: row.integration_id,
    provider: row.provider,
    chatId: row.external_chat_id,
    externalUserId: row.external_user_id,
    senderName: row.sender_name || null,
    payload: parse(row.payload_json, {}),
    status: row.status,
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at || null,
    deliveredAt: row.delivered_at || null,
  }
}

export function getBridgeContact({ userId, integrationId, provider, externalUserId } = {}) {
  if (!userId || !integrationId || !provider || !externalUserId) return null
  const row = getDb().prepare(`
    SELECT * FROM bridge_contacts
     WHERE user_id = ? AND integration_id = ? AND provider = ? AND external_user_id = ?
  `).get(userId, integrationId, provider, externalUserId)
  return row ? {
    userId: row.user_id,
    integrationId: row.integration_id,
    provider: row.provider,
    externalUserId: row.external_user_id,
    displayName: row.display_name || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at || null,
  } : null
}

export function setBridgeContactStatus({
  userId,
  integrationId,
  provider,
  externalUserId,
  displayName = null,
  status,
  now = Date.now(),
} = {}) {
  if (!['pending', 'allowed', 'blocked'].includes(status)) throw new Error('invalid bridge contact status')
  if (!userId || !integrationId || !provider || !externalUserId) throw new Error('bridge contact identity required')
  getDb().prepare(`
    INSERT INTO bridge_contacts
      (user_id, integration_id, provider, external_user_id, display_name, status, created_at, updated_at, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, integration_id, provider, external_user_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, bridge_contacts.display_name),
      status = excluded.status,
      updated_at = excluded.updated_at,
      decided_at = excluded.decided_at
  `).run(
    userId,
    integrationId,
    provider,
    externalUserId,
    displayName,
    status,
    now,
    now,
    status === 'pending' ? null : now,
  )
  return getBridgeContact({ userId, integrationId, provider, externalUserId })
}

export function parkBridgeMessage({
  userId,
  integrationId,
  provider,
  chatId,
  externalUserId,
  senderName = null,
  payload,
  now = Date.now(),
} = {}) {
  if (!userId || !integrationId || !provider || !chatId || !externalUserId) {
    throw new Error('parked bridge message identity required')
  }
  const messageId = id()
  const db = getDb()
  db.transaction(() => {
    setBridgeContactStatus({
      userId,
      integrationId,
      provider,
      externalUserId,
      displayName: senderName,
      status: 'pending',
      now,
    })
    db.prepare(`
      INSERT INTO bridge_parked_messages
        (id, user_id, integration_id, provider, external_chat_id, external_user_id,
         sender_name, payload_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'parked', ?, ?)
    `).run(
      messageId,
      userId,
      integrationId,
      provider,
      chatId,
      externalUserId,
      senderName,
      JSON.stringify(payload || {}),
      now,
      now,
    )
  })()
  return getParkedBridgeMessage({ userId, id: messageId })
}

export function getParkedBridgeMessage({ userId, id: messageId } = {}) {
  if (!userId || !messageId) return null
  return mapMessage(getDb().prepare(`
    SELECT * FROM bridge_parked_messages WHERE id = ? AND user_id = ?
  `).get(messageId, userId))
}

export function listParkedBridgeMessages({ userId, status = 'parked', limit = 100 } = {}) {
  if (!userId) return []
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500)
  const rows = status === 'all'
    ? getDb().prepare(`
        SELECT * FROM bridge_parked_messages WHERE user_id = ?
         ORDER BY created_at DESC LIMIT ?
      `).all(userId, capped)
    : getDb().prepare(`
        SELECT * FROM bridge_parked_messages WHERE user_id = ? AND status = ?
         ORDER BY created_at DESC LIMIT ?
      `).all(userId, status, capped)
  return rows.map(mapMessage)
}

export function transitionParkedBridgeMessage({ userId, id: messageId, from, to, error = null, now = Date.now() } = {}) {
  if (!userId || !messageId) return null
  const result = getDb().prepare(`
    UPDATE bridge_parked_messages
       SET status = ?, error = ?, updated_at = ?,
           decided_at = CASE WHEN ? IN ('delivering','rejected') THEN ? ELSE decided_at END,
           delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
     WHERE id = ? AND user_id = ? AND status = ?
  `).run(to, error, now, to, now, to, now, messageId, userId, from)
  return result.changes > 0 ? getParkedBridgeMessage({ userId, id: messageId }) : null
}
