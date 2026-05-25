/**
 * Reasonix-inspired 服务端模块：钉记忆 / TODO / effort 设置 / session meter。
 *
 * 设计原则：
 * - 全部走独立路由 /api/reasonix/*，不与现有 modelProxy / jobRuntime 耦合
 * - 仅用 server/db.js 已暴露的 getDb()，不污染主 schema 链
 * - 所有写操作要求 Bearer token；通过 getSessionByToken + getUserById 解析用户
 */

import crypto from 'node:crypto'
import { getDb, getSessionByToken, getUserById } from '../db.js'
import { readJson, sendJson, authToken } from '../utils.js'

function requireUser(req) {
  const token = authToken(req)
  if (!token) {
    const err = new Error('未登录')
    err.statusCode = 401
    throw err
  }
  const session = getSessionByToken(token)
  if (!session) {
    const err = new Error('会话已过期')
    err.statusCode = 401
    throw err
  }
  const user = getUserById(session.user_id)
  if (!user) {
    const err = new Error('用户不存在')
    err.statusCode = 401
    throw err
  }
  return user
}

function nowMs() {
  return Date.now()
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`
}

/* ── 钉记忆 ── */

const MEMORY_KINDS = new Set(['user', 'project', 'feedback', 'reference'])

function rowToMemory(row) {
  if (!row) return null
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    tokens: row.tokens,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listMemories({ userId, enabledOnly = false } = {}) {
  const db = getDb()
  const sql = enabledOnly
    ? 'SELECT * FROM pinned_memories WHERE user_id = ? AND enabled = 1 ORDER BY updated_at DESC'
    : 'SELECT * FROM pinned_memories WHERE user_id = ? ORDER BY updated_at DESC'
  return db.prepare(sql).all(userId).map(rowToMemory)
}

export function createMemory({ userId, kind = 'user', title, content }) {
  if (!title || typeof title !== 'string') throw new Error('title 必填')
  if (!content || typeof content !== 'string') throw new Error('content 必填')
  if (title.length > 200) throw new Error('title 不能超过 200 字')
  if (content.length > 4000) throw new Error('content 不能超过 4000 字（保护 prefix cache）')
  if (!MEMORY_KINDS.has(kind)) throw new Error(`kind 必须是 ${[...MEMORY_KINDS].join('/')}`)
  // 简易 token 估算：中文≈2 char/token，英文≈4 char/token，取保守值
  const tokens = Math.ceil(content.length / 3)
  const id = newId('mem')
  const now = nowMs()
  getDb()
    .prepare(
      'INSERT INTO pinned_memories (id, user_id, kind, title, content, tokens, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)'
    )
    .run(id, userId, kind, title, content, tokens, now, now)
  return rowToMemory(getDb().prepare('SELECT * FROM pinned_memories WHERE id = ?').get(id))
}

export function updateMemory({ userId, id, patch }) {
  const db = getDb()
  const row = db.prepare('SELECT * FROM pinned_memories WHERE id = ? AND user_id = ?').get(id, userId)
  if (!row) throw new Error('记忆不存在')
  const next = { ...row }
  if (patch.title != null) next.title = String(patch.title).slice(0, 200)
  if (patch.content != null) {
    next.content = String(patch.content).slice(0, 4000)
    next.tokens = Math.ceil(next.content.length / 3)
  }
  if (patch.kind != null && MEMORY_KINDS.has(patch.kind)) next.kind = patch.kind
  if (patch.enabled != null) next.enabled = patch.enabled ? 1 : 0
  next.updated_at = nowMs()
  db.prepare(
    'UPDATE pinned_memories SET kind = ?, title = ?, content = ?, tokens = ?, enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).run(next.kind, next.title, next.content, next.tokens, next.enabled, next.updated_at, id, userId)
  return rowToMemory(db.prepare('SELECT * FROM pinned_memories WHERE id = ?').get(id))
}

export function deleteMemory({ userId, id }) {
  const result = getDb()
    .prepare('DELETE FROM pinned_memories WHERE id = ? AND user_id = ?')
    .run(id, userId)
  return { ok: true, deleted: result.changes }
}

/**
 * 给主聊天循环用：拼装当前用户启用的钉记忆为 system message 注入内容。
 * 总 token 上限 1024（保护 prefix cache），按 updated_at DESC 截断。
 */
export function buildMemoryPrefix({ userId, maxTokens = 1024 } = {}) {
  const memories = listMemories({ userId, enabledOnly: true })
  const lines = ['## Pinned Memories', '以下是用户长期记忆，请在回答时考虑：']
  let total = 0
  for (const m of memories) {
    if (total + m.tokens > maxTokens) break
    lines.push(`### [${m.kind}] ${m.title}`)
    lines.push(m.content)
    total += m.tokens
  }
  if (memories.length === 0) return ''
  return lines.join('\n\n')
}

/* ── TODO ── */

const TODO_STATUSES = new Set(['pending', 'in_progress', 'done', 'cancelled'])

