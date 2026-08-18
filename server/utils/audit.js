/**
 * 统一的 tool_audit 写入器。
 *
 * 之前 hooksService / mcpManager 各写一份 SQL,fsShellTools 干脆不写。
 * 抽这里:任何工具执行(MCP / Hook / 本地 bash / fs / git / Agent / artifact)都走这。
 *
 * - args 会被 JSON.stringify + SHA256 截前 16 位写入 args_hash,
 *   既能在日志里关联同次调用,又不会把 secret/path 等敏感 raw 数据落盘
 * - best-effort 写入:DB 失败不影响主流程(只 console.warn)
 * - 失败重复写多次也无所谓(只是审计)
 */

import { createHash } from 'node:crypto'
import { getDb } from '../db.js'

export const TOOL_AUDIT_STAGES = Object.freeze([
  'proposed',
  'started',
  'approval_requested',
  'auto_allowed',
  'approved',
  'denied',
  'finished',
  'filtered',
])

const VALID_STAGES = new Set(TOOL_AUDIT_STAGES)
const VALID_STATUSES = new Set(['ok', 'error', 'denied', 'timeout', 'truncated', 'cancelled'])
const REDACTED = '[REDACTED]'
const MAX_RESULT_PREVIEW_CHARS = 500

function sensitiveAuditKey(key) {
  const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!normalized) return false
  return [
    'apikey',
    'token',
    'secret',
    'password',
    'authorization',
    'credential',
    'cookie',
  ].some((term) => normalized === term || normalized.startsWith(term) || normalized.endsWith(term))
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|credential|cookie)\s*[=:]\s*)(["']?)[^\s,;&"']+\2/giu,
      `$1${REDACTED}`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED}`)
}

export function sanitizeAuditValue(value, { maxDepth = 16 } = {}) {
  const seen = new WeakSet()
  const visit = (input, key = '', depth = 0) => {
    if (sensitiveAuditKey(key)) return REDACTED
    if (typeof input === 'string') return redactSensitiveText(input)
    if (input == null || typeof input === 'number' || typeof input === 'boolean') return input
    if (typeof input === 'bigint') return String(input)
    if (typeof input !== 'object') return String(input)
    if (depth >= maxDepth) return '[MAX_DEPTH]'
    if (seen.has(input)) return '[CIRCULAR]'
    seen.add(input)
    if (Array.isArray(input)) return input.map((item) => visit(item, '', depth + 1))
    return Object.fromEntries(
      Object.entries(input).map(([entryKey, item]) => [entryKey, visit(item, entryKey, depth + 1)]),
    )
  }
  return visit(value)
}

export function serializeSanitizedAuditArgs(args) {
  if (args == null) return null
  try {
    return JSON.stringify(sanitizeAuditValue(args))
  } catch {
    return JSON.stringify({ value: '[UNSERIALIZABLE]' })
  }
}

export function auditResultPreview(result) {
  if (result == null) return null
  let text
  try {
    const sanitized = sanitizeAuditValue(result)
    text = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized)
  } catch {
    text = '[UNSERIALIZABLE]'
  }
  return String(text || '').slice(0, MAX_RESULT_PREVIEW_CHARS)
}

export function hashArgs(args) {
  if (args == null) return null
  try {
    const str = typeof args === 'string' ? args : JSON.stringify(args)
    return createHash('sha256').update(str).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

/**
 * @param {object} opts
 * @param {string} opts.userId        必填 - 用户隔离主键
 * @param {string} opts.origin        必填 - 'bash'|'fs'|'git'|'mcp'|'hook'|'agent'|'artifact'
 * @param {string} opts.toolName      必填 - 'bash_exec' / 'read_file' / 'mcp:github.create_issue' ...
 * @param {string} [opts.serverId]    MCP server id / hook id / 子代理 id
 * @param {*}      [opts.args]        原始参数,内部 hash 后只存指纹
 * @param {string} opts.status        'ok'|'error'|'denied'|'timeout'|'truncated'
 * @param {number} [opts.durationMs]
 */
export function writeToolAudit({
  userId,
  origin,
  toolName,
  serverId = null,
  callId = null,
  stage = null,
  args = null,
  result = null,
  status,
  durationMs = null,
  createdAt = Date.now(),
}) {
  if (!userId || !origin || !toolName || !status) return
  if (!VALID_STATUSES.has(status)) status = 'error'
  const normalizedStage = VALID_STAGES.has(stage) ? stage : null
  try {
    return getDb()
      .prepare(
        `INSERT INTO tool_audit (
          user_id, origin, tool_name, server_id, call_id, stage,
          args_hash, args_json, result_preview, status, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(userId),
        String(origin),
        String(toolName),
        serverId ? String(serverId) : null,
        callId ? String(callId) : null,
        normalizedStage,
        hashArgs(args),
        serializeSanitizedAuditArgs(args),
        auditResultPreview(result),
        status,
        durationMs == null ? null : Number(durationMs),
        Number(createdAt) || Date.now(),
      )
  } catch (err) {
    // 审计是 best-effort,不能影响业务
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[audit] write failed:', err?.message || err)
    }
  }
}
