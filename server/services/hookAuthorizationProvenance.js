import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { credentialScopedFingerprint } from '../utils/credentialVault.js'

const HOOK_AUTHORIZATION_VERSION = 1
const HOOK_AUTHORIZATION_KIND = 'pre_tool_use_hook'
const HOOK_AUTHORIZATION_SIGNATURE_PURPOSE = 'hook-authorization-provenance'
const liveHookAuthorizations = new WeakSet()

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalId(value) {
  return text(value) || null
}

function canonicalize(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null
  if (seen.has(value)) throw new TypeError('hook authorization arguments must not contain cycles')
  seen.add(value)
  const normalized = Array.isArray(value)
    ? value.map((item) => canonicalize(item, seen))
    : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key], seen)]))
  seen.delete(value)
  return normalized
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function signaturePayload(provenance) {
  const unsigned = { ...(provenance || {}) }
  Reflect.deleteProperty(unsigned, 'signature')
  return JSON.stringify(canonicalize(unsigned))
}

function signProvenance(provenance) {
  return credentialScopedFingerprint(signaturePayload(provenance), {
    purpose: HOOK_AUTHORIZATION_SIGNATURE_PURPOSE,
  })
}

function hasValidSignature(provenance) {
  const actual = String(provenance?.signature || '')
  if (!/^[a-f0-9]{64}$/i.test(actual)) return false
  let expected
  try {
    expected = signProvenance(provenance)
  } catch {
    return false
  }
  const actualBuffer = Buffer.from(actual, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer)
}

export function hookAuthorizationArgsDigest(args) {
  return digest(args || {})
}

export function hookConfigurationDigest(hook) {
  return digest({
    id: hook?.id || null,
    userId: hook?.userId || null,
    event: hook?.event || null,
    toolPattern: hook?.toolPattern || null,
    argumentMatcher: hook?.argumentMatcher || null,
    kind: hook?.kind || null,
    command: hook?.command || null,
    url: hook?.url || null,
    headers: hook?.headers || null,
    enabled: hook?.enabled === true,
    blocking: hook?.blocking === true,
    timeoutMs: Number(hook?.timeoutMs) || null,
  })
}

export function issueHookAuthorizationProvenance({
  hook,
  userId,
  origin = null,
  jobId = null,
  stepId = null,
  sessionId = null,
  requestId = null,
  toolCallId,
  toolName,
  args = {},
} = {}) {
  const ownerId = text(userId)
  const callId = text(toolCallId)
  const name = text(toolName)
  const hookId = text(hook?.id)
  if (!ownerId || !callId || !name || !hookId) return null
  if (hook?.event !== 'pre_tool_use' || hook?.enabled !== true || hook?.blocking !== true) return null

  const unsigned = {
    version: HOOK_AUTHORIZATION_VERSION,
    kind: HOOK_AUTHORIZATION_KIND,
    invocationId: randomUUID(),
    hookId,
    hookRevision: Number(hook.updatedAt) || null,
    hookConfigDigest: hookConfigurationDigest(hook),
    userId: ownerId,
    origin: optionalId(origin),
    jobId: optionalId(jobId),
    stepId: optionalId(stepId),
    sessionId: optionalId(sessionId),
    requestId: optionalId(requestId),
    toolCallId: callId,
    toolName: name,
    argsDigest: hookAuthorizationArgsDigest(args),
  }
  const provenance = Object.freeze({ ...unsigned, signature: signProvenance(unsigned) })
  liveHookAuthorizations.add(provenance)
  return provenance
}

function invalid(code, reason) {
  return { valid: false, code, reason }
}

export function validateHookAuthorizationProvenance({
  provenance,
  expected,
  resolveHook,
  requireLive = true,
} = {}) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return invalid('hook_authorization_provenance_missing', 'Hook 授权来源缺失，已保守拒绝执行')
  }
  if (provenance.version !== HOOK_AUTHORIZATION_VERSION || provenance.kind !== HOOK_AUTHORIZATION_KIND) {
    return invalid('hook_authorization_provenance_invalid', 'Hook 授权来源格式无效，已保守拒绝执行')
  }
  if (!hasValidSignature(provenance)) {
    return invalid('hook_authorization_provenance_untrusted', 'Hook 授权签名无效或不是由当前本地运行时签发，已保守拒绝执行')
  }
  if (requireLive && !liveHookAuthorizations.has(provenance)) {
    return invalid('hook_authorization_provenance_not_live', '实时 Hook 授权不是当前进程本次调用签发的对象，已保守拒绝执行')
  }
  if (!text(provenance.invocationId) || !text(provenance.hookId)) {
    return invalid('hook_authorization_provenance_invalid', 'Hook 授权缺少调用或 Hook 身份，已保守拒绝执行')
  }

  const normalizedExpected = {
    userId: text(expected?.userId),
    origin: optionalId(expected?.origin),
    jobId: optionalId(expected?.jobId),
    stepId: optionalId(expected?.stepId),
    sessionId: optionalId(expected?.sessionId),
    requestId: optionalId(expected?.requestId),
    toolCallId: text(expected?.toolCallId),
    toolName: text(expected?.toolName),
  }
  if (!normalizedExpected.userId || !normalizedExpected.toolCallId || !normalizedExpected.toolName) {
    return invalid('hook_authorization_scope_missing', '当前工具调用缺少 Hook 授权所需的最小作用域，已保守拒绝执行')
  }
  for (const [field, value] of Object.entries(normalizedExpected)) {
    if ((provenance[field] ?? null) !== value) {
      return invalid('hook_authorization_scope_mismatch', `Hook 授权与当前 ${field} 不匹配，已保守拒绝执行`)
    }
  }
  if (provenance.argsDigest !== hookAuthorizationArgsDigest(expected?.args || {})) {
    return invalid('hook_authorization_args_mismatch', 'Hook 授权参数与当前执行参数不匹配，已保守拒绝执行')
  }
  if (typeof resolveHook !== 'function') {
    return invalid('hook_authorization_verifier_missing', 'Hook 授权无法验证当前配置，已保守拒绝执行')
  }
  const hook = resolveHook(normalizedExpected.userId, provenance.hookId)
  if (!hook || hook.enabled !== true || hook.blocking !== true || hook.event !== 'pre_tool_use') {
    return invalid('hook_authorization_hook_unavailable', '签发授权的 Hook 已删除、停用或不再可阻塞，已保守拒绝执行')
  }
  if ((Number(hook.updatedAt) || null) !== (Number(provenance.hookRevision) || null)
    || hookConfigurationDigest(hook) !== provenance.hookConfigDigest) {
    return invalid('hook_authorization_hook_drift', '签发授权的 Hook 配置已变更，旧授权已失效')
  }
  return { valid: true, provenance }
}

export const _hookAuthorizationInternals = {
  HOOK_AUTHORIZATION_KIND,
  HOOK_AUTHORIZATION_VERSION,
}
