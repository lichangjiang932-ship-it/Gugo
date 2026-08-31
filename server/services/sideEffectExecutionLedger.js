import crypto from 'node:crypto'
import { getDb } from '../db.js'
import { isSuccessfulTurnCompletedEvent } from '../../shared/turnEventProjection.js'

export const DURABLE_SIDE_EFFECT_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'patch_file',
  'bash_exec',
  'run_command',
  'git_write',
  'git_commit',
  'git_push',
  'git_rollback',
])

export const SIDE_EFFECT_OUTCOME_UNKNOWN = 'SIDE_EFFECT_OUTCOME_UNKNOWN'
export const SIDE_EFFECT_LEDGER_CONFLICT = 'SIDE_EFFECT_LEDGER_CONFLICT'
export const SIDE_EFFECT_LEDGER_OUTCOME_INVALID = 'SIDE_EFFECT_LEDGER_OUTCOME_INVALID'

const DEFAULT_MAX_OUTCOME_BYTES = 128 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RESOLVED_RETENTION_DAYS = 90
const DEFAULT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000
const TERMINAL_JOB_STATUSES = Object.freeze(['completed', 'failed', 'cancelled'])
const TERMINAL_TURN_EVENT_TYPES = Object.freeze(['turn.completed', 'turn.cancelled', 'turn.failed'])

function storedTurnEventIsResolved(type, payloadJson) {
  if (type === 'turn.cancelled' || type === 'turn.failed') return true
  if (type !== 'turn.completed') return false
  try {
    return isSuccessfulTurnCompletedEvent({
      type,
      payload: JSON.parse(payloadJson),
    })
  } catch {
    return false
  }
}

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

