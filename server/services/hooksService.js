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
 *   响应   = { allow?: boolean, replacementArgs?: object, reason?: string,
 *              permissionDecision?: 'allow'|'deny'|'ask' }
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
import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'
import {
  hookAuthorizationArgsDigest,
  issueHookAuthorizationProvenance,
} from './hookAuthorizationProvenance.js'
import { getHookSideEffectExecutor } from './hookSideEffectExecution.js'

const ALLOWED_EVENTS = ['user_prompt_submit', 'pre_tool_use', 'post_tool_use', 'stop', 'pre_compact', 'session_start', 'session_end', 'subagent_stop', 'notification']
const HOOK_HEADERS_PURPOSE = 'hook-headers'
const MAX_ARGUMENT_MATCHER_BYTES = 8 * 1024
const MAX_ARGUMENT_MATCHER_DEPTH = 8
const MAX_ARGUMENT_MATCHER_KEYS = 128
const PERMISSION_DECISION_PRIORITY = Object.freeze({ allow: 1, ask: 2, deny: 3 })
const HOOK_EXECUTION_UNTRUSTED = 'HOOK_EXECUTION_UNTRUSTED'
const HOOK_DENIED = 'HOOK_DENIED'

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
  const storedMatcher = parseStoredArgumentMatcher(row.argument_matcher_json)
  return {
    id: row.id,
    userId: row.user_id,
    event: row.event,
    toolPattern: row.tool_pattern || null,
    argumentMatcher: storedMatcher.value,
    ...(storedMatcher.invalid ? { argumentMatcherInvalid: true } : {}),
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

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function validateMatcherValue(value, state, depth = 0) {
  if (depth > MAX_ARGUMENT_MATCHER_DEPTH) throw new Error(`argumentMatcher 最深 ${MAX_ARGUMENT_MATCHER_DEPTH} 层`)
  if (value === null || ['string', 'boolean'].includes(typeof value)) return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    for (const item of value) validateMatcherValue(item, state, depth + 1)
    return
  }
  if (!isPlainObject(value)) throw new Error('argumentMatcher 只能包含 JSON 值')
  for (const [key, item] of Object.entries(value)) {
    state.keys += 1
    if (state.keys > MAX_ARGUMENT_MATCHER_KEYS) throw new Error(`argumentMatcher 最多 ${MAX_ARGUMENT_MATCHER_KEYS} 个字段`)
    if (!key) throw new Error('argumentMatcher 字段名不能为空')
    validateMatcherValue(item, state, depth + 1)
  }
}

function normalizeArgumentMatcher(value) {
  if (value == null || value === '') return null
  if (!isPlainObject(value)) throw new Error('argumentMatcher 必须是 JSON 对象')
  validateMatcherValue(value, { keys: 0 })
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ARGUMENT_MATCHER_BYTES) {
    throw new Error(`argumentMatcher 不能超过 ${MAX_ARGUMENT_MATCHER_BYTES} 字节`)
  }
  return JSON.parse(serialized)
}

function parseStoredArgumentMatcher(raw) {
  if (raw == null) return { value: null, invalid: false }
  try {
    const parsed = JSON.parse(raw)
    if (!isPlainObject(parsed)) throw new Error('stored argumentMatcher is not an object')
    return { value: normalizeArgumentMatcher(parsed), invalid: false }
  } catch {
    return { value: null, invalid: true }
  }
}

function matchesArgumentValue(matcher, candidate) {
  if (Array.isArray(matcher)) {
    return Array.isArray(candidate)
      && matcher.length === candidate.length
      && matcher.every((value, index) => matchesArgumentValue(value, candidate[index]))
  }
  if (isPlainObject(matcher)) {
    if (!isPlainObject(candidate)) return false
    return Object.entries(matcher).every(([key, value]) => (
      Object.prototype.hasOwnProperty.call(candidate, key)
      && matchesArgumentValue(value, candidate[key])
    ))
  }
  return Object.is(matcher, candidate)
}

function matchesArgumentMatcher(matcher, args) {
  return matcher == null || matchesArgumentValue(matcher, args)
}

function normalizeBlockingHookOutcome(outcome) {
  const value = isPlainObject(outcome) ? outcome : {}
  if (value.allow === true) return { ...value, ok: true }
  const intentionalDenial = value.allow === false && !value.error
  return {
    ...value,
    ok: false,
    allow: false,
    code: value.code || (intentionalDenial ? HOOK_DENIED : HOOK_EXECUTION_UNTRUSTED),
    reason: value.reason || (intentionalDenial
      ? 'blocking hook denied the call'
      : 'blocking hook did not return a trusted allow decision'),
  }
}

