import { createHash } from 'node:crypto'

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const SENSITIVE_KEY_RE = /(?:api_?key|token|secret|password|passphrase|credential|private_?key|client_?secret|authorization|cookie)/iu
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/u
const MAX_RUNTIME_CONFIG_BYTES = 64 * 1024

const integer = (minimum, maximum) => Object.freeze({ kind: 'integer', minimum, maximum })
const number = (minimum, maximum) => Object.freeze({ kind: 'number', minimum, maximum })
const boolean = Object.freeze({ kind: 'boolean' })

export const EVOLUTION_CONFIG_POLICY_VERSION = 'runtime-config-policy-v2'
export const EVOLUTION_CONFIG_ALLOWED_KEYS = Object.freeze({
  AGENT_INJECT_ENABLED: boolean,
  JOB_MAX_ITERS: integer(1, 100_000),
  JOB_MAX_MODEL_CALLS: integer(1, 100_000),
  JOB_MAX_MODEL_TOKENS: integer(0, 1_000_000_000),
  JOB_MAX_TOOL_CALLS: integer(1, 100_000),
  JOB_MAX_WALL_MS: integer(0, 604_800_000),
  JOB_RUNTIME_CONCURRENCY: integer(1, 32),
  JOB_VERIFY_MAX_REPAIR_ATTEMPTS: integer(0, 5),
  MEMORY_INJECT_TOKEN_CAP: integer(64, 1_000_000),
  MODEL_ACTIVE_CONTEXT_TOKENS: integer(1_024, 2_000_000),
  MODEL_BACKGROUND_TIMEOUT_MS: integer(1_000, 86_400_000),
  MODEL_CONTEXT_WINDOW: integer(1_024, 2_000_000),
  MODEL_EXECUTION_REASONING_MAX_CHARS: integer(0, 100_000_000),
  MODEL_FIRST_TOKEN_TIMEOUT_MS: integer(1_000, 86_400_000),
  MODEL_IDLE_TIMEOUT_MS: integer(1_000, 86_400_000),
  MODEL_MAX_TOKENS: integer(1, 1_000_000),
  MODEL_PROBE_TIMEOUT_MS: integer(1_000, 3_600_000),
  MODEL_REASONING_MAX_CHARS: integer(0, 100_000_000),
  MODEL_TEMPERATURE: number(0, 2),
  PLANNING_EXPLORER_MAX_ITERS: integer(1, 1_000),
  SUBAGENT_MAX_CONCURRENT: integer(1, 32),
  SUBAGENT_MAX_DEPTH: integer(1, 8),
  SUBAGENT_MAX_ITERS: integer(1, 100_000),
  SUBAGENT_MAX_PER_BATCH: integer(1, 32),
  SUBAGENT_MAX_TOOL_CALLS: integer(1, 100_000),
  SUBAGENT_MAX_WALL_MS: integer(0, 604_800_000),
  TOOL_MAX_ROUNDS: integer(0, 1_000),
  TOOL_OUTPUT_MAX_CHARS: integer(1_024, 10_000_000),
})

function configError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

function assertSafeObject(value, label, seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== 'object') return
  if (depth > 32 || seen.has(value)) {
    throw configError('EVOLUTION_CONFIG_CONTENT_INVALID', `${label} must contain bounded plain data`)
  }
  seen.add(value)
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw configError('EVOLUTION_CONFIG_CONTENT_INVALID', `${label} must contain plain objects`)
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw configError('EVOLUTION_CONFIG_FORBIDDEN_KEY', `${label} contains a forbidden object key`)
    }
    assertSafeObject(child, label, seen, depth + 1)
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  const output = Object.create(null)
  for (const key of Object.keys(value).sort()) output[key] = stableValue(value[key])
  return output
}

export function stableConfigJson(value) {
  return JSON.stringify(stableValue(value))
}

export function configSha256(value) {
  const input = typeof value === 'string' || Buffer.isBuffer(value) ? value : stableConfigJson(value)
  return createHash('sha256').update(input).digest('hex')
}

function parseCandidateContent(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  const source = String(value || '').trim()
  if (!source || Buffer.byteLength(source, 'utf8') > MAX_RUNTIME_CONFIG_BYTES) {
    throw configError('EVOLUTION_CONFIG_CONTENT_INVALID', 'config candidate content is empty or too large')
  }
  try {
    const parsed = JSON.parse(source)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // The stable public error below intentionally does not echo model output.
  }
  throw configError('EVOLUTION_CONFIG_CONTENT_INVALID', 'config candidate content must be a JSON object')
}

function normalizeRuleValue(key, value, rule) {
  if (value === null) return null
  if (rule.kind === 'boolean') {
    if (value === true || value === '1') return '1'
    if (value === false || value === '0') return '0'
    throw configError('EVOLUTION_CONFIG_VALUE_INVALID', `${key} must be boolean or 0/1`)
  }
  if (typeof value === 'string' && !value.trim()) {
    throw configError('EVOLUTION_CONFIG_VALUE_INVALID', `${key} must not be empty`)
  }
  const parsed = Number(value)
  const validNumber = Number.isFinite(parsed)
  const validKind = rule.kind !== 'integer' || Number.isSafeInteger(parsed)
  if (!validNumber || !validKind || parsed < rule.minimum || parsed > rule.maximum) {
    throw configError(
      'EVOLUTION_CONFIG_VALUE_INVALID',
      `${key} must be a ${rule.kind} between ${rule.minimum} and ${rule.maximum}`,
    )
  }
  return String(parsed)
}

