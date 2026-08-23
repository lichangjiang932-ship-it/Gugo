export const COMPACTION_ARCHIVE_PORT_VERSION = 1
export const COMPACTION_ARCHIVE_GOVERNANCE_VERSION = 1

const RUNTIME_METHODS = Object.freeze(['create', 'get', 'cleanup'])
const EXPORT_METHODS = Object.freeze([
  'createExportSnapshot',
  'listExportEntries',
  'readExportChunk',
  'releaseExportSnapshot',
])
const DELETION_METHODS = Object.freeze([
  'previewDeletion',
  'stageDeletion',
  'assertDeletionStable',
  'commitDeletion',
  'rollbackDeletion',
  'recoverDeletion',
])
const GOVERNANCE_METHODS = Object.freeze([...EXPORT_METHODS, ...DELETION_METHODS])
const REQUIRED_METHODS = RUNTIME_METHODS
const AUDIT_LIMIT = 256
const HOST_PORTS = new WeakSet()
const auditEvents = []
let auditSequence = 0
let activeBinding = null
const ARCHIVE_FIELDS = Object.freeze([
  'id',
  'userId',
  'sessionId',
  'replacedMessageCount',
  'archivedMessages',
  'summaryText',
  'createdAt',
])
const CREATE_INPUT_FIELDS = Object.freeze([
  'userId',
  'sessionId',
  'archivedMessages',
  'summaryText',
  'id',
])
const GET_INPUT_FIELDS = Object.freeze(['userId', 'id'])
const CLEANUP_INPUT_FIELDS = Object.freeze([
  'userId',
  'now',
  'orphanGraceMs',
  'maxEntries',
])
const CLEANUP_METRIC_FIELDS = Object.freeze([
  'scanned',
  'removedFiles',
  'removedBytes',
  'preserved',
  'unsafe',
])
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MAX_EXPORT_CHUNK_BYTES = 16 * 1024 * 1024

function portError(code, message) {
  return Object.assign(new TypeError(message), {
    code,
    retryable: false,
  })
}

function emit(event, binding, details = {}) {
  const entry = Object.freeze({
    event,
    portId: binding.port.id,
    apiVersion: binding.port.apiVersion,
    source: binding.source,
    sequence: auditSequence += 1,
    at: Date.now(),
    ...details,
  })
  auditEvents.push(entry)
  if (auditEvents.length > AUDIT_LIMIT) {
    auditEvents.splice(0, auditEvents.length - AUDIT_LIMIT)
  }
}

function boundaryError(direction, method, message) {
  return portError(
    `COMPACTION_ARCHIVE_PORT_${direction.toUpperCase()}_INVALID`,
    `CompactionArchivePort ${method} ${direction} ${message}`,
  )
}

function identityError(method, field, expected, actual) {
  return portError(
    'COMPACTION_ARCHIVE_PORT_IDENTITY_MISMATCH',
    `CompactionArchivePort ${method} output ${field} must match input (${expected}); received ${actual}`,
  )
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertRecord(value, direction, method) {
  if (!isRecord(value)) {
    throw boundaryError(direction, method, 'must be a plain object')
  }
  return value
}

function assertAllowedFields(value, allowed, direction, method) {
  const allowedFields = new Set(allowed)
  const unexpected = Object.keys(value).find((field) => !allowedFields.has(field))
  if (unexpected) {
    throw boundaryError(direction, method, `contains unsupported field ${unexpected}`)
  }
}

function assertIdentity(value, direction, method, field) {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw boundaryError(direction, method, `${field} must be a non-empty normalized string`)
  }
  return value
}

function assertNonNegativeInteger(value, direction, method, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw boundaryError(direction, method, `${field} must be a non-negative safe integer`)
  }
  return value
}

function assertCreateInput(input) {
  assertRecord(input, 'input', 'create')
  assertAllowedFields(input, CREATE_INPUT_FIELDS, 'input', 'create')
  assertIdentity(input.userId, 'input', 'create', 'userId')
  assertIdentity(input.sessionId, 'input', 'create', 'sessionId')
  if (!Array.isArray(input.archivedMessages)) {
    throw boundaryError('input', 'create', 'archivedMessages must be an array')
  }
  if (typeof input.summaryText !== 'string') {
    throw boundaryError('input', 'create', 'summaryText must be a string')
  }
  if (input.id !== undefined) assertIdentity(input.id, 'input', 'create', 'id')
  return input
}

