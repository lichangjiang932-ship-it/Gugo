import crypto from 'node:crypto'
import path from 'node:path'

import {
  resolveCompactionArchiveStorage,
  resolveCompactionArchiveUserStorage,
} from './compactionArchiveStore.js'

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const ACTIVE_STATES = new Set(['staging', 'staged', 'committing', 'rolling_back'])
const ALL_STATES = new Set([...ACTIVE_STATES, 'committed', 'rolled_back'])
const TERMINAL_STATES = new Set(['committed', 'rolled_back'])

export function compactionGovernanceError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  error.statusCode = 409
  error.retryable = false
  return error
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function terminalReceiptDigest(receipt) {
  return sha256(JSON.stringify({
    version: receipt.version,
    userId: receipt.userId,
    operationId: receipt.operationId,
    stageToken: receipt.stageToken,
    digest: receipt.digest,
    state: receipt.state,
    completedAt: receipt.completedAt,
  }))
}

export function createCompactionGovernanceTerminalReceipt(manifest, state, completedAt) {
  const receipt = {
    version: 1,
    userId: manifest.userId,
    operationId: manifest.operationId,
    stageToken: manifest.stageToken,
    digest: manifest.digest,
    state,
    completedAt: Math.max(manifest.createdAt, completedAt),
  }
  return Object.freeze({
    ...receipt,
    receiptDigest: terminalReceiptDigest(receipt),
  })
}

export function compactionGovernancePayloadName({ userId, id, storagePath }) {
  return `${sha256(`${userId}\0${id}\0${storagePath}`)}.json`
}

export function isActiveCompactionGovernanceState(state) {
  return ACTIVE_STATES.has(state)
}

function assertPlainObject(value, message) {
  const prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : null
  if (!value || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) {
    throw compactionGovernanceError('COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID', message)
  }
}

function assertExactFields(value, fields, message) {
  const expected = new Set(fields)
  if (Object.keys(value).some((field) => !expected.has(field))) {
    throw compactionGovernanceError('COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID', message)
  }
}

function assertIdentity(value, message) {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw compactionGovernanceError('COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID', message)
  }
}

function assertCount(value, message) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw compactionGovernanceError('COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID', message)
  }
}

function validateScope(scope) {
  assertPlainObject(scope, 'The compaction archive deletion scope is invalid')
  if (scope.kind === 'user') {
    assertExactFields(scope, ['kind'], 'The compaction archive deletion user scope is invalid')
    return
  }
  if (scope.kind === 'session') {
    assertExactFields(
      scope,
      ['kind', 'sessionId'],
      'The compaction archive deletion session scope is invalid',
    )
    assertIdentity(scope.sessionId, 'The compaction archive deletion session is invalid')
    return
  }
  throw compactionGovernanceError(
    'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
    'The compaction archive deletion scope is invalid',
  )
}

function resolveManifestStorage({ manifest, id, storagePath, message }) {
  try {
    resolveCompactionArchiveStorage({
      userId: manifest.userId,
      id,
      storagePath,
      env: manifest.env,
    })
  } catch (cause) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      message,
      cause,
    )
  }
}

function resolveManifestOrphanStorage({ manifest, storagePath, message }) {
  try {
    const owner = resolveCompactionArchiveUserStorage({
      userId: manifest.userId,
      env: manifest.env,
    })
    const fileName = path.posix.basename(storagePath)
    const expected = path.posix.join('v1', owner.bucket, fileName)
    const fullPath = path.resolve(owner.root, ...storagePath.split('/'))
    if (storagePath !== expected
      || storagePath.includes('\\')
      || !fileName
      || fileName === '.'
      || fileName === '..'
      || path.dirname(fullPath) !== path.resolve(owner.bucketPath)) {
      throw new Error('Unsafe orphan storage path')
    }
  } catch (cause) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      message,
      cause,
    )
  }
}

function validateRecord(record, manifest) {
  assertPlainObject(record, 'A compaction archive deletion record is invalid')
  assertExactFields(
    record,
    ['id', 'sessionId', 'storagePath', 'sizeBytes', 'sha256'],
    'A compaction archive deletion record has unsupported fields',
  )
  assertIdentity(record.id, 'A compaction archive deletion record id is invalid')
  assertIdentity(record.sessionId, 'A compaction archive deletion session id is invalid')
  const legacy = record.storagePath === null
    && record.sizeBytes === null
    && record.sha256 === null
  if (legacy) return
  assertIdentity(record.storagePath, 'A compaction archive deletion storage path is invalid')
  assertCount(record.sizeBytes, 'A compaction archive deletion size is invalid')
  if (typeof record.sha256 !== 'string' || !SHA256_PATTERN.test(record.sha256)) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'A compaction archive deletion digest is invalid',
    )
  }
  resolveManifestStorage({
    manifest,
    id: record.id,
    storagePath: record.storagePath,
    message: 'A compaction archive deletion record escaped managed storage',
  })
}

function validateOrphanFile(file, manifest) {
  assertExactFields(
    file,
    ['kind', 'storagePath', 'payloadName', 'sizeBytes', 'sha256'],
    'A compaction archive orphan has unsupported fields',
  )
  if (manifest.scope.kind !== 'user') {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'A session deletion cannot contain owner bucket orphans',
    )
  }
  assertIdentity(file.storagePath, 'A compaction archive orphan path is invalid')
  assertIdentity(file.payloadName, 'A compaction archive orphan payload name is invalid')
  assertCount(file.sizeBytes, 'A compaction archive orphan size is invalid')
  if (!SHA256_PATTERN.test(String(file.sha256 || ''))) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'A compaction archive orphan digest is invalid',
    )
  }
  const expectedPayload = compactionGovernancePayloadName({
    userId: manifest.userId,
    id: 'orphan',
    storagePath: file.storagePath,
  })
  if (file.payloadName !== expectedPayload || path.basename(file.payloadName) !== file.payloadName) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'A compaction archive orphan payload path is invalid',
    )
  }
  resolveManifestOrphanStorage({
    manifest,
    storagePath: file.storagePath,
    message: 'A compaction archive orphan escaped managed storage',
  })
}

