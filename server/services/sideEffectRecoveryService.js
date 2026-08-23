import crypto from 'node:crypto'
import { getDb } from '../db.js'
import {
  encodeSideEffectOutcome,
  maybePruneSideEffectExecutions,
  recoverableSideEffectOutcomeFields,
  sanitizeSideEffectRecoveryTarget,
} from './sideEffectExecutionLedger.js'

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 100
const MAX_RECOVERY_EVIDENCE_ITEMS = 12
const MAX_RECOVERY_TEXT_LENGTH = 500
const LIST_CURSOR_VERSION = 1
const MAX_LIST_CURSOR_LENGTH = 4_096
const REDACTED = '[REDACTED]'

const TARGET_KEYS = Object.freeze([
  'path',
  'filePath',
  'file_path',
  'outputPath',
  'output_path',
  'outputDir',
  'filename',
  'url',
  'target',
  'destination',
])

const CREDENTIAL_VALUE_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu,
  /\bsk-[A-Za-z0-9_-]{8,}\b/giu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/giu,
])
const CREDENTIAL_ASSIGNMENT_PATTERN = /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)\s*[:=]\s*)[^\s,;"'}]{4,}/giu

function recoveryError(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode })
}

function requiredText(value, name, maxLength) {
  const normalized = String(value || '').trim()
  if (!normalized) throw recoveryError('SIDE_EFFECT_RECOVERY_INVALID', `${name} is required`, 400)
  if (normalized.length > maxLength) {
    throw recoveryError('SIDE_EFFECT_RECOVERY_INVALID', `${name} is too long`, 400)
  }
  return normalized
}