function assertGetInput(input) {
  assertRecord(input, 'input', 'get')
  assertAllowedFields(input, GET_INPUT_FIELDS, 'input', 'get')
  assertIdentity(input.userId, 'input', 'get', 'userId')
  assertIdentity(input.id, 'input', 'get', 'id')
  return input
}

function assertCleanupInput(input) {
  assertRecord(input, 'input', 'cleanup')
  assertAllowedFields(input, CLEANUP_INPUT_FIELDS, 'input', 'cleanup')
  assertIdentity(input.userId, 'input', 'cleanup', 'userId')
  for (const field of CLEANUP_INPUT_FIELDS.slice(1)) {
    if (input[field] !== undefined) {
      assertNonNegativeInteger(input[field], 'input', 'cleanup', field)
    }
  }
  return input
}

function assertArchiveOutput(output, method, input) {
  assertRecord(output, 'output', method)
  assertAllowedFields(output, ARCHIVE_FIELDS, 'output', method)
  const id = assertIdentity(output.id, 'output', method, 'id')
  const userId = assertIdentity(output.userId, 'output', method, 'userId')
  const sessionId = assertIdentity(output.sessionId, 'output', method, 'sessionId')
  if (userId !== input.userId) {
    throw identityError(method, 'userId', input.userId, userId)
  }
  if (method === 'get' && id !== input.id) {
    throw identityError(method, 'id', input.id, id)
  }
  if (method === 'create' && input.id !== undefined && id !== input.id) {
    throw identityError(method, 'id', input.id, id)
  }
  if (method === 'create' && sessionId !== input.sessionId) {
    throw identityError(method, 'sessionId', input.sessionId, sessionId)
  }
  if (!Array.isArray(output.archivedMessages)) {
    throw boundaryError('output', method, 'archivedMessages must be an array')
  }
  const count = assertNonNegativeInteger(
    output.replacedMessageCount,
    'output',
    method,
    'replacedMessageCount',
  )
  if (count !== output.archivedMessages.length) {
    throw boundaryError(
      'output',
      method,
      'replacedMessageCount must equal archivedMessages.length',
    )
  }
  if (typeof output.summaryText !== 'string') {
    throw boundaryError('output', method, 'summaryText must be a string')
  }
  assertNonNegativeInteger(output.createdAt, 'output', method, 'createdAt')
  return output
}

function assertCreateOutput(output, input) {
  return assertArchiveOutput(output, 'create', input)
}

function assertGetOutput(output, input) {
  return output === null ? null : assertArchiveOutput(output, 'get', input)
}

function assertCleanupOutput(output) {
  assertRecord(output, 'output', 'cleanup')
  const fields = Object.keys(output)
  if (fields.length === 1 && fields[0] === 'removed') {
    assertNonNegativeInteger(output.removed, 'output', 'cleanup', 'removed')
    return output
  }
  assertAllowedFields(output, CLEANUP_METRIC_FIELDS, 'output', 'cleanup')
  for (const field of CLEANUP_METRIC_FIELDS) {
    assertNonNegativeInteger(output[field], 'output', 'cleanup', field)
  }
  return output
}

function assertBoolean(value, direction, method, field) {
  if (typeof value !== 'boolean') {
    throw boundaryError(direction, method, `${field} must be a boolean`)
  }
  return value
}

function assertDigest(value, direction, method, field = 'digest') {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw boundaryError(direction, method, `${field} must be a lowercase sha256 digest`)
  }
  return value
}

function assertScope(value, direction, method) {
  assertRecord(value, direction, method)
  if (value.kind === 'user') {
    assertAllowedFields(value, ['kind'], direction, method)
    return value
  }
  if (value.kind === 'session') {
    assertAllowedFields(value, ['kind', 'sessionId'], direction, method)
    assertIdentity(value.sessionId, direction, method, 'scope.sessionId')
    return value
  }
  throw boundaryError(direction, method, 'scope.kind must be user or session')
}

