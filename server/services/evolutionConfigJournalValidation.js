import path from 'node:path'

import {
  configSha256,
  normalizeRuntimeConfigDocument,
} from './evolutionConfigPolicy.js'

const SHA256_RE = /^[a-f0-9]{64}$/u
const OPERATIONS = new Set(['apply', 'rollback', 'revoke'])
export const EVOLUTION_CONFIG_JOURNAL_VERSION = 1
export const MAX_EVOLUTION_CONFIG_DOCUMENT_BYTES = 64 * 1024

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

export function evolutionConfigJournalError(code, message, statusCode = 409, cause) {
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

export function isEvolutionConfigJournalHash(value) {
  return typeof value === 'string' && SHA256_RE.test(value)
}

function validateDocument(content, expectedHash) {
  if (typeof content !== 'string'
    || Buffer.byteLength(content, 'utf8') > MAX_EVOLUTION_CONFIG_DOCUMENT_BYTES) return false
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

export function normalizeEvolutionConfigJournalEvent(value) {
  if (!hasExactKeys(value, EVENT_KEYS)
    || !requiredString(value.id, 200)
    || !requiredString(value.userId, 200)
    || !requiredString(value.approvalId, 200)
    || !requiredString(value.candidateId, 200)
    || !(value.rootApplyId === null || requiredString(value.rootApplyId, 200))
    || !OPERATIONS.has(value.operation)
    || !requiredString(value.reason)
    || !isEvolutionConfigJournalHash(value.beforeDocumentSha256)
    || !isEvolutionConfigJournalHash(value.afterDocumentSha256)
    || !isEvolutionConfigJournalHash(value.expectedCurrentSha256)
    || !isEvolutionConfigJournalHash(value.confirmationSha256)
    || !isEvolutionConfigJournalHash(value.eventFingerprint)
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < 0
    || !validateDocument(value.beforeDocumentJson, value.beforeDocumentSha256)
    || !validateDocument(value.afterDocumentJson, value.afterDocumentSha256)
    || (value.operation === 'apply' ? value.rootApplyId !== null : value.rootApplyId === null)
    || eventFingerprint(value) !== value.eventFingerprint) {
    throw evolutionConfigJournalError(
      'EVOLUTION_CONFIG_JOURNAL_INVALID',
      'pending config change journal is invalid',
    )
  }
  return Object.freeze(Object.fromEntries(EVENT_KEYS.map((key) => [key, value[key]])))
}

export function normalizeEvolutionConfigJournal(value, expectedTargetPath = null) {
  if (!hasExactKeys(value, JOURNAL_KEYS)
    || value.schemaVersion !== EVOLUTION_CONFIG_JOURNAL_VERSION
    || value.state !== 'pending'
    || !requiredString(value.journalId, 200)
    || !requiredString(value.targetPath, 4_096)
    || !path.isAbsolute(value.targetPath)
    || !isEvolutionConfigJournalHash(value.reviewFingerprint)
    || !isEvolutionConfigJournalHash(value.journalFingerprint)) {
    throw evolutionConfigJournalError(
      'EVOLUTION_CONFIG_JOURNAL_INVALID',
      'pending config change journal is invalid',
    )
  }
  const event = normalizeEvolutionConfigJournalEvent(value.event)
  const targetPath = path.resolve(value.targetPath)
  if (expectedTargetPath && targetPath !== path.resolve(expectedTargetPath)) {
    throw evolutionConfigJournalError(
      'EVOLUTION_CONFIG_JOURNAL_CONFLICT',
      'pending config change target does not match',
    )
  }
  const normalized = {
    schemaVersion: EVOLUTION_CONFIG_JOURNAL_VERSION,
    state: 'pending',
    journalId: value.journalId,
    targetPath,
    reviewFingerprint: value.reviewFingerprint,
    event,
  }
  if (configSha256(normalized) !== value.journalFingerprint) {
    throw evolutionConfigJournalError(
      'EVOLUTION_CONFIG_JOURNAL_INVALID',
      'pending config change journal is invalid',
    )
  }
  return Object.freeze({ ...normalized, journalFingerprint: value.journalFingerprint })
}
