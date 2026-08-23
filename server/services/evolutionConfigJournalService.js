import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { getDb } from '../db.js'
import { resolveRuntimeConfigPaths } from '../utils/runtimeEnv.js'
import {
  configSha256,
  normalizeEvolutionConfigPatch,
  normalizeRuntimeConfigDocument,
} from './evolutionConfigPolicy.js'
import {
  activateEvolutionRuntimeEnv,
  atomicWriteEvolutionRuntimeConfig,
  EMPTY_RUNTIME_CONFIG,
} from './evolutionConfigRuntime.js'

const SHA256_RE = /^[a-f0-9]{64}$/u
const OPERATIONS = new Set(['apply', 'rollback', 'revoke'])
const JOURNAL_VERSION = 1
const MAX_DOCUMENT_BYTES = 64 * 1024
const MAX_JOURNAL_BYTES = 512 * 1024
const JOURNAL_KEYS = [
  'schemaVersion',
  'state',
  'journalId',
  'targetPath',
  'reviewFingerprint',
  'event',
  'journalFingerprint',
]
const EVENT_KEYS = [
  'id',
  'userId',
  'approvalId',
  'candidateId',
  'rootApplyId',
  'operation',
  'beforeDocumentJson',
  'afterDocumentJson',
  'beforeDocumentSha256',
  'afterDocumentSha256',
  'expectedCurrentSha256',
  'reason',
  'confirmationSha256',
  'eventFingerprint',
  'createdAt',
]

function journalError(code, message, statusCode = 409, cause) {
  return Object.assign(new Error(message), { code, statusCode, ...(cause ? { cause } : {}) })
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function requiredString(value, maximum = 2_000) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function validHash(value) {
  return typeof value === 'string' && SHA256_RE.test(value)
}

function validateDocument(content, expectedHash) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) return false
  if (configSha256(content) !== expectedHash) return false
  try {
    normalizeRuntimeConfigDocument(content)
    return true
  } catch {
    return false
  }
}

function eventFingerprint(event) {
  if (event.operation === 'apply') {
    return configSha256({
      operation: event.operation,
      approvalId: event.approvalId,
      candidateId: event.candidateId,
      beforeDocumentSha256: event.beforeDocumentSha256,
      afterDocumentSha256: event.afterDocumentSha256,
      reason: event.reason,
      confirmationSha256: event.confirmationSha256,
      createdAt: event.createdAt,
    })
  }
  return configSha256({
    operation: event.operation,
    applyId: event.rootApplyId,
    beforeDocumentSha256: event.beforeDocumentSha256,
    afterDocumentSha256: event.afterDocumentSha256,
    reason: event.reason,
    confirmationSha256: event.confirmationSha256,
    createdAt: event.createdAt,
  })
}

function normalizeEvent(value) {
  if (!hasExactKeys(value, EVENT_KEYS)
    || !requiredString(value.id, 200)
    || !requiredString(value.userId, 200)
    || !requiredString(value.approvalId, 200)
    || !requiredString(value.candidateId, 200)
    || !(value.rootApplyId === null || requiredString(value.rootApplyId, 200))
    || !OPERATIONS.has(value.operation)
    || !requiredString(value.reason)
    || !validHash(value.beforeDocumentSha256)
    || !validHash(value.afterDocumentSha256)
    || !validHash(value.expectedCurrentSha256)
    || !validHash(value.confirmationSha256)
    || !validHash(value.eventFingerprint)
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < 0
    || !validateDocument(value.beforeDocumentJson, value.beforeDocumentSha256)
    || !validateDocument(value.afterDocumentJson, value.afterDocumentSha256)
    || (value.operation === 'apply' ? value.rootApplyId !== null : value.rootApplyId === null)
    || eventFingerprint(value) !== value.eventFingerprint) {
    throw journalError('EVOLUTION_CONFIG_JOURNAL_INVALID', 'pending config change journal is invalid')
  }
  return Object.freeze(Object.fromEntries(EVENT_KEYS.map((key) => [key, value[key]])))
}