function assertGovernanceData(value, direction, method, seen = new WeakSet()) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw boundaryError(direction, method, 'numbers must be non-negative safe integers')
    }
    return value
  }
  if (typeof value !== 'object') {
    throw boundaryError(direction, method, 'must contain only plain serializable data')
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw boundaryError(direction, method, 'must not contain Buffer, typed-array, or ArrayBuffer values')
  }
  if (seen.has(value)) {
    throw boundaryError(direction, method, 'must not contain cyclic data')
  }
  seen.add(value)
  if (!Array.isArray(value) && !isRecord(value)) {
    throw boundaryError(direction, method, 'must contain only arrays and plain objects')
  }
  for (const entry of Object.values(value)) {
    assertGovernanceData(entry, direction, method, seen)
  }
  seen.delete(value)
  return value
}

function assertUserInput(input, method, allowed = ['userId']) {
  assertGovernanceData(input, 'input', method)
  assertRecord(input, 'input', method)
  assertAllowedFields(input, allowed, 'input', method)
  assertIdentity(input.userId, 'input', method, 'userId')
  return input
}

function assertExportSnapshotInput(input) {
  return assertUserInput(input, 'createExportSnapshot')
}

function assertSnapshotInput(input, method) {
  assertUserInput(input, method, ['userId', 'snapshotToken'])
  assertIdentity(input.snapshotToken, 'input', method, 'snapshotToken')
  return input
}

function assertListExportEntriesInput(input) {
  return assertSnapshotInput(input, 'listExportEntries')
}

function assertReadExportChunkInput(input) {
  const method = 'readExportChunk'
  assertUserInput(input, method, [
    'userId',
    'snapshotToken',
    'contentToken',
    'offset',
    'maxBytes',
  ])
  assertIdentity(input.snapshotToken, 'input', method, 'snapshotToken')
  assertIdentity(input.contentToken, 'input', method, 'contentToken')
  assertNonNegativeInteger(input.offset, 'input', method, 'offset')
  assertNonNegativeInteger(input.maxBytes, 'input', method, 'maxBytes')
  if (input.maxBytes < 1 || input.maxBytes > MAX_EXPORT_CHUNK_BYTES) {
    throw boundaryError('input', method, `maxBytes must be between 1 and ${MAX_EXPORT_CHUNK_BYTES}`)
  }
  return input
}

function assertReleaseExportSnapshotInput(input) {
  return assertSnapshotInput(input, 'releaseExportSnapshot')
}

function assertPreviewDeletionInput(input) {
  const method = 'previewDeletion'
  assertUserInput(input, method, ['userId', 'scope'])
  assertScope(input.scope, 'input', method)
  return input
}

function assertStageDeletionInput(input) {
  const method = 'stageDeletion'
  assertUserInput(input, method, ['userId', 'scope', 'operationId', 'expectedDigest'])
  assertScope(input.scope, 'input', method)
  assertIdentity(input.operationId, 'input', method, 'operationId')
  assertDigest(input.expectedDigest, 'input', method, 'expectedDigest')
  return input
}

function assertStagedDeletionInput(input, method) {
  assertUserInput(input, method, ['userId', 'operationId', 'stageToken', 'digest'])
  assertIdentity(input.operationId, 'input', method, 'operationId')
  assertIdentity(input.stageToken, 'input', method, 'stageToken')
  assertDigest(input.digest, 'input', method)
  return input
}

function assertRecoverDeletionInput(input) {
  const method = 'recoverDeletion'
  assertUserInput(input, method, [
    'userId',
    'operationId',
    'databaseCommitted',
    'expectedDigest',
    'expectedStageToken',
  ])
  assertIdentity(input.operationId, 'input', method, 'operationId')
  assertBoolean(input.databaseCommitted, 'input', method, 'databaseCommitted')
  assertDigest(input.expectedDigest, 'input', method, 'expectedDigest')
  if (input.expectedStageToken !== null) {
    assertIdentity(input.expectedStageToken, 'input', method, 'expectedStageToken')
  }
  return input
}

