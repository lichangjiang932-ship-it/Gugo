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

const VALID_STATUSES = new Set(['ok', 'error', 'denied', 'timeout', 'truncated'])

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
export function writeToolAudit({ userId, origin, toolName, serverId = null, args = null, status, durationMs = null }) {
  if (!userId || !origin || !toolName || !status) return
  if (!VALID_STATUSES.has(status)) status = 'error'
  try {
    getDb()
      .prepare(
        'INSERT INTO tool_audit (user_id, origin, tool_name, server_id, args_hash, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(String(userId), String(origin), String(toolName), serverId ? String(serverId) : null, hashArgs(args), status, durationMs == null ? null : Number(durationMs), Date.now())
  } catch (err) {
    // 审计是 best-effort,不能影响业务
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[audit] write failed:', err?.message || err)
    }
  }
}
