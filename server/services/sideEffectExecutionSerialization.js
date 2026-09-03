import crypto from 'node:crypto'

export const DEFAULT_MAX_OUTCOME_BYTES = 128 * 1024

// These fields are sufficient to reconnect a replayed tool result to managed
// artifacts, verified local outputs, and mutation verification. Large stdout,
// binary previews, and other presentation-only fields remain digest-only.
const RECOVERY_OUTCOME_FIELDS = Object.freeze([
  'artifactId',
  'artifactIds',
  'artifacts',
  'verifiedOutputs',
  'changedPaths',
  'changedFiles',
  'changes',
  'renamed',
  'path',
  'filePath',
  'file_path',
  'outputPath',
  'output',
  'output_path',
  'outputDir',
  'outputs',
  'target',
  'destination',
  'cwd',
  'scope',
  'filename',
  'url',
  'type',
  'deliveryStatus',
  'verifiedLocalFiles',
  'retainedLocalFiles',
])

const RECOVERY_MAX_DEPTH = 5
const RECOVERY_MAX_ARRAY_ITEMS = 256
const RECOVERY_MAX_OBJECT_KEYS = 64
const RECOVERY_MAX_STRING_CHARS = 16_384
const MAX_INTENT_TARGETS = 12
const MAX_INTENT_TEXT_CHARS = 500
const REDACTED = '[REDACTED]'
const REDACTED_PATH = '[REDACTED_PATH]'
const INTENT_TARGET_KEYS = Object.freeze([
  ['path', 'path'], ['filePath', 'path'], ['file_path', 'path'],
  ['outputPath', 'path'], ['output_path', 'path'], ['outputDir', 'path'],
  ['filename', 'path'], ['destination', 'destination'], ['target', 'target'],
  ['url', 'url'], ['webhookUrl', 'url'], ['webhook_url', 'url'],
  ['endpoint', 'url'], ['from', 'source'], ['to', 'destination'],
])
const CREDENTIAL_VALUE_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu,
  /\bsk-[A-Za-z0-9_-]{8,}\b/giu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/giu,
])
const CREDENTIAL_ASSIGNMENT_PATTERN = /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)\s*[:=]\s*)[^\s,;"'}]{4,}/giu
const SENSITIVE_QUERY_NAME = /^(?:x-amz-|x-goog-|sig(?:nature)?$|token$|key$|secret$|password$|credential$|authorization$|se$|sp$|sv$)/iu
const SENSITIVE_PATH_MARKER = /\/(?:services|webhooks?|hooks?|tokens?|secrets?|signed)(?:\/|$)/iu
const HIGH_ENTROPY_PATH_SEGMENT = /^[A-Za-z0-9._~+/=-]{24,}$/u

function stripRecoveryControls(value) {
  return Array.from(String(value ?? ''), (character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127 ? ' ' : character
  }).join('')
}

function redactRecoveryText(value, maxLength = MAX_INTENT_TEXT_CHARS) {
  let text = stripRecoveryControls(value).replace(/\s+/gu, ' ').trim()
  for (const pattern of CREDENTIAL_VALUE_PATTERNS) text = text.replace(pattern, REDACTED)
  text = text.replace(CREDENTIAL_ASSIGNMENT_PATTERN, `$1${REDACTED}`)
  text = text.replace(/((?:--?(?:api[_-]?key|token|secret|password|authorization|cookie)|-u)\s+)(?:"[^"]*"|'[^']*'|\S+)/giu, `$1${REDACTED}`)
  text = text.replace(/(\bAuthorization\s*:\s*)(?:Bearer\s+)?[^\s,"'}]+/giu, `$1${REDACTED}`)
  return text.slice(0, maxLength)
}

function urlHasSecretBearingPath(url, original) {
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'hooks.slack.com' && /^\/services\//iu.test(url.pathname)) return true
  if ((hostname === 'discord.com' || hostname === 'discordapp.com') && /\/api\/webhooks?\//iu.test(url.pathname)) return true
  if (SENSITIVE_PATH_MARKER.test(url.pathname)) return true
  if ([...url.searchParams.keys()].some((name) => SENSITIVE_QUERY_NAME.test(name))) return true
  if (/\b(?:x-amz-signature|x-goog-signature|signature|sharedaccesssignature)=/iu.test(original)) return true
  return url.pathname.split('/').filter(Boolean).some((segment) => HIGH_ENTROPY_PATH_SEGMENT.test(segment))
}

export function sanitizeSideEffectRecoveryTarget(value, { kind = 'target' } = {}) {
  const raw = stripRecoveryControls(value).replace(/\s+/gu, ' ').trim()
  if (!raw) return ''
  const urlLike = kind === 'url' || /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)
  if (!urlLike) return redactRecoveryText(raw)
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) return '[REDACTED_URL]'
    const origin = url.origin
    if (urlHasSecretBearingPath(url, raw)) return `${origin}/${REDACTED_PATH}`
    return `${origin}${url.pathname || '/'}`.slice(0, MAX_INTENT_TEXT_CHARS)
  } catch {
    return '[REDACTED_URL]'
  }
}

function commandIntentSummary(value) {
  let summary = redactRecoveryText(value, 300)
  summary = summary.replace(/https?:\/\/[^\s"']+/giu, (candidate) => (
    sanitizeSideEffectRecoveryTarget(candidate, { kind: 'url' })
  ))
  return summary
}

export function requiredText(value, name, maxLength = 500) {
  const normalized = String(value || '').trim().slice(0, maxLength)
  if (!normalized) throw new TypeError(`${name} is required`)
  return normalized
}

export function createSideEffectIntentSummary({ toolName, args } = {}) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const targets = []
  const addTarget = (kind, value) => {
    if (targets.length >= MAX_INTENT_TARGETS || value == null) return
    if (Array.isArray(value)) {
      for (const item of value) addTarget(kind, item)
      return
    }
    if (typeof value === 'object') {
      for (const [key, nestedKind] of INTENT_TARGET_KEYS) {
        if (Object.hasOwn(value, key)) addTarget(nestedKind, value[key])
      }
      return
    }
    const safe = sanitizeSideEffectRecoveryTarget(value, { kind })
    if (safe && !targets.some((target) => target.kind === kind && target.value === safe)) {
      targets.push({ kind, value: safe })
    }
  }
  for (const [key, kind] of INTENT_TARGET_KEYS) {
    if (Object.hasOwn(input, key)) addTarget(kind, input[key])
  }
  for (const key of ['paths', 'files', 'outputs', 'expected_outputs', 'destinations', 'urls']) {
    if (Object.hasOwn(input, key)) addTarget(key === 'urls' ? 'url' : 'path', input[key])
  }
  const command = commandIntentSummary(input.command || input.cmd || input.script || '')
  return {
    toolName: requiredText(toolName, 'toolName', 200),
    ...(command ? { command } : {}),
    targets,
  }
}

export function decodeJsonObject(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function canonicalRecoveryJson(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new TypeError('side-effect recovery plan must be an object')
  }
  return JSON.stringify(canonicalize(plan))
}

function canonicalize(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null
  if (seen.has(value)) throw new TypeError('side-effect arguments must not contain cycles')
  seen.add(value)
  const normalized = Array.isArray(value)
    ? value.map((item) => canonicalize(item, seen))
    : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key], seen)]))
  seen.delete(value)
  return normalized
}