function rowToTodo(row) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    project: row.project,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

export function listTodos({ userId, status }) {
  const db = getDb()
  const sql = status
    ? 'SELECT * FROM todos WHERE user_id = ? AND status = ? ORDER BY priority DESC, updated_at DESC'
    : `SELECT * FROM todos WHERE user_id = ? ORDER BY (status = 'done') ASC, priority DESC, updated_at DESC`
  const rows = status
    ? db.prepare(sql).all(userId, status)
    : db.prepare(sql).all(userId)
  return rows.map(rowToTodo)
}

export function createTodo({ userId, title, priority = 0, project = null }) {
  if (!title || typeof title !== 'string') throw new Error('title 必填')
  if (title.length > 500) throw new Error('title 不能超过 500 字')
  const id = newId('todo')
  const now = nowMs()
  getDb()
    .prepare(
      'INSERT INTO todos (id, user_id, title, status, priority, project, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, userId, title.trim(), 'pending', Number(priority) || 0, project, now, now)
  return rowToTodo(getDb().prepare('SELECT * FROM todos WHERE id = ?').get(id))
}

export function updateTodo({ userId, id, patch }) {
  const db = getDb()
  const row = db.prepare('SELECT * FROM todos WHERE id = ? AND user_id = ?').get(id, userId)
  if (!row) throw new Error('TODO 不存在')
  const next = { ...row }
  if (patch.title != null) next.title = String(patch.title).slice(0, 500)
  if (patch.priority != null) next.priority = Number(patch.priority) || 0
  if (patch.project !== undefined) next.project = patch.project ? String(patch.project).slice(0, 100) : null
  if (patch.status != null) {
    if (!TODO_STATUSES.has(patch.status)) throw new Error(`status 必须是 ${[...TODO_STATUSES].join('/')}`)
    next.status = patch.status
    next.completed_at = patch.status === 'done' ? nowMs() : null
  }
  next.updated_at = nowMs()
  db.prepare(
    'UPDATE todos SET title = ?, status = ?, priority = ?, project = ?, updated_at = ?, completed_at = ? WHERE id = ? AND user_id = ?'
  ).run(next.title, next.status, next.priority, next.project, next.updated_at, next.completed_at, id, userId)
  return rowToTodo(db.prepare('SELECT * FROM todos WHERE id = ?').get(id))
}

export function deleteTodo({ userId, id }) {
  const result = getDb().prepare('DELETE FROM todos WHERE id = ? AND user_id = ?').run(id, userId)
  return { ok: true, deleted: result.changes }
}

/* ── effort 设置 ── */

const EFFORT_LEVELS = {
  low: { maxSteps: 4, reasoningDepth: 1, costRatio: 0.5, label: '低（快）' },
  medium: { maxSteps: 12, reasoningDepth: 2, costRatio: 1.0, label: '中（平衡）' },
  high: { maxSteps: 24, reasoningDepth: 3, costRatio: 1.8, label: '高（深思）' },
  ultra: { maxSteps: 48, reasoningDepth: 4, costRatio: 3.0, label: '极致（最慢最贵）' },
}

export function getEffortSetting({ userId }) {
  const db = getDb()
  const row = db.prepare('SELECT * FROM effort_settings WHERE user_id = ?').get(userId)
  if (!row) {
    return { effort: 'medium', maxSteps: 12, reasoningDepth: 2, ...EFFORT_LEVELS.medium, presets: EFFORT_LEVELS }
  }
  return {
    effort: row.effort,
    maxSteps: row.max_steps,
    reasoningDepth: row.reasoning_depth,
    ...EFFORT_LEVELS[row.effort],
    presets: EFFORT_LEVELS,
  }
}

export function setEffortSetting({ userId, effort }) {
  if (!EFFORT_LEVELS[effort]) throw new Error(`effort 必须是 ${Object.keys(EFFORT_LEVELS).join('/')}`)
  const preset = EFFORT_LEVELS[effort]
  const now = nowMs()
  getDb()
    .prepare(
      'INSERT INTO effort_settings (user_id, effort, max_steps, reasoning_depth, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET effort = excluded.effort, max_steps = excluded.max_steps, reasoning_depth = excluded.reasoning_depth, updated_at = excluded.updated_at'
    )
    .run(userId, effort, preset.maxSteps, preset.reasoningDepth, now)
  return getEffortSetting({ userId })
}

/* ── session meter ── */

function rowToMeter(row) {
  if (!row) return null
  const total = row.tokens_in + row.tokens_out
  const cacheHitRate = total > 0 ? row.tokens_cached / total : 0
  return {
    sessionId: row.session_id,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    tokensCached: row.tokens_cached,
    costCredits: row.cost_credits,
    turns: row.turns,
    cacheHitRate: Number(cacheHitRate.toFixed(4)),
    updatedAt: row.updated_at,
  }
}

export function getSessionMeter({ userId, sessionId }) {
  const row = getDb()
    .prepare('SELECT * FROM session_meters WHERE session_id = ? AND user_id = ?')
    .get(sessionId, userId)
  return row ? rowToMeter(row) : {
    sessionId, tokensIn: 0, tokensOut: 0, tokensCached: 0, costCredits: 0, turns: 0, cacheHitRate: 0, updatedAt: 0,
  }
}

export function bumpSessionMeter({ userId, sessionId, tokensIn = 0, tokensOut = 0, tokensCached = 0, costCredits = 0 }) {
  const now = nowMs()
  const db = getDb()
  const existing = db.prepare('SELECT * FROM session_meters WHERE session_id = ? AND user_id = ?').get(sessionId, userId)
  if (existing) {
    db.prepare(
      'UPDATE session_meters SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, tokens_cached = tokens_cached + ?, cost_credits = cost_credits + ?, turns = turns + 1, updated_at = ? WHERE session_id = ? AND user_id = ?'
    ).run(tokensIn, tokensOut, tokensCached, costCredits, now, sessionId, userId)
  } else {
    db.prepare(
      'INSERT INTO session_meters (session_id, user_id, tokens_in, tokens_out, tokens_cached, cost_credits, turns, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
    ).run(sessionId, userId, tokensIn, tokensOut, tokensCached, costCredits, now)
  }
  return getSessionMeter({ userId, sessionId })
}

export function listRecentMeters({ userId, limit = 20 }) {
  return getDb()
    .prepare('SELECT * FROM session_meters WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?')
    .all(userId, Math.min(Math.max(1, limit), 200))
    .map(rowToMeter)
}

/* ── HTTP 路由 ── */

export async function handleReasonixRequest(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    const method = req.method

    if (path === '/api/reasonix/ping') {
      sendJson(res, 200, { ok: true, module: 'reasonix', version: 1 })
      return
    }

    const user = requireUser(req)

    if (path === '/api/reasonix/memories') {
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, memories: listMemories({ userId: user.id }) })
        return
      }
      if (method === 'POST') {
        const body = await readJson(req, { maxBytes: 64 * 1024 })
        sendJson(res, 200, { ok: true, memory: createMemory({ userId: user.id, ...body }) })
        return
      }
    }
    if (path.startsWith('/api/reasonix/memories/')) {
      const id = decodeURIComponent(path.slice('/api/reasonix/memories/'.length))
      if (method === 'PATCH') {
        const body = await readJson(req, { maxBytes: 64 * 1024 })
        sendJson(res, 200, { ok: true, memory: updateMemory({ userId: user.id, id, patch: body }) })
        return
      }
      if (method === 'DELETE') {
        sendJson(res, 200, deleteMemory({ userId: user.id, id }))
        return
      }
    }

    if (path === '/api/reasonix/todos') {
      if (method === 'GET') {
        const status = url.searchParams.get('status') || undefined
        sendJson(res, 200, { ok: true, todos: listTodos({ userId: user.id, status }) })
        return
      }
      if (method === 'POST') {
        const body = await readJson(req, { maxBytes: 16 * 1024 })
        sendJson(res, 200, { ok: true, todo: createTodo({ userId: user.id, ...body }) })
        return
      }
    }
    if (path.startsWith('/api/reasonix/todos/')) {
      const id = decodeURIComponent(path.slice('/api/reasonix/todos/'.length))
      if (method === 'PATCH') {
        const body = await readJson(req, { maxBytes: 16 * 1024 })
        sendJson(res, 200, { ok: true, todo: updateTodo({ userId: user.id, id, patch: body }) })
        return
      }
      if (method === 'DELETE') {
        sendJson(res, 200, deleteTodo({ userId: user.id, id }))
        return
      }
    }

    if (path === '/api/reasonix/effort') {
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, effort: getEffortSetting({ userId: user.id }) })
        return
      }
      if (method === 'PUT') {
        const body = await readJson(req, { maxBytes: 4 * 1024 })
        sendJson(res, 200, { ok: true, effort: setEffortSetting({ userId: user.id, effort: body.effort }) })
        return
      }
    }

    if (path === '/api/reasonix/meters') {
      if (method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 20)
        sendJson(res, 200, { ok: true, meters: listRecentMeters({ userId: user.id, limit }) })
        return
      }
    }
    if (path.startsWith('/api/reasonix/meters/')) {
      const sessionId = decodeURIComponent(path.slice('/api/reasonix/meters/'.length))
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, meter: getSessionMeter({ userId: user.id, sessionId }) })
        return
      }
      if (method === 'POST') {
        const body = await readJson(req, { maxBytes: 4 * 1024 })
        sendJson(res, 200, { ok: true, meter: bumpSessionMeter({ userId: user.id, sessionId, ...body }) })
        return
      }
    }

    sendJson(res, 404, { ok: false, error: '接口不存在' })
  } catch (error) {
    const status = error?.statusCode || 400
    sendJson(res, status, { ok: false, error: error.message || '请求失败' })
  }
}
