/**
 * server/services/agentStore.js
 *
 * Agent 人格管理（SOUL + IDENTITY 卡片）。
 * 多人格：一个用户可拥有多个 agent；其中一个是 is_default=1。
 * 本阶段只做 CRUD，不接入 chat 流程注入（阶段 4 再做）。
 */

import crypto from 'node:crypto'
import { getDb } from '../db.js'
import { getAgentTemplateSystemPrompt, isKnownAgentTemplate } from './agentTemplates.js'

const MAX_NAME_LEN = 80
const MAX_MD_LEN = 32 * 1024     // 32KB / 卡片，够写一整篇 SOUL.md
const MAX_AVATAR_LEN = 1024
const MAX_TEMPLATE_LEN = 64

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
    personaTemplate: row.persona_template || '',
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

function normalizePersonaTemplate(value) {
  const raw = clampStr(value, MAX_TEMPLATE_LEN, 'personaTemplate').trim()
  if (!raw) return ''
  if (!isKnownAgentTemplate(raw)) throw new Error(`未知人格模板: ${raw}`)
  return raw
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

export function createAgent({ userId, name, soulMd = '', identityMd = '', personaTemplate = '', avatarUrl = null, isDefault = false, now = Date.now() }) {
  if (!userId) throw new Error('userId required')
  const nm = clampStr(name, MAX_NAME_LEN, 'name').trim()
  if (!nm) throw new Error('name 不能为空')
  const soul = clampStr(soulMd, MAX_MD_LEN, 'soulMd')
  const ident = clampStr(identityMd, MAX_MD_LEN, 'identityMd')
  const persona = normalizePersonaTemplate(personaTemplate)
  const avatar = avatarUrl == null ? null : clampStr(avatarUrl, MAX_AVATAR_LEN, 'avatarUrl')
  const db = getDb()
  const id = newId()
  const tx = db.transaction(() => {
    if (isDefault) {
      db.prepare('UPDATE agents SET is_default = 0 WHERE user_id = ? AND is_default = 1').run(userId)
    }
    db.prepare(
      'INSERT INTO agents (id, user_id, name, soul_md, identity_md, persona_template, avatar_url, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, userId, nm, soul, ident, persona || null, avatar, isDefault ? 1 : 0, now, now)
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
  if ('personaTemplate' in patch) next.personaTemplate = normalizePersonaTemplate(patch.personaTemplate)
  if ('persona_template' in patch) next.personaTemplate = normalizePersonaTemplate(patch.persona_template)
  if ('avatarUrl' in patch) next.avatarUrl = patch.avatarUrl == null ? null : clampStr(patch.avatarUrl, MAX_AVATAR_LEN, 'avatarUrl')
  if ('isDefault' in patch) next.isDefault = !!patch.isDefault
  const db = getDb()
  const tx = db.transaction(() => {
    if (next.isDefault && !existing.isDefault) {
      db.prepare('UPDATE agents SET is_default = 0 WHERE user_id = ? AND is_default = 1').run(userId)
    }
    db.prepare(
      'UPDATE agents SET name = ?, soul_md = ?, identity_md = ?, persona_template = ?, avatar_url = ?, is_default = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).run(next.name, next.soulMd, next.identityMd, next.personaTemplate || null, next.avatarUrl, next.isDefault ? 1 : 0, now, id, userId)
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

/**
 * 把 agent 的 SOUL + IDENTITY 拼成一个 system block 字符串。
 * 用于 chat 注入；空 agent 或两字段都空时返回空字符串（调用方应跳过）。
 */
export function buildAgentSystemBlock(agent) {
  if (!agent) return ''
  const parts = []
  const soul = (agent.soulMd || '').trim()
  const identity = (agent.identityMd || '').trim()
  const personaPrompt = getAgentTemplateSystemPrompt(agent.personaTemplate || '', { lang: 'zh' }).trim()
  if (!soul && !identity && !personaPrompt) return ''
  parts.push(`# Agent: ${agent.name || 'Agent'}`)
  if (personaPrompt) parts.push('\n## PERSONA TEMPLATE\n' + personaPrompt)
  if (identity) parts.push('\n## IDENTITY\n' + identity)
  if (soul) parts.push('\n## SOUL\n' + soul)
  parts.push('\nFollow the persona above. Stay in character.')
  return parts.join('\n')
}

/**
 * 序列化 agent 为 .agent.md 文本：frontmatter + IDENTITY + SOUL。
 */
export function serializeAgentMarkdown(agent) {
  if (!agent) throw new Error('agent required')
  const front = [
    '---',
    `name: ${JSON.stringify(agent.name || '')}`,
    `avatar_url: ${JSON.stringify(agent.avatarUrl || '')}`,
    `persona_template: ${JSON.stringify(agent.personaTemplate || '')}`,
    `exported_at: ${new Date().toISOString()}`,
    '---',
    '',
  ].join('\n')
  return front +
    `# ${agent.name || 'Agent'}\n\n` +
    `## IDENTITY\n\n${agent.identityMd || ''}\n\n` +
    `## SOUL\n\n${agent.soulMd || ''}\n`
}

/**
 * 解析 .agent.md 文本回 { name, avatarUrl, soulMd, identityMd }。
 * 容错：找不到 frontmatter 就从 H1 取 name；找不到 ## SOUL/IDENTITY 就把全文当 soul。
 */
export function parseAgentMarkdown(text) {
  if (!text || typeof text !== 'string') throw new Error('source 不能为空')
  let body = text
  let name = ''
  let avatarUrl = null
  let personaTemplate = ''

  const fmMatch = body.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)
  if (fmMatch) {
    const fm = fmMatch[1]
    const nm = fm.match(/^name:\s*(.+)$/m)
    if (nm) {
      try { name = JSON.parse(nm[1]) } catch { name = nm[1].trim() }
    }
    const av = fm.match(/^avatar_url:\s*(.+)$/m)
    if (av) {
      try { avatarUrl = JSON.parse(av[1]) || null } catch { avatarUrl = av[1].trim() || null }
    }
    const pt = fm.match(/^persona_template:\s*(.+)$/m)
    if (pt) {
      try { personaTemplate = JSON.parse(pt[1]) || '' } catch { personaTemplate = pt[1].trim() || '' }
    }
    body = body.slice(fmMatch[0].length)
  }

  if (!name) {
    const h1 = body.match(/^#\s+(.+)$/m)
    if (h1) name = h1[1].trim()
  }
  if (!name) name = 'Imported Agent'

  // 抽 ## IDENTITY / ## SOUL（不区分顺序）
  let identityMd = ''
  let soulMd = ''
  const idMatch = body.match(/##\s*IDENTITY\s*\n([\s\S]*?)(?=\n##\s|$)/i)
  if (idMatch) identityMd = idMatch[1].trim()
  const soulMatch = body.match(/##\s*SOUL\s*\n([\s\S]*?)(?=\n##\s|$)/i)
  if (soulMatch) soulMd = soulMatch[1].trim()

  // fallback：全文当 soul
  if (!identityMd && !soulMd) soulMd = body.trim()

  return { name, avatarUrl, personaTemplate, soulMd, identityMd }
}