function normalizeJournal(value, expectedTargetPath = null) {
  if (!hasExactKeys(value, JOURNAL_KEYS)
    || value.schemaVersion !== JOURNAL_VERSION
    || value.state !== 'pending'
    || !requiredString(value.journalId, 200)
    || !requiredString(value.targetPath, 4_096)
    || !path.isAbsolute(value.targetPath)
    || !validHash(value.reviewFingerprint)
    || !validHash(value.journalFingerprint)) {
    throw journalError('EVOLUTION_CONFIG_JOURNAL_INVALID', 'pending config change journal is invalid')
  }
  const event = normalizeEvent(value.event)
  const targetPath = path.resolve(value.targetPath)
  if (expectedTargetPath && targetPath !== path.resolve(expectedTargetPath)) {
    throw journalError('EVOLUTION_CONFIG_JOURNAL_CONFLICT', 'pending config change target does not match')
  }
  const normalized = {
    schemaVersion: JOURNAL_VERSION,
    state: 'pending',
    journalId: value.journalId,
    targetPath,
    reviewFingerprint: value.reviewFingerprint,
    event,
  }
  if (configSha256(normalized) !== value.journalFingerprint) {
    throw journalError('EVOLUTION_CONFIG_JOURNAL_INVALID', 'pending config change journal is invalid')
  }
  return Object.freeze({ ...normalized, journalFingerprint: value.journalFingerprint })
}

