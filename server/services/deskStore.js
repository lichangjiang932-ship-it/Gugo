/**
 * Desk Notes 仓储 (Hanako 平行功能：书桌便笺)
 *
 * 设计要点：
 * - 一切按 user_id 隔离，遵循项目 row→object mapping 风格 (mapNote)。
 * - agent_id 可选；不绑定 agent 的便笺出现在全局书桌。
 * - pinned 排序在前，其次按 updated_at desc。
 */

import { getDb } from '../db.js'
import { randomBytes } from 'node:crypto'

function generateId() {
  return 'note_' + randomBytes(8).toString('hex')
}

function mapNote(row) {
  if (!row) return null
  return {
    id: row.id,
    agentId: row.agent_id || null,
    title: row.title || '',
    body: row.body || '',
    pinned: !!row.pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listDeskNotes({ userId, agentId, limit = 200 } = {}) {
  if (!userId) throw new Error('userId required')
  const db = getDb()
  const lim = Math.min(500, Math.max(1, Number(limit) || 200))
  if (agentId === undefined) {
    return db
      .prepare(
        'SELECT * FROM desk_notes WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC LIMIT ?'
      )
      .all(userId, lim)
      .map(mapNote)
  }
  if (agentId === null) {
    return db
      .prepare(
        'SELECT * FROM desk_notes WHERE user_id = ? AND agent_id IS NULL ORDER BY pinned DESC, updated_at DESC LIMIT ?'
      )
      .all(userId, lim)
      .map(mapNote)
  }
  return db
    .prepare(
      'SELECT * FROM desk_notes WHERE user_id = ? AND agent_id = ? ORDER BY pinned DESC, updated_at DESC LIMIT ?'
    )
    .all(userId, agentId, lim)
    .map(mapNote)
}

export function getDeskNote({ userId, id }) {
  if (!userId || !id) return null
  const db = getDb()
  return mapNote(db.prepare('SELECT * FROM desk_notes WHERE id = ? AND user_id = ?').get(id, userId))
}

export function createDeskNote({
  userId,
  agentId = null,
  title = '',
  body = '',
  pinned = false,
  now = Date.now(),
}) {
  if (!userId) throw new Error('userId required')
  const db = getDb()
  const id = generateId()
  db.prepare(
    `INSERT INTO desk_notes (id, user_id, agent_id, title, body, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, agentId || null, String(title || ''), String(body || ''), pinned ? 1 : 0, now, now)
  return getDeskNote({ userId, id })
}

export function updateDeskNote({ userId, id, patch = {}, now = Date.now() }) {
  if (!userId || !id) return null
  const existing = getDeskNote({ userId, id })
  if (!existing) return null
  const next = {
    agent_id: 'agentId' in patch ? patch.agentId || null : existing.agentId,
    title: 'title' in patch ? String(patch.title || '') : existing.title,
    body: 'body' in patch ? String(patch.body || '') : existing.body,
    pinned: 'pinned' in patch ? (patch.pinned ? 1 : 0) : existing.pinned ? 1 : 0,
  }
  const db = getDb()
  db.prepare(
    `UPDATE desk_notes
     SET agent_id = ?, title = ?, body = ?, pinned = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(next.agent_id, next.title, next.body, next.pinned, now, id, userId)
  return getDeskNote({ userId, id })
}

export function deleteDeskNote({ userId, id }) {
  if (!userId || !id) return false
  const db = getDb()
  const result = db.prepare('DELETE FROM desk_notes WHERE id = ? AND user_id = ?').run(id, userId)
  return result.changes > 0
}

export function countDeskNotes({ userId, agentId } = {}) {
  if (!userId) return 0
  const db = getDb()
  if (agentId === undefined) {
    return db.prepare('SELECT COUNT(*) as n FROM desk_notes WHERE user_id = ?').get(userId).n
  }
  if (agentId === null) {
    return db.prepare('SELECT COUNT(*) as n FROM desk_notes WHERE user_id = ? AND agent_id IS NULL').get(userId).n
  }
  return db
    .prepare('SELECT COUNT(*) as n FROM desk_notes WHERE user_id = ? AND agent_id = ?')
    .get(userId, agentId).n
}
