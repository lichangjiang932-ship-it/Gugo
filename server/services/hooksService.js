/**
 * Feature 7: Hook 执行器
 *
 * 两类:
 *   - shell  : execFile(argv, { cwd: WORKSPACE_ROOT, timeout, env: 净化 })
 *              要求 HOOKS_SHELL_ENABLED=1。argv 是 JSON 数组形式。
 *   - http   : fetch(url, { method:'POST', body: JSON.stringify(payload) })
 *              强制 HTTPS。SSRF allowlist 复用 toolProxy.assertSafeOutboundUrl。
 *
 * 协议:
 *   payload = { event, tool, args, userId, sessionId?, requestId?, timestamp }
 *   响应   = { allow?: boolean, replacementArgs?: object, reason?: string }
 *
 * 阻塞型 hook 返回 allow:false → fire 短路。
 * 非阻塞 (blocking=0) → 启动后立即返回 allowed:true，结果到 audit log。
 */

import { execFile } from 'node:child_process'
import path from 'node:path'
import { getDb } from '../db.js'
import { randomUUID } from 'node:crypto'
import { assertSafeOutboundUrl, fetchSafe } from '../adapters/toolProxy.js'
import { writeToolAudit } from '../utils/audit.js'
import { openCredentialObject, sealCredentialObject } from '../utils/credentialVault.js'

const ALLOWED_EVENTS = ['user_prompt_submit', 'pre_tool_use', 'post_tool_use', 'stop', 'pre_compact', 'session_start', 'session_end', 'subagent_stop', 'notification']
const HOOK_HEADERS_PURPOSE = 'hook-headers'