function fsyncDirectory(directory) {
  let descriptor
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } catch (error) {
    if (process.platform !== 'win32'
      && !['EINVAL', 'EPERM', 'EISDIR', 'EBADF', 'ENOTSUP'].includes(error?.code)) throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function journalPathForTarget(targetPath) {
  const resolved = path.resolve(targetPath)
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.evolution-config.pending.json`)
}

export function evolutionConfigJournalPath({ cwd = process.cwd(), env = process.env } = {}) {
  return journalPathForTarget(resolveRuntimeConfigPaths({ cwd, env }).user)
}

export function createEvolutionConfigJournal({ targetPath, reviewFingerprint, event } = {}) {
  const normalizedEvent = normalizeEvent(event)
  if (!validHash(reviewFingerprint)) {
    throw journalError('EVOLUTION_CONFIG_JOURNAL_INVALID', 'pending config change journal is invalid')
  }
  const payload = {
    schemaVersion: JOURNAL_VERSION,
    state: 'pending',
    journalId: randomUUID(),
    targetPath: path.resolve(targetPath),
    reviewFingerprint,
    event: normalizedEvent,
  }
  return Object.freeze({ ...payload, journalFingerprint: configSha256(payload) })
}

function durableTempFile(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, content, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    return tempPath
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* best effort */ }
    }
    try { fs.unlinkSync(tempPath) } catch { /* best effort */ }
    throw error
  }
}

export function persistEvolutionConfigJournal(value) {
  const journal = normalizeJournal(value, value?.targetPath)
  const journalPath = journalPathForTarget(journal.targetPath)
  const directory = path.dirname(journalPath)
  fs.mkdirSync(directory, { recursive: true })
  const content = `${JSON.stringify(journal, null, 2)}\n`
  let tempPath
  try {
    tempPath = durableTempFile(journalPath, content)
    fs.linkSync(tempPath, journalPath)
    fs.unlinkSync(tempPath)
    tempPath = null
    fsyncDirectory(directory)
    return journal
  } catch (error) {
    if (tempPath) {
      try { fs.unlinkSync(tempPath) } catch { /* best effort */ }
    }
    if (error?.code === 'EEXIST') {
      throw journalError('EVOLUTION_CONFIG_JOURNAL_BUSY', 'another config change is pending', 409)
    }
    throw journalError('EVOLUTION_CONFIG_JOURNAL_IO_FAILED', 'could not persist config change journal', 500, error)
  }
}

function readJournalAtPath(journalPath, targetPath, { missingAsNull = false } = {}) {
  let stat
  try {
    stat = fs.lstatSync(journalPath)
  } catch (error) {
    if (error?.code === 'ENOENT' && missingAsNull) return null
    throw journalError('EVOLUTION_CONFIG_JOURNAL_IO_FAILED', 'could not read config change journal', 500, error)
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOURNAL_BYTES) {
    throw journalError('EVOLUTION_CONFIG_JOURNAL_INVALID', 'pending config change journal is invalid')
  }
  try {
    const content = fs.readFileSync(journalPath, 'utf8')
    return normalizeJournal(JSON.parse(content), targetPath)
  } catch (error) {
    if (error?.code?.startsWith('EVOLUTION_CONFIG_')) throw error
    throw journalError('EVOLUTION_CONFIG_JOURNAL_INVALID', 'pending config change journal is invalid', 409, error)
  }
}

function readJournalForTarget(targetPath) {
  return readJournalAtPath(journalPathForTarget(targetPath), targetPath, { missingAsNull: true })
}

function restoreClaimedJournal({ claimPath, journalPath, cause }) {
  try {
    fs.linkSync(claimPath, journalPath)
    fs.unlinkSync(claimPath)
    fsyncDirectory(path.dirname(journalPath))
    return null
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return journalError(
        'EVOLUTION_CONFIG_JOURNAL_CONFLICT',
        'pending config change journal changed while it was being finalized',
        409,
        cause,
      )
    }
    throw journalError(
      'EVOLUTION_CONFIG_JOURNAL_IO_FAILED',
      'could not restore claimed config change journal',
      500,
      error,
    )
  }
}

function clearJournal(journal) {
  const journalPath = journalPathForTarget(journal.targetPath)
  const claimPath = `${journalPath}.${process.pid}.${randomUUID()}.clearing`
  try {
    fs.renameSync(journalPath, claimPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw journalError('EVOLUTION_CONFIG_JOURNAL_IO_FAILED', 'could not claim config change journal', 500, error)
  }

  let claimed
  try {
    claimed = readJournalAtPath(claimPath, journal.targetPath)
  } catch (error) {
    const restoreError = restoreClaimedJournal({
      claimPath,
      journalPath,
      cause: error,
    })
    if (restoreError) {
      restoreError.recoveryPath = claimPath
      throw restoreError
    }
    throw error
  }
  if (claimed.journalFingerprint !== journal.journalFingerprint) {
    const conflict = journalError(
      'EVOLUTION_CONFIG_JOURNAL_CONFLICT',
      'pending config change journal changed',
    )
    const restoreError = restoreClaimedJournal({
      claimPath,
      journalPath,
      cause: conflict,
    })
    if (restoreError) {
      restoreError.recoveryPath = claimPath
      throw restoreError
    }
    throw conflict
  }
  try {
    fs.unlinkSync(claimPath)
    fsyncDirectory(path.dirname(journalPath))
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw journalError('EVOLUTION_CONFIG_JOURNAL_IO_FAILED', 'could not finalize config change journal', 500, error)
  }
}

function readTargetContent(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) return EMPTY_RUNTIME_CONFIG
    const stat = fs.lstatSync(targetPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DOCUMENT_BYTES) {
      throw journalError('EVOLUTION_CONFIG_JOURNAL_CONFLICT', 'runtime config conflicts with pending change')
    }
    return fs.readFileSync(targetPath, 'utf8')
  } catch (error) {
    if (error?.code?.startsWith('EVOLUTION_CONFIG_')) throw error
    throw journalError('EVOLUTION_CONFIG_JOURNAL_CONFLICT', 'runtime config conflicts with pending change', 409, error)
  }
}

function expectedApplyConfirmation(approval, replay, candidate) {
  const confirmations = {
    candidateContentSha256: candidate.content_sha256,
    replayRunFingerprint: replay.run_fingerprint,
    evaluationFingerprint: approval.evaluation_fingerprint,
    approvalDecisionFingerprint: approval.decision_fingerprint,
    baselineDocumentSha256: replay.baseline_document_sha256,
    proposedDocumentSha256: replay.proposed_document_sha256,
    baselineEffectiveSha256: replay.baseline_effective_sha256,
  }
  return configSha256({ operation: 'apply', approvalId: approval.id, confirmations })
}

function validateApplyProvenance(journal) {
  const event = journal.event
  const db = getDb()
  const approval = db.prepare(`
    SELECT * FROM evolution_config_approval_decisions WHERE id = ? AND user_id = ?
  `).get(event.approvalId, event.userId)
  const replay = approval && db.prepare(`
    SELECT * FROM evolution_config_replays WHERE id = ? AND user_id = ?
  `).get(approval.replay_id, event.userId)
  const candidate = db.prepare(`
    SELECT * FROM evolution_candidates WHERE id = ? AND user_id = ?
  `).get(event.candidateId, event.userId)
  if (!approval || !replay || !candidate
    || approval.decision !== 'approved'
    || approval.candidate_id !== event.candidateId
    || replay.candidate_id !== event.candidateId
    || candidate.kind !== 'config'
    || candidate.target !== 'config:runtime'
    || candidate.content_sha256 !== approval.candidate_sha256
    || approval.decision_fingerprint !== journal.reviewFingerprint
    || replay.baseline_document_json !== event.beforeDocumentJson
    || replay.proposed_document_json !== event.afterDocumentJson
    || replay.baseline_document_sha256 !== event.beforeDocumentSha256
    || replay.proposed_document_sha256 !== event.afterDocumentSha256
    || event.expectedCurrentSha256 !== event.beforeDocumentSha256
    || expectedApplyConfirmation(approval, replay, candidate) !== event.confirmationSha256) {
    throw journalError('EVOLUTION_CONFIG_JOURNAL_PROVENANCE_INVALID', 'pending config change provenance is invalid')
  }
  return candidate
}

function validateReversalProvenance(journal) {
  const event = journal.event
  const db = getDb()
  const apply = db.prepare(`
    SELECT * FROM evolution_config_change_events
    WHERE id = ? AND user_id = ? AND operation = 'apply'
  `).get(event.rootApplyId, event.userId)
  const candidate = db.prepare(`
    SELECT * FROM evolution_candidates WHERE id = ? AND user_id = ?
  `).get(event.candidateId, event.userId)
  const expectedConfirmation = apply && configSha256({
    operation: event.operation,
    applyId: apply.id,
    applyEventFingerprint: apply.event_fingerprint,
    expectedCurrentSha256: apply.after_document_sha256,
  })
  const restoredContent = (() => {
    try {
      if (!apply) return null
      normalizeRuntimeConfigDocument(apply.before_document_json)
      return apply.before_document_json
    } catch { return null }
  })()
  if (!apply || !candidate
    || candidate.kind !== 'config'
    || candidate.target !== 'config:runtime'
    || apply.approval_id !== event.approvalId
    || apply.candidate_id !== event.candidateId
    || apply.event_fingerprint !== journal.reviewFingerprint
    || apply.after_document_json !== event.beforeDocumentJson
    || restoredContent !== event.afterDocumentJson
    || apply.after_document_sha256 !== event.beforeDocumentSha256
    || configSha256(restoredContent || '') !== event.afterDocumentSha256
    || event.expectedCurrentSha256 !== apply.after_document_sha256
    || expectedConfirmation !== event.confirmationSha256) {
    throw journalError('EVOLUTION_CONFIG_JOURNAL_PROVENANCE_INVALID', 'pending config change provenance is invalid')
  }
  return candidate
}

function validateProvenance(journal) {
  return journal.event.operation === 'apply'
    ? validateApplyProvenance(journal)
    : validateReversalProvenance(journal)
}

function rowMatchesEvent(row, event) {
  return Boolean(row)
    && row.id === event.id
    && row.user_id === event.userId
    && row.approval_id === event.approvalId
    && row.candidate_id === event.candidateId
    && (row.root_apply_id || null) === event.rootApplyId
    && row.operation === event.operation
    && row.before_document_json === event.beforeDocumentJson
    && row.after_document_json === event.afterDocumentJson
    && row.before_document_sha256 === event.beforeDocumentSha256
    && row.after_document_sha256 === event.afterDocumentSha256
    && row.expected_current_sha256 === event.expectedCurrentSha256
    && row.reason === event.reason
    && row.confirmation_sha256 === event.confirmationSha256
    && row.event_fingerprint === event.eventFingerprint
    && row.created_at === event.createdAt
}

function existingEvent(journal) {
  return getDb().prepare(`
    SELECT * FROM evolution_config_change_events WHERE id = ? AND user_id = ?
  `).get(journal.event.id, journal.event.userId)
}

function logicalExistingEvent(journal) {
  const event = journal.event
  if (event.operation === 'apply') {
    return getDb().prepare(`
      SELECT * FROM evolution_config_change_events
      WHERE user_id = ? AND approval_id = ? AND operation = 'apply'
    `).get(event.userId, event.approvalId)
  }
  return getDb().prepare(`
    SELECT * FROM evolution_config_change_events
    WHERE user_id = ? AND root_apply_id = ? AND operation IN ('rollback', 'revoke')
  `).get(event.userId, event.rootApplyId)
}

function ensureNoConflictingAudit(journal) {
  const exact = existingEvent(journal)
  if (exact && !rowMatchesEvent(exact, journal.event)) {
    throw journalError('EVOLUTION_CONFIG_JOURNAL_CONFLICT', 'pending config change conflicts with its audit')
  }
  const logical = logicalExistingEvent(journal)
  if (logical && !rowMatchesEvent(logical, journal.event)) {
    throw journalError('EVOLUTION_CONFIG_JOURNAL_CONFLICT', 'pending config change conflicts with another audit')
  }
  return exact || logical || null
}

export function commitEvolutionConfigJournalAudit(journalValue) {
  const journal = normalizeJournal(journalValue, journalValue?.targetPath)
  const transaction = getDb().transaction(() => {
    validateProvenance(journal)
    const prior = ensureNoConflictingAudit(journal)
    if (prior) return { inserted: false, row: prior }
    if (configSha256(readTargetContent(journal.targetPath)) !== journal.event.afterDocumentSha256) {
      throw journalError('EVOLUTION_CONFIG_JOURNAL_CONFLICT', 'runtime config conflicts with pending change')
    }
    const event = journal.event
    getDb().prepare(`
      INSERT INTO evolution_config_change_events (
        id, user_id, approval_id, candidate_id, root_apply_id, operation,
        before_document_json, after_document_json,
        before_document_sha256, after_document_sha256, expected_current_sha256,
        reason, confirmation_sha256, event_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.userId,
      event.approvalId,
      event.candidateId,
      event.rootApplyId,
      event.operation,
      event.beforeDocumentJson,
      event.afterDocumentJson,
      event.beforeDocumentSha256,
      event.afterDocumentSha256,
      event.expectedCurrentSha256,
      event.reason,
      event.confirmationSha256,
      event.eventFingerprint,
      event.createdAt,
    )
    if (configSha256(readTargetContent(journal.targetPath)) !== journal.event.afterDocumentSha256) {
      throw journalError('EVOLUTION_CONFIG_JOURNAL_CONFLICT', 'runtime config conflicts with pending change')
    }
    return { inserted: true, row: existingEvent(journal) }
  })
  try {
    return transaction()
  } catch (error) {
    if (/UNIQUE constraint failed/iu.test(String(error?.message || ''))) {
      const prior = ensureNoConflictingAudit(journal)
      if (prior) return { inserted: false, row: prior }
    }
    throw error
  }
}

