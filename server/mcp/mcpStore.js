/**
 * Feature 1: mcp_servers 表 CRUD
 *
 * env_json / headers_json 应被 AES 加密。本 v1 简化:用 base64 obfuscation +
 * 注释提示运维不要把 DB 共享。后续如有 server/crypto.js 再切到 AES-GCM。
 */

import { getDb } from '../db.js'
import { randomUUID } from 'node:crypto'

const TRANSPORTS = ['stdio', 'sse']

function obfuscate(s) {
  if (s == null) return null
  return Buffer.from(String(s), 'utf8').toString('base64')
}
function deobfuscate(s) {
  if (s == null) return null
  try { return Buffer.from(String(s), 'base64').toString('utf8') } catch { return null }
}

function row2server(row) {
  if (!row) return null
  let argsArr = []
  let env = {}
  let headers = {}
  let autoApprove = []
  try { argsArr = row.args_json ? JSON.parse(row.args_json) : [] } catch { /* keep empty */ }
  try {
    const raw = deobfuscate(row.env_json)
    env = raw ? JSON.parse(raw) : {}
  } catch { /* keep empty */ }
  try {
    const raw = deobfuscate(row.headers_json)
    headers = raw ? JSON.parse(raw) : {}
  } catch { /* keep empty */ }
  try { autoApprove = row.auto_approve_json ? JSON.parse(row.auto_approve_json) : [] } catch { /* keep empty */ }
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: argsArr,
    env,
    cwd: row.cwd,
    url: row.url,
    headers,
    enabled: !!row.enabled,
    autoApprove,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listServers(userId) {
  if (!userId) return []
  const db = getDb()
  return db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY name').all(userId).map(row2server)
}

export function listEnabledServers(userId) {
  if (!userId) return []
  const db = getDb()
  return db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? AND enabled = 1 ORDER BY name').all(userId).map(row2server)
}

export function getServer(userId, id) {
  if (!userId || !id) return null
  const db = getDb()
  return row2server(db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? AND id = ?').get(userId, id))
}

export function upsertServer({ id, userId, name, transport, command, args, env, cwd, url, headers, enabled, autoApprove }) {
  if (!userId) throw new Error('userId 必填')
  if (!name?.trim()) throw new Error('name 不能为空')
  if (!TRANSPORTS.includes(transport)) throw new Error('transport 必须是 stdio / sse')
  if (transport === 'stdio') {
    if (!command?.trim()) throw new Error('stdio 必须提供 command')
  } else if (transport === 'sse') {
    if (!url || !/^https?:\/\//.test(url)) throw new Error('sse 必须提供 http/https url')
  }
  const db = getDb()
  const now = Date.now()
  const serverId = id || randomUUID()
  const argsJson = JSON.stringify(Array.isArray(args) ? args : [])
  const envJson = obfuscate(JSON.stringify(env || {}))
  const headersJson = obfuscate(JSON.stringify(headers || {}))
  const autoApproveJson = JSON.stringify(Array.isArray(autoApprove) ? autoApprove : [])

  const existing = db.prepare('SELECT id FROM mcp_servers WHERE user_id = ? AND id = ?').get(userId, serverId)
  if (existing) {
    db.prepare(`UPDATE mcp_servers SET name=?, transport=?, command=?, args_json=?, env_json=?, cwd=?, url=?, headers_json=?, enabled=?, auto_approve_json=?, updated_at=? WHERE id=?`).run(
      name.trim(), transport, command || null, argsJson, envJson, cwd || null, url || null, headersJson, enabled ? 1 : 0, autoApproveJson, now, serverId,
    )
  } else {
    db.prepare(`INSERT INTO mcp_servers (id, user_id, name, transport, command, args_json, env_json, cwd, url, headers_json, enabled, auto_approve_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      serverId, userId, name.trim(), transport, command || null, argsJson, envJson, cwd || null, url || null, headersJson, enabled ? 1 : 0, autoApproveJson, now, now,
    )
  }
  return getServer(userId, serverId)
}

export function deleteServer(userId, id) {
  if (!userId || !id) return { deleted: 0 }
  const db = getDb()
  const r = db.prepare('DELETE FROM mcp_servers WHERE user_id = ? AND id = ?').run(userId, id)
  return { deleted: r.changes }
}