function assertSameIdentity(output, input, method, fields) {
  for (const field of fields) {
    if (output[field] !== input[field]) {
      throw identityError(method, field, input[field], output[field])
    }
  }
}

function assertExportSnapshotOutput(output, input) {
  const method = 'createExportSnapshot'
  assertGovernanceData(output, 'output', method)
  assertRecord(output, 'output', method)
  assertAllowedFields(output, ['userId', 'snapshotToken', 'entryCount'], 'output', method)
  assertIdentity(output.userId, 'output', method, 'userId')
  assertIdentity(output.snapshotToken, 'output', method, 'snapshotToken')
  assertNonNegativeInteger(output.entryCount, 'output', method, 'entryCount')
  assertSameIdentity(output, input, method, ['userId'])
  return output
}

function assertListExportEntriesOutput(output, input) {
  const method = 'listExportEntries'
  assertGovernanceData(output, 'output', method)
  assertRecord(output, 'output', method)
  assertAllowedFields(output, ['userId', 'snapshotToken', 'entries'], 'output', method)
  assertSameIdentity(output, input, method, ['userId', 'snapshotToken'])
  if (!Array.isArray(output.entries)) {
    throw boundaryError('output', method, 'entries must be an array')
  }
  const contentTokens = new Set()
  for (const entry of output.entries) {
    assertRecord(entry, 'output', method)
    assertAllowedFields(
      entry,
      ['id', 'userId', 'sessionId', 'contentToken', 'sizeBytes', 'sha256'],
      'output',
      method,
    )
    assertIdentity(entry.id, 'output', method, 'entry.id')
    assertIdentity(entry.userId, 'output', method, 'entry.userId')
    assertIdentity(entry.sessionId, 'output', method, 'entry.sessionId')
    assertIdentity(entry.contentToken, 'output', method, 'entry.contentToken')
    assertNonNegativeInteger(entry.sizeBytes, 'output', method, 'entry.sizeBytes')
    assertDigest(entry.sha256, 'output', method, 'entry.sha256')
    if (entry.userId !== input.userId) {
      throw identityError(method, 'entry.userId', input.userId, entry.userId)
    }
    if (contentTokens.has(entry.contentToken)) {
      throw boundaryError('output', method, 'entry.contentToken values must be unique')
    }
    contentTokens.add(entry.contentToken)
  }
  return output
}

function assertReadExportChunkOutput(output, input) {
  const method = 'readExportChunk'
  assertGovernanceData(output, 'output', method)
  assertRecord(output, 'output', method)
  assertAllowedFields(output, [
    'userId',
    'snapshotToken',
    'contentToken',
    'dataBase64',
    'byteLength',
    'nextOffset',
    'done',
  ], 'output', method)
  assertSameIdentity(output, input, method, ['userId', 'snapshotToken', 'contentToken'])
  if (typeof output.dataBase64 !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(output.dataBase64)) {
    throw boundaryError('output', method, 'dataBase64 must be canonical base64 data')
  }
  assertNonNegativeInteger(output.byteLength, 'output', method, 'byteLength')
  assertNonNegativeInteger(output.nextOffset, 'output', method, 'nextOffset')
  assertBoolean(output.done, 'output', method, 'done')
  if (Buffer.byteLength(output.dataBase64, 'base64') !== output.byteLength
    || output.nextOffset !== input.offset + output.byteLength
    || output.byteLength > input.maxBytes) {
    throw boundaryError('output', method, 'chunk offsets or byte length are invalid')
  }
  return output
}

function assertReleaseExportSnapshotOutput(output, input) {
  const method = 'releaseExportSnapshot'
  assertGovernanceData(output, 'output', method)
  assertRecord(output, 'output', method)
  assertAllowedFields(output, ['userId', 'snapshotToken', 'released'], 'output', method)
  assertSameIdentity(output, input, method, ['userId', 'snapshotToken'])
  assertBoolean(output.released, 'output', method, 'released')
  return output
}

