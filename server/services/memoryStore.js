/**
 * Feature 3: 记忆系统的 DB CRUD + MEMORY.md 索引合成。
 *
 * 字段映射:
 *   memories.frontmatter_json: { tags?: string[], scope?: string, confidence?: number, source?: string }
 *
 * [[link]] 链:
 *   - body 中出现 [[slug]] 时记入 memory_links 表
 *   - 渲染时 MarkdownRenderer 检测 [[slug]] 替换为 anchor (前端做)
 */

import { getDb } from '../db.js'
import { createHash, randomUUID } from 'node:crypto'
import { normalizedSearchText, rankMemoriesByQuery } from './memoryRelevance.js'
import { searchLexicalMemories } from './memoryLexicalSearch.js'
import { findIndexedMemory, findMemoryWithPredicate } from './memoryExactMatch.js'
import { assertCompleteMemorySearchIndex, indexMemoryRow } from './memorySearchIndex.js'
import { memorySimilarityById, searchMemoryEmbeddings } from './memoryEmbeddingStore.js'
import { row2memory } from './memoryRowMapper.js'
import { fitMemorySystemBlock } from './memoryPromptRendering.js'
export { classifyMemoryFreshness, buildMemorySystemBlock } from './memoryPromptRendering.js'
export { scoreMemoryRelevance } from './memoryRelevance.js'

const ALLOWED_TYPES = ['user', 'feedback', 'project', 'reference']
const RECENT_CANDIDATE_LIMIT = 60
const MAX_LINK_DEPTH = 5
const MAX_LINK_NODES = 200

function normalizeSlug(s) {
  return Array.from(String(s || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, ''))
    .slice(0, 80).join('') || 'memory'
}

function allocateMemorySlug(db, userId, title, memoryId) {
  const base = normalizeSlug(title)
  const exists = db.prepare('SELECT 1 FROM memories WHERE user_id = ? AND slug = ? LIMIT 1')
  if (!exists.get(userId, base)) return base
  const suffix = createHash('sha256').update(String(memoryId)).digest('hex').slice(0, 16)
  const slug = `${Array.from(base).slice(0, 63).join('')}-${suffix}`
  if (exists.get(userId, slug)) throw new Error('Memory link identity conflicts with an existing memory')
  return slug
}


export function listMemories({ userId, type = null, query = null, limit = 200, agentFilter = null,
  signal = null, lexicalLimits = {}, indexLimits = {} }) {
  if (!userId) return []
  const db = getDb()
  const params = [userId]
  const safeLimit = Math.floor(Math.min(Math.max(1, Number(limit) || 200), 500))
  if (normalizedSearchText(query)) {
    return searchLexicalMemories(db, {
      userId, query, agentId: agentFilter === '__global__' ? null : agentFilter,
      includeAllAgents: !agentFilter, type: ALLOWED_TYPES.includes(type) ? type : null,
      signal, limits: { ...lexicalLimits, topK: safeLimit }, indexLimits,
    }).memories
  }
  let sql = 'SELECT * FROM memories WHERE user_id = ?'
  if (type && ALLOWED_TYPES.includes(type)) {
    sql += ' AND type = ?'
    params.push(type)
  }
  // v0.8：agent 过滤
  // '__global__'      → 只看全局（agent_id IS NULL）
  // 具体 agentId   → 只看该 agent 专属
  // null / undefined  → 不过滤（全部）
  if (agentFilter === '__global__') {
    sql += ' AND agent_id IS NULL'
  } else if (agentFilter) {
    sql += ' AND agent_id = ?'
    params.push(agentFilter)
  }
  sql += ' ORDER BY pinned DESC, COALESCE(last_used_at, updated_at) DESC LIMIT ?'
  params.push(safeLimit)
  const memories = db.prepare(sql).all(...params).map(row2memory)
  return memories
}

export function findMatchingMemory(options, matches) {
  if (!options?.userId) return null
  return findMemoryWithPredicate(getDb(), options, matches)
}

export function findExactMemory(options) {
  if (!options?.userId) return null
  return findIndexedMemory(getDb(), options)
}

/** Commit bounded index catch-up separately; then fence matching and mutation together. */
export function withMemoryMatchTransaction(options, work) {
  const db = getDb()
  assertCompleteMemorySearchIndex(db, options)
  return db.transaction(() => {
    assertCompleteMemorySearchIndex(db, options)
    return work()
  }).immediate()
}

