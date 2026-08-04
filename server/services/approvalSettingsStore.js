/**
 * 每用户的审批档位与「总是允许」清单。
 *
 * 对齐 Claude Code / Codex:用户能自己选被问到什么程度,也能对某个工具说
 * 「以后别问了」。以前只有一个 env 级开关,用户改不了,且每次都得重新点。
 */
import { getDb } from '../db.js'
import { buildRememberedGrant, DEFAULT_PERMISSION_MODE, PERMISSION_MODES } from '../utils/approvalPolicy.js'

const RISK_CLASSES = new Set(['read', 'write_local', 'exec', 'external'])

export function getApprovalMode({ userId } = {}) {
  if (!userId) return DEFAULT_PERMISSION_MODE
  const row = getDb()
    .prepare('SELECT mode FROM user_approval_settings WHERE user_id = ?')
    .get(userId)
  return PERMISSION_MODES.includes(row?.mode) ? row.mode : DEFAULT_PERMISSION_MODE
}

export function setApprovalMode({ userId, mode } = {}) {
  if (!userId) throw new Error('userId 必填')
  if (!PERMISSION_MODES.includes(mode)) throw new Error(`非法模式: ${mode}`)
  const now = Date.now()
  getDb().prepare(`
    INSERT INTO user_approval_settings (user_id, mode, updated_at)
    VALUES (@userId, @mode, @now)
    ON CONFLICT(user_id) DO UPDATE SET mode = @mode, updated_at = @now
  `).run({ userId, mode, now })
  return getApprovalMode({ userId })
}

export function listRememberedTools({ userId } = {}) {
  if (!userId) return []
  return getDb()
    .prepare('SELECT DISTINCT tool_name FROM approval_tool_grants WHERE user_id = ? ORDER BY tool_name')
    .all(userId)
    .map((r) => r.tool_name)
}

export function listRememberedGrants({ userId } = {}) {
  if (!userId) return []
  return getDb()
    .prepare('SELECT tool_name, command_prefix FROM approval_tool_grants WHERE user_id = ? ORDER BY tool_name, command_prefix')
    .all(userId)
    .map((row) => ({ toolName: row.tool_name, commandPrefix: row.command_prefix }))
}

/** 用户点了「总是允许这个工具」。幂等。 */
export function rememberTool({ userId, toolName, args = {} } = {}) {
  if (!userId) throw new Error('userId 必填')
  const name = String(toolName || '').trim()
  const grant = buildRememberedGrant(name, args)
  if (!name) throw new Error('toolName 必填')
  getDb().prepare(`
    INSERT INTO approval_tool_grants (user_id, tool_name, command_prefix, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, tool_name, command_prefix) DO NOTHING
  `).run(userId, grant.toolName, grant.commandPrefix, Date.now())
  return listRememberedTools({ userId })
}

/** 撤销「总是允许」,恢复成每次都问。 */
export function forgetTool({ userId, toolName } = {}) {
  if (!userId) throw new Error('userId 必填')
  getDb()
    .prepare('DELETE FROM approval_tool_grants WHERE user_id = ? AND tool_name = ?')
    .run(userId, String(toolName || ''))
  return listRememberedTools({ userId })
}

export function clearRememberedTools({ userId } = {}) {
  if (!userId) return []
  getDb().prepare('DELETE FROM approval_tool_grants WHERE user_id = ?').run(userId)
  return []
}

export function listRiskOverrides({ userId } = {}) {
  if (!userId) return []
  return getDb()
    .prepare('SELECT tool_name, risk_class FROM user_tool_risk_overrides WHERE user_id = ? ORDER BY tool_name')
    .all(userId)
    .map((row) => ({ toolName: row.tool_name, riskClass: row.risk_class }))
}

export function setRiskOverride({ userId, toolName, riskClass } = {}) {
  if (!userId) throw new Error('userId 必填')
  const name = String(toolName || '').trim()
  if (!name) throw new Error('toolName 必填')
  if (riskClass === null || riskClass === undefined || riskClass === '') {
    getDb().prepare('DELETE FROM user_tool_risk_overrides WHERE user_id = ? AND tool_name = ?').run(userId, name)
    return listRiskOverrides({ userId })
  }
  const normalized = String(riskClass).trim()
  if (!RISK_CLASSES.has(normalized)) throw new Error(`非法 riskClass: ${normalized}`)
  const now = Date.now()
  getDb().prepare(`
    INSERT INTO user_tool_risk_overrides (user_id, tool_name, risk_class, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, tool_name) DO UPDATE SET risk_class = excluded.risk_class, updated_at = excluded.updated_at
  `).run(userId, name, normalized, now, now)
  return listRiskOverrides({ userId })
}

/** 一次拿齐,供 approvalGate 和前端使用。 */
export function getApprovalSettings({ userId } = {}) {
  return {
    mode: getApprovalMode({ userId }),
    rememberedTools: listRememberedTools({ userId }),
    rememberedGrants: listRememberedGrants({ userId }),
    riskOverrides: listRiskOverrides({ userId }),
    modes: PERMISSION_MODES,
  }
}
