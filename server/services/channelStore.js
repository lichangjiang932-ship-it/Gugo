import crypto from 'node:crypto'
import { getDb } from '../db.js'

const VALID_KINDS = new Set(['dm', 'group'])
const VALID_ROLES = new Set(['member', 'owner'])
const VALID_SENDERS = new Set(['user', 'agent'])
const subscribers = new Map()

function newChannelId() {
  return crypto.randomUUID()
}

function newMessageId() {
  return crypto.randomUUID()
}

function parseJson(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeKind(kind) {
  const value = kind === 'dm' ? 'dm' : 'group'
  if (!VALID_KINDS.has(value)) throw new Error('invalid channel kind')
  return value
}

function normalizeRole(role = 'member') {
  const value = role === 'owner' ? 'owner' : 'member'
  if (!VALID_ROLES.has(value)) throw new Error('invalid channel agent role')
  return value
}

function normalizeAgentIds(agentIds = []) {
  return Array.from(new Set(
    (Array.isArray(agentIds) ? agentIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  ))
}

function normalizeMentions(mentions = []) {
  return normalizeAgentIds(mentions)
}

function mapAgent(row) {
  if (!row?.agent_id) return null
  return {
    id: row.agent_id,
    userId: row.agent_user_id,
    name: row.agent_name || 'Agent',
    avatarUrl: row.avatar_url || null,
    role: row.role || 'member',
    joinedAt: row.joined_at,
    isDefault: row.default_agent_id === row.agent_id,
  }
}

function mapChannel(row, agents = []) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    kind: row.kind,
    defaultAgentId: row.default_agent_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at || null,
    agents,
  }
}

function mapMessage(row) {
  if (!row) return null
  return {
    id: row.id,
    channelId: row.channel_id,
    senderKind: row.sender_kind,
    senderId: row.sender_id,
    content: row.content || '',
    mentions: parseJson(row.mentions_json, []),
    parentMessageId: row.parent_message_id || null,
    createdAt: row.created_at,
    sender: row.sender_kind === 'agent'
      ? {
          id: row.agent_id || row.sender_id,
          name: row.agent_name || 'Agent',
          avatarUrl: row.agent_avatar_url || null,
        }
      : null,
  }
}

function channelRow({ userId, channelId }) {
  return getDb().prepare('SELECT * FROM channels WHERE id = ? AND user_id = ?').get(channelId, userId)
}

function agentBelongsToUser({ userId, agentId }) {
  if (!agentId) return false
  const row = getDb().prepare('SELECT id FROM agents WHERE id = ? AND user_id = ?').get(agentId, userId)
  return !!row
}

function assertChannel({ userId, channelId }) {
  if (!userId || !channelId) throw new Error('userId + channelId required')
  const row = channelRow({ userId, channelId })
  if (!row) {
    const err = new Error('channel not found')
    err.statusCode = 404
    throw err
  }
  return row
}

function assertAgent({ userId, agentId }) {
  if (!agentBelongsToUser({ userId, agentId })) {
    const err = new Error('agent does not belong to user')
    err.statusCode = 403
    throw err
  }
}

function agentsForChannels(channelIds = []) {
  if (!channelIds.length) return new Map()
  const placeholders = channelIds.map(() => '?').join(',')
  const rows = getDb().prepare(`
    SELECT
      ca.channel_id,
      ca.agent_id,
      ca.role,
      ca.joined_at,
      c.default_agent_id,
      a.user_id AS agent_user_id,
      a.name AS agent_name,
      a.avatar_url
    FROM channel_agents ca
    JOIN channels c ON c.id = ca.channel_id
    JOIN agents a ON a.id = ca.agent_id
    WHERE ca.channel_id IN (${placeholders})
    ORDER BY ca.joined_at ASC, a.name ASC
  `).all(...channelIds)
  const map = new Map()
  for (const row of rows) {
    const list = map.get(row.channel_id) || []
    const agent = mapAgent(row)
    if (agent) list.push(agent)
    map.set(row.channel_id, list)
  }
  return map
}

function emitChannelMessage(message) {
  const set = subscribers.get(message.channelId)
  if (!set) return
  for (const listener of set) {
    try {
      listener(message)
    } catch (err) {
      console.error('[channels] subscriber error:', err?.stack || err)
    }
  }
}