function validateFile(file, manifest, records) {
  assertPlainObject(file, 'A compaction archive deletion file is invalid')
  if (file.kind === 'orphan') {
    validateOrphanFile(file, manifest)
    return
  }
  assertExactFields(
    file,
    ['id', 'storagePath', 'payloadName', 'sizeBytes', 'sha256'],
    'A compaction archive deletion file has unsupported fields',
  )
  assertIdentity(file.id, 'A compaction archive deletion file id is invalid')
  assertIdentity(file.storagePath, 'A compaction archive deletion file path is invalid')
  assertIdentity(file.payloadName, 'A compaction archive deletion payload name is invalid')
  assertCount(file.sizeBytes, 'A compaction archive deletion file size is invalid')
  if (!SHA256_PATTERN.test(String(file.sha256 || ''))) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'A compaction archive deletion file digest is invalid',
    )
  }
  const expectedPayload = compactionGovernancePayloadName({
    userId: manifest.userId,
    id: file.id,
    storagePath: file.storagePath,
  })
  if (file.payloadName !== expectedPayload
    || path.isAbsolute(file.storagePath)
    || path.win32.isAbsolute(file.storagePath)
    || path.basename(file.payloadName) !== file.payloadName) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'A compaction archive deletion file path is not logical managed storage',
    )
  }
  const record = records.get(file.id)
  if (!record
    || record.storagePath !== file.storagePath
    || record.sizeBytes !== file.sizeBytes
    || record.sha256 !== file.sha256) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'A compaction archive deletion file does not match its record',
    )
  }
  resolveManifestStorage({
    manifest,
    id: file.id,
    storagePath: file.storagePath,
    message: 'A compaction archive deletion file escaped managed storage',
  })
}

function validateTerminalReceipt(receipt, manifest) {
  if (receipt === undefined || receipt === null) return false
  assertPlainObject(receipt, 'The compaction archive terminal receipt is invalid')
  assertExactFields(receipt, [
    'version',
    'userId',
    'operationId',
    'stageToken',
    'digest',
    'state',
    'completedAt',
    'receiptDigest',
  ], 'The compaction archive terminal receipt has unsupported fields')
  if (receipt.version !== 1
    || receipt.userId !== manifest.userId
    || receipt.operationId !== manifest.operationId
    || receipt.stageToken !== manifest.stageToken
    || receipt.digest !== manifest.digest
    || receipt.state !== manifest.state
    || !TERMINAL_STATES.has(receipt.state)
    || !Number.isSafeInteger(receipt.completedAt)
    || receipt.completedAt < manifest.createdAt
    || receipt.receiptDigest !== terminalReceiptDigest(receipt)) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'The compaction archive terminal receipt is not bound to its deletion manifest',
    )
  }
  return true
}

export function validateCompactionGovernanceManifest(value, { userId, operationId, env }) {
  assertPlainObject(value, 'The compaction archive deletion manifest is invalid')
  assertExactFields(value, [
    'version',
    'userId',
    'operationId',
    'stageToken',
    'scope',
    'digest',
    'records',
    'files',
    'alreadyMissing',
    'totalBytes',
    'state',
    'createdAt',
    'terminalReceipt',
  ], 'The compaction archive deletion manifest has unsupported fields')
  if (value.version !== 1 || value.userId !== userId || value.operationId !== operationId) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'The compaction archive deletion manifest identity is invalid',
    )
  }
  assertIdentity(value.stageToken, 'The compaction archive deletion stage token is invalid')
  validateScope(value.scope)
  if (typeof value.digest !== 'string' || !SHA256_PATTERN.test(value.digest)) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'The compaction archive deletion manifest digest is invalid',
    )
  }
  if (!ALL_STATES.has(value.state) || !Array.isArray(value.records) || !Array.isArray(value.files)) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'The compaction archive deletion manifest state is invalid',
    )
  }
  assertCount(value.alreadyMissing, 'The compaction archive missing count is invalid')
  assertCount(value.totalBytes, 'The compaction archive total size is invalid')
  assertCount(value.createdAt, 'The compaction archive manifest timestamp is invalid')
  const hasTerminalReceipt = validateTerminalReceipt(value.terminalReceipt, value)
  if (isActiveCompactionGovernanceState(value.state) && hasTerminalReceipt) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'An active compaction archive deletion cannot have a terminal receipt',
    )
  }
  const manifest = { ...value, env }
  const records = new Map()
  for (const record of value.records) {
    validateRecord(record, manifest)
    if (records.has(record.id)) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
        'The compaction archive deletion manifest contains duplicate records',
      )
    }
    records.set(record.id, record)
  }
  const payloads = new Set()
  const storagePaths = new Set()
  let totalBytes = 0
  for (const file of value.files) {
    validateFile(file, manifest, records)
    if (payloads.has(file.payloadName) || storagePaths.has(file.storagePath)) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
        'The compaction archive deletion manifest contains duplicate files',
      )
    }
    payloads.add(file.payloadName)
    storagePaths.add(file.storagePath)
    totalBytes += file.sizeBytes
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes !== value.totalBytes) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'The compaction archive deletion manifest total size is inconsistent',
    )
  }
  return value
}