export function getMemory(userId, id) {
  if (!userId || !id) return null
  const db = getDb()
  const row = db.prepare('SELECT * FROM memories WHERE user_id = ? AND id = ?').get(userId, id)
  return row2memory(row)
}

export function upsertMemory({ id, userId, type, title, body, frontmatter = {}, pinned = false, sourceSessionId = null, sourceMessageId = null, agentId = null }) {
  if (!userId) throw new Error('userId 必填')
  if (!ALLOWED_TYPES.includes(type)) throw new Error(`type 必须是 ${ALLOWED_TYPES.join('/')} 之一`)
  if (!title?.trim()) throw new Error('title 不能为空')
  if (!body?.trim()) throw new Error('body 不能为空')
  const db = getDb()
  const now = Date.now()
  const memoryId = id || randomUUID()
  const frontmatterJson = JSON.stringify(frontmatter || {})

  return db.transaction(() => {
    if (agentId && !db.prepare('SELECT 1 FROM agents WHERE user_id = ? AND id = ?').get(userId, agentId)) {
      throw Object.assign(new Error('Memory agent does not belong to this user'), { code: 'MEMORY_AGENT_NOT_FOUND' })
    }
    const existing = db.prepare('SELECT id, slug, source_session_id, source_message_id FROM memories WHERE user_id = ? AND id = ?').get(userId, memoryId)
    // Slugs are stable identities, not a projection that changes with a title.
    // Preserve legacy links instead of ambiguously rewriting historical data.
    const slug = existing?.slug || allocateMemorySlug(db, userId, title, memoryId)
    if (existing) {
      const sourceProvided = sourceSessionId != null || sourceMessageId != null
      const nextSession = sourceProvided ? sourceSessionId : existing.source_session_id
      const nextMessage = sourceProvided ? sourceMessageId : existing.source_message_id
      db.prepare(
        `UPDATE memories SET type=?, title=?, slug=?, body=?, frontmatter_json=?, pinned=?, agent_id=?, updated_at=?,
         source_session_id=?, source_message_id=?
         WHERE id=? AND user_id=?`
      ).run(type, title.trim(), slug, body.trim(), frontmatterJson, pinned ? 1 : 0, agentId || null, now,
        nextSession, nextMessage, memoryId, userId)
    } else {
      db.prepare(
        `INSERT INTO memories (id, user_id, type, title, slug, body, frontmatter_json, pinned, source_session_id, source_message_id, agent_id, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      ).run(memoryId, userId, type, title.trim(), slug, body.trim(), frontmatterJson, pinned ? 1 : 0, sourceSessionId, sourceMessageId, agentId || null, now, now)
    }

    // The memory body, attribution and linked graph are one atomic mutation.
    db.prepare('DELETE FROM memory_links WHERE from_id = ?').run(memoryId)
    const links = new Set()
    const linkPattern = /\[\[([\p{L}\p{N}_-]+)\]\]/giu
    let m
    const canonicalLinkText = body.normalize('NFKC')
    while ((m = linkPattern.exec(canonicalLinkText)) !== null) {
      links.add(normalizeSlug(m[1]))
    }
    const insLink = db.prepare(`
      INSERT INTO memory_links (from_id, to_slug) VALUES (?, ?)
      ON CONFLICT(from_id, to_slug) DO NOTHING
    `)
    for (const s of links) insLink.run(memoryId, s)

    indexMemoryRow(db, db.prepare('SELECT rowid AS memory_order,* FROM memories WHERE id = ? AND user_id = ?')
      .get(memoryId, userId))

    return getMemory(userId, memoryId)
  })()
}

export function deleteMemory(userId, id) {
  if (!userId || !id) return { deleted: 0 }
  const db = getDb()
  const result = db.prepare('DELETE FROM memories WHERE user_id = ? AND id = ?').run(userId, id)
  return { deleted: result.changes }
}

export function touchMemoryUsage(userId, ids) {
  if (!userId || !Array.isArray(ids) || !ids.length) return
  const db = getDb()
  const now = Date.now()
  const stmt = db.prepare('UPDATE memories SET last_used_at = ? WHERE user_id = ? AND id = ?')
  db.transaction(() => {
    for (const id of ids) stmt.run(now, userId, id)
  })()
}

/**
 * 选 active 记忆做注入。优先 pinned > last_used_at > updated_at。
 *
 * 阶段 6：支持 agentId 过滤。只返回 “agent_id IS NULL (全局) OR agent_id = :agentId” 的记忆。
 * agentId = null 则只拿全局记忆 (未绑 agent)。
 */
export function selectActiveMemoriesForInjection({
  userId, tokenCap = 800, agentId = null, query = null, queryVector = null, querySpace = null,
  signal = null, semanticLimits = {}, lexicalLimits = {}, indexLimits = {}, lexicalCursor = null,
  now = Date.now(), deferFitting = false,
}) {
  if (!userId) return { memories: [], totalChars: 0 }
  if (signal?.aborted) return { memories: [], totalChars: 0, diagnostics: { cancelled: true } }
  const db = getDb()
  const normalizedTokenCap = memoryInjectionTokenCap(tokenCap)
  const hasQuery = !!normalizedSearchText(query)
  // Semantic scoring is only allowed when the caller can name the vector space
  // the query came from. Without it a stored vector is not comparable, and
  // guessing would silently rank unrelated memories.
  const semanticActive = Array.isArray(queryVector) && queryVector.length > 0 && !!querySpace && querySpace !== 'unknown'
  const scopeClause = agentId
    ? 'AND (agent_id IS NULL OR agent_id = ?)'
    : 'AND agent_id IS NULL'
  const scopeParams = agentId ? [String(agentId)] : []
  const orderBy = 'ORDER BY pinned DESC, COALESCE(last_used_at, updated_at) DESC, id ASC'
  const readPool = (limit) => db.prepare(
    `SELECT * FROM memories WHERE user_id = ? ${scopeClause} ${orderBy} LIMIT ?`,
  ).all(String(userId), ...scopeParams, limit)
  const byId = new Map()
  const collect = (rows) => {
    for (const row of rows) {
      if (!byId.has(row.id)) byId.set(row.id, row2memory(row))
    }
  }

  // Lexical candidates are never filtered by semantic index availability,
  // embedding space, or the semantic scan's resource budget.
  let lexical = null
  if (hasQuery) {
    lexical = searchLexicalMemories(db, {
      userId, agentId, includeGlobal: true, query, signal,
      limits: lexicalLimits, indexLimits, cursor: lexicalCursor,
    })
    for (const memory of lexical.memories) byId.set(memory.id, memory)
    collect(db.prepare(`SELECT * FROM memories WHERE user_id = ? ${scopeClause} AND pinned = 1 ${orderBy} LIMIT ?`)
      .all(String(userId), ...scopeParams, RECENT_CANDIDATE_LIMIT))
  }
  if (!hasQuery && !semanticActive) collect(readPool(RECENT_CANDIDATE_LIMIT))
  if (!hasQuery && semanticActive) collect(db.prepare(
    `SELECT * FROM memories WHERE user_id = ? ${scopeClause} AND pinned = 1 ${orderBy} LIMIT ?`,
  ).all(String(userId), ...scopeParams, RECENT_CANDIDATE_LIMIT))
  const lexicalCount = byId.size
  const semantic = semanticActive ? searchMemoryEmbeddings({
    userId, agentId, queryVector, querySpace, signal,
    limits: semanticLimits,
  }) : null
  let similarityById = null
  if (semantic) {
    try {
      similarityById = memorySimilarityById({ userId, memories: [...byId.values()], queryVector, querySpace })
    } catch {
      semantic.diagnostics.code = 'MEMORY_SEMANTIC_QUERY_FAILED'
      semantic.diagnostics.truncated = true
      semantic.diagnostics.coverage = 'partial'
      similarityById = new Map()
    }
    for (const memory of semantic.memories) if (!byId.has(memory.id)) byId.set(memory.id, memory)
    for (const [id, similarity] of semantic.similarityById) similarityById.set(id, similarity)
  }
  const memories = [...byId.values()]
  const ranked = hasQuery || similarityById
    ? rankMemoriesByQuery(memories, query, { keepPinned: true, similarityById }).map(({ memory }) => memory)
    : memories
  const fitted = deferFitting
    ? { memories: ranked, totalChars: 0, tokenTruncated: false }
    : fitMemorySystemBlock(ranked, { tokenCap: normalizedTokenCap, query, now })
  return {
    memories: fitted.memories, totalChars: fitted.totalChars,
    diagnostics: { lexicalCandidates: lexicalCount, lexical: lexical?.diagnostics || null, semantic: semantic?.diagnostics || null,
      candidateCount: ranked.length, tokenTruncated: fitted.tokenTruncated },
  }
}

/** Shared injection budget, including a finite upper bound for malformed config. */
export function memoryInjectionTokenCap(tokenCap = 800) {
  return clampInteger(tokenCap, 800, 1, 16_000)
}

export function buildMemoryIndex(userId) {
  if (!userId) return '# MEMORY.md\n\n(未登录)\n'
  const { list, total } = getDb().transaction(() => ({
    list: listMemories({ userId, limit: 500 }),
    total: getDb().prepare('SELECT COUNT(*) AS total FROM memories WHERE user_id = ?').get(userId).total,
  }))()
  const byType = {}
  for (const m of list) {
    if (!byType[m.type]) byType[m.type] = []
    byType[m.type].push(m)
  }
  const lines = ['# MEMORY.md', '', `本用户共 ${total} 条记忆。\n`]
  if (total > list.length) lines.push(`当前展示 ${list.length} 条记忆（上限 500 条）；以下分类数量仅统计已展示条目。\n`)
  for (const type of ALLOWED_TYPES) {
    const items = byType[type] || []
    if (!items.length) continue
    lines.push(`## ${type} (${items.length})`)
    for (const m of items) {
      const star = m.pinned ? '★ ' : ''
      const snippet = (m.body || '').split('\n')[0].slice(0, 80)
      lines.push(`- ${star}[[${m.slug}]] **${m.title}** — ${snippet}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function findBySlug(userId, slug) {
  if (!userId || !slug) return null
  const db = getDb()
  const row = db.prepare('SELECT * FROM memories WHERE user_id = ? AND slug = ? ORDER BY updated_at DESC LIMIT 1').get(userId, slug)
  return row2memory(row)
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(Math.trunc(parsed), max))
}

function agentVisibility(alias, agentId, params) {
  if (agentId) {
    params.push(agentId)
    return `(${alias}.agent_id IS NULL OR ${alias}.agent_id = ?)`
  }
  return `${alias}.agent_id IS NULL`
}

function loadMemoryLinkSeeds({ db, userId, seedIds, seedSlugs, agentId, limit }) {
  const seeds = []
  if (seedIds.length) {
    const params = [userId]
    const visibility = agentVisibility('memories', agentId, params)
    const placeholders = seedIds.map(() => '?').join(',')
    params.push(...seedIds, limit)
    seeds.push(...db.prepare(
      `SELECT * FROM memories WHERE user_id = ? AND ${visibility} AND id IN (${placeholders})
       ORDER BY pinned DESC, updated_at DESC, id ASC LIMIT ?`
    ).all(...params).map(row2memory))
  }
  if (seedSlugs.length && seeds.length < limit) {
    const params = [userId]
    const visibility = agentVisibility('memories', agentId, params)
    const placeholders = seedSlugs.map(() => '?').join(',')
    params.push(...seedSlugs, limit - seeds.length)
    seeds.push(...db.prepare(
      `SELECT * FROM memories WHERE user_id = ? AND ${visibility} AND slug IN (${placeholders})
       ORDER BY pinned DESC, updated_at DESC, id ASC LIMIT ?`
    ).all(...params).map(row2memory))
  }
  return [...new Map(seeds.map((memory) => [memory.id, memory])).values()].slice(0, limit)
}

function queryOutgoingMemoryLinks({ db, userId, frontierIds, agentId, limit }) {
  if (!frontierIds.length) return []
  const params = [userId]
  const visibility = agentVisibility('target', agentId, params)
  const placeholders = frontierIds.map(() => '?').join(',')
  params.push(...frontierIds, limit)
  return db.prepare(
    `SELECT target.*, memory_links.from_id AS link_from_id, memory_links.to_slug AS link_to_slug
     FROM memory_links
     JOIN memories AS source ON source.id = memory_links.from_id
     JOIN memories AS target ON target.user_id = source.user_id AND target.slug = memory_links.to_slug
     WHERE source.user_id = ? AND ${visibility} AND memory_links.from_id IN (${placeholders})
     ORDER BY target.pinned DESC, target.updated_at DESC, target.id ASC LIMIT ?`
  ).all(...params).map((row) => ({
    memory: row2memory(row),
    link: { fromId: row.link_from_id, toId: row.id, toSlug: row.link_to_slug },
  }))
}

function queryIncomingMemoryLinks({ db, userId, frontierIds, agentId, limit }) {
  if (!frontierIds.length) return []
  const params = [userId]
  const visibility = agentVisibility('source', agentId, params)
  const placeholders = frontierIds.map(() => '?').join(',')
  params.push(...frontierIds, limit)
  return db.prepare(
    `SELECT source.*, target.id AS link_to_id, memory_links.to_slug AS link_to_slug
     FROM memory_links
     JOIN memories AS source ON source.id = memory_links.from_id
     JOIN memories AS target ON target.user_id = source.user_id AND target.slug = memory_links.to_slug
     WHERE source.user_id = ? AND ${visibility} AND target.id IN (${placeholders})
     ORDER BY source.pinned DESC, source.updated_at DESC, source.id ASC LIMIT ?`
  ).all(...params).map((row) => ({
    memory: row2memory(row),
    link: { fromId: row.id, toId: row.link_to_id, toSlug: row.link_to_slug },
  }))
}

export function traverseMemoryLinks({
  userId,
  seedIds = [],
  seedSlugs = [],
  agentId = null,
  maxDepth = 2,
  maxNodes = 50,
  direction = 'both',
} = {}) {
  const empty = { memories: [], links: [], depthById: {}, truncated: false }
  if (!userId) return empty
  const safeDepth = clampInteger(maxDepth, 2, 0, MAX_LINK_DEPTH)
  const safeNodes = clampInteger(maxNodes, 50, 1, MAX_LINK_NODES)
  const safeDirection = ['outgoing', 'incoming', 'both'].includes(direction) ? direction : 'both'
  const ids = [...new Set((Array.isArray(seedIds) ? seedIds : []).map(String).filter(Boolean))].slice(0, safeNodes)
  const slugs = [...new Set((Array.isArray(seedSlugs) ? seedSlugs : []).map(normalizeSlug).filter(Boolean))].slice(0, safeNodes)
  if (!ids.length && !slugs.length) return empty

  const db = getDb()
  const seeds = loadMemoryLinkSeeds({ db, userId, seedIds: ids, seedSlugs: slugs, agentId, limit: safeNodes })
  if (!seeds.length) return empty
  const memoriesById = new Map(seeds.map((memory) => [memory.id, memory]))
  const depthById = new Map(seeds.map((memory) => [memory.id, 0]))
  const linksByKey = new Map()
  let frontier = seeds.map((memory) => memory.id)
  let truncated = seeds.length >= safeNodes && (ids.length + slugs.length) > seeds.length

  for (let depth = 0; depth < safeDepth && frontier.length; depth += 1) {
    const remaining = safeNodes - memoriesById.size
    if (remaining <= 0) {
      truncated = true
      break
    }
    const edgeLimit = Math.min(Math.max(remaining * 8, 32), 1000)
    const candidates = []
    if (safeDirection !== 'incoming') {
      candidates.push(...queryOutgoingMemoryLinks({ db, userId, frontierIds: frontier, agentId, limit: edgeLimit }))
    }
    if (safeDirection !== 'outgoing') {
      candidates.push(...queryIncomingMemoryLinks({ db, userId, frontierIds: frontier, agentId, limit: edgeLimit }))
    }
    const next = []
    for (const candidate of candidates) {
      const key = `${candidate.link.fromId}:${candidate.link.toId}:${candidate.link.toSlug}`
      linksByKey.set(key, candidate.link)
      if (memoriesById.has(candidate.memory.id)) continue
      if (memoriesById.size >= safeNodes) {
        truncated = true
        continue
      }
      memoriesById.set(candidate.memory.id, candidate.memory)
      depthById.set(candidate.memory.id, depth + 1)
      next.push(candidate.memory.id)
    }
    frontier = [...new Set(next)]
  }

  const included = new Set(memoriesById.keys())
  const links = [...linksByKey.values()].filter((link) => included.has(link.fromId) && included.has(link.toId))
  return {
    memories: [...memoriesById.values()],
    links,
    depthById: Object.fromEntries(depthById),
    truncated,
  }
}