export function createChannel({
  userId,
  name,
  agentIds = [],
  kind = 'group',
  defaultAgentId = null,
  now = Date.now(),
} = {}) {
  if (!userId) throw new Error('userId required')
  const finalName = String(name || '').trim()
  if (!finalName) throw new Error('channel name required')
  const finalKind = normalizeKind(kind)
  const members = normalizeAgentIds(defaultAgentId ? [...agentIds, defaultAgentId] : agentIds)
  for (const agentId of members) assertAgent({ userId, agentId })
  if (defaultAgentId && !members.includes(defaultAgentId)) assertAgent({ userId, agentId: defaultAgentId })
  if (finalKind === 'dm' && members.length !== 1) throw new Error('dm channel requires exactly one agent')

  const db = getDb()
  const id = newChannelId()
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO channels (id, user_id, name, kind, default_agent_id, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(id, userId, finalName, finalKind, defaultAgentId || null, now, now)
    const stmt = db.prepare(`
      INSERT INTO channel_agents (channel_id, agent_id, role, joined_at)
      VALUES (?, ?, ?, ?)
    `)
    for (const agentId of members) {
      stmt.run(id, agentId, agentId === defaultAgentId ? 'owner' : 'member', now)
    }
  })
  tx()
  return getChannel({ userId, channelId: id })
}

export function listChannels({ userId, archived = 'false', limit = 200, offset = 0 } = {}) {
  if (!userId) return []
  const clauses = ['user_id = @userId']
  if (archived === true || archived === 'true') clauses.push('archived_at IS NOT NULL')
  else if (archived !== 'all') clauses.push('archived_at IS NULL')
  const rows = getDb().prepare(`
    SELECT * FROM channels
    WHERE ${clauses.join(' AND ')}
    ORDER BY COALESCE(updated_at, created_at) DESC
    LIMIT @limit OFFSET @offset
  `).all({
    userId,
    limit: Math.max(1, Math.min(Number(limit) || 200, 500)),
    offset: Math.max(0, Number(offset) || 0),
  })
  const agentMap = agentsForChannels(rows.map((row) => row.id))
  return rows.map((row) => mapChannel(row, agentMap.get(row.id) || []))
}

export function getChannel({ userId, channelId }) {
  if (!userId || !channelId) return null
  const row = channelRow({ userId, channelId })
  if (!row) return null
  const agentMap = agentsForChannels([channelId])
  return mapChannel(row, agentMap.get(channelId) || [])
}

