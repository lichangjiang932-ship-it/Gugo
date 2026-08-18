/**
 * 每用户的审批档位与「总是允许」清单。
 *
 * 对齐 Claude Code / Codex:用户能自己选被问到什么程度,也能对某个工具说
 * 「以后别问了」。以前只有一个 env 级开关,用户改不了,且每次都得重新点。
 */
import { getDb } from '../db.js'
import { buildRememberedGrant, DEFAULT_PERMISSION_MODE, PERMISSION_MODES } from '../utils/approvalPolicy.js'

const RISK_CLASSES = new Set(['read', 'write_local', 'exec', 'external'])
export const INITIAL_USER_PERMISSION_MODE = 'normal'
export const PERMISSION_MODE_CHANGE_TOOL = 'permission_mode_change'
export const WIDER_PERMISSION_MODES = Object.freeze({
  plan: Object.freeze(['normal', 'acceptEdits', 'bypass']),
  normal: Object.freeze(['acceptEdits', 'bypass']),
  acceptEdits: Object.freeze(['bypass']),
  bypass: Object.freeze([]),
})

function permissionModeError(message, { code, statusCode = 400, currentMode, requestedMode } = {}) {
  const error = new Error(message)
  error.code = code || 'PERMISSION_MODE_ERROR'
  error.statusCode = statusCode
  error.currentMode = currentMode
  error.requestedMode = requestedMode
  return error
}

export function isPermissionModeWidening(currentMode, requestedMode) {
  if (!PERMISSION_MODES.includes(currentMode) || !PERMISSION_MODES.includes(requestedMode)) return false
  return WIDER_PERMISSION_MODES[currentMode]?.includes(requestedMode) === true
}

export function preparePermissionModeChange({ userId, mode, justification = '' } = {}) {
  if (!userId) throw new Error('userId 必填')
  if (!PERMISSION_MODES.includes(mode)) throw new Error(`非法模式: ${mode}`)
  const currentMode = getApprovalMode({ userId })
  const widened = isPermissionModeWidening(currentMode, mode)
  const normalizedJustification = String(justification || '').trim().slice(0, 1000)
  if (mode === 'bypass' && currentMode !== mode && !normalizedJustification) {
    throw permissionModeError('切换到全部放行必须填写理由', {
      code: 'PERMISSION_JUSTIFICATION_REQUIRED',
      currentMode,
      requestedMode: mode,
    })
  }
  return {
    mode,
    previousMode: currentMode,
    changed: currentMode !== mode,
    widened,
    justification: normalizedJustification,
  }
}

export function getApprovalMode({ userId } = {}) {
  if (!userId) return DEFAULT_PERMISSION_MODE
  const row = getDb()
    .prepare('SELECT mode FROM user_approval_settings WHERE user_id = ?')
    .get(userId)
  if (!row) return INITIAL_USER_PERMISSION_MODE
  return PERMISSION_MODES.includes(row.mode) ? row.mode : DEFAULT_PERMISSION_MODE
}

/** Keep path and execution scopes aligned with the effective UI mode. */
export function isApprovalBypassEnabled({ userId } = {}) {
  return !!userId && getApprovalMode({ userId }) === 'bypass'
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

export function changeApprovalMode({
  userId,
  mode,
  approveEscalation = false,
  justification = '',
} = {}) {
  const prepared = preparePermissionModeChange({ userId, mode, justification })
  const currentMode = prepared.previousMode
  if (currentMode === mode) {
    return { mode, previousMode: currentMode, changed: false, widened: false }
  }

  const widened = prepared.widened
  const normalizedJustification = prepared.justification
  if (widened && approveEscalation !== true) {
    throw permissionModeError('放宽权限需要明确批准', {
      code: 'PERMISSION_ESCALATION_REQUIRED',
      statusCode: 409,
      currentMode,
      requestedMode: mode,
    })
  }
  const now = Date.now()
  const db = getDb()
  db.transaction(() => {
    db.prepare(`
      INSERT INTO user_approval_settings (user_id, mode, updated_at)
      VALUES (@userId, @mode, @now)
      ON CONFLICT(user_id) DO UPDATE SET mode = @mode, updated_at = @now
    `).run({ userId, mode, now })
    db.prepare(`
      INSERT INTO permission_mode_events
        (user_id, from_mode, to_mode, transition_kind, justification, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      currentMode,
      mode,
      widened ? 'widened' : 'tightened',
      normalizedJustification || null,
      now,
    )
  })()

  return { mode, previousMode: currentMode, changed: true, widened }
}

export function applyApprovedPermissionModeChange({
  userId,
  fromMode,
  mode,
  justification = '',
} = {}) {
  const currentMode = getApprovalMode({ userId })
  if (currentMode !== fromMode) {
    throw permissionModeError('审批创建后权限模式已变化，请重新发起升级', {
      code: 'PERMISSION_APPROVAL_STALE',
      statusCode: 409,
      currentMode,
      requestedMode: mode,
    })
  }
  return changeApprovalMode({
    userId,
    mode,
    approveEscalation: true,
    justification,
  })
}

export function listPermissionModeEvents({ userId, limit = 20 } = {}) {
  if (!userId) return []
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20))
  return getDb().prepare(`
    SELECT id, from_mode, to_mode, transition_kind, justification, created_at
      FROM permission_mode_events
     WHERE user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?
  `).all(userId, safeLimit).map((row) => ({
    id: row.id,
    fromMode: row.from_mode,
    toMode: row.to_mode,
    transitionKind: row.transition_kind,
    justification: row.justification,
    createdAt: row.created_at,
  }))
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
    modeHistory: listPermissionModeEvents({ userId }),
  }
}
