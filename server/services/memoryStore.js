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
import { randomUUID } from 'node:crypto'

const ALLOWED_TYPES = ['user', 'feedback', 'project', 'reference']
const DAY_MS = 24 * 60 * 60 * 1000
const VERIFY_MEMORY_MS = DAY_MS
const AGING_MEMORY_MS = 30 * DAY_MS
const STALE_MEMORY_MS = 180 * DAY_MS
const MAX_QUERY_TERMS = 24
const MAX_SEARCH_CANDIDATES = 2000
const MAX_LINK_DEPTH = 5
const MAX_LINK_NODES = 200

function normalizeSlug(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 80) || 'memory'
}

function row2memory(row) {
  if (!row) return null
  let frontmatter = {}
  try { frontmatter = row.frontmatter_json ? JSON.parse(row.frontmatter_json) : {} } catch { /* keep empty */ }
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    slug: row.slug,
    body: row.body,
    frontmatter,
    pinned: !!row.pinned,
    sourceSessionId: row.source_session_id || null,
    sourceMessageId: row.source_message_id || null,
    agentId: row.agent_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  }
}

function normalizedSearchText(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

function queryTerms(query) {
  const normalized = normalizedSearchText(query)
  if (!normalized) return []
  const terms = new Set([normalized])
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu) || []
  for (const word of words) {
    if (word.length > 1) terms.add(word)
    for (const run of word.match(/\p{Script=Han}+/gu) || []) {
      if (run.length < 3) continue
      for (let index = 0; index < run.length - 1; index += 1) {
        terms.add(run.slice(index, index + 2))
      }
    }
  }
  return [...terms].filter(Boolean).sort((a, b) => b.length - a.length).slice(0, MAX_QUERY_TERMS)
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0
  let count = 0
  let offset = 0
  while ((offset = haystack.indexOf(needle, offset)) >= 0) {
    count += 1
    offset += Math.max(needle.length, 1)
    if (count >= 8) break
  }
  return count
}

export function scoreMemoryRelevance(memory, query) {
  const fullQuery = normalizedSearchText(query)
  const terms = queryTerms(query)
  if (!fullQuery || !terms.length || !memory) return 0

  const title = normalizedSearchText(memory.title)
  const slug = normalizedSearchText(memory.slug)
  const body = normalizedSearchText(memory.body)
  const type = normalizedSearchText(memory.type)
  const tags = Array.isArray(memory.frontmatter?.tags)
    ? memory.frontmatter.tags.map(normalizedSearchText).filter(Boolean)
    : []
  let score = 0
  if (title === fullQuery) score += 140
  else if (title.includes(fullQuery)) score += 80
  if (slug === fullQuery) score += 90
  else if (slug.includes(fullQuery)) score += 45
  if (body.includes(fullQuery)) score += 36 + Math.min(12, countOccurrences(body, fullQuery) * 2)
  if (tags.includes(fullQuery)) score += 70

  let matchedTerms = 0
  for (const term of terms) {
    let matched = false
    if (title === term) {
      score += 32
      matched = true
    } else if (title.includes(term)) {
      score += 22
      matched = true
    }
    if (slug === term) {
      score += 24
      matched = true
    } else if (slug.includes(term)) {
      score += 12
      matched = true
    }
    if (body.includes(term)) {
      score += 7 + Math.min(9, countOccurrences(body, term))
      matched = true
    }
    if (tags.some((tag) => tag === term || tag.includes(term))) {
      score += 18
      matched = true
    }
    if (type === term) {
      score += 8
      matched = true
    }
    if (matched) matchedTerms += 1
  }
  if (!matchedTerms) return 0
  const coverage = matchedTerms / terms.length
  score += coverage * 24
  if (coverage === 1) score += 12
  return Math.round(score * 1000) / 1000
}

function memoryRecency(memory) {
  return Number(memory.lastUsedAt || memory.updatedAt || memory.createdAt || 0)
}

