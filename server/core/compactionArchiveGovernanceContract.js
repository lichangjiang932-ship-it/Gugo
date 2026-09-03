import {
  assertAllowedFields,
  assertIdentity,
  assertNonNegativeInteger,
  assertRecord,
  boundaryError,
  identityError,
  isRecord,
} from './compactionArchivePortValidation.js'

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
export const GOVERNANCE_METHODS = Object.freeze([...EXPORT_METHODS, ...DELETION_METHODS])

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MAX_EXPORT_CHUNK_BYTES = 16 * 1024 * 1024

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

export function assertGovernanceData(value, direction, method, seen = new WeakSet()) {
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

export const GOVERNANCE_INPUT_VALIDATORS = Object.freeze({
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

export const GOVERNANCE_OUTPUT_VALIDATORS = Object.freeze({
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