function decodeJsonObject(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function canonicalRecoveryJson(plan) {
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

function requiredText(value, name, maxLength = 500) {
  const normalized = String(value || '').trim().slice(0, maxLength)
  if (!normalized) throw new TypeError(`${name} is required`)
  return normalized
}

function optionalText(value, maxLength = 500) {
  const normalized = String(value || '').trim().slice(0, maxLength)
  return normalized || null
}

export function createSideEffectScope({ job, step, approvalOrigin, approvalSessionId } = {}) {
  const ownerId = requiredText(job?.userId, 'ownerId')
  const jobId = requiredText(job?.id, 'job.id')
  const stepId = requiredText(step?.id, 'step.id')
  const availableSessionId = optionalText(approvalSessionId || job?.sessionId)
  // Production chat entry points declare approvalOrigin='chat' and must always
  // provide a real session identity. Lower-level Loop callers may label a job as
  // chat-originated without carrying chat transport context; keep those calls
  // durable under their explicit job/step identity instead of disabling the
  // ledger or inventing a shared session.
  if (approvalOrigin === 'chat' || (job?.origin === 'chat' && availableSessionId)) {
    const sessionId = requiredText(availableSessionId, 'sessionId')
    return {
      ownerId,
      kind: 'turn',
      scopeKey: JSON.stringify(['turn', sessionId, jobId]),
      sessionId,
      turnId: jobId,
      jobId: null,
      stepId,
    }
  }
  return {
    ownerId,
    kind: 'job',
    scopeKey: JSON.stringify(['job', jobId, stepId]),
    sessionId: optionalText(job?.sessionId),
    turnId: null,
    jobId,
    stepId,
  }
}

function normalizeIdentity({ scope, effectKind = 'tool', toolCallId, idempotencyKey, toolName, args } = {}) {
  if (!scope || !['turn', 'job', 'request'].includes(scope.kind)) throw new TypeError('valid side-effect scope is required')
  if (!['tool', 'hook'].includes(effectKind)) throw new TypeError('valid side-effect effectKind is required')
  return {
    ownerId: requiredText(scope.ownerId, 'ownerId'),
    scopeKind: scope.kind,
    scopeKey: requiredText(scope.scopeKey, 'scopeKey', 1_500),
    sessionId: optionalText(scope.sessionId),
    turnId: optionalText(scope.turnId),
    jobId: optionalText(scope.jobId),
    stepId: optionalText(scope.stepId),
    requestId: optionalText(scope.requestId),
    effectKind,
    toolCallId: requiredText(toolCallId, 'toolCallId'),
    idempotencyKey: requiredText(idempotencyKey, 'idempotencyKey', 1_000),
    toolName: requiredText(toolName, 'toolName', 200),
    argsDigest: canonicalSideEffectArgsDigest(args),
  }
}

function rowToRecord(row) {
  if (!row) return null
  return {
    ownerId: row.owner_id,
    scopeKind: row.scope_kind,
    scopeKey: row.scope_key,
    sessionId: row.session_id,
    turnId: row.turn_id,
    jobId: row.job_id,
    stepId: row.step_id,
    requestId: row.request_id,
    effectKind: row.effect_kind || 'tool',
    toolCallId: row.tool_call_id,
    idempotencyKey: row.idempotency_key,
    toolName: row.tool_name,
    argsDigest: row.args_digest,
    intent: decodeJsonObject(row.intent_json),
    recovery: decodeJsonObject(row.recovery_json),
    recoveryJson: row.recovery_json,
    status: row.status,
    outcomeJson: row.outcome_json,
    audit: decodeJsonObject(row.audit_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preparedAt: row.prepared_at,
    executingAt: row.executing_at,
    finishedAt: row.finished_at,
  }
}

export function sideEffectRecoveryBlock(code, message, record = null) {
  return Object.assign(new Error(message), {
    name: 'SideEffectRecoveryError',
    code,
    retryable: false,
    unsafeToReplay: true,
    requiresUserVerification: true,
    sideEffectExecution: record,
  })
}

function assertSameIdentity(record, identity) {
  if (record
    && record.scopeKind === identity.scopeKind
    && record.effectKind === identity.effectKind
    && record.idempotencyKey === identity.idempotencyKey
    && record.toolName === identity.toolName
    && record.argsDigest === identity.argsDigest) return record
  throw sideEffectRecoveryBlock(
    SIDE_EFFECT_LEDGER_CONFLICT,
    'The durable side-effect identity changed for this tool call. Execution was blocked to prevent replaying a different operation.',
    record,
  )
}

function parseOutcome(record) {
  try {
    const parsed = JSON.parse(record?.outcomeJson)
    if (parsed && typeof parsed === 'object') {
      const replayable = { ...parsed }
      delete replayable.audit
      return { ...replayable, sideEffectLedgerReplay: true }
    }
  } catch { /* handled below */ }
  throw sideEffectRecoveryBlock(
    SIDE_EFFECT_LEDGER_OUTCOME_INVALID,
    'The durable side-effect result is unreadable. Verify the local state before retrying.',
    record,
  )
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

function boundedNumber(value, fallback, { min, max }) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min) return fallback
  return Math.min(max, parsed)
}

export function resolveSideEffectRetentionPolicy(env = process.env) {
  const resolvedRetentionDays = boundedNumber(
    env?.SIDE_EFFECT_RESOLVED_RETENTION_DAYS,
    DEFAULT_RESOLVED_RETENTION_DAYS,
    { min: 1, max: 3_650 },
  )
  return Object.freeze({
    resolvedRetentionMs: Math.floor(resolvedRetentionDays * DAY_MS),
    cleanupIntervalMs: Math.floor(boundedNumber(
      env?.SIDE_EFFECT_CLEANUP_INTERVAL_MS,
      DEFAULT_CLEANUP_INTERVAL_MS,
      { min: 1_000, max: DAY_MS },
    )),
    // An unresolved unknown row is a safety barrier, not disposable history.
    // It is retained until the owner resolves it or clears their local data.
    unknownRetention: 'until_manual_resolution_or_user_data_clear',
  })
}

export function pruneSideEffectExecutions({
  db = getDb(),
  userId = null,
  now = Date.now(),
  resolvedRetentionMs = null,
} = {}) {
  const defaults = resolveSideEffectRetentionPolicy()
  const timestamp = Number.isFinite(Number(now)) ? Math.floor(Number(now)) : Date.now()
  const retentionMs = Math.max(1, Math.floor(boundedNumber(
    resolvedRetentionMs,
    defaults.resolvedRetentionMs,
    { min: 1, max: 3_650 * DAY_MS },
  )))
  const cutoff = timestamp - retentionMs
  const normalizedOwnerId = userId == null ? null : requiredText(userId, 'userId')
  const ownerClause = normalizedOwnerId ? 'AND execution.owner_id = ?' : ''
  const params = normalizedOwnerId ? [cutoff, normalizedOwnerId] : [cutoff]
  const deleted = db.transaction(() => {
    const candidates = db.prepare(`
      SELECT
        execution.owner_id,
        execution.scope_key,
        execution.tool_call_id,
        execution.scope_kind,
        latest_turn.type AS turn_event_type,
        latest_turn.payload_json AS turn_payload_json,
        job.status AS job_status,
        EXISTS (
          SELECT 1 FROM job_turn_checkpoints AS checkpoint
          WHERE checkpoint.job_id = execution.job_id
            AND checkpoint.user_id = execution.owner_id
        ) AS has_job_checkpoint
      FROM side_effect_executions AS execution
      LEFT JOIN turn_events AS latest_turn
        ON execution.scope_kind = 'turn'
       AND latest_turn.user_id = execution.owner_id
       AND latest_turn.session_id = execution.session_id
       AND latest_turn.turn_id = execution.turn_id
       AND latest_turn.sequence = (
         SELECT MAX(event.sequence)
         FROM turn_events AS event
         WHERE event.user_id = execution.owner_id
           AND event.session_id = execution.session_id
           AND event.turn_id = execution.turn_id
       )
      LEFT JOIN jobs AS job
        ON execution.scope_kind = 'job'
       AND job.id = execution.job_id
       AND job.user_id = execution.owner_id
      WHERE execution.status IN ('committed', 'failed')
        AND execution.finished_at IS NOT NULL
        AND execution.finished_at <= ?
        ${ownerClause}
    `).all(...params)
    const remove = db.prepare(`
      DELETE FROM side_effect_executions
      WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ?
    `)
    let changes = 0
    for (const row of candidates) {
      const resolved = row.scope_kind === 'request'
        || (row.scope_kind === 'job'
          && TERMINAL_JOB_STATUSES.includes(row.job_status)
          && Number(row.has_job_checkpoint) === 0)
        || (row.scope_kind === 'turn'
          && TERMINAL_TURN_EVENT_TYPES.includes(row.turn_event_type)
          && storedTurnEventIsResolved(row.turn_event_type, row.turn_payload_json))
      if (!resolved) continue
      changes += remove.run(row.owner_id, row.scope_key, row.tool_call_id).changes
    }
    return changes
  }).immediate()
  return {
    deleted,
    cutoff,
    unknownRetention: defaults.unknownRetention,
  }
}

let lastCleanupAt = 0
let lastCleanupDb = null

export function maybePruneSideEffectExecutions({ db = getDb(), now = Date.now() } = {}) {
  const policy = resolveSideEffectRetentionPolicy()
  const timestamp = Number.isFinite(Number(now)) ? Math.floor(Number(now)) : Date.now()
  if (lastCleanupDb === db && timestamp - lastCleanupAt < policy.cleanupIntervalMs) {
    return { skipped: true, reason: 'cleanup_interval' }
  }
  lastCleanupDb = db
  lastCleanupAt = timestamp
  try {
    return pruneSideEffectExecutions({ db, now: timestamp, ...policy })
  } catch (error) {
    // Maintenance must never prevent a new side effect from being recorded.
    return { skipped: true, reason: 'cleanup_failed', error: error?.message || String(error) }
  }
}

export function createSideEffectExecutionLedger({
  db = getDb(),
  now = Date.now,
  maxOutcomeBytes = DEFAULT_MAX_OUTCOME_BYTES,
} = {}) {
  const readByCall = (identity) => rowToRecord(db.prepare(`
    SELECT * FROM side_effect_executions
    WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ?
  `).get(identity.ownerId, identity.scopeKey, identity.toolCallId))
  const readByIdempotencyKey = (identity) => rowToRecord(db.prepare(`
    SELECT * FROM side_effect_executions
    WHERE owner_id = ? AND scope_key = ? AND idempotency_key = ?
  `).get(identity.ownerId, identity.scopeKey, identity.idempotencyKey))

  const prepare = (input) => {
    const identity = normalizeIdentity(input)
    const intentJson = JSON.stringify(createSideEffectIntentSummary(input))
    const timestamp = Number(now()) || Date.now()
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO side_effect_executions (
        owner_id, scope_kind, scope_key, session_id, turn_id, job_id, step_id,
        request_id, effect_kind, tool_call_id, idempotency_key, tool_name, args_digest, intent_json, status,
        outcome_json, audit_json, created_at, updated_at, prepared_at, executing_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, NULL, ?, ?, ?, NULL, NULL)
    `).run(
      identity.ownerId, identity.scopeKind, identity.scopeKey,
      identity.sessionId, identity.turnId, identity.jobId, identity.stepId,
      identity.requestId, identity.effectKind,
      identity.toolCallId, identity.idempotencyKey, identity.toolName, identity.argsDigest,
      intentJson,
      timestamp, timestamp, timestamp,
    )
    if (inserted.changes === 0) {
      db.prepare(`UPDATE side_effect_executions SET intent_json = COALESCE(intent_json, ?)
        WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ?`)
        .run(intentJson, identity.ownerId, identity.scopeKey, identity.toolCallId)
    }
    const record = inserted.changes > 0
      ? readByCall(identity)
      : readByCall(identity) || readByIdempotencyKey(identity)
    return assertSameIdentity(record, identity)
  }

  const read = (input) => {
    const identity = normalizeIdentity(input)
    const record = readByCall(identity) || readByIdempotencyKey(identity)
    return record ? assertSameIdentity(record, identity) : null
  }

  const readRecovery = (input) => {
    const record = read(input)
    if (!record || record.recoveryJson === null || record.recoveryJson === undefined) return null
    if (record.recovery) return record.recovery
    throw sideEffectRecoveryBlock(
      SIDE_EFFECT_LEDGER_CONFLICT,
      'The durable side-effect recovery plan is unreadable. Recovery was blocked.',
      record,
    )
  }

  const prepareRecovery = (input, plan) => {
    const identity = normalizeIdentity(input)
    const recoveryJson = canonicalRecoveryJson(plan)
    const record = read(input)
    if (!record) {
      throw sideEffectRecoveryBlock(
        SIDE_EFFECT_LEDGER_CONFLICT,
        'The executing side-effect record is missing, so its recovery plan cannot be prepared.',
      )
    }
    if (record.recoveryJson !== null && record.recoveryJson !== undefined) {
      if (record.recoveryJson === recoveryJson && record.recovery) return record.recovery
      throw sideEffectRecoveryBlock(
        SIDE_EFFECT_LEDGER_CONFLICT,
        'The durable side-effect recovery plan changed for this execution. Recovery was blocked.',
        record,
      )
    }
    if (record.status !== 'executing') {
      throw sideEffectRecoveryBlock(
        SIDE_EFFECT_LEDGER_CONFLICT,
        'A side-effect recovery plan can only be prepared while the execution is in progress.',
        record,
      )
    }
    const timestamp = Number(now()) || Date.now()
    const updated = db.prepare(`UPDATE side_effect_executions
      SET recovery_json = ?, updated_at = ?
      WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ?
        AND status = 'executing' AND recovery_json IS NULL`)
      .run(
        recoveryJson,
        timestamp,
        identity.ownerId,
        identity.scopeKey,
        identity.toolCallId,
      )
    const current = read(input)
    if (updated.changes === 1 && current?.recoveryJson === recoveryJson && current.recovery) {
      return current.recovery
    }
    if (current?.recoveryJson === recoveryJson && current.recovery) return current.recovery
    throw sideEffectRecoveryBlock(
      SIDE_EFFECT_LEDGER_CONFLICT,
      'The side-effect recovery plan could not be prepared without overwriting concurrent state.',
      current,
    )
  }

  const claimExecution = (input) => {
    const identity = normalizeIdentity(input)
    const record = read(input)
    if (!record) throw sideEffectRecoveryBlock(SIDE_EFFECT_LEDGER_CONFLICT, 'The prepared side-effect record is missing.')
    if (record.status !== 'prepared') return { claimed: false, record }
    const timestamp = Number(now()) || Date.now()
    const claimed = db.prepare(`UPDATE side_effect_executions
      SET status = 'executing', executing_at = ?, updated_at = ?
      WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ? AND status = 'prepared'`)
      .run(timestamp, timestamp, identity.ownerId, identity.scopeKey, identity.toolCallId)
    const current = read(input)
    if (!current) {
      throw sideEffectRecoveryBlock(SIDE_EFFECT_LEDGER_CONFLICT, 'The claimed side-effect record is missing.')
    }
    return {
      claimed: claimed.changes === 1 && current.status === 'executing',
      record: current,
    }
  }

  const markExecuting = (input) => {
    const claim = claimExecution(input)
    if (claim.claimed) return claim.record
    throw sideEffectRecoveryBlock(
      SIDE_EFFECT_OUTCOME_UNKNOWN,
      'The side-effect execution boundary is already claimed and was not replayed.',
      claim.record,
    )
  }

  const markUnknown = (input, { outcome } = {}) => {
    const identity = normalizeIdentity(input)
    const record = read(input)
    if (!record) return null
    if (record.status === 'executing') {
      const timestamp = Number(now()) || Date.now()
      db.prepare(`UPDATE side_effect_executions
        SET status = 'unknown',
            outcome_json = COALESCE(?, outcome_json),
            updated_at = ?, finished_at = ?
        WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ? AND status = 'executing'`)
        .run(
          outcome === undefined ? null : encodeSideEffectOutcome(outcome, maxOutcomeBytes),
          timestamp,
          timestamp,
          identity.ownerId,
          identity.scopeKey,
          identity.toolCallId,
        )
    }
    return read(input)
  }

  const finish = (input, { status, outcome } = {}) => {
    if (!['committed', 'failed'].includes(status)) throw new TypeError('finish status must be committed or failed')
    const identity = normalizeIdentity(input)
    const record = read(input)
    if (!record) throw sideEffectRecoveryBlock(SIDE_EFFECT_LEDGER_CONFLICT, 'The executing side-effect record is missing.')
    if (['committed', 'failed'].includes(record.status)) return record
    if (record.status !== 'executing') {
      throw sideEffectRecoveryBlock(
        SIDE_EFFECT_OUTCOME_UNKNOWN,
        'The side-effect execution is not in a state that can be completed safely.',
        record,
      )
    }
    const timestamp = Number(now()) || Date.now()
    db.prepare(`UPDATE side_effect_executions
      SET status = ?, outcome_json = ?, updated_at = ?, finished_at = ?
      WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ? AND status = 'executing'`)
      .run(
        status, encodeSideEffectOutcome(outcome, maxOutcomeBytes), timestamp, timestamp,
        identity.ownerId, identity.scopeKey, identity.toolCallId,
      )
    return read(input)
  }

  return Object.freeze({
    prepare,
    read,
    prepareRecovery,
    readRecovery,
    claimExecution,
    markExecuting,
    markUnknown,
    finish,
    parseOutcome,
  })
}

let singleton = null
let singletonDb = null

export function getSideEffectExecutionLedger() {
  const db = getDb()
  maybePruneSideEffectExecutions({ db })
  if (!singleton || singletonDb !== db) {
    singletonDb = db
    singleton = createSideEffectExecutionLedger({ db })
  }
  return singleton
}

const REQUIRED_LEDGER_METHODS = Object.freeze([
  'prepare',
  'read',
  'prepareRecovery',
  'readRecovery',
  'claimExecution',
  'markExecuting',
  'markUnknown',
  'finish',
  'parseOutcome',
])

/**
 * Resolve the loop's replay-prevention contract without inventing an owner.
 * The first-party executor is durable by default; injected executors are
 * ephemeral unless their caller supplies a ledger. `null` is the only
 * explicit opt-out, so falsey configuration mistakes cannot silently disable
 * replay protection.
 */
export function resolveSideEffectExecutionLedger({
  configuredLedger,
  usesDefaultExecutor = false,
  getDefaultLedger = getSideEffectExecutionLedger,
} = {}) {
  if (configuredLedger === null) return null
  if (configuredLedger === undefined && !usesDefaultExecutor) return null
  const ledger = configuredLedger === undefined
    ? getDefaultLedger()
    : configuredLedger
  if (!ledger || REQUIRED_LEDGER_METHODS.some((name) => typeof ledger[name] !== 'function')) {
    throw new TypeError('sideEffectLedger must implement the durable side-effect ledger contract')
  }
  return ledger
}