function rankMemoriesByQuery(memories, query, { keepPinned = false } = {}) {
  return memories
    .map((memory) => ({ memory, score: scoreMemoryRelevance(memory, query) }))
    .filter(({ memory, score }) => score > 0 || (keepPinned && memory.pinned))
    .sort((a, b) => (
      (keepPinned ? Number(b.memory.pinned) - Number(a.memory.pinned) : 0)
      || b.score - a.score
      || memoryRecency(b.memory) - memoryRecency(a.memory)
      || String(a.memory.id).localeCompare(String(b.memory.id))
    ))
}

function addQueryPredicate(sql, params, query, { includePinned = false } = {}) {
  const terms = queryTerms(query)
  if (!terms.length) return { sql, terms }
  const clauses = terms.map(() => '(title LIKE ? OR slug LIKE ? OR body LIKE ? OR frontmatter_json LIKE ?)')
  const predicate = clauses.join(' OR ')
  sql += includePinned ? ` AND (pinned = 1 OR ${predicate})` : ` AND (${predicate})`
  for (const term of terms) {
    const pattern = `%${term}%`
    params.push(pattern, pattern, pattern, pattern)
  }
  return { sql, terms }
}

export function listMemories({ userId, type = null, query = null, limit = 200, agentFilter = null }) {
  if (!userId) return []
  const db = getDb()
  const params = [userId]
  const safeLimit = Math.min(Math.max(1, Number(limit) || 200), 500)
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
  const hasQuery = !!normalizedSearchText(query)
  if (hasQuery) ({ sql } = addQueryPredicate(sql, params, query))
  sql += ' ORDER BY pinned DESC, COALESCE(last_used_at, updated_at) DESC LIMIT ?'
  params.push(hasQuery ? Math.min(Math.max(safeLimit * 8, 200), MAX_SEARCH_CANDIDATES) : safeLimit)
  const memories = db.prepare(sql).all(...params).map(row2memory)
  if (!hasQuery) return memories
  return rankMemoriesByQuery(memories, query).slice(0, safeLimit).map(({ memory }) => memory)
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
  const slug = normalizeSlug(title)
  const frontmatterJson = JSON.stringify(frontmatter || {})

  const existing = db.prepare('SELECT id FROM memories WHERE user_id = ? AND id = ?').get(userId, memoryId)
  if (existing) {
    db.prepare(
      `UPDATE memories SET type=?, title=?, slug=?, body=?, frontmatter_json=?, pinned=?, agent_id=?, updated_at=? WHERE id=?`
    ).run(type, title.trim(), slug, body.trim(), frontmatterJson, pinned ? 1 : 0, agentId || null, now, memoryId)
  } else {
    db.prepare(
      `INSERT INTO memories (id, user_id, type, title, slug, body, frontmatter_json, pinned, source_session_id, source_message_id, agent_id, created_at, updated_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(memoryId, userId, type, title.trim(), slug, body.trim(), frontmatterJson, pinned ? 1 : 0, sourceSessionId, sourceMessageId, agentId || null, now, now)
  }

  // 重新计算 [[slug]] 链
  db.prepare('DELETE FROM memory_links WHERE from_id = ?').run(memoryId)
  const links = new Set()
  const linkPattern = /\[\[([a-z0-9_-]+)\]\]/gi
  let m
  while ((m = linkPattern.exec(body)) !== null) {
    links.add(normalizeSlug(m[1]))
  }
  const insLink = db.prepare(`
    INSERT INTO memory_links (from_id, to_slug) VALUES (?, ?)
    ON CONFLICT(from_id, to_slug) DO NOTHING
  `)
  for (const s of links) insLink.run(memoryId, s)

  return getMemory(userId, memoryId)
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
 * token 预算用粗算 (chars / 4)，超出就尾部裁掉。
 *
 * 阶段 6：支持 agentId 过滤。只返回 “agent_id IS NULL (全局) OR agent_id = :agentId” 的记忆。
 * agentId = null 则只拿全局记忆 (未绑 agent)。
 */
export function selectActiveMemoriesForInjection({ userId, tokenCap = 800, agentId = null, query = null }) {
  if (!userId) return { memories: [], totalChars: 0 }
  const db = getDb()
  const params = [userId]
  let sql
  if (agentId) {
    sql = 'SELECT * FROM memories WHERE user_id = ? AND (agent_id IS NULL OR agent_id = ?)'
    params.push(agentId)
  } else {
    sql = 'SELECT * FROM memories WHERE user_id = ? AND agent_id IS NULL'
  }
  const hasQuery = !!normalizedSearchText(query)
  if (hasQuery) ({ sql } = addQueryPredicate(sql, params, query, { includePinned: true }))
  sql += ' ORDER BY pinned DESC, COALESCE(last_used_at, updated_at) DESC, id ASC LIMIT ?'
  params.push(hasQuery ? 240 : 60)
  const rows = db.prepare(sql).all(...params)
  const memories = rows.map(row2memory)
  const ranked = hasQuery
    ? rankMemoriesByQuery(memories, query, { keepPinned: true }).map(({ memory }) => memory)
    : memories
  const out = []
  let charsUsed = 0
  const charsCap = Math.max(200, tokenCap * 4)
  for (const mem of ranked) {
    const block = `### ${mem.type}: ${mem.title}\n${mem.body}\n`
    if (charsUsed + block.length > charsCap) continue
    out.push(mem)
    charsUsed += block.length
  }
  return { memories: out, totalChars: charsUsed }
}

export function classifyMemoryFreshness(updatedAt, { now = Date.now() } = {}) {
  const timestamp = Number(updatedAt)
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { level: 'unknown', label: '时间未知，使用前核实', ageDays: null, warning: true }
  }
  const ageMs = Math.max(0, Number(now) - timestamp)
  const ageDays = Math.floor(ageMs / DAY_MS)
  if (ageMs > STALE_MEMORY_MS) return { level: 'stale', label: '陈旧，使用前核实', ageDays, warning: true }
  if (ageMs > AGING_MEMORY_MS) return { level: 'aging', label: '较旧，注意核实', ageDays, warning: true }
  if (ageMs > VERIFY_MEMORY_MS) {
    return {
      level: 'recent',
      label: `近期（${ageDays} 天前写入；请对照当前代码和事实核实）`,
      ageDays,
      warning: true,
    }
  }
  return { level: 'recent', label: '近期', ageDays, warning: false }
}