function assertDeletionPreviewOutput(output, input) {
  const method = 'previewDeletion'
  assertGovernanceData(output, 'output', method)
  assertRecord(output, 'output', method)
  assertAllowedFields(output, [
    'userId',
    'scope',
    'digest',
    'fileCount',
    'totalBytes',
    'alreadyMissing',
  ], 'output', method)
  assertIdentity(output.userId, 'output', method, 'userId')
  assertSameIdentity(output, input, method, ['userId'])
  assertScope(output.scope, 'output', method)
  if (JSON.stringify(output.scope) !== JSON.stringify(input.scope)) {
    throw identityError(method, 'scope', JSON.stringify(input.scope), JSON.stringify(output.scope))
  }
  assertDigest(output.digest, 'output', method)
  for (const field of ['fileCount', 'totalBytes', 'alreadyMissing']) {
    assertNonNegativeInteger(output[field], 'output', method, field)
  }
  return output
}

function assertStageDeletionOutput(output, input) {
  const method = 'stageDeletion'
  assertGovernanceData(output, 'output', method)
  assertRecord(output, 'output', method)
  assertAllowedFields(output, [
    'userId',
    'operationId',
    'stageToken',
    'digest',
    'state',
  ], 'output', method)
  assertSameIdentity(output, input, method, ['userId', 'operationId'])
  assertIdentity(output.stageToken, 'output', method, 'stageToken')
  assertDigest(output.digest, 'output', method)
  if (output.digest !== input.expectedDigest) {
    throw identityError(method, 'digest', input.expectedDigest, output.digest)
  }
  if (output.state !== 'staged') {
    throw boundaryError('output', method, 'state must be staged')
  }
  return output
}

function assertDeletionLifecycleOutput(output, input, method, expectedState) {
  assertGovernanceData(output, 'output', method)
  assertRecord(output, 'output', method)
  const metric = method === 'rollbackDeletion' ? 'restoredFiles' : 'removedFiles'
  assertAllowedFields(output, [
    'userId',
    'operationId',
    'stageToken',
    'digest',
    'state',
    metric,
    'removedBytes',
    'alreadyMissing',
    ...(method === 'assertDeletionStable' ? ['stable'] : []),
  ], 'output', method)
  assertSameIdentity(output, input, method, ['userId', 'operationId', 'stageToken', 'digest'])
  if (output.state !== expectedState) {
    throw boundaryError('output', method, `state must be ${expectedState}`)
  }
  if (method === 'assertDeletionStable') {
    assertBoolean(output.stable, 'output', method, 'stable')
  } else {
    for (const field of [metric, 'removedBytes', 'alreadyMissing']) {
      assertNonNegativeInteger(output[field], 'output', method, field)
    }
  }
  return output
}

function assertRecoverDeletionOutput(output, input) {
  const method = 'recoverDeletion'
  assertGovernanceData(output, 'output', method)
  assertRecord(output, 'output', method)
  assertAllowedFields(
    output,
    ['userId', 'operationId', 'recovered', 'state', 'digest', 'stageToken'],
    'output',
    method,
  )
  assertSameIdentity(output, input, method, ['userId', 'operationId'])
  assertBoolean(output.recovered, 'output', method, 'recovered')
  if (!['none', 'committed', 'rolled_back'].includes(output.state)) {
    throw boundaryError('output', method, 'state must be none, committed, or rolled_back')
  }
  if (!output.recovered) {
    if (output.state !== 'none' || output.digest !== null || output.stageToken !== null) {
      throw boundaryError(
        'output',
        method,
        'unrecovered output must use state none with null digest and stageToken',
      )
    }
    return output
  }
  if (output.state === 'none') {
    throw boundaryError('output', method, 'recovered output must contain a terminal state')
  }
  assertDigest(output.digest, 'output', method, 'digest')
  assertIdentity(output.stageToken, 'output', method, 'stageToken')
  if (output.digest !== input.expectedDigest) {
    throw identityError(method, 'digest', input.expectedDigest, output.digest)
  }
  if (input.expectedStageToken !== null && output.stageToken !== input.expectedStageToken) {
    throw identityError(method, 'stageToken', input.expectedStageToken, output.stageToken)
  }
  return output
}