export function normalizeEvolutionConfigPatch(value) {
  const parsed = parseCandidateContent(value)
  assertSafeObject(parsed, 'config candidate')
  const allowedTopLevel = new Set(['schemaVersion', 'mode', 'env'])
  if (Object.keys(parsed).some((key) => !allowedTopLevel.has(key))) {
    throw configError('EVOLUTION_CONFIG_CONTENT_INVALID', 'config candidate contains unsupported fields')
  }
  if (parsed.schemaVersion !== 1 || parsed.mode !== 'patch') {
    throw configError(
      'EVOLUTION_CONFIG_CONTENT_INVALID',
      'config candidate must use schemaVersion 1 and mode patch',
    )
  }
  if (!parsed.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) {
    throw configError('EVOLUTION_CONFIG_CONTENT_INVALID', 'config candidate env must be an object')
  }
  const entries = Object.entries(parsed.env)
  if (entries.length < 1 || entries.length > 32) {
    throw configError('EVOLUTION_CONFIG_CONTENT_INVALID', 'config candidate env must contain 1 to 32 keys')
  }
  const env = Object.create(null)
  for (const [key, rawValue] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    const rule = EVOLUTION_CONFIG_ALLOWED_KEYS[key]
    if (!rule) {
      throw configError('EVOLUTION_CONFIG_KEY_NOT_ALLOWED', `${key} is not allowed for self-evolution`)
    }
    env[key] = normalizeRuleValue(key, rawValue, rule)
  }
  return Object.freeze({ schemaVersion: 1, mode: 'patch', env: Object.freeze(env) })
}

export function canonicalEvolutionConfigPatch(value) {
  return stableConfigJson(normalizeEvolutionConfigPatch(value))
}

function cloneSafeData(value) {
  if (Array.isArray(value)) return value.map(cloneSafeData)
  if (!value || typeof value !== 'object') return value
  const output = Object.create(null)
  for (const [key, child] of Object.entries(value)) output[key] = cloneSafeData(child)
  return output
}

export function normalizeRuntimeConfigDocument(value) {
  const parsed = typeof value === 'string' ? (() => {
    if (Buffer.byteLength(value, 'utf8') > MAX_RUNTIME_CONFIG_BYTES) {
      throw configError('EVOLUTION_CONFIG_BASELINE_INVALID', 'runtime config is too large', 409)
    }
    try { return JSON.parse(value) } catch {
      throw configError('EVOLUTION_CONFIG_BASELINE_INVALID', 'runtime config is invalid JSON', 409)
    }
  })() : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configError('EVOLUTION_CONFIG_BASELINE_INVALID', 'runtime config must be an object', 409)
  }
  assertSafeObject(parsed, 'runtime config')
  const document = Object.hasOwn(parsed, 'env') ? cloneSafeData(parsed) : { env: cloneSafeData(parsed) }
  if (!document.env || typeof document.env !== 'object' || Array.isArray(document.env)) {
    throw configError('EVOLUTION_CONFIG_BASELINE_INVALID', 'runtime config env must be an object', 409)
  }
  for (const [key, value] of Object.entries(document.env)) {
    if (!ENV_KEY_RE.test(key) || SENSITIVE_KEY_RE.test(key)) {
      throw configError('EVOLUTION_CONFIG_BASELINE_INVALID', 'runtime config contains an invalid or sensitive env key', 409)
    }
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw configError('EVOLUTION_CONFIG_BASELINE_INVALID', `${key} must be a scalar`, 409)
    }
    document.env[key] = value == null ? '' : String(value)
  }
  const content = `${JSON.stringify(document, null, 2)}\n`
  if (Buffer.byteLength(content, 'utf8') > MAX_RUNTIME_CONFIG_BYTES) {
    throw configError('EVOLUTION_CONFIG_BASELINE_INVALID', 'runtime config is too large', 409)
  }
  return Object.freeze({ document: Object.freeze(document), content })
}

export function applyEvolutionConfigPatch(documentValue, patchValue) {
  const baseline = normalizeRuntimeConfigDocument(documentValue)
  const patch = normalizeEvolutionConfigPatch(patchValue)
  const next = cloneSafeData(baseline.document)
  next.env = cloneSafeData(next.env)
  for (const [key, value] of Object.entries(patch.env)) {
    if (value === null) delete next.env[key]
    else next.env[key] = value
  }
  return normalizeRuntimeConfigDocument(next)
}

export function safeEffectiveConfigSnapshot(env) {
  const snapshot = Object.create(null)
  for (const key of Object.keys(EVOLUTION_CONFIG_ALLOWED_KEYS).sort()) {
    if (!Object.hasOwn(env || {}, key)) continue
    snapshot[key] = normalizeRuleValue(key, env[key], EVOLUTION_CONFIG_ALLOWED_KEYS[key])
  }
  return Object.freeze(snapshot)
}

export function configPatchChanges(before, after, patchValue, locked = []) {
  const patch = normalizeEvolutionConfigPatch(patchValue)
  const lockedByKey = new Map(locked.map((entry) => [entry.key, entry.source]))
  return Object.freeze(Object.keys(patch.env).sort().map((key) => Object.freeze({
    key,
    operation: patch.env[key] === null ? 'remove' : 'set',
    beforeSha256: Object.hasOwn(before, key) ? configSha256(String(before[key])) : null,
    afterSha256: Object.hasOwn(after, key) ? configSha256(String(after[key])) : null,
    changed: (before[key] ?? null) !== (after[key] ?? null),
    locked: lockedByKey.has(key),
    lockedSource: lockedByKey.get(key) || null,
  })))
}
