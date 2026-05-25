/**
 * server/services/agentStore.js
 *
 * Agent 人格管理（SOUL + IDENTITY 卡片）。
 * 多人格：一个用户可拥有多个 agent；其中一个是 is_default=1。
 * 本阶段只做 CRUD，不接入 chat 流程注入（阶段 4 再做）。
 */

import crypto from 'node:crypto'
import { getDb } from '../db.js'

const MAX_NAME_LEN = 80
const MAX_MD_LEN = 32 * 1024     // 32KB / 卡片，够写一整篇 SOUL.md
const MAX_AVATAR_LEN = 1024

function newId() {
  return 'agt_' + crypto.randomBytes(9).toString('base64url')
}

function rowToAgent(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    soulMd: row.soul_md,
    identityMd: row.identity_md,
    avatarUrl: row.avatar_url || null,
    isDefault: !!row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function clampStr(s, max, name) {
  if (s == null) return ''
  if (typeof s !== 'string') throw new Error(`${name} 必须是字符串`)
  if (s.length > max) throw new Error(`${name} 超长 (${s.length} > ${max})`)
  return s
}

export function listAgents({ userId }) {
  if (!userId) throw new Error('userId required')
  const db = getDb()
  const rows = db.prepare(
    'SELECT * FROM agents WHERE user_id = ? ORDER BY is_default DESC, updated_at DESC'
  ).all(userId)
  return rows.map(rowToAgent)
}

export function getAgent({ userId, id }) {
  if (!userId || !id) throw new Error('userId + id required')
  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM agents WHERE id = ? AND user_id = ?'
  ).get(id, userId)
  return rowToAgent(row)
}

export function getDefaultAgent({ userId }) {
  if (!userId) throw new Error('userId required')
  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM agents WHERE user_id = ? AND is_default = 1 LIMIT 1'
  ).get(userId)
  return rowToAgent(row)
}

export function createAgent({ userId, name, soulMd = '', identityMd = '', avatarUrl = null, isDefault = false, now = Date.now() }) {
  if (!userId) throw new Error('userId required')
  const nm = clampStr(name, MAX_NAME_LEN, 'name').trim()
  if (!nm) throw new Error('name 不能为空')
  const soul = clampStr(soulMd, MAX_MD_LEN, 'soulMd')
  const ident = clampStr(identityMd, MAX_MD_LEN, 'identityMd')
  const avatar = avatarUrl == null ? null : clampStr(avatarUrl, MAX_AVATAR_LEN, 'avatarUrl')
  const db = getDb()
  const id = newId()
  const tx = db.transaction(() => {
    if (isDefault) {
      db.prepare('UPDATE agents SET is_default = 0 WHERE user_id = ? AND is_default = 1').run(userId)
    }
    db.prepare(
      'INSERT INTO agents (id, user_id, name, soul_md, identity_md, avatar_url, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, userId, nm, soul, ident, avatar, isDefault ? 1 : 0, now, now)
  })
  try {
    tx()
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed')) {
      throw new Error(`已存在同名 agent: ${nm}`, { cause: err })
    }
    throw err
  }
  return getAgent({ userId, id })
}

export function updateAgent({ userId, id, patch = {}, now = Date.now() }) {
  if (!userId || !id) throw new Error('userId + id required')
  const existing = getAgent({ userId, id })
  if (!existing) return null
  const next = { ...existing }
  if ('name' in patch) {
    const nm = clampStr(patch.name, MAX_NAME_LEN, 'name').trim()
    if (!nm) throw new Error('name 不能为空')
    next.name = nm
  }
  if ('soulMd' in patch) next.soulMd = clampStr(patch.soulMd, MAX_MD_LEN, 'soulMd')
  if ('identityMd' in patch) next.identityMd = clampStr(patch.identityMd, MAX_MD_LEN, 'identityMd')
  if ('avatarUrl' in patch) next.avatarUrl = patch.avatarUrl == null ? null : clampStr(patch.avatarUrl, MAX_AVATAR_LEN, 'avatarUrl')
  if ('isDefault' in patch) next.isDefault = !!patch.isDefault
  const db = getDb()
  const tx = db.transaction(() => {
    if (next.isDefault && !existing.isDefault) {
      db.prepare('UPDATE agents SET is_default = 0 WHERE user_id = ? AND is_default = 1').run(userId)
    }
    db.prepare(
      'UPDATE agents SET name = ?, soul_md = ?, identity_md = ?, avatar_url = ?, is_default = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).run(next.name, next.soulMd, next.identityMd, next.avatarUrl, next.isDefault ? 1 : 0, now, id, userId)
  })
  try {
    tx()
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed')) {
      throw new Error(`已存在同名 agent: ${next.name}`, { cause: err })
    }
    throw err
  }
  return getAgent({ userId, id })
}

export function deleteAgent({ userId, id }) {
  if (!userId || !id) throw new Error('userId + id required')
  const db = getDb()
  const info = db.prepare('DELETE FROM agents WHERE id = ? AND user_id = ?').run(id, userId)
  return info.changes > 0
}

const DEFAULT_SOUL = `# SOUL.md — Atelier

You are a careful collaborator helping a single user produce documents,
presentations, and analyses.

- Be concise, never sycophantic.
- Ask one focused question if a request is ambiguous; otherwise act.
- Surface real opinions on design and writing; do not hedge with "should/probably".
- When you do not know, say so and propose how to find out.
`

const DEFAULT_IDENTITY = `# IDENTITY.md — Atelier

- Name: Atelier
- Role: 个人工作台默认 agent
- Style: 平实、克制、像一位资深排版与文案搭档
- Emoji: 不使用
`

/** 给新用户播种一个默认 agent，幂等：已有任意 agent 就不再 seed。 */
export function ensureDefaultAgent({ userId, now = Date.now() }) {
  if (!userId) throw new Error('userId required')
  const existing = listAgents({ userId })
  if (existing.length > 0) return existing.find(a => a.isDefault) || existing[0]
  return createAgent({
    userId,
    name: 'Atelier',
    soulMd: DEFAULT_SOUL,
    identityMd: DEFAULT_IDENTITY,
    isDefault: true,
    now,
  })
}
