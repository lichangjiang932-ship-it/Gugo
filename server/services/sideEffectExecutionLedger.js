import { getDb } from '../db.js'
import { resolveSideEffectExecutionLedgerContract } from './sideEffectExecutionSafety.js'

export { hasUnresolvedJobStepSideEffects } from './sideEffectExecutionSafety.js'
import { isSuccessfulTurnCompletedEvent } from '../../shared/turnEventProjection.js'
import { optionalSideEffectText as optionalText } from './sideEffectExecutionScope.js'
import {
  canonicalRecoveryJson,
  canonicalSideEffectArgsDigest,
  createSideEffectIntentSummary,
  decodeJsonObject,
  DEFAULT_MAX_OUTCOME_BYTES,
  encodeSideEffectOutcome,
  requiredText,
} from './sideEffectExecutionSerialization.js'

export {
  canonicalSideEffectArgsDigest,
  createSideEffectIntentSummary,
  encodeSideEffectOutcome,
  recoverableSideEffectOutcomeFields,
  sanitizeSideEffectRecoveryTarget,
} from './sideEffectExecutionSerialization.js'

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

// Scope construction remains independent from the SQL-backed ledger transitions.
// Re-export it here to preserve the ledger's public compatibility surface.
export { createSideEffectScope } from './sideEffectExecutionScope.js'

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

function prepareDurableSideEffectRecovery({ db, now, read, input, plan }) {
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

function readDurableSideEffectRecovery(read, input) {
  const record = read(input)
  if (!record || record.recoveryJson === null || record.recoveryJson === undefined) return null
  if (record.recovery) return record.recovery
  throw sideEffectRecoveryBlock(
    SIDE_EFFECT_LEDGER_CONFLICT,
    'The durable side-effect recovery plan is unreadable. Recovery was blocked.',
    record,
  )
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
      INSERT INTO side_effect_executions (
        owner_id, scope_kind, scope_key, session_id, turn_id, job_id, step_id,
        request_id, effect_kind, tool_call_id, idempotency_key, tool_name, args_digest, intent_json, status,
        outcome_json, audit_json, created_at, updated_at, prepared_at, executing_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, NULL, ?, ?, ?, NULL, NULL) ON CONFLICT(owner_id, scope_key, tool_call_id) DO NOTHING ON CONFLICT(owner_id, scope_key, idempotency_key) DO NOTHING
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

  const readRecovery = (input) => readDurableSideEffectRecovery(read, input)

  const prepareRecovery = (input, plan) => prepareDurableSideEffectRecovery({
    db,
    now,
    read,
    input,
    plan,
  })

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
  return resolveSideEffectExecutionLedgerContract({
    configuredLedger,
    usesDefaultExecutor,
    getDefaultLedger,
  })
}
