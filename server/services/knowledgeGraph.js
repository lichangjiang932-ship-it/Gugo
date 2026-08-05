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

import { getDb } from '../db.js'
import crypto from 'node:crypto'
import { traverseMemoryLinks } from './memoryStore.js'

const MAX_TRAVERSAL_DEPTH = 5
const MAX_TRAVERSAL_NODES = 250

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

export const READ_GRAPH_DEFAULT_LIMIT = 200

/**
 * 读取用户的知识图谱。
 *
 * 实体数量可能超过单页上限,因此返回值带有分页元信息:
 *   - totalEntities:该用户实体总数(不受 limit 影响)
 *   - truncated:本次是否只返回了部分实体
 * 调用方应检查 truncated,必要时用 offset 继续翻页,
 * 而不是把结果当作完整图谱。
 *
 * 关系两端只要有一端落在本页实体内就会被返回(与 searchNodes 一致),
 * 避免出现「实体在、关系却凭空消失」的割裂子图。
 */
export function readGraph({ userId, limit = READ_GRAPH_DEFAULT_LIMIT, offset = 0 } = {}) {
  const empty = { entities: [], relations: [], observations: [], totalEntities: 0, truncated: false }
  if (!userId) return empty
  const db = getDb()

  const safeLimit = Math.max(1, Math.min(Number(limit) || READ_GRAPH_DEFAULT_LIMIT, 1000))
  const safeOffset = Math.max(0, Number(offset) || 0)

  const { count: totalEntities } = db.prepare(
    'SELECT COUNT(*) AS count FROM entities WHERE user_id = ?'
  ).get(userId)

  const entities = db.prepare(
    'SELECT * FROM entities WHERE user_id = ? ORDER BY name LIMIT ? OFFSET ?'
  ).all(userId, safeLimit, safeOffset).map(rowToEntity)

  const truncated = safeOffset + entities.length < totalEntities
  if (!entities.length) return { ...empty, totalEntities, truncated }

  const entityIds = entities.map((e) => e.id)
  const placeholders = entityIds.map(() => '?').join(',')
  const relations = db.prepare(
    `SELECT * FROM relations WHERE from_entity_id IN (${placeholders}) OR to_entity_id IN (${placeholders})`
  ).all(...entityIds, ...entityIds).map(rowToRelation)
  const observations = db.prepare(
    `SELECT * FROM observations WHERE entity_id IN (${placeholders})`
  ).all(...entityIds).map(rowToObservation)

  return { entities, relations, observations, totalEntities, truncated }
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

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(Math.trunc(parsed), max))
}

function loadTraversalSeeds({ db, userId, startIds, startNames, limit }) {
  const seeds = []
  if (startIds.length) {
    const placeholders = startIds.map(() => '?').join(',')
    seeds.push(...db.prepare(
      `SELECT * FROM entities WHERE user_id = ? AND id IN (${placeholders})
       ORDER BY name, id LIMIT ?`
    ).all(userId, ...startIds, limit).map(rowToEntity))
  }
  if (startNames.length && seeds.length < limit) {
    const placeholders = startNames.map(() => '?').join(',')
    seeds.push(...db.prepare(
      `SELECT * FROM entities WHERE user_id = ? AND name IN (${placeholders})
       ORDER BY name, id LIMIT ?`
    ).all(userId, ...startNames, limit - seeds.length).map(rowToEntity))
  }
  return [...new Map(seeds.map((entity) => [entity.id, entity])).values()].slice(0, limit)
}

function loadFrontierRelations({ db, userId, frontier, direction, limit }) {
  if (!frontier.length) return []
  const placeholders = frontier.map(() => '?').join(',')
  if (direction === 'outgoing') {
    return db.prepare(
      `SELECT * FROM relations WHERE user_id = ? AND from_entity_id IN (${placeholders})
       ORDER BY created_at, id LIMIT ?`
    ).all(userId, ...frontier, limit).map(rowToRelation)
  }
  if (direction === 'incoming') {
    return db.prepare(
      `SELECT * FROM relations WHERE user_id = ? AND to_entity_id IN (${placeholders})
       ORDER BY created_at, id LIMIT ?`
    ).all(userId, ...frontier, limit).map(rowToRelation)
  }
  return db.prepare(
    `SELECT * FROM relations WHERE user_id = ?
     AND (from_entity_id IN (${placeholders}) OR to_entity_id IN (${placeholders}))
     ORDER BY created_at, id LIMIT ?`
  ).all(userId, ...frontier, ...frontier, limit).map(rowToRelation)
}