function sameExecutable(left, right) {
  const a = path.normalize(left)
  const b = path.normalize(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function shellCommandAllowlist(env = process.env) {
  return String(env.HOOKS_SHELL_ALLOWED_COMMANDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function assertShellCommandAllowed(command, env = process.env) {
  if (env.HOOKS_SHELL_ENABLED !== '1') {
    throw new Error('shell hook is disabled')
  }
  const executable = String(command?.[0] || '').trim()
  const allowed = shellCommandAllowlist(env)
  if (!executable || !allowed.length) {
    throw new Error('shell hook executable must be listed in HOOKS_SHELL_ALLOWED_COMMANDS')
  }
  const executableBase = path.basename(executable)
  const accepted = allowed.some((entry) => {
    if (path.isAbsolute(entry) || entry.includes('/') || entry.includes('\\')) {
      if (!path.isAbsolute(executable)) return false
      return sameExecutable(path.resolve(executable), path.resolve(entry))
    }
    return sameExecutable(executableBase, entry)
  })
  if (!accepted) throw new Error(`shell hook executable is not allowed: ${executableBase}`)
}

function readHookHeaders(row) {
  if (!row?.headers_json) return null
  const decoded = openCredentialObject(row.headers_json, {
    purpose: HOOK_HEADERS_PURPOSE,
    legacyDecoder: (raw) => safeParseJson(raw) || {},
  })
  if (decoded.legacy && row.id && Object.keys(decoded.value).length) {
    getDb().prepare('UPDATE hooks SET headers_json = ? WHERE id = ?')
      .run(sealCredentialObject(decoded.value, { purpose: HOOK_HEADERS_PURPOSE }), row.id)
  }
  return decoded.value
}

function row2hook(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    event: row.event,
    toolPattern: row.tool_pattern || null,
    kind: row.kind,
    command: row.command || null,
    url: row.url || null,
    headers: readHookHeaders(row),
    enabled: !!row.enabled,
    blocking: !!row.blocking,
    timeoutMs: row.timeout_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function safeParseJson(s) {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

function matchPattern(pattern, name) {
  if (!pattern || pattern === '*') return true
  // 简易 glob: prefix*  / *suffix / *middle* / 精确
  if (pattern === name) return true
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(name)
}

export function listHooks({ userId, event = null }) {
  if (!userId) return []
  const db = getDb()
  let rows
  if (event) {
    rows = db.prepare('SELECT * FROM hooks WHERE user_id = ? AND event = ? ORDER BY created_at').all(userId, event)
  } else {
    rows = db.prepare('SELECT * FROM hooks WHERE user_id = ? ORDER BY event, created_at').all(userId)
  }
  return rows.map(row2hook)
}

export function getHook(userId, id) {
  if (!userId || !id) return null
  const db = getDb()
  const row = db.prepare('SELECT * FROM hooks WHERE user_id = ? AND id = ?').get(userId, id)
  return row2hook(row)
}

export function upsertHook({ id, userId, event, toolPattern, kind, command, url, headers, enabled, blocking, timeoutMs }) {
  if (!userId) throw new Error('userId 必填')
  if (!ALLOWED_EVENTS.includes(event)) throw new Error('event 非法')
  if (!['shell', 'http'].includes(kind)) throw new Error('kind 非法')
  if (kind === 'shell' && (!Array.isArray(command) || !command.length)) throw new Error('shell hook 需要 command:string[]')
  if (kind === 'http' && (!url || !/^https?:\/\//.test(url))) throw new Error('http hook 需要 https url')
  if (kind === 'http' && process.env.NODE_ENV === 'production' && !url.startsWith('https://')) {
    throw new Error('生产环境 hook url 必须 https')
  }
  if (kind === 'shell') assertShellCommandAllowed(command)
  const db = getDb()
  const now = Date.now()
  const hookId = id || randomUUID()
  const cmdJson = kind === 'shell' ? JSON.stringify(command) : null
  const headersJson = kind === 'http' && headers
    ? sealCredentialObject(headers, { purpose: HOOK_HEADERS_PURPOSE })
    : null
  const existing = db.prepare('SELECT id FROM hooks WHERE user_id = ? AND id = ?').get(userId, hookId)
  if (existing) {
    db.prepare(
      `UPDATE hooks SET event=?, tool_pattern=?, kind=?, command=?, url=?, headers_json=?, enabled=?, blocking=?, timeout_ms=?, updated_at=? WHERE id=?`
    ).run(event, toolPattern || null, kind, cmdJson, url || null, headersJson, enabled ? 1 : 0, blocking ? 1 : 0, Math.max(500, Math.min(60000, Number(timeoutMs) || 5000)), now, hookId)
  } else {
    db.prepare(
      `INSERT INTO hooks (id, user_id, event, tool_pattern, kind, command, url, headers_json, enabled, blocking, timeout_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(hookId, userId, event, toolPattern || null, kind, cmdJson, url || null, headersJson, enabled ? 1 : 0, blocking ? 1 : 0, Math.max(500, Math.min(60000, Number(timeoutMs) || 5000)), now, now)
  }
  return getHook(userId, hookId)
}

export function deleteHook(userId, id) {
  if (!userId || !id) return { deleted: 0 }
  const db = getDb()
  const result = db.prepare('DELETE FROM hooks WHERE user_id = ? AND id = ?').run(userId, id)
  return { deleted: result.changes }
}

function runShell({ argv, timeoutMs, cwd }) {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv
    const child = execFile(cmd, args, {
      cwd: cwd || process.cwd(),
      timeout: Math.max(500, Math.min(60000, timeoutMs || 5000)),
      shell: false,
      // 净化 env: 不传敏感变量
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
      },
      maxBuffer: 64 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ allow: true, error: err.message, stdout, stderr })
        return
      }
      // shell hook 可在 stdout 输出 JSON {allow,replacementArgs}
      const trimmed = String(stdout || '').trim()
      if (!trimmed) return resolve({ allow: true })
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object') {
          resolve(parsed)
          return
        }
      } catch { /* not json */ }
      resolve({ allow: true, stdout: trimmed.slice(0, 1024) })
    })
    child.on('error', (e) => resolve({ allow: true, error: e.message }))
  })
}

async function runHttp({ url, headers, body, timeoutMs }) {
  let target
  try {
    target = await assertSafeOutboundUrl(url)
  } catch (err) {
    return { ok: false, error: `ssrf_blocked: ${err?.message || String(err)}` }
  }
  if (target.protocol !== 'https:') return { ok: false, error: 'http_required_https' }
  try {
    const payload = JSON.stringify(body)
    const resp = await fetchSafe({
      url: target.toString(),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: payload,
      timeoutMs: Math.max(500, Math.min(60000, timeoutMs || 5000)),
      maxRedirects: 3,
      requireHttps: true,
    })
    const text = String(resp.body || '')
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
    if (resp.status < 200 || resp.status >= 300) {
      return { allow: true, error: `HTTP ${resp.status}: ${data?.error || text.slice(0, 200)}` }
    }
    return data
  } catch (err) {
    return { ok: false, error: `ssrf_blocked: ${err?.message || String(err)}` }
  }
}

async function executeOne(hook, payload) {
  const start = Date.now()
  let outcome
  try {
    if (hook.kind === 'shell') {
      const argv = Array.isArray(hook.command) ? hook.command : safeParseJson(hook.command) || []
      assertShellCommandAllowed(argv)
      const fullArgv = [...argv, JSON.stringify(payload)]
      const cwd = path.resolve(process.env.WORKSPACE_ROOT?.trim() || process.cwd())
      outcome = await runShell({ argv: fullArgv, timeoutMs: hook.timeoutMs, cwd })
    } else {
      outcome = await runHttp({ url: hook.url, headers: hook.headers, body: payload, timeoutMs: hook.timeoutMs })
    }
  } catch (err) {
    outcome = { allow: true, error: err?.message || String(err) }
  }
  const duration = Date.now() - start
  // ★ P0:走统一 audit 写入器(与 fsShell/mcp 共享同一条路径)
  writeToolAudit({
    userId: hook.userId,
    origin: 'hook',
    toolName: `${hook.event}:${payload.tool || '-'}`,
    serverId: hook.id,
    args: payload,
    status: outcome?.allow === false ? 'denied' : (outcome?.error ? 'error' : 'ok'),
    durationMs: duration,
  })
  return outcome
}

/**
 * 在 hookBus listener 里调用这个分发器。
 *   ctx = { userId, event, tool, args, sessionId?, requestId?, payload? }
 * 返回:
 *   - 全部 allow → { allow: true, replacementArgs?: {...}, permissionDecision?: 'allow'|'deny' }
 *   - 任一 blocking hook allow=false → { allow: false, reason }
 *
 * pre_tool_use hook 可以返回 permissionDecision 来直接放行/拒绝，
 * 让 hook 替代审批门控（与 Claude Code 的 PreToolUse 语义一致）。
 */
export async function dispatchHooks(ctx) {
  if (!ctx?.userId || !ctx?.event) return { allow: true }
  const hooks = listHooks({ userId: ctx.userId, event: ctx.event }).filter((h) => {
    if (!h.enabled) return false
    return matchPattern(h.toolPattern, ctx.tool || '*')
  })
  if (!hooks.length) return { allow: true }
  let workingArgs = ctx.args
  let permissionDecision = null
  let permissionReason = null
  for (const h of hooks) {
    const payload = {
      event: ctx.event,
      tool: ctx.tool || null,
      args: workingArgs,
      userId: ctx.userId,
      sessionId: ctx.sessionId || null,
      requestId: ctx.requestId || null,
      ...(ctx.payload && typeof ctx.payload === 'object' ? { payload: ctx.payload } : {}),
      timestamp: Date.now(),
    }
    if (h.blocking) {
      const outcome = await executeOne(h, payload)
      if (outcome?.allow === false) {
        return { allow: false, reason: outcome.reason || `hook ${h.id} 拒绝` }
      }
      if (outcome?.replacementArgs && typeof outcome.replacementArgs === 'object') {
        workingArgs = { ...workingArgs, ...outcome.replacementArgs }
      }
      // Only pre_tool_use may short-circuit approval. The last blocking hook
      // that returns a decision wins.
      if (outcome?.permissionDecision === 'allow' || outcome?.permissionDecision === 'deny') {
        permissionDecision = outcome.permissionDecision
        permissionReason = outcome.reason || null
      }
    } else {
      // 非阻塞: fire-and-forget
      executeOne(h, payload).catch((err) => {
        console.warn('[hooks] 非阻塞 hook 执行失败:', h.id, err?.message || err)
      })
    }
  }
  if (permissionDecision === 'deny') {
    return { allow: false, reason: permissionReason || 'hook 拒绝', permissionDecision: 'deny' }
  }
  return {
    allow: true,
    replacementArgs: workingArgs,
    ...(permissionDecision === 'allow' ? { permissionDecision: 'allow' } : {}),
  }
}

export async function testHook({ userId, id }) {
  const hook = getHook(userId, id)
  if (!hook) throw new Error('hook 不存在')
  const stub = {
    event: hook.event,
    tool: 'test_stub',
    args: { hello: 'world' },
    userId,
    timestamp: Date.now(),
    testMode: true,
  }
  return await executeOne(hook, stub)
}

export const _hooksInternals = { assertShellCommandAllowed, shellCommandAllowlist }
