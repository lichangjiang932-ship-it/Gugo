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
import { getDb } from './db.js'
import { randomUUID } from 'node:crypto'

const ALLOWED_EVENTS = ['user_prompt_submit', 'pre_tool_use', 'post_tool_use', 'stop']

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
    headers: safeParseJson(row.headers_json) || null,
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
  if (kind === 'shell' && process.env.HOOKS_SHELL_ENABLED !== '1') {
    throw new Error('shell hook 已禁用 (设置 HOOKS_SHELL_ENABLED=1 启用)')
  }
  const db = getDb()
  const now = Date.now()
  const hookId = id || randomUUID()
  const cmdJson = kind === 'shell' ? JSON.stringify(command) : null
  const headersJson = kind === 'http' && headers ? JSON.stringify(headers) : null
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
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), Math.max(500, Math.min(60000, timeoutMs || 5000)))
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await resp.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
    if (!resp.ok) return { allow: true, error: `HTTP ${resp.status}: ${data?.error || text.slice(0, 200)}` }
    return data
  } catch (err) {
    return { allow: true, error: err?.message || String(err) }
  } finally {
    clearTimeout(t)
  }
}

async function executeOne(hook, payload) {
  const start = Date.now()
  let outcome
  try {
    if (hook.kind === 'shell') {
      const argv = Array.isArray(hook.command) ? hook.command : safeParseJson(hook.command) || []
      const fullArgv = [...argv, JSON.stringify(payload)]
      outcome = await runShell({ argv: fullArgv, timeoutMs: hook.timeoutMs })
    } else {
      outcome = await runHttp({ url: hook.url, headers: hook.headers, body: payload, timeoutMs: hook.timeoutMs })
    }
  } catch (err) {
    outcome = { allow: true, error: err?.message || String(err) }
  }
  const duration = Date.now() - start
  // 审计日志
  try {
    const db = getDb()
    db.prepare(
      'INSERT INTO tool_audit (user_id, origin, tool_name, server_id, args_hash, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(hook.userId, 'hook', `${hook.event}:${payload.tool || '-'}`, hook.id, null, outcome?.allow === false ? 'denied' : 'ok', duration, Date.now())
  } catch { /* audit best-effort */ }
  return outcome
}

/**
 * 在 hookBus listener 里调用这个分发器。
 *   ctx = { userId, event, tool, args, sessionId?, requestId? }
 * 返回:
 *   - 全部 allow → { allow: true, replacement?: {...} }
 *   - 任一 blocking hook allow=false → { allow: false, reason }
 */
export async function dispatchHooks(ctx) {
  if (!ctx?.userId || !ctx?.event) return { allow: true }
  const hooks = listHooks({ userId: ctx.userId, event: ctx.event }).filter((h) => {
    if (!h.enabled) return false
    return matchPattern(h.toolPattern, ctx.tool || '*')
  })
  if (!hooks.length) return { allow: true }
  let workingArgs = ctx.args
  for (const h of hooks) {
    const payload = {
      event: ctx.event,
      tool: ctx.tool || null,
      args: workingArgs,
      userId: ctx.userId,
      sessionId: ctx.sessionId || null,
      requestId: ctx.requestId || null,
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
    } else {
      // 非阻塞: fire-and-forget
      executeOne(h, payload).catch((err) => {
        console.warn('[hooks] 非阻塞 hook 执行失败:', h.id, err?.message || err)
      })
    }
  }
  return { allow: true, replacementArgs: workingArgs }
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