export function listHooks({ userId, event = null }) {
  if (!userId) return []
  const db = getDb()
  let rows
  if (event) {
    rows = db.prepare('SELECT * FROM hooks WHERE user_id = ? AND event = ? ORDER BY created_at, id').all(userId, event)
  } else {
    rows = db.prepare('SELECT * FROM hooks WHERE user_id = ? ORDER BY event, created_at, id').all(userId)
  }
  return rows.map(row2hook)
}

export function getHook(userId, id) {
  if (!userId || !id) return null
  const db = getDb()
  const row = db.prepare('SELECT * FROM hooks WHERE user_id = ? AND id = ?').get(userId, id)
  return row2hook(row)
}

export function upsertHook({ id, userId, event, toolPattern, argumentMatcher, kind, command, url, headers, enabled, blocking, timeoutMs }) {
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
  const normalizedMatcher = normalizeArgumentMatcher(argumentMatcher)
  const argumentMatcherJson = normalizedMatcher ? JSON.stringify(normalizedMatcher) : null
  const cmdJson = kind === 'shell' ? JSON.stringify(command) : null
  const headersJson = kind === 'http' && headers
    ? sealCredentialObject(headers, { purpose: HOOK_HEADERS_PURPOSE })
    : null
  const existing = db.prepare('SELECT id FROM hooks WHERE user_id = ? AND id = ?').get(userId, hookId)
  if (existing) {
    db.prepare(
      `UPDATE hooks SET event=?, tool_pattern=?, argument_matcher_json=?, kind=?, command=?, url=?, headers_json=?, enabled=?, blocking=?, timeout_ms=?, updated_at=? WHERE id=?`
    ).run(event, toolPattern || null, argumentMatcherJson, kind, cmdJson, url || null, headersJson, enabled ? 1 : 0, blocking ? 1 : 0, Math.max(500, Math.min(60000, Number(timeoutMs) || 5000)), now, hookId)
  } else {
    db.prepare(
      `INSERT INTO hooks (id, user_id, event, tool_pattern, argument_matcher_json, kind, command, url, headers_json, enabled, blocking, timeout_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(hookId, userId, event, toolPattern || null, argumentMatcherJson, kind, cmdJson, url || null, headersJson, enabled ? 1 : 0, blocking ? 1 : 0, Math.max(500, Math.min(60000, Number(timeoutMs) || 5000)), now, now)
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
      env: sanitizeChildEnv(),
      maxBuffer: 64 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ allow: false, error: err.message, reason: 'blocking shell hook execution failed', stdout, stderr })
        return
      }
      // shell hook 可在 stdout 输出 JSON {allow,replacementArgs}
      const trimmed = String(stdout || '').trim()
      if (!trimmed) {
        resolve({ allow: false, error: 'empty hook response', reason: 'blocking shell hook returned no decision' })
        return
      }
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          resolve(parsed)
          return
        }
      } catch { /* not json */ }
      resolve({
        allow: false,
        error: 'invalid hook response JSON',
        reason: 'blocking shell hook returned an invalid decision',
        stdout: trimmed.slice(0, 1024),
      })
    })
    child.on('error', (e) => resolve({
      allow: false,
      error: e.message,
      reason: 'blocking shell hook process could not start',
    }))
  })
}

function hookRequestHeaders(headers, idempotencyKey) {
  const output = {}
  for (const [name, value] of Object.entries(headers || {})) {
    const normalized = name.toLowerCase()
    if (normalized === 'content-type' || normalized === 'idempotency-key') continue
    output[name] = value
  }
  output['Content-Type'] = 'application/json'
  output['Idempotency-Key'] = idempotencyKey
  return output
}

async function runHttp({ url, headers, body, timeoutMs, idempotencyKey }) {
  let target
  try {
    target = await assertSafeOutboundUrl(url)
  } catch (err) {
    return { allow: false, error: `ssrf_blocked: ${err?.message || String(err)}`, reason: 'blocking HTTP hook target was rejected' }
  }
  if (target.protocol !== 'https:') return { allow: false, error: 'http_required_https', reason: 'blocking HTTP hook requires HTTPS' }
  try {
    const payload = JSON.stringify(body)
    const resp = await fetchSafe({
      url: target.toString(),
      method: 'POST',
      headers: hookRequestHeaders(headers, idempotencyKey),
      body: payload,
      timeoutMs: Math.max(500, Math.min(60000, timeoutMs || 5000)),
      maxRedirects: 3,
      requireHttps: true,
    })
    const text = String(resp.body || '')
    let data
    try { data = text ? JSON.parse(text) : {} } catch {
      return { allow: false, error: 'invalid_hook_response_json', reason: 'blocking HTTP hook returned invalid JSON' }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { allow: false, error: 'invalid_hook_response_shape', reason: 'blocking HTTP hook returned an invalid decision' }
    }
    if (resp.status < 200 || resp.status >= 300) {
      return {
        allow: false,
        error: `HTTP ${resp.status}: ${data?.error || text.slice(0, 200)}`,
        reason: 'blocking HTTP hook request failed',
      }
    }
    return data
  } catch (err) {
    return {
      allow: false,
      error: `hook_request_failed: ${err?.message || String(err)}`,
      reason: 'blocking HTTP hook request failed',
    }
  }
}

async function executeOne(hook, payload, { invocationId } = {}) {
  const start = Date.now()
  let outcome
  try {
    const executed = await getHookSideEffectExecutor().execute({
      hook,
      payload,
      invocationId,
      execute: async ({ idempotencyKey }) => {
        const executionPayload = { ...payload, hookInvocationId: invocationId, idempotencyKey }
        if (hook.kind === 'shell') {
          const argv = Array.isArray(hook.command) ? hook.command : safeParseJson(hook.command) || []
          assertShellCommandAllowed(argv)
          const fullArgv = [...argv, JSON.stringify(executionPayload)]
          const cwd = path.resolve(process.env.WORKSPACE_ROOT?.trim() || process.cwd())
          return await runShell({ argv: fullArgv, timeoutMs: hook.timeoutMs, cwd })
        }
        return await runHttp({
          url: hook.url,
          headers: hook.headers,
          body: executionPayload,
          timeoutMs: hook.timeoutMs,
          idempotencyKey,
        })
      },
    })
    outcome = executed.outcome
  } catch (err) {
    outcome = {
      allow: false,
      code: err?.code || HOOK_EXECUTION_UNTRUSTED,
      error: err?.message || String(err),
      reason: err?.requiresUserVerification
        ? 'Hook 执行结果未知，需要人工核验后才能重试'
        : 'blocking hook execution failed',
    }
  }
  if (hook.blocking) outcome = normalizeBlockingHookOutcome(outcome)
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
 *   - 全部 allow → { allow: true, replacementArgs?: {...}, permissionDecision?: 'allow'|'deny'|'ask' }
 *   - 任一 blocking hook allow=false → { allow: false, reason }
 *
 * pre_tool_use hook 可以返回 permissionDecision 来直接放行/拒绝/强制审批，
 * 让 hook 替代审批门控（与 Claude Code 的 PreToolUse 语义一致）。
 */
export async function dispatchHooks(ctx) {
  if (!ctx?.userId || !ctx?.event) {
    return {
      allow: false,
      code: 'hook_subject_missing',
      reason: 'Hook 调用缺少用户或事件主体，已保守拒绝',
    }
  }
  const hooks = listHooks({ userId: ctx.userId, event: ctx.event }).filter((h) => {
    if (!h.enabled) return false
    return matchPattern(h.toolPattern, ctx.tool || '*')
  })
  if (!hooks.length) return { allow: true }
  const invocationId = String(ctx.hookInvocationId || ctx.requestId || ctx.toolCallId || '').trim()
  if (!invocationId) {
    return {
      allow: false,
      code: 'hook_invocation_id_missing',
      reason: 'Hook 调用缺少稳定 invocation ID，已保守拒绝',
    }
  }
  let workingArgs = ctx.args
  let permissionDecision = null
  let permissionReason = null
  let permissionHook = null
  let permissionArgsDigest = null
  let matchedHook = false
  for (const h of hooks) {
    if (h.argumentMatcherInvalid) {
      if (h.blocking) {
        return { allow: false, reason: `hook ${h.id} argumentMatcher 配置无效` }
      }
      continue
    }
    if (!matchesArgumentMatcher(h.argumentMatcher, workingArgs)) continue
    matchedHook = true
    const payload = {
      event: ctx.event,
      tool: ctx.tool || null,
      args: workingArgs,
      userId: ctx.userId,
      origin: ctx.origin || null,
      jobId: ctx.jobId || null,
      stepId: ctx.stepId || null,
      sessionId: ctx.sessionId || null,
      requestId: ctx.requestId || null,
      toolCallId: ctx.toolCallId || null,
      ...(ctx.payload && typeof ctx.payload === 'object' ? { payload: ctx.payload } : {}),
      timestamp: Date.now(),
    }
    if (h.blocking) {
      const outcome = await executeOne(h, payload, { invocationId })
      if (outcome?.allow !== true) {
        return {
          allow: false,
          code: outcome?.code || HOOK_EXECUTION_UNTRUSTED,
          reason: outcome?.reason || `hook ${h.id} 未返回可信放行决定`,
        }
      }
      if (outcome?.replacementArgs && typeof outcome.replacementArgs === 'object') {
        workingArgs = { ...workingArgs, ...outcome.replacementArgs }
      }
      // Only pre_tool_use callers act on this decision. Multiple matching
      // hooks are combined conservatively: deny > ask > allow.
      const nextDecision = outcome?.permissionDecision
      const nextPriority = PERMISSION_DECISION_PRIORITY[nextDecision] || 0
      const currentPriority = PERMISSION_DECISION_PRIORITY[permissionDecision] || 0
      if (nextPriority >= currentPriority && nextPriority > 0) {
        permissionDecision = nextDecision
        permissionReason = outcome.reason || null
        permissionHook = h
        permissionArgsDigest = nextDecision === 'allow'
          ? hookAuthorizationArgsDigest(workingArgs)
          : null
      }
    } else {
      // 非阻塞: fire-and-forget
      executeOne(h, payload, { invocationId }).catch((err) => {
        console.warn('[hooks] 非阻塞 hook 执行失败:', h.id, err?.message || err)
      })
    }
  }
  if (!matchedHook) return { allow: true }
  if (permissionDecision === 'allow'
    && permissionArgsDigest !== hookAuthorizationArgsDigest(workingArgs)) {
    permissionDecision = null
    permissionReason = null
    permissionHook = null
  }
  if (permissionDecision === 'deny') {
    return { allow: false, reason: permissionReason || 'hook 拒绝', permissionDecision: 'deny' }
  }
  const hookAuthorizationProvenance = permissionDecision === 'allow'
    ? issueHookAuthorizationProvenance({
        hook: permissionHook,
        userId: ctx.userId,
        origin: ctx.origin,
        jobId: ctx.jobId,
        stepId: ctx.stepId,
        sessionId: ctx.sessionId,
        requestId: ctx.requestId,
        toolCallId: ctx.toolCallId,
        toolName: ctx.tool,
        args: workingArgs,
      })
    : null
  if (permissionDecision === 'allow' && !hookAuthorizationProvenance) {
    return {
      allow: false,
      code: 'hook_authorization_scope_missing',
      reason: 'Hook 授权缺少当前调用的最小作用域，已保守拒绝',
      permissionDecision: 'deny',
    }
  }
  return {
    allow: true,
    replacementArgs: workingArgs,
    ...(['allow', 'ask'].includes(permissionDecision) ? { permissionDecision, reason: permissionReason } : {}),
    ...(hookAuthorizationProvenance ? { hookAuthorizationProvenance } : {}),
  }
}

export async function testHook({ userId, id, idempotencyKey }) {
  const hook = getHook(userId, id)
  if (!hook) throw new Error('hook 不存在')
  const invocationId = String(idempotencyKey || '').trim()
  if (!invocationId) {
    throw Object.assign(new Error('Idempotency-Key header is required'), {
      code: 'HOOK_IDEMPOTENCY_KEY_REQUIRED',
      statusCode: 400,
    })
  }
  const stub = {
    event: hook.event,
    tool: 'test_stub',
    args: { hello: 'world' },
    userId,
    timestamp: Date.now(),
    testMode: true,
  }
  return await executeOne(hook, stub, { invocationId: `test:${invocationId}` })
}

export const _hooksInternals = {
  assertShellCommandAllowed,
  shellCommandAllowlist,
  matchesArgumentMatcher,
  normalizeArgumentMatcher,
  hookRequestHeaders,
}