const INPUT_VALIDATORS = Object.freeze({
  create: assertCreateInput,
  get: assertGetInput,
  cleanup: assertCleanupInput,
  createExportSnapshot: assertExportSnapshotInput,
  listExportEntries: assertListExportEntriesInput,
  readExportChunk: assertReadExportChunkInput,
  releaseExportSnapshot: assertReleaseExportSnapshotInput,
  previewDeletion: assertPreviewDeletionInput,
  stageDeletion: assertStageDeletionInput,
  assertDeletionStable: (input) => assertStagedDeletionInput(input, 'assertDeletionStable'),
  commitDeletion: (input) => assertStagedDeletionInput(input, 'commitDeletion'),
  rollbackDeletion: (input) => assertStagedDeletionInput(input, 'rollbackDeletion'),
  recoverDeletion: assertRecoverDeletionInput,
})

const OUTPUT_VALIDATORS = Object.freeze({
  create: assertCreateOutput,
  get: assertGetOutput,
  cleanup: assertCleanupOutput,
  createExportSnapshot: assertExportSnapshotOutput,
  listExportEntries: assertListExportEntriesOutput,
  readExportChunk: assertReadExportChunkOutput,
  releaseExportSnapshot: assertReleaseExportSnapshotOutput,
  previewDeletion: assertDeletionPreviewOutput,
  stageDeletion: assertStageDeletionOutput,
  assertDeletionStable: (output, input) => assertDeletionLifecycleOutput(
    output,
    input,
    'assertDeletionStable',
    'staged',
  ),
  commitDeletion: (output, input) => assertDeletionLifecycleOutput(
    output,
    input,
    'commitDeletion',
    'committed',
  ),
  rollbackDeletion: (output, input) => assertDeletionLifecycleOutput(
    output,
    input,
    'rollbackDeletion',
    'rolled_back',
  ),
  recoverDeletion: assertRecoverDeletionOutput,
})

function cloneData(value) {
  if (value === undefined || value === null) return value
  return structuredClone(value)
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const entry of Object.values(value)) deepFreeze(entry, seen)
  return Object.freeze(value)
}

function frozenData(value) {
  return deepFreeze(cloneData(value))
}

function isPromiseLike(value) {
  return !!value && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function'
}

function normalizeAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw portError(
      'COMPACTION_ARCHIVE_PORT_INVALID',
      'Compaction archive adapter must be an object',
    )
  }
  const version = Number(adapter.apiVersion)
  if (version !== COMPACTION_ARCHIVE_PORT_VERSION) {
    throw portError(
      'COMPACTION_ARCHIVE_PORT_VERSION_UNSUPPORTED',
      `Compaction archive adapter apiVersion must be ${COMPACTION_ARCHIVE_PORT_VERSION}`,
    )
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw portError(
        'COMPACTION_ARCHIVE_PORT_INVALID',
        `Compaction archive adapter is missing ${method}()`,
      )
    }
  }
  const governanceMethods = GOVERNANCE_METHODS.filter(
    (method) => typeof adapter[method] === 'function',
  )
  if (governanceMethods.length > 0 && governanceMethods.length !== GOVERNANCE_METHODS.length) {
    const missing = GOVERNANCE_METHODS.find((method) => typeof adapter[method] !== 'function')
    throw portError(
      'COMPACTION_ARCHIVE_PORT_INVALID',
      `Compaction archive governance adapter is missing ${missing}()`,
    )
  }
  if (governanceMethods.length > 0
    && Number(adapter.governanceApiVersion) !== COMPACTION_ARCHIVE_GOVERNANCE_VERSION) {
    throw portError(
      'COMPACTION_ARCHIVE_GOVERNANCE_VERSION_UNSUPPORTED',
      `Compaction archive governance apiVersion must be ${COMPACTION_ARCHIVE_GOVERNANCE_VERSION}`,
    )
  }
  return { adapter, governanceMethods }
}

/**
 * Host-owned CompactionArchivePort v1 with an optional governance v1 surface.
 *
 * Runtime methods may return a value or Promise. Governance methods are
 * deliberately synchronous so export snapshots and staged deletion barriers
 * cannot escape their host-owned transaction/lifecycle scope.
 */