export function updateChannel({ userId, channelId, patch = {}, now = Date.now() }) {
  const existing = assertChannel({ userId, channelId })
  let name = existing.name
  let defaultAgentId = existing.default_agent_id || null
  let archivedAt = existing.archived_at || null

  if ('name' in patch) {
    name = String(patch.name || '').trim()
    if (!name) throw new Error('channel name required')
  }
  if ('defaultAgentId' in patch || 'default_agent_id' in patch) {
    defaultAgentId = patch.defaultAgentId ?? patch.default_agent_id ?? null
    if (defaultAgentId) {
      assertAgent({ userId, agentId: defaultAgentId })
      const member = getDb().prepare(
        'SELECT 1 FROM channel_agents WHERE channel_id = ? AND agent_id = ?'
      ).get(channelId, defaultAgentId)
      if (!member) throw new Error('default agent must be a channel member')
    }
  }
  if ('archived' in patch) archivedAt = patch.archived ? (archivedAt || now) : null
  if ('archivedAt' in patch) archivedAt = patch.archivedAt || null

  getDb().prepare(`
    UPDATE channels
    SET name = ?, default_agent_id = ?, archived_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(name, defaultAgentId || null, archivedAt, now, channelId, userId)
  return getChannel({ userId, channelId })
}

export function archiveChannel({ userId, channelId, archived = true, now = Date.now() }) {
  return updateChannel({ userId, channelId, patch: { archived }, now })
}

export function addAgentToChannel({ userId, channelId, agentId, role = 'member', now = Date.now() }) {
  assertChannel({ userId, channelId })
  assertAgent({ userId, agentId })
  const finalRole = normalizeRole(role)
  getDb().prepare(`
    INSERT INTO channel_agents (channel_id, agent_id, role, joined_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id, agent_id) DO UPDATE SET role = excluded.role
  `).run(channelId, agentId, finalRole, now)
  getDb().prepare('UPDATE channels SET updated_at = ? WHERE id = ? AND user_id = ?').run(now, channelId, userId)
  return getChannel({ userId, channelId })
}

export function removeAgentFromChannel({ userId, channelId, agentId, now = Date.now() }) {
  assertChannel({ userId, channelId })
  const info = getDb().prepare(`
    DELETE FROM channel_agents
    WHERE channel_id = ? AND agent_id = ?
  `).run(channelId, agentId)
  getDb().prepare(`
    UPDATE channels
    SET default_agent_id = CASE WHEN default_agent_id = ? THEN NULL ELSE default_agent_id END,
        updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(agentId, now, channelId, userId)
  return { removed: info.changes > 0, channel: getChannel({ userId, channelId }) }
}

export function appendMessage({
  id = newMessageId(),
  userId,
  channelId,
  senderKind,
  senderId,
  content = '',
  mentions = [],
  parentMessageId = null,
  now = Date.now(),
} = {}) {
  const channel = assertChannel({ userId, channelId })
  if (!VALID_SENDERS.has(senderKind)) throw new Error('invalid sender kind')
  if (!senderId) throw new Error('senderId required')
  if (senderKind === 'user' && senderId !== userId) throw new Error('user sender mismatch')
  if (senderKind === 'agent') {
    const member = getDb().prepare(
      'SELECT 1 FROM channel_agents WHERE channel_id = ? AND agent_id = ?'
    ).get(channelId, senderId)
    if (!member) throw new Error('agent is not a channel member')
  }
  if (parentMessageId) {
    const parent = getDb().prepare(
      'SELECT 1 FROM channel_messages WHERE id = ? AND channel_id = ?'
    ).get(parentMessageId, channelId)
    if (!parent) throw new Error('parent message not found')
  }

  const db = getDb()
  db.prepare(`
    INSERT INTO channel_messages
      (id, channel_id, sender_kind, sender_id, content, mentions_json, parent_message_id, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    channelId,
    senderKind,
    senderId,
    String(content ?? ''),
    JSON.stringify(normalizeMentions(mentions)),
    parentMessageId || null,
    now,
  )
  db.prepare('UPDATE channels SET updated_at = ? WHERE id = ? AND user_id = ?').run(now, channelId, userId)
  const message = getMessage({ userId, channelId, messageId: id })
  emitChannelMessage({ ...message, channel })
  return message
}

export function getMessage({ userId, channelId, messageId }) {
  if (!userId || !channelId || !messageId) return null
  const channel = channelRow({ userId, channelId })
  if (!channel) return null
  const row = getDb().prepare(`
    SELECT
      cm.*,
      a.id AS agent_id,
      a.name AS agent_name,
      a.avatar_url AS agent_avatar_url
    FROM channel_messages cm
    LEFT JOIN agents a ON cm.sender_kind = 'agent' AND a.id = cm.sender_id
    WHERE cm.channel_id = ? AND cm.id = ?
  `).get(channelId, messageId)
  return mapMessage(row)
}

export function listMessages({ userId, channelId, limit = 50, before = null } = {}) {
  assertChannel({ userId, channelId })
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200))
  const beforeTs = before == null || before === '' ? null : Number(before)
  const rows = beforeTs
    ? getDb().prepare(`
        SELECT cm.*, a.id AS agent_id, a.name AS agent_name, a.avatar_url AS agent_avatar_url
        FROM channel_messages cm
        LEFT JOIN agents a ON cm.sender_kind = 'agent' AND a.id = cm.sender_id
        WHERE cm.channel_id = ? AND cm.created_at < ?
        ORDER BY cm.created_at DESC
        LIMIT ?
      `).all(channelId, beforeTs, safeLimit)
    : getDb().prepare(`
        SELECT cm.*, a.id AS agent_id, a.name AS agent_name, a.avatar_url AS agent_avatar_url
        FROM channel_messages cm
        LEFT JOIN agents a ON cm.sender_kind = 'agent' AND a.id = cm.sender_id
        WHERE cm.channel_id = ?
        ORDER BY cm.created_at DESC
        LIMIT ?
      `).all(channelId, safeLimit)
  return rows.reverse().map(mapMessage)
}

export function getLatestAgentMessage({ userId, channelId, excludeAgentId = null } = {}) {
  assertChannel({ userId, channelId })
  const row = excludeAgentId
    ? getDb().prepare(`
        SELECT * FROM channel_messages
        WHERE channel_id = ? AND sender_kind = 'agent' AND sender_id != ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(channelId, excludeAgentId)
    : getDb().prepare(`
        SELECT * FROM channel_messages
        WHERE channel_id = ? AND sender_kind = 'agent'
        ORDER BY created_at DESC
        LIMIT 1
      `).get(channelId)
  return mapMessage(row)
}

export function getMessageDepth({ userId, channelId, messageId, max = 10 } = {}) {
  if (!messageId) return 0
  assertChannel({ userId, channelId })
  let depth = 0
  let current = messageId
  const stmt = getDb().prepare('SELECT parent_message_id FROM channel_messages WHERE id = ? AND channel_id = ?')
  while (current && depth <= max) {
    const row = stmt.get(current, channelId)
    if (!row) break
    if (!row.parent_message_id) break
    depth += 1
    current = row.parent_message_id
  }
  return depth
}

export function subscribeChannelMessages(channelId, listener) {
  if (!channelId || typeof listener !== 'function') return () => {}
  const set = subscribers.get(channelId) || new Set()
  set.add(listener)
  subscribers.set(channelId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) subscribers.delete(channelId)
  }
}