export function finalizeEvolutionConfigJournal(journalValue) {
  const journal = normalizeJournal(journalValue, journalValue?.targetPath)
  const existing = ensureNoConflictingAudit(journal)
  if (!existing || !rowMatchesEvent(existing, journal.event)) {
    throw journalError('EVOLUTION_CONFIG_JOURNAL_CONFLICT', 'config change audit is not committed')
  }
  clearJournal(journal)
}

export function abortEvolutionConfigJournal(journalValue) {
  const journal = normalizeJournal(journalValue, journalValue?.targetPath)
  validateProvenance(journal)
  if (ensureNoConflictingAudit(journal)) {
    throw journalError('EVOLUTION_CONFIG_JOURNAL_CONFLICT', 'committed config change cannot be aborted')
  }
  if (configSha256(readTargetContent(journal.targetPath)) !== journal.event.beforeDocumentSha256) {
    throw journalError('EVOLUTION_CONFIG_JOURNAL_CONFLICT', 'runtime config conflicts with pending change')
  }
  clearJournal(journal)
}

function invokeCrashInjector(injector, stage, event) {
  if (typeof injector === 'function') {
    injector(stage, Object.freeze({ eventId: event.id, operation: event.operation }))
  }
}

export function executeEvolutionConfigJournalChange({ journal, activate, crashInjector } = {}) {
  persistEvolutionConfigJournal(journal)
  invokeCrashInjector(crashInjector, 'after_journal_persisted', journal.event)
  let write
  try {
    write = atomicWriteEvolutionRuntimeConfig({
      filePath: journal.targetPath,
      content: journal.event.afterDocumentJson,
      expectedSha256: journal.event.beforeDocumentSha256,
      activate,
    })
  } catch (error) {
    try { abortEvolutionConfigJournal(journal) } catch (recoveryError) {
      error.journalRecoveryFailed = true
      error.journalRecoveryError = recoveryError
    }
    throw error
  }
  if (write.beforeSha256 !== journal.event.beforeDocumentSha256
    || write.afterSha256 !== journal.event.afterDocumentSha256) {
    throw journalError(
      'EVOLUTION_CONFIG_JOURNAL_CONFLICT',
      'runtime config write does not match the pending change',
    )
  }
  invokeCrashInjector(crashInjector, 'after_config_replaced', journal.event)
  commitEvolutionConfigJournalAudit(journal)
  invokeCrashInjector(crashInjector, 'after_audit_committed', journal.event)
  finalizeEvolutionConfigJournal(journal)
  return journal.event.id
}

