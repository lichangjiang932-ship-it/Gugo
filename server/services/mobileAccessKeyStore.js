/**
 * Mobile / LAN Access Key 仓储 (Hanako 平行功能)
 *
 * 安全模型：
 * - 创建时返回 raw key 一次（show-once），DB 只存 sha256(key_hash) + key_prefix。
 * - verifyAccessKey 接受 raw key，比对 hash，命中且未撤销/未过期则返回 record + userId。
 * - revoke 只置 revoked_at；保留审计（不物理删除）。
 */

import { createHash, randomBytes } from 'node:crypto'
import { getDb } from '../db.js'

const KEY_BYTES = 32 // 256-bit
const PREFIX_LEN = 8

function generateRawKey() {
  return 'ymak_' + randomBytes(KEY_BYTES).toString('base64url')
}

function hashKey(raw) {
  return createHash('sha256').update(String(raw || '')).digest('hex')
}

function mapKey(row) {
  if (!row) return null
  return {
    id: row.id,
    label: row.label || '',
    keyPrefix: row.key_prefix,
    lastUsedAt: row.last_used_at || null,
    expiresAt: row.expires_at || null,
    revokedAt: row.revoked_at || null,
    createdAt: row.created_at,
  }
}

export function listMobileKeys({ userId } = {}) {
  if (!userId) throw new Error('userId required')
  const db = getDb()
  return db
    .prepare('SELECT * FROM mobile_access_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(userId)
    .map(mapKey)
}

export function createMobileKey({ userId, label = '', ttlMs = null, now = Date.now() } = {}) {
  if (!userId) throw new Error('userId required')
  const raw = generateRawKey()
  const id = 'mak_' + randomBytes(8).toString('hex')
  const keyHash = hashKey(raw)
  const keyPrefix = raw.slice(0, PREFIX_LEN)
  const expiresAt = ttlMs !== null && ttlMs !== undefined && Number.isFinite(Number(ttlMs)) ? now + Number(ttlMs) : null
  const db = getDb()
  db.prepare(
    `INSERT INTO mobile_access_keys
     (id, user_id, label, key_hash, key_prefix, last_used_at, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?)`
  ).run(id, userId, String(label || ''), keyHash, keyPrefix, expiresAt, now)
  return {
    record: mapKey(db.prepare('SELECT * FROM mobile_access_keys WHERE id = ?').get(id)),
    rawKey: raw,
  }
}

export function revokeMobileKey({ userId, id, now = Date.now() }) {
  if (!userId || !id) return false
  const db = getDb()
  const result = db
    .prepare('UPDATE mobile_access_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .run(now, id, userId)
  return result.changes > 0
}

/**
 * 校验 raw key 是否有效；成功返回 { userId, keyId, record }，失败返回 null。
 * 顺带更新 last_used_at。
 */
export function verifyAccessKey(rawKey, now = Date.now()) {
  if (!rawKey || typeof rawKey !== 'string' || rawKey.length < 16) return null
  const db = getDb()
  const row = db
    .prepare(
      `SELECT * FROM mobile_access_keys
       WHERE key_hash = ?
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`
    )
    .get(hashKey(rawKey), now)
  if (!row) return null
  db.prepare('UPDATE mobile_access_keys SET last_used_at = ? WHERE id = ?').run(now, row.id)
  return { userId: row.user_id, keyId: row.id, record: mapKey(row) }
}