function normalizeLimit(value) {
  if (value == null || value === '') return DEFAULT_LIST_LIMIT
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
    throw recoveryError(
      'SIDE_EFFECT_RECOVERY_INVALID',
      `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
      400,
    )
  }
  return parsed
}

function cursorError() {
  return recoveryError(
    'SIDE_EFFECT_RECOVERY_CURSOR_INVALID',
    'cursor is invalid for this side-effect result set',
    400,
  )
}

function cursorOwnerFingerprint(ownerId) {
  return crypto.createHash('sha256').update(ownerId).digest('base64url').slice(0, 22)
}

function encodeListCursor({ kind, ownerId, row }) {
  const payload = [
    LIST_CURSOR_VERSION,
    kind,
    cursorOwnerFingerprint(ownerId),
    row.updated_at,
    row.scope_key,
    row.tool_call_id,
  ]
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeListCursor(value, { kind, ownerId }) {
  if (value == null) return null
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_LIST_CURSOR_LENGTH
    || !/^[A-Za-z0-9_-]+$/u.test(value)) throw cursorError()
  try {
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) throw cursorError()
    const payload = JSON.parse(decoded.toString('utf8'))
    if (!Array.isArray(payload) || payload.length !== 6) throw cursorError()
    const [version, cursorKind, ownerFingerprint, updatedAt, scopeKey, toolCallId] = payload
    if (version !== LIST_CURSOR_VERSION
      || cursorKind !== kind
      || ownerFingerprint !== cursorOwnerFingerprint(ownerId)
      || !Number.isSafeInteger(updatedAt)
      || updatedAt < 0
      || typeof scopeKey !== 'string'
      || scopeKey.length < 1
      || scopeKey.length > 1_500
      || typeof toolCallId !== 'string'
      || toolCallId.length < 1
      || toolCallId.length > 500) throw cursorError()
    return { updatedAt, scopeKey, toolCallId }
  } catch (error) {
    if (error?.code === 'SIDE_EFFECT_RECOVERY_CURSOR_INVALID') throw error
    throw cursorError()
  }
}

function decodeOutcome(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function stripControlCharacters(value) {
  return Array.from(String(value ?? ''), (character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127 ? ' ' : character
  }).join('')
}

function sanitizeRecoveryText(value, maxLength = MAX_RECOVERY_TEXT_LENGTH) {
  let text = stripControlCharacters(value)
    .replace(/\s+/gu, ' ')
    .trim()
  if (!text) return ''

  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) {
    try {
      const url = new URL(text)
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      text = url.toString()
    } catch {
      // Fall through to credential redaction for malformed URL-like values.
    }
  }

  for (const pattern of CREDENTIAL_VALUE_PATTERNS) text = text.replace(pattern, REDACTED)
  text = text.replace(CREDENTIAL_ASSIGNMENT_PATTERN, `$1${REDACTED}`)
  text = text.replace(
    /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|key|secret|password|signature|sig|credential|authorization)=)[^&#\s]+/giu,
    `$1${REDACTED}`,
  )
  return text.slice(0, maxLength)
}

function safeIdentifier(value, maxLength = 300) {
  return sanitizeRecoveryText(value, maxLength)
}

function firstTarget(value) {
  if (typeof value === 'string') return sanitizeSideEffectRecoveryTarget(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  for (const key of [...TARGET_KEYS, 'from', 'to']) {
    if (!Object.hasOwn(value, key)) continue
    const target = sanitizeSideEffectRecoveryTarget(value[key], {
      kind: key.toLowerCase().includes('url') ? 'url' : 'target',
    })
    if (target) return target
  }
  return ''
}

function targetList(...values) {
  const targets = []
  const add = (value) => {
    if (targets.length >= MAX_RECOVERY_EVIDENCE_ITEMS) return
    if (Array.isArray(value)) {
      for (const item of value) add(item)
      return
    }
    const target = firstTarget(value)
    if (target && !targets.includes(target)) targets.push(target)
  }
  for (const value of values) add(value)
  return targets
}

function artifactIdList(outcome) {
  const ids = []
  const add = (value) => {
    if (ids.length >= MAX_RECOVERY_EVIDENCE_ITEMS) return
    if (Array.isArray(value)) {
      for (const item of value) add(item)
      return
    }
    if (value && typeof value === 'object') {
      add(value.artifactId || value.id)
      return
    }
    const id = safeIdentifier(value)
    if (id && !ids.includes(id)) ids.push(id)
  }
  add(outcome?.artifactId)
  add(outcome?.artifactIds)
  add(outcome?.artifacts)
  return ids
}

function safeVerifiedOutput(value) {
  const target = firstTarget(value)
  if (typeof value === 'string') return target ? { target } : null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const artifactId = safeIdentifier(value.artifactId || value.id)
  const receiptId = safeIdentifier(value.receiptId || value.receipt_id)
  const sha256 = /^[a-f0-9]{16,128}$/iu.test(String(value.sha256 || ''))
    ? String(value.sha256).toLowerCase()
    : ''
  const rawSize = value.size ?? value.bytes
  const size = Number.isFinite(Number(rawSize)) && Number(rawSize) >= 0
    ? Number(rawSize)
    : null
  const safe = {
    ...(target ? { target } : {}),
    ...(artifactId ? { artifactId } : {}),
    ...(receiptId ? { receiptId } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(size != null ? { size } : {}),
    ...(typeof value.verified === 'boolean' ? { verified: value.verified } : {}),
  }
  return Object.keys(safe).length > 0 ? safe : null
}

function verifiedOutputList(outcome) {
  const values = [
    ...(Array.isArray(outcome?.verifiedOutputs) ? outcome.verifiedOutputs : []),
    ...(Array.isArray(outcome?.verifiedLocalFiles) ? outcome.verifiedLocalFiles : []),
  ]
  return values
    .slice(0, MAX_RECOVERY_EVIDENCE_ITEMS)
    .map(safeVerifiedOutput)
    .filter(Boolean)
}

function recoveryEvidence(outcome, intent) {
  const safeOutcome = outcome && typeof outcome === 'object' ? outcome : {}
  const intentTargets = Array.isArray(intent?.targets)
    ? intent.targets.map((target) => target?.value)
    : []
  const changedPaths = targetList(
    safeOutcome.changedPaths,
    safeOutcome.changedFiles,
    safeOutcome.changes,
    safeOutcome.renamed,
  )
  const verifiedOutputs = verifiedOutputList(safeOutcome)
  const artifactIds = artifactIdList(safeOutcome)
  const directTargets = TARGET_KEYS.map((key) => safeOutcome[key])
  const targetSummary = targetList(
    intentTargets,
    changedPaths,
    verifiedOutputs,
    safeOutcome.artifacts,
    ...directTargets,
  )
  return { targetSummary, changedPaths, verifiedOutputs, artifactIds }
}

function safeIntentSummary(record) {
  const intent = record?.intent && typeof record.intent === 'object' ? record.intent : {}
  const targets = Array.isArray(intent.targets)
    ? intent.targets.slice(0, MAX_RECOVERY_EVIDENCE_ITEMS).map((target) => {
      const kind = sanitizeRecoveryText(target?.kind, 40) || 'target'
      const value = sanitizeSideEffectRecoveryTarget(target?.value, { kind })
      return value ? { kind, value } : null
    }).filter(Boolean)
    : []
  const command = sanitizeRecoveryText(intent.command, 300)
  return {
    toolName: safeIdentifier(record?.toolName, 200),
    ...(command ? { command } : {}),
    targets,
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
    toolCallId: row.tool_call_id,
    idempotencyKey: row.idempotency_key,
    toolName: row.tool_name,
    argsDigest: row.args_digest,
    intent: decodeOutcome(row.intent_json),
    status: row.status,
    outcome: decodeOutcome(row.outcome_json),
    audit: decodeOutcome(row.audit_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preparedAt: row.prepared_at,
    executingAt: row.executing_at,
    finishedAt: row.finished_at,
  }
}

export function sideEffectRecoveryRecordForClient(record, { includeScopeKey = true } = {}) {
  if (!record) return null
  const intentSummary = safeIntentSummary(record)
  return {
    scopeKind: record.scopeKind,
    ...(includeScopeKey ? { scopeKey: record.scopeKey } : {}),
    sessionId: record.sessionId,
    turnId: record.turnId,
    jobId: record.jobId,
    stepId: record.stepId,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    argsDigest: record.argsDigest,
    status: record.status,
    intentSummary,
    evidence: recoveryEvidence(record.outcome, intentSummary),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    preparedAt: record.preparedAt,
    executingAt: record.executingAt,
    finishedAt: record.finishedAt,
  }
}

export function sideEffectRecoveryHistoryRecordForClient(record) {
  if (!record) return null
  const audit = record.audit && typeof record.audit === 'object' && !Array.isArray(record.audit)
    ? record.audit
    : {}
  const resolution = ['committed', 'failed'].includes(audit.resolution)
    ? audit.resolution
    : record.status
  const confirmedAt = Number.isSafeInteger(audit.confirmedAt) && audit.confirmedAt >= 0
    ? audit.confirmedAt
    : record.finishedAt
  const confirmedBy = safeIdentifier(audit.confirmedBy, 500)
  const note = typeof audit.note === 'string' ? audit.note.slice(0, 2_000) : ''
  return {
    ...sideEffectRecoveryRecordForClient(record, { includeScopeKey: false }),
    audit: {
      resolution,
      confirmedAt,
      ...(confirmedBy ? { confirmedBy } : {}),
      ...(note ? { note } : {}),
    },
  }
}

export function sideEffectResumeDescriptor(record) {
  if (!record) return null
  if (record.scopeKind === 'turn' && record.sessionId && record.turnId && record.toolCallId) {
    return {
      kind: 'turn',
      sessionId: record.sessionId,
      turnId: record.turnId,
      toolCallId: record.toolCallId,
    }
  }
  if (record.scopeKind === 'job' && record.jobId && record.stepId) {
    return { kind: 'job', jobId: record.jobId, stepId: record.stepId }
  }
  return null
}

export function listUnknownSideEffects({
  userId,
  limit = DEFAULT_LIST_LIMIT,
  cursor = null,
  db = getDb(),
} = {}) {
  const ownerId = requiredText(userId, 'userId', 500)
  const boundedLimit = normalizeLimit(limit)
  const after = decodeListCursor(cursor, { kind: 'unknown', ownerId })
  maybePruneSideEffectExecutions({ db })
  const rows = db.prepare(`
    SELECT * FROM side_effect_executions
    WHERE owner_id = ? AND status = 'unknown'
      ${after ? `AND (
        updated_at < ?
        OR (updated_at = ? AND scope_key > ?)
        OR (updated_at = ? AND scope_key = ? AND tool_call_id > ?)
      )` : ''}
    ORDER BY updated_at DESC, scope_key ASC, tool_call_id ASC
    LIMIT ?
  `).all(
    ownerId,
    ...(after ? [
      after.updatedAt,
      after.updatedAt,
      after.scopeKey,
      after.updatedAt,
      after.scopeKey,
      after.toolCallId,
    ] : []),
    boundedLimit + 1,
  )
  const hasMore = rows.length > boundedLimit
  const pageRows = hasMore ? rows.slice(0, boundedLimit) : rows
  return {
    records: pageRows.map(rowToRecord).map(sideEffectRecoveryRecordForClient),
    nextCursor: hasMore
      ? encodeListCursor({ kind: 'unknown', ownerId, row: pageRows.at(-1) })
      : null,
  }
}

export function listSideEffectHistory({
  userId,
  limit = DEFAULT_LIST_LIMIT,
  cursor = null,
  db = getDb(),
} = {}) {
  const ownerId = requiredText(userId, 'userId', 500)
  const boundedLimit = normalizeLimit(limit)
  const after = decodeListCursor(cursor, { kind: 'history', ownerId })
  maybePruneSideEffectExecutions({ db })
  const rows = db.prepare(`
    SELECT * FROM side_effect_executions
    WHERE owner_id = ? AND audit_json IS NOT NULL
      ${after ? `AND (
        updated_at < ?
        OR (updated_at = ? AND scope_key > ?)
        OR (updated_at = ? AND scope_key = ? AND tool_call_id > ?)
      )` : ''}
    ORDER BY updated_at DESC, scope_key ASC, tool_call_id ASC
    LIMIT ?
  `).all(
    ownerId,
    ...(after ? [
      after.updatedAt,
      after.updatedAt,
      after.scopeKey,
      after.updatedAt,
      after.scopeKey,
      after.toolCallId,
    ] : []),
    boundedLimit + 1,
  )
  const hasMore = rows.length > boundedLimit
  const pageRows = hasMore ? rows.slice(0, boundedLimit) : rows
  return {
    records: pageRows.map(rowToRecord).map(sideEffectRecoveryHistoryRecordForClient),
    nextCursor: hasMore
      ? encodeListCursor({ kind: 'history', ownerId, row: pageRows.at(-1) })
      : null,
  }
}

export function resolveUnknownSideEffect({
  userId,
  scopeKey,
  toolCallId,
  verificationConfirmed,
  confirmToolCallId,
  resolution,
  note = null,
  db = getDb(),
  now = Date.now,
} = {}) {
  const ownerId = requiredText(userId, 'userId', 500)
  const normalizedScopeKey = requiredText(scopeKey, 'scopeKey', 1_500)
  const normalizedToolCallId = requiredText(toolCallId, 'toolCallId', 500)
  if (verificationConfirmed !== true) {
    throw recoveryError(
      'SIDE_EFFECT_RECOVERY_VERIFICATION_REQUIRED',
      'verificationConfirmed must be true after verifying the real outcome',
      400,
    )
  }
  if (String(confirmToolCallId || '').trim() !== normalizedToolCallId) {
    throw recoveryError(
      'SIDE_EFFECT_RECOVERY_CONFIRMATION_MISMATCH',
      'confirmToolCallId must exactly match toolCallId',
      400,
    )
  }
  const normalizedResolution = String(resolution || '').trim()
  if (!['committed', 'failed'].includes(normalizedResolution)) {
    throw recoveryError(
      'SIDE_EFFECT_RECOVERY_INVALID',
      'resolution must be committed or failed',
      400,
    )
  }
  const normalizedNote = note == null ? null : String(note).trim()
  if (normalizedNote && normalizedNote.length > 2_000) {
    throw recoveryError('SIDE_EFFECT_RECOVERY_INVALID', 'note is too long', 400)
  }
  const confirmedAt = Number(now()) || Date.now()
  const committed = normalizedResolution === 'committed'
  maybePruneSideEffectExecutions({ db, now: confirmedAt })
  const existingRecord = db.prepare(`
    SELECT status, outcome_json FROM side_effect_executions
    WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ?
  `).get(ownerId, normalizedScopeKey, normalizedToolCallId)
  if (!existingRecord) {
    throw recoveryError(
      'SIDE_EFFECT_RECOVERY_NOT_FOUND',
      'side-effect recovery record was not found',
      404,
    )
  }
  if (existingRecord.status !== 'unknown') {
    throw recoveryError(
      'SIDE_EFFECT_RECOVERY_CONFLICT',
      `side-effect recovery record is already ${existingRecord.status}`,
      409,
    )
  }
  const recoveryOutcome = recoverableSideEffectOutcomeFields(
    decodeOutcome(existingRecord.outcome_json),
  )
  const outcome = {
    ...(recoveryOutcome || {}),
    ok: committed,
    code: committed
      ? 'SIDE_EFFECT_USER_CONFIRMED_COMMITTED'
      : 'SIDE_EFFECT_USER_CONFIRMED_FAILED',
    userConfirmed: true,
  }
  const audit = {
    action: 'resolve_unknown_side_effect',
    resolution: normalizedResolution,
    confirmedAt,
    confirmedBy: ownerId,
    ...(normalizedNote ? { note: normalizedNote } : {}),
  }

  const updated = db.prepare(`
    UPDATE side_effect_executions
    SET status = ?, outcome_json = ?, audit_json = ?, updated_at = ?, finished_at = ?
    WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ? AND status = 'unknown'
  `).run(
    normalizedResolution,
    encodeSideEffectOutcome(outcome),
    JSON.stringify(audit),
    confirmedAt,
    confirmedAt,
    ownerId,
    normalizedScopeKey,
    normalizedToolCallId,
  )

  if (updated.changes !== 1) {
    const existing = db.prepare(`
      SELECT status FROM side_effect_executions
      WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ?
    `).get(ownerId, normalizedScopeKey, normalizedToolCallId)
    if (!existing) {
      throw recoveryError(
        'SIDE_EFFECT_RECOVERY_NOT_FOUND',
        'side-effect recovery record was not found',
        404,
      )
    }
    throw recoveryError(
      'SIDE_EFFECT_RECOVERY_CONFLICT',
      `side-effect recovery record is already ${existing.status}`,
      409,
    )
  }

  return rowToRecord(db.prepare(`
    SELECT * FROM side_effect_executions
    WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ?
  `).get(ownerId, normalizedScopeKey, normalizedToolCallId))
}