export function buildMemorySystemBlock(memories, { now = Date.now() } = {}) {
  if (!memories?.length) return ''
  const parts = [
    '# 用户长期记忆 (memories)',
    '以下是用户偏好、项目背景、反馈与参考资料。当前用户消息优先；与当前消息冲突或标记为较旧/陈旧/时间未知的内容，必须先核实再使用。\n',
  ]
  for (const m of memories) {
    const freshness = classifyMemoryFreshness(m.updatedAt, { now })
    const updated = Number.isFinite(Number(m.updatedAt)) && Number(m.updatedAt) > 0
      ? new Date(Number(m.updatedAt)).toISOString().slice(0, 10)
      : '未知日期'
    parts.push(`## [${m.type}] ${m.title}（更新：${updated}；新鲜度：${freshness.label}）`)
    if (freshness.warning && freshness.ageDays != null) {
      parts.push(`> 这条记忆写于 ${freshness.ageDays} 天前；涉及文件、行号、版本或外部状态时，必须先核实。`)
    }
    parts.push(m.body)
    parts.push('')
  }
  return parts.join('\n')
}

export function buildMemoryIndex(userId) {
  if (!userId) return '# MEMORY.md\n\n(未登录)\n'
  const list = listMemories({ userId, limit: 500 })
  const byType = {}
  for (const m of list) {
    if (!byType[m.type]) byType[m.type] = []
    byType[m.type].push(m)
  }
  const lines = ['# MEMORY.md', '', `本用户共 ${list.length} 条记忆。\n`]
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