export function createCompactionArchivePort(adapter) {
  const { adapter: normalized, governanceMethods } = normalizeAdapter(adapter)
  const methodNames = [...REQUIRED_METHODS, ...governanceMethods]

  const invoke = (method, input) => {
    if (GOVERNANCE_METHODS.includes(method)) {
      assertGovernanceData(input, 'input', method)
    }
    const boundaryInput = frozenData(input)
    INPUT_VALIDATORS[method](boundaryInput)
    const result = normalized[method](boundaryInput)
    if (GOVERNANCE_METHODS.includes(method) && isPromiseLike(result)) {
      throw portError(
        'COMPACTION_ARCHIVE_PORT_GOVERNANCE_ASYNC_UNSUPPORTED',
        `CompactionArchivePort ${method} must return synchronously`,
      )
    }
    const settle = (value) => {
      if (GOVERNANCE_METHODS.includes(method)) {
        assertGovernanceData(value, 'output', method)
      }
      const boundaryOutput = frozenData(value)
      return frozenData(OUTPUT_VALIDATORS[method](boundaryOutput, boundaryInput))
    }
    return isPromiseLike(result)
      ? Promise.resolve(result).then(settle)
      : settle(result)
  }

  const methods = Object.fromEntries(methodNames.map((method) => [
    method,
    (input) => invoke(method, input),
  ]))
  const port = Object.freeze({
    apiVersion: COMPACTION_ARCHIVE_PORT_VERSION,
    governanceApiVersion: governanceMethods.length > 0
      ? COMPACTION_ARCHIVE_GOVERNANCE_VERSION
      : null,
    id: String(normalized.id || 'compaction-archive-adapter').trim()
      || 'compaction-archive-adapter',
    ...methods,
  })
  HOST_PORTS.add(port)
  return port
}

export function assertCompactionArchivePort(port) {
  if (!port || Number(port.apiVersion) !== COMPACTION_ARCHIVE_PORT_VERSION) {
    throw portError(
      'COMPACTION_ARCHIVE_PORT_VERSION_UNSUPPORTED',
      `CompactionArchivePort v${COMPACTION_ARCHIVE_PORT_VERSION} is required`,
    )
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof port[method] !== 'function') {
      throw portError(
        'COMPACTION_ARCHIVE_PORT_INVALID',
        `CompactionArchivePort is missing ${method}()`,
      )
    }
  }
  if (!HOST_PORTS.has(port)) {
    throw portError(
      'COMPACTION_ARCHIVE_PORT_UNTRUSTED',
      'CompactionArchivePort must be created by the host boundary',
    )
  }
  return port
}

export function assertCompactionArchiveGovernancePort(port) {
  const trusted = assertCompactionArchivePort(port)
  if (Number(trusted.governanceApiVersion) !== COMPACTION_ARCHIVE_GOVERNANCE_VERSION) {
    throw portError(
      'COMPACTION_ARCHIVE_GOVERNANCE_NOT_CONFIGURED',
      'CompactionArchivePort governance capability is not configured',
    )
  }
  for (const method of GOVERNANCE_METHODS) {
    if (typeof trusted[method] !== 'function') {
      throw portError(
        'COMPACTION_ARCHIVE_GOVERNANCE_NOT_CONFIGURED',
        `CompactionArchivePort governance is missing ${method}()`,
      )
    }
  }
  return trusted
}

function createRevocableCompactionArchivePort(port, {
  isAuthorized,
  authority = 'runtime capability',
} = {}) {
  const target = assertCompactionArchivePort(port)
  if (typeof isAuthorized !== 'function') {
    throw new TypeError('CompactionArchivePort revocation authority must be a function')
  }
  const assertAuthorized = () => {
    if (isAuthorized()) return
    throw portError(
      'COMPACTION_ARCHIVE_PORT_REVOKED',
      `CompactionArchivePort ${target.id} ${authority} has been revoked`,
    )
  }
  const invoke = (method, input) => {
    assertAuthorized()
    return target[method](input)
  }
  const governanceMethods = Number(target.governanceApiVersion)
      === COMPACTION_ARCHIVE_GOVERNANCE_VERSION
    ? GOVERNANCE_METHODS
    : []
  const methods = Object.fromEntries([...REQUIRED_METHODS, ...governanceMethods].map((method) => [
    method,
    (input) => invoke(method, input),
  ]))
  const facade = Object.freeze({
    apiVersion: target.apiVersion,
    governanceApiVersion: target.governanceApiVersion ?? null,
    id: target.id,
    ...methods,
  })
  HOST_PORTS.add(facade)
  return facade
}

