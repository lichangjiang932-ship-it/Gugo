/**
 * 知识图谱 —— 实体/关系/观测值 三要素模型。
 * 参考 Reasonix 的 memory_* 工具集设计。
 *
 * 设计:
 *   entities:  { name, entityType, observations }
 *   relations: { from, to, relationType } — 主动语态
 *   observations: 附加到实体的文本片段
 *
 * 操作:
 *   createEntities / deleteEntities
 *   createRelations / deleteRelations
 *   addObservations / deleteObservations
 *   searchNodes / readGraph / openNodes
 */

import { getDb } from './db.js'
import crypto from 'node:crypto'

function newId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function now() {
  return Date.now()
}

/* ─── Entity helpers ─── */

function rowToEntity(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    entityType: row.entity_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToRelation(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    from: row.from_entity_id,
    to: row.to_entity_id,
    relationType: row.relation_type,
    createdAt: row.created_at,
  }
}

function rowToObservation(row) {
  if (!row) return null
  return {
    id: row.id,
    entityId: row.entity_id,
    content: row.content,
    createdAt: row.created_at,
  }
}

/* ─── Entities ─── */

export function createEntities({ userId, entities }) {
  if (!userId) throw new Error('createEntities requires userId')
  const db = getDb()
  const stmt = db.prepare(
    'INSERT INTO entities (id, user_id, name, entity_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const t = now()
  const ids = []
  const insertMany = db.transaction((items) => {
    for (const entity of items) {
      const id = newId()
      stmt.run(id, userId, entity.name, entity.entityType || 'general', t, t)
      ids.push(id)
    }
  })
  insertMany(entities)
  return ids.map((id) => getEntityById(id))
}

export function getEntityById(id) {
  return rowToEntity(getDb().prepare('SELECT * FROM entities WHERE id = ?').get(id))
}

export function findEntityByName({ userId, name }) {
  return rowToEntity(
    getDb().prepare('SELECT * FROM entities WHERE user_id = ? AND name = ?').get(userId, name)
  )
}

export function deleteEntities({ userId, entityNames }) {
  if (!userId || !Array.isArray(entityNames)) return
  const db = getDb()
  // CASCADE will delete relations and observations
  const stmt = db.prepare('DELETE FROM entities WHERE user_id = ? AND name = ?')
  const deleteMany = db.transaction((names) => {
    for (const name of names) stmt.run(userId, name)
  })
  deleteMany(entityNames)
}

/* ─── Relations ─── */

export function createRelations({ userId, relations }) {
  if (!userId) throw new Error('createRelations requires userId')
  const db = getDb()
  const stmt = db.prepare(
    'INSERT INTO relations (id, user_id, from_entity_id, to_entity_id, relation_type, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const t = now()
  const insertMany = db.transaction((items) => {
    for (const rel of items) {
      const from = findEntityByName({ userId, name: rel.from })
      const to = findEntityByName({ userId, name: rel.to })
      if (!from || !to) continue // skip dangling relations
      stmt.run(newId(), userId, from.id, to.id, rel.relationType, t)
    }
  })
  insertMany(relations)
}

export function deleteRelations({ userId, relations }) {
  if (!userId || !Array.isArray(relations)) return
  const db = getDb()
  const stmt = db.prepare(`
    DELETE FROM relations
    WHERE user_id = ? AND from_entity_id = (SELECT id FROM entities WHERE user_id = ? AND name = ? LIMIT 1)
      AND to_entity_id = (SELECT id FROM entities WHERE user_id = ? AND name = ? LIMIT 1)
      AND relation_type = ?
  `)
  const deleteMany = db.transaction((items) => {
    for (const rel of items) {
      stmt.run(userId, userId, rel.from, userId, rel.to, rel.relationType)
    }
  })
  deleteMany(relations)
}

/* ─── Observations ─── */

export function addObservations({ userId, observations }) {
  if (!userId) throw new Error('addObservations requires userId')
  const db = getDb()
  const stmt = db.prepare(
    'INSERT INTO observations (id, entity_id, content, created_at) VALUES (?, (SELECT id FROM entities WHERE user_id = ? AND name = ?), ?, ?)'
  )
  const t = now()
  const insertMany = db.transaction((items) => {
    for (const obs of items) {
      const entity = findEntityByName({ userId, name: obs.entityName })
      if (!entity) continue
      // Each content string becomes a separate observation row
      for (const content of obs.contents) {
        stmt.run(newId(), userId, obs.entityName, String(content), t)
      }
    }
  })
  insertMany(observations)
}

export function deleteObservations({ userId, deletions }) {
  if (!userId || !Array.isArray(deletions)) return
  const db = getDb()
  const stmt = db.prepare(`
    DELETE FROM observations WHERE id = ? AND entity_id = (SELECT id FROM entities WHERE user_id = ? AND name = ?)
  `)
  const deleteMany = db.transaction((items) => {
    for (const d of items) {
      const entity = findEntityByName({ userId, name: d.entityName })
      if (!entity) continue
      for (const obsId of d.observations) {
        // obsId is actually content match — we'll match by content string
        const obs = db.prepare(
          'SELECT id FROM observations WHERE entity_id = ? AND content = ?'
        ).get(entity.id, obsId)
        if (obs) stmt.run(obs.id, userId, d.entityName)
      }
    }
  })
  deleteMany(deletions)
}

/* ─── Query ─── */

export function searchNodes({ userId, query }) {
  if (!userId) return { entities: [], relations: [], observations: [] }
  const db = getDb()
  const q = `%${query}%`
  const entities = db.prepare(
    'SELECT * FROM entities WHERE user_id = ? AND (name LIKE ? OR entity_type LIKE ?) ORDER BY name LIMIT 50'
  ).all(userId, q, q).map(rowToEntity)

  const entityIds = entities.map((e) => e.id)
  if (!entityIds.length) return { entities, relations: [], observations: [] }

  const placeholders = entityIds.map(() => '?').join(',')
  const relations = db.prepare(
    `SELECT * FROM relations WHERE from_entity_id IN (${placeholders}) OR to_entity_id IN (${placeholders})`
  ).all(...entityIds, ...entityIds).map(rowToRelation)

  const observations = db.prepare(
    `SELECT * FROM observations WHERE entity_id IN (${placeholders}) AND content LIKE ?`
  ).all(...entityIds, q).map(rowToObservation)

  return { entities, relations, observations }
}

export function readGraph({ userId }) {
  if (!userId) return { entities: [], relations: [], observations: [] }
  const db = getDb()
  const entities = db.prepare(
    'SELECT * FROM entities WHERE user_id = ? ORDER BY name LIMIT 200'
  ).all(userId).map(rowToEntity)
  const entityIds = entities.map((e) => e.id)
  if (!entityIds.length) return { entities, relations: [], observations: [] }
  const placeholders = entityIds.map(() => '?').join(',')
  const relations = db.prepare(
    `SELECT * FROM relations WHERE from_entity_id IN (${placeholders})`
  ).all(...entityIds).map(rowToRelation)
  const observations = db.prepare(
    `SELECT * FROM observations WHERE entity_id IN (${placeholders})`
  ).all(...entityIds).map(rowToObservation)
  return { entities, relations, observations }
}

export function openNodes({ userId, names }) {
  if (!userId || !Array.isArray(names)) return []
  const db = getDb()
  const results = []
  for (const name of names) {
    const entity = findEntityByName({ userId, name })
    if (!entity) continue
    const relations = db.prepare(
      'SELECT * FROM relations WHERE from_entity_id = ? OR to_entity_id = ?'
    ).all(entity.id, entity.id).map(rowToRelation)
    const observations = db.prepare(
      'SELECT * FROM observations WHERE entity_id = ?'
    ).all(entity.id).map(rowToObservation)
    results.push({ ...entity, relations, observations })
  }
  return results
}
