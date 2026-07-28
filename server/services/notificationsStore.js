import crypto from 'node:crypto'
import { getDb } from '../db.js'

const VALID_KINDS = new Set(['info', 'success', 'warn', 'error', 'job', 'approval'])
const subscribers = new Map()

function newId() {
  return crypto.randomUUID?.() || `notification-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function mapNotification(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    title: row.title,
    body: row.body || '',
    link: row.link || null,
    data: parseJson(row.data_json),
    readAt: row.read_at || null,
    createdAt: row.created_at,
  }
}

function emitNotification(notification) {
  if (!notification?.userId) return
  const set = subscribers.get(notification.userId)
  if (!set) return
  for (const listener of set) {
    try {
      listener(notification)
    } catch (err) {
      console.error('[notifications] listener error:', err?.stack || err)
    }
  }
}

export function createNotification({
  id = newId(),
  userId,
  kind = 'info',
  title,
  body = '',
  link = null,
  data = null,
  now = Date.now(),
}) {
  if (!userId) throw new Error('createNotification requires userId')
  if (!title || !String(title).trim()) throw new Error('createNotification requires title')
  const normalizedKind = VALID_KINDS.has(kind) ? kind : 'info'
  getDb().prepare(`
    INSERT INTO notifications
      (id, user_id, kind, title, body, link, data_json, read_at, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    id,
    userId,
    normalizedKind,
    String(title).trim(),
    body == null ? '' : String(body),
    link || null,
    data == null ? null : JSON.stringify(data),
    now,
  )
  const notification = getNotification(id)
  emitNotification(notification)
  return notification
}

export function getNotification(id, { userId } = {}) {
  const row = getDb().prepare('SELECT * FROM notifications WHERE id = ?').get(id)
  if (!row) return null
  if (userId && row.user_id !== userId) return null
  return mapNotification(row)
}

export function listNotifications({ userId, unread = false, limit = 50, offset = 0 } = {}) {
  if (!userId) throw new Error('listNotifications requires userId')
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100))
  const safeOffset = Math.max(0, Number(offset) || 0)
  const db = getDb()
  const rows = unread
    ? db.prepare(`
        SELECT * FROM notifications
        WHERE user_id = ? AND read_at IS NULL
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(userId, safeLimit, safeOffset)
    : db.prepare(`
        SELECT * FROM notifications
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(userId, safeLimit, safeOffset)
  return rows.map(mapNotification)
}

export function countUnreadNotifications(userId) {
  if (!userId) throw new Error('countUnreadNotifications requires userId')
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM notifications
    WHERE user_id = ? AND read_at IS NULL
  `).get(userId)
  return Number(row?.count || 0)
}

export function markRead(ids = [], { userId, now = Date.now() } = {}) {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))]
  if (!uniqueIds.length) return 0
  const placeholders = uniqueIds.map(() => '?').join(',')
  const params = userId ? [now, userId, ...uniqueIds] : [now, ...uniqueIds]
  const where = userId
    ? `user_id = ? AND id IN (${placeholders})`
    : `id IN (${placeholders})`
  const info = getDb().prepare(`
    UPDATE notifications
    SET read_at = COALESCE(read_at, ?)
    WHERE ${where}
  `).run(...params)
  return info.changes
}

export function markAllRead(userId, { now = Date.now() } = {}) {
  if (!userId) throw new Error('markAllRead requires userId')
  const info = getDb().prepare(`
    UPDATE notifications
    SET read_at = COALESCE(read_at, ?)
    WHERE user_id = ? AND read_at IS NULL
  `).run(now, userId)
  return info.changes
}

export function deleteNotification(id, { userId } = {}) {
  if (!id) return 0
  const info = userId
    ? getDb().prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(id, userId)
    : getDb().prepare('DELETE FROM notifications WHERE id = ?').run(id)
  return info.changes
}

export function deleteOld(beforeTs) {
  const info = getDb().prepare('DELETE FROM notifications WHERE created_at < ?').run(Number(beforeTs) || 0)
  return info.changes
}

export function subscribeNotifications(userId, listener) {
  if (!userId || typeof listener !== 'function') return () => {}
  const set = subscribers.get(userId) || new Set()
  set.add(listener)
  subscribers.set(userId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) subscribers.delete(userId)
  }
}
