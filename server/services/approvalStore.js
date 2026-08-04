/**
 * 审批 store —— pending_approvals 表的 CRUD。
 *
 * 红线(AGENTS.md 4.1.2):所有函数签名带 userId,prepared statement 不拼字符串。
 * decideApproval 必须幂等 + 竞态安全:双击 / 多标签页 / 多进程同时决策,只有一个能赢。
 */
import crypto from 'node:crypto'
import { getDb } from '../db.js'
import { resolveApprovalTimeoutMs } from '../utils/approvalPolicy.js'

const VALID_ORIGINS = new Set(['job', 'subagent', 'chat'])
const VALID_RISKS = new Set(['low', 'medium', 'high'])
const TERMINAL_STATUSES = new Set(['approved', 'denied', 'edited', 'expired', 'cancelled'])
/** decision → 落库 status */
const DECISION_STATUS = Object.freeze({ approve: 'approved', deny: 'denied', edit: 'edited' })

function newId() {
  return crypto.randomUUID?.() || `approval-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function stringifyArgs(args) {
  try {
    return JSON.stringify(args ?? {})
  } catch {
    return '{}'
  }
}

function mapApproval(row) {
  if (!row) return null
  const decidedArgs = parseJson(row.decided_args_json)
  return {
    id: row.id,
    userId: row.user_id,
    origin: row.origin,
    jobId: row.job_id || null,
    stepId: row.step_id || null,
    sessionId: row.session_id || null,
    toolName: row.tool_name,
    args: parseJson(row.args_json, {}),
    risk: row.risk,
    reason: row.reason || null,
    status: row.status,
    decidedArgs,
    // 调用方只关心「最终该用哪份参数」,edited 时用改写后的
    effectiveArgs: row.status === 'edited' && decidedArgs ? decidedArgs : parseJson(row.args_json, {}),
    decidedBy: row.decided_by || null,
    decidedAt: row.decided_at || null,
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createPendingApproval({
  id = newId(),
  userId,
  origin = 'job',
  jobId = null,
  stepId = null,
  sessionId = null,
  toolName,
  args = {},
  risk = 'medium',
  reason = null,
  expiresAt = null,
} = {}) {
  if (!userId) throw new Error('userId 必填')
  if (!toolName) throw new Error('toolName 必填')
  if (!VALID_ORIGINS.has(origin)) throw new Error(`非法 origin: ${origin}`)
  if (!VALID_RISKS.has(risk)) throw new Error(`非法 risk: ${risk}`)

  const now = Date.now()
  const expiry = Number.isFinite(expiresAt) && expiresAt > 0
    ? Math.floor(expiresAt)
    : now + resolveApprovalTimeoutMs()

  getDb().prepare(`
    INSERT INTO pending_approvals
      (id, user_id, origin, job_id, step_id, session_id, tool_name, args_json,
       risk, reason, status, expires_at, created_at, updated_at)
    VALUES
      (@id, @userId, @origin, @jobId, @stepId, @sessionId, @toolName, @argsJson,
       @risk, @reason, 'pending', @expiresAt, @now, @now)
  `).run({
    id,
    userId,
    origin,
    jobId,
    stepId,
    sessionId,
    toolName,
    argsJson: stringifyArgs(args),
    risk,
    reason: reason ? String(reason).slice(0, 500) : null,
    expiresAt: expiry,
    now,
  })

  return getPendingApproval({ userId, id })
}

export function getPendingApproval({ userId, id } = {}) {
  if (!userId || !id) return null
  const row = getDb()
    .prepare('SELECT * FROM pending_approvals WHERE id = ? AND user_id = ?')
    .get(id, userId)
  return mapApproval(row)
}

/** 内部用:不带 userId 的读取(gate 轮询自己写的记录时用,不经 HTTP 暴露)。 */
export function getApprovalById(id) {
  if (!id) return null
  return mapApproval(getDb().prepare('SELECT * FROM pending_approvals WHERE id = ?').get(id))
}

export function getLatestJobApproval({ jobId, userId, stepId = null } = {}) {
  if (!jobId || !userId) return null
  const row = stepId
    ? getDb().prepare(`
        SELECT * FROM pending_approvals
         WHERE job_id = ? AND user_id = ? AND step_id = ?
         ORDER BY created_at DESC LIMIT 1
      `).get(jobId, userId, stepId)
    : getDb().prepare(`
        SELECT * FROM pending_approvals
         WHERE job_id = ? AND user_id = ?
         ORDER BY created_at DESC LIMIT 1
      `).get(jobId, userId)
  return mapApproval(row)
}

export function listPendingApprovals({ userId, status = 'pending', limit = 100 } = {}) {
  if (!userId) return []
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500)
  const db = getDb()
  const rows = status === 'all'
    ? db.prepare(`
        SELECT * FROM pending_approvals WHERE user_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(userId, capped)
    : db.prepare(`
        SELECT * FROM pending_approvals WHERE user_id = ? AND status = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(userId, status, capped)
  return rows.map(mapApproval)
}

export function countPendingApprovals({ userId } = {}) {
  if (!userId) return 0
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM pending_approvals WHERE user_id = ? AND status = 'pending'")
    .get(userId)
  return row?.n || 0
}

/**
 * 决策。竞态安全:UPDATE ... WHERE status='pending' 的 changes 判断是否抢到。
 *
 * @returns {{ ok: boolean, approval: object|null, alreadyDecided: boolean }}
 */
export function decideApproval({ userId, id, decision, editedArgs = null, decidedBy = null } = {}) {
  if (!userId || !id) throw new Error('userId 与 id 必填')
  const status = DECISION_STATUS[decision]
  if (!status) throw new Error(`非法 decision: ${decision}`)
  if (status === 'edited' && (!editedArgs || typeof editedArgs !== 'object')) {
    throw new Error('decision=edit 时必须提供 args 对象')
  }

  const now = Date.now()
  const result = getDb().prepare(`
    UPDATE pending_approvals
       SET status = @status,
           decided_args_json = @decidedArgs,
           decided_by = @decidedBy,
           decided_at = @now,
           updated_at = @now
     WHERE id = @id AND user_id = @userId AND status = 'pending'
  `).run({
    id,
    userId,
    status,
    decidedArgs: status === 'edited' ? stringifyArgs(editedArgs) : null,
    decidedBy: decidedBy || userId,
    now,
  })

  const approval = getPendingApproval({ userId, id })
  if (result.changes === 0) {
    // 要么不存在/跨用户(approval 为 null),要么已被别人决策过(幂等,不报错)
    return { ok: false, approval, alreadyDecided: !!approval && TERMINAL_STATUSES.has(approval.status) }
  }
  return { ok: true, approval, alreadyDecided: false }
}

/** 超时的 pending 置 expired,视同拒绝。返回被置换的条数。 */
export function expireStaleApprovals({ now = Date.now() } = {}) {
  const result = getDb().prepare(`
    UPDATE pending_approvals
       SET status = 'expired', decided_at = @now, updated_at = @now
     WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= @now
  `).run({ now })
  return result.changes || 0
}

/** job 被取消/失败时,把它名下还挂着的审批一并作废,避免收件箱里留幽灵条目。 */
export function cancelApprovalsForJob({ jobId } = {}) {
  if (!jobId) return 0
  const now = Date.now()
  const result = getDb().prepare(`
    UPDATE pending_approvals
       SET status = 'cancelled', decided_at = @now, updated_at = @now
     WHERE job_id = @jobId AND status = 'pending'
  `).run({ jobId, now })
  return result.changes || 0
}

export function cancelApprovalsForTurn({ userId, sessionId, turnId } = {}) {
  if (!userId || !sessionId || !turnId) return 0
  const now = Date.now()
  const result = getDb().prepare(`
    UPDATE pending_approvals
       SET status = 'cancelled', decided_at = @now, updated_at = @now
     WHERE user_id = @userId AND origin = 'chat' AND session_id = @sessionId
       AND step_id = @turnId AND status = 'pending'
  `).run({ userId, sessionId, turnId, now })
  return result.changes || 0
}