export function canonicalSideEffectArgsDigest(args) {
  const canonical = JSON.stringify(canonicalize(args || {}))
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

function boundedRecoveryValue(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value.slice(0, RECOVERY_MAX_STRING_CHARS)
  if (depth >= RECOVERY_MAX_DEPTH || !value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    return value
      .slice(0, RECOVERY_MAX_ARRAY_ITEMS)
      .map((item) => boundedRecoveryValue(item, depth + 1))
      .filter((item) => item !== undefined)
  }
  const output = {}
  for (const key of Object.keys(value).slice(0, RECOVERY_MAX_OBJECT_KEYS)) {
    const normalized = boundedRecoveryValue(value[key], depth + 1)
    if (normalized !== undefined) output[key] = normalized
  }
  return output
}

export function recoverableSideEffectOutcomeFields(outcome) {
  if (!outcome || typeof outcome !== 'object') return {}
  const recovery = {}
  for (const key of RECOVERY_OUTCOME_FIELDS) {
    if (!Object.hasOwn(outcome, key)) continue
    const normalized = boundedRecoveryValue(outcome[key])
    if (normalized !== undefined) recovery[key] = normalized
  }
  return recovery
}

function encodedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function fitArrayPrefix(envelope, key, values, maxOutcomeBytes) {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encodedBytes({ ...envelope, [key]: values.slice(0, middle) }) <= maxOutcomeBytes) low = middle
    else high = middle - 1
  }
  return low > 0 ? values.slice(0, low) : undefined
}

export function encodeSideEffectOutcome(outcome, maxOutcomeBytes = DEFAULT_MAX_OUTCOME_BYTES) {
  const replayableOutcome = outcome && typeof outcome === 'object'
    ? Object.fromEntries(Object.entries(outcome).filter(([key]) => key !== 'audit'))
    : outcome
  const json = JSON.stringify(replayableOutcome ?? null)
  if (Buffer.byteLength(json, 'utf8') <= maxOutcomeBytes) return json
  const digest = crypto.createHash('sha256').update(json).digest('hex')
  const envelope = {
    ok: replayableOutcome?.ok === true,
    code: String(
      replayableOutcome?.code || (replayableOutcome?.ok === true ? 'side_effect_committed' : 'side_effect_failed'),
    ).slice(0, 500),
    error: replayableOutcome?.error ? String(replayableOutcome.error).slice(0, 2_000) : undefined,
    ledgerOutcomeTruncated: true,
    outcomeDigest: digest,
  }
  const recovery = recoverableSideEffectOutcomeFields(replayableOutcome)
  const truncatedFields = []
  if (replayableOutcome?.userConfirmed === true) envelope.userConfirmed = true
  for (const [key, value] of Object.entries(recovery)) {
    const candidate = { ...envelope, [key]: value }
    if (encodedBytes(candidate) <= maxOutcomeBytes) {
      envelope[key] = value
      continue
    }
    if (Array.isArray(value)) {
      const prefix = fitArrayPrefix(envelope, key, value, maxOutcomeBytes)
      if (prefix) envelope[key] = prefix
    }
    truncatedFields.push(key)
  }
  if (truncatedFields.length > 0) {
    const marker = [...new Set(truncatedFields)]
    if (encodedBytes({ ...envelope, ledgerRecoveryFieldsTruncated: marker }) <= maxOutcomeBytes) {
      envelope.ledgerRecoveryFieldsTruncated = marker
    }
  }
  return JSON.stringify(envelope)
}
