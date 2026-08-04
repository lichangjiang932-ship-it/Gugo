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
const AGING_MEMORY_MS = 30 * DAY_MS
const STALE_MEMORY_MS = 180 * DAY_MS

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

export function listMemories({ userId, type = null, query = null, limit = 200, agentFilter = null }) {
  if (!userId) return []
  const db = getDb()
  const params = [userId]
  let sql = 'SELECT * FROM memories WHERE user_id = ?'
  if (type && ALLOWED_TYPES.includes(type)) {
    sql += ' AND type = ?'
    params.push(type)
  }
  if (query && String(query).trim()) {
    sql += ' AND (title LIKE ? OR body LIKE ?)'
    const q = `%${String(query).trim()}%`
    params.push(q, q)
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
  params.push(Math.min(Math.max(1, Number(limit) || 200), 500))
  return db.prepare(sql).all(...params).map(row2memory)
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
  const insLink = db.prepare('INSERT OR IGNORE INTO memory_links (from_id, to_slug) VALUES (?, ?)')
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
export function selectActiveMemoriesForInjection({ userId, tokenCap = 800, agentId = null }) {
  if (!userId) return { memories: [], totalChars: 0 }
  const db = getDb()
  let rows
  if (agentId) {
    rows = db.prepare(
      `SELECT * FROM memories WHERE user_id = ? AND (agent_id IS NULL OR agent_id = ?)
       ORDER BY pinned DESC, COALESCE(last_used_at, updated_at) DESC, id ASC LIMIT 60`
    ).all(userId, agentId)
  } else {
    rows = db.prepare(
      `SELECT * FROM memories WHERE user_id = ? AND agent_id IS NULL
       ORDER BY pinned DESC, COALESCE(last_used_at, updated_at) DESC, id ASC LIMIT 60`
    ).all(userId)
  }
  const out = []
  let charsUsed = 0
  const charsCap = Math.max(200, tokenCap * 4)
  for (const r of rows) {
    const mem = row2memory(r)
    const block = `### ${mem.type}: ${mem.title}\n${mem.body}\n`
    if (charsUsed + block.length > charsCap) break
    out.push(mem)
    charsUsed += block.length
  }
  return { memories: out, totalChars: charsUsed }
}

export function classifyMemoryFreshness(updatedAt, { now = Date.now() } = {}) {
  const timestamp = Number(updatedAt)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return { level: 'unknown', label: '时间未知，使用前核实' }
  const ageMs = Math.max(0, Number(now) - timestamp)
  if (ageMs > STALE_MEMORY_MS) return { level: 'stale', label: '陈旧，使用前核实' }
  if (ageMs > AGING_MEMORY_MS) return { level: 'aging', label: '较旧，注意核实' }
  return { level: 'recent', label: '近期' }
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
