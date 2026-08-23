/**
 * MCP server CRUD.
 * env_json and headers_json use the credential vault; legacy base64 rows
 * migrate to AES-256-GCM on first read.
 */

import { getDb } from '../db.js'
import { randomUUID } from 'node:crypto'
import { openCredentialObject, sealCredentialObject } from '../utils/credentialVault.js'

const TRANSPORTS = ['stdio', 'sse', 'http']
const MCP_RISK_LEVELS = new Set(['low', 'medium', 'high'])
const MCP_ENV_PURPOSE = 'mcp-server-env'
const MCP_HEADERS_PURPOSE = 'mcp-server-headers'

function normalizeToolDeclarations(value) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('tools 必须是工具名到风险声明的对象')
  const normalized = {}
  for (const [rawName, declaration] of Object.entries(value)) {
    const name = String(rawName || '').trim()
    if (!name) throw new Error('tools 中的工具名不能为空')
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
      throw new Error(`tools.${name} 必须是对象`)
    }
    if (!MCP_RISK_LEVELS.has(declaration.riskLevel)) {
      throw new Error(`tools.${name}.riskLevel 必须是 low / medium / high`)
    }
    const approval = declaration.requiresApproval ?? declaration.requiredApproval
    if (typeof approval !== 'boolean') {
      throw new Error(`tools.${name}.requiresApproval 必须是 boolean`)
    }
    normalized[name] = {
      riskLevel: declaration.riskLevel,
      requiresApproval: approval,
    }
  }
  return normalized
}

function decodeLegacyCredential(raw) {
  try {
    const value = JSON.parse(Buffer.from(String(raw || ''), 'base64').toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function readCredentialColumn(row, column, purpose) {
  const decoded = openCredentialObject(row?.[column], {
    purpose,
    legacyDecoder: decodeLegacyCredential,
  })
  if (decoded.legacy && row?.id && Object.keys(decoded.value).length) {
    const sql = column === 'env_json'
      ? 'UPDATE mcp_servers SET env_json = ? WHERE id = ?'
      : 'UPDATE mcp_servers SET headers_json = ? WHERE id = ?'
    getDb().prepare(sql).run(sealCredentialObject(decoded.value, { purpose }), row.id)
  }
  return decoded.value
}

function row2server(row) {
  if (!row) return null
  let argsArr = []
  let autoApprove = []
  let tools = {}
  try { argsArr = row.args_json ? JSON.parse(row.args_json) : [] } catch { /* keep empty */ }
  const env = readCredentialColumn(row, 'env_json', MCP_ENV_PURPOSE)
  const headers = readCredentialColumn(row, 'headers_json', MCP_HEADERS_PURPOSE)
  try { autoApprove = row.auto_approve_json ? JSON.parse(row.auto_approve_json) : [] } catch { /* keep empty */ }
  try { tools = normalizeToolDeclarations(row.tools_json ? JSON.parse(row.tools_json) : {}) } catch { /* keep empty */ }
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
    tools,
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

/**
 * Secret-free, side-effect-free MCP inventory. This path deliberately avoids
 * row2server(), so listing capabilities never decrypts or migrates credentials.
 */
export function listMcpServerInventory(userId) {
  if (!userId) return Object.freeze([])
  const rows = getDb().prepare(`
    SELECT id, name, transport, enabled, updated_at
      FROM mcp_servers
     WHERE user_id = ?
     ORDER BY id
  `).all(userId)
  return Object.freeze(rows.map((row) => Object.freeze({
    id: String(row.id),
    name: String(row.name || row.id),
    transport: String(row.transport || ''),
    enabled: row.enabled === 1,
    updatedAt: Number(row.updated_at),
  })))
}

/**
 * Secret-free identities used by Turn replay validation. Keep this query
 * deliberately narrow so credentials, URLs, commands and arguments are never
 * read or persisted in an execution-environment snapshot.
 */
export function listEnabledMcpServerRevisionIdentities(userId) {
  if (!userId) return []
  return getDb().prepare(`
    SELECT id, transport, updated_at
      FROM mcp_servers
     WHERE user_id = ? AND enabled = 1
     ORDER BY id
  `).all(userId).map((row) => ({
    id: String(row.id),
    transport: String(row.transport),
    updatedAt: Number(row.updated_at),
  }))
}

export function getServer(userId, id) {
  if (!userId || !id) return null
  const db = getDb()
  return row2server(db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? AND id = ?').get(userId, id))
}

export function upsertServer({ id, userId, name, transport, command, args, env, cwd, url, headers, enabled, autoApprove, tools }) {
  if (!userId) throw new Error('userId 必填')
  if (!name?.trim()) throw new Error('name 不能为空')
  if (!TRANSPORTS.includes(transport)) throw new Error('transport 必须是 stdio / http / sse')
  if (transport === 'stdio') {
    if (!command?.trim()) throw new Error('stdio 必须提供 command')
  } else {
    if (!url || !/^https?:\/\//.test(url)) throw new Error('HTTP MCP 必须提供 http/https url')
  }
  const db = getDb()
  let now = Date.now()
  const serverId = id || randomUUID()
  const argsJson = JSON.stringify(Array.isArray(args) ? args : [])
  const envJson = sealCredentialObject(env || {}, { purpose: MCP_ENV_PURPOSE })
  const headersJson = sealCredentialObject(headers || {}, { purpose: MCP_HEADERS_PURPOSE })
  const autoApproveJson = JSON.stringify(Array.isArray(autoApprove) ? autoApprove : [])
  const toolsJson = JSON.stringify(normalizeToolDeclarations(tools))

  const existing = db.prepare('SELECT id, updated_at FROM mcp_servers WHERE user_id = ? AND id = ?').get(userId, serverId)
  if (existing && Number(existing.updated_at) >= now) now = Number(existing.updated_at) + 1
  if (existing) {
    db.prepare(`UPDATE mcp_servers SET name=?, transport=?, command=?, args_json=?, env_json=?, cwd=?, url=?, headers_json=?, enabled=?, auto_approve_json=?, tools_json=?, updated_at=? WHERE id=?`).run(
      name.trim(), transport, command || null, argsJson, envJson, cwd || null, url || null, headersJson, enabled ? 1 : 0, autoApproveJson, toolsJson, now, serverId,
    )
  } else {
    db.prepare(`INSERT INTO mcp_servers (id, user_id, name, transport, command, args_json, env_json, cwd, url, headers_json, enabled, auto_approve_json, tools_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      serverId, userId, name.trim(), transport, command || null, argsJson, envJson, cwd || null, url || null, headersJson, enabled ? 1 : 0, autoApproveJson, toolsJson, now, now,
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