export function reconcileEvolutionConfigJournal({
  userId = null,
  cwd = process.cwd(),
  env = process.env,
  activate,
} = {}) {
  const targetPath = resolveRuntimeConfigPaths({ cwd, env }).user
  const journal = readJournalForTarget(targetPath)
  if (!journal) return Object.freeze({ status: 'none' })
  if (userId != null && String(userId).trim() !== journal.event.userId) {
    throw journalError('EVOLUTION_CONFIG_JOURNAL_OWNER_MISMATCH', 'pending config change belongs to another owner', 403)
  }
  const candidate = validateProvenance(journal)
  const audit = ensureNoConflictingAudit(journal)
  const currentSha256 = configSha256(readTargetContent(targetPath))
  if (currentSha256 === journal.event.beforeDocumentSha256) {
    if (audit) {
      throw journalError('EVOLUTION_CONFIG_JOURNAL_CONFLICT', 'committed audit conflicts with runtime config')
    }
    clearJournal(journal)
    return Object.freeze({ status: 'aborted', operation: journal.event.operation })
  }
  if (currentSha256 !== journal.event.afterDocumentSha256) {
    throw journalError('EVOLUTION_CONFIG_JOURNAL_CONFLICT', 'runtime config conflicts with pending change')
  }
  const keys = Object.keys(normalizeEvolutionConfigPatch(candidate.content).env)
  const nextEnv = normalizeRuntimeConfigDocument(journal.event.afterDocumentJson).document.env
  if (typeof activate === 'function') activate(nextEnv, keys)
  else activateEvolutionRuntimeEnv(nextEnv, keys)
  const committed = commitEvolutionConfigJournalAudit(journal)
  finalizeEvolutionConfigJournal(journal)
  return Object.freeze({
    status: committed.inserted ? 'recovered' : 'committed',
    operation: journal.event.operation,
  })
}