function prepareControllerPort(input) {
  try {
    return assertCompactionArchivePort(input)
  } catch (error) {
    if (error?.code !== 'COMPACTION_ARCHIVE_PORT_UNTRUSTED') throw error
    return createCompactionArchivePort(input)
  }
}

function activatePort(port, source) {
  if (activeBinding) {
    throw portError(
      'COMPACTION_ARCHIVE_PORT_ALREADY_ACTIVE',
      `CompactionArchivePort ${activeBinding.port.id} is already active`,
    )
  }
  const binding = {
    port,
    source: String(source || 'host').trim().slice(0, 80) || 'host',
    leases: new Set(),
  }
  activeBinding = binding
  emit('compaction_archive.configured', binding)
  return binding
}

/** Host lifecycle controller. Runtime consumers can acquire but cannot replace the active port. */
export function createCompactionArchivePortController(input, {
  source = 'host.lifecycle',
} = {}) {
  const hostPort = prepareControllerPort(input)
  let activation = null
  return Object.freeze({
    portId: hostPort.id,
    activate() {
      if (activation) return activation.port
      let authorized = true
      let ownedBinding = null
      const port = createRevocableCompactionArchivePort(hostPort, {
        authority: 'controller capability',
        isAuthorized: () => authorized && activeBinding === ownedBinding,
      })
      ownedBinding = activatePort(port, source)
      activation = {
        binding: ownedBinding,
        port,
        revoke: () => { authorized = false },
      }
      return port
    },
    release() {
      if (!activation) return false
      const { binding } = activation
      if (activeBinding !== binding) {
        throw portError(
          'COMPACTION_ARCHIVE_PORT_BINDING_STALE',
          `CompactionArchivePort binding ${hostPort.id} is no longer authoritative`,
        )
      }
      if (binding.leases.size > 0) {
        throw portError(
          'COMPACTION_ARCHIVE_PORT_IN_USE',
          `CompactionArchivePort ${hostPort.id} cannot be released while leases are active`,
        )
      }
      emit('compaction_archive.released', binding)
      activation.revoke()
      activeBinding = null
      activation = null
      return true
    },
  })
}

/** Acquire one immutable port snapshot for a complete archive operation scope. */
export function acquireCompactionArchivePort() {
  if (!activeBinding) {
    throw portError(
      'COMPACTION_ARCHIVE_PORT_NOT_CONFIGURED',
      'CompactionArchivePort must be activated before it is acquired',
    )
  }
  const binding = activeBinding
  const token = Object.freeze({})
  binding.leases.add(token)
  let released = false
  const port = createRevocableCompactionArchivePort(binding.port, {
    authority: 'lease capability',
    isAuthorized: () => !released
      && activeBinding === binding
      && binding.leases.has(token),
  })
  emit('compaction_archive.lease_acquired', binding, { activeLeases: binding.leases.size })
  return Object.freeze({
    port,
    release() {
      if (released) return false
      if (activeBinding !== binding || !binding.leases.has(token)) {
        throw portError(
          'COMPACTION_ARCHIVE_PORT_LEASE_STALE',
          `CompactionArchivePort lease ${binding.port.id} is no longer authoritative`,
        )
      }
      binding.leases.delete(token)
      released = true
      emit('compaction_archive.lease_released', binding, { activeLeases: binding.leases.size })
      return true
    },
  })
}

export function getCompactionArchivePortStatus() {
  if (!activeBinding) {
    return Object.freeze({
      configured: false,
      portId: null,
      apiVersion: COMPACTION_ARCHIVE_PORT_VERSION,
      activeLeases: 0,
      source: null,
    })
  }
  return Object.freeze({
    configured: true,
    portId: activeBinding.port.id,
    apiVersion: activeBinding.port.apiVersion,
    activeLeases: activeBinding.leases.size,
    source: activeBinding.source,
  })
}

export function listCompactionArchivePortAuditEvents() {
  return Object.freeze([...auditEvents])
}