function neighborIds(relations, frontier, direction) {
  const frontierSet = new Set(frontier)
  const ids = []
  for (const relation of relations) {
    if (direction !== 'incoming' && frontierSet.has(relation.from)) ids.push(relation.to)
    if (direction !== 'outgoing' && frontierSet.has(relation.to)) ids.push(relation.from)
  }
  return [...new Set(ids)]
}

function loadEntitiesById({ db, userId, ids }) {
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(
    `SELECT * FROM entities WHERE user_id = ? AND id IN (${placeholders}) ORDER BY name, id`
  ).all(userId, ...ids).map(rowToEntity)
}

function loadObservationsForEntities({ db, entityIds }) {
  if (!entityIds.length) return []
  const placeholders = entityIds.map(() => '?').join(',')
  return db.prepare(
    `SELECT * FROM observations WHERE entity_id IN (${placeholders}) ORDER BY created_at, id`
  ).all(...entityIds).map(rowToObservation)
}

/**
 * 从一组实体开始做有界多跳遍历。深度和节点数同时受硬上限约束，
 * 返回的关系只包含最终节点集合内部的边，避免悬空端点和跨用户泄漏。
 */
export function traverseGraph({
  userId,
  startIds = [],
  startNames = [],
  maxDepth = 2,
  maxNodes = 100,
  direction = 'both',
  includeObservations = true,
} = {}) {
  const empty = {
    entities: [],
    relations: [],
    observations: [],
    depthByEntityId: {},
    truncated: false,
  }
  if (!userId) return empty
  const safeDepth = boundedInteger(maxDepth, 2, 0, MAX_TRAVERSAL_DEPTH)
  const safeNodes = boundedInteger(maxNodes, 100, 1, MAX_TRAVERSAL_NODES)
  const safeDirection = ['outgoing', 'incoming', 'both'].includes(direction) ? direction : 'both'
  const ids = [...new Set((Array.isArray(startIds) ? startIds : []).map(String).filter(Boolean))].slice(0, safeNodes)
  const names = [...new Set((Array.isArray(startNames) ? startNames : []).map(String).map((name) => name.trim()).filter(Boolean))].slice(0, safeNodes)
  if (!ids.length && !names.length) return empty

  const db = getDb()
  const seeds = loadTraversalSeeds({ db, userId, startIds: ids, startNames: names, limit: safeNodes })
  if (!seeds.length) return empty
  const entitiesById = new Map(seeds.map((entity) => [entity.id, entity]))
  const depthByEntityId = new Map(seeds.map((entity) => [entity.id, 0]))
  const relationsById = new Map()
  let frontier = seeds.map((entity) => entity.id)
  let truncated = seeds.length >= safeNodes && (ids.length + names.length) > seeds.length

  for (let depth = 0; depth < safeDepth && frontier.length; depth += 1) {
    const remaining = safeNodes - entitiesById.size
    if (remaining <= 0) {
      truncated = true
      break
    }
    const relationLimit = Math.min(Math.max(remaining * 12, 64), 2000)
    const relations = loadFrontierRelations({
      db,
      userId,
      frontier,
      direction: safeDirection,
      limit: relationLimit,
    })
    for (const relation of relations) relationsById.set(relation.id, relation)
    const candidates = neighborIds(relations, frontier, safeDirection)
      .filter((id) => !entitiesById.has(id))
    const loaded = loadEntitiesById({ db, userId, ids: candidates })
    const next = []
    for (const entity of loaded) {
      if (entitiesById.size >= safeNodes) {
        truncated = true
        continue
      }
      entitiesById.set(entity.id, entity)
      depthByEntityId.set(entity.id, depth + 1)
      next.push(entity.id)
    }
    frontier = next
  }

  const included = new Set(entitiesById.keys())
  const relations = [...relationsById.values()].filter((relation) => (
    included.has(relation.from) && included.has(relation.to)
  ))
  const entityIds = [...entitiesById.keys()]
  return {
    entities: [...entitiesById.values()],
    relations,
    observations: includeObservations ? loadObservationsForEntities({ db, entityIds }) : [],
    depthByEntityId: Object.fromEntries(depthByEntityId),
    truncated,
  }
}

/**
 * 把 memories + memory_links 作为知识图谱的记忆子图读取。
 * 具体遍历与 agent 可见性由 memoryStore 统一实现。
 */
export function traverseMemoryGraph(options = {}) {
  return traverseMemoryLinks(options)
}
