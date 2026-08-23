import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertCompactionArchiveGovernancePort,
  assertCompactionArchivePort,
  createCompactionArchivePort,
} from '../server/core/compactionArchivePort.js'
import { resolveCompactionArchivePort } from '../server/services/compactionArchiveRuntime.js'

function archive(input, overrides = {}) {
  const archivedMessages = overrides.archivedMessages || input.archivedMessages || []
  return {
    id: input.id || 'archive-1',
    userId: input.userId,
    sessionId: input.sessionId || 'session-1',
    replacedMessageCount: archivedMessages.length,
    archivedMessages,
    summaryText: 'summary',
    createdAt: 1,
    ...overrides,
  }
}

const DIGEST = '0'.repeat(64)

function runtimeAdapter(overrides = {}) {
  return {
    apiVersion: 1,
    id: 'test.boundary',
    create(input) {
      return archive(input)
    },
    get(input) {
      return archive({ ...input, sessionId: 'session-1', archivedMessages: [] })
    },
    cleanup() {
      return { removed: 0 }
    },
    ...overrides,
  }
}

function governanceMethods(overrides = {}) {
  return {
    governanceApiVersion: 1,
    createExportSnapshot(input) {
      return { userId: input.userId, snapshotToken: 'snapshot-1', entryCount: 0 }
    },
    listExportEntries(input) {
      return { userId: input.userId, snapshotToken: input.snapshotToken, entries: [] }
    },
    readExportChunk(input) {
      return {
        userId: input.userId,
        snapshotToken: input.snapshotToken,
        contentToken: input.contentToken,
        dataBase64: '',
        byteLength: 0,
        nextOffset: input.offset,
        done: true,
      }
    },
    releaseExportSnapshot(input) {
      return { userId: input.userId, snapshotToken: input.snapshotToken, released: true }
    },
    previewDeletion(input) {
      return {
        userId: input.userId,
        scope: input.scope,
        digest: DIGEST,
        fileCount: 0,
        totalBytes: 0,
        alreadyMissing: 0,
      }
    },
    stageDeletion(input) {
      return {
        userId: input.userId,
        operationId: input.operationId,
        stageToken: 'stage-1',
        digest: input.expectedDigest,
        state: 'staged',
      }
    },
    assertDeletionStable(input) {
      return { ...input, state: 'staged', stable: true }
    },
    commitDeletion(input) {
      return {
        ...input,
        state: 'committed',
        removedFiles: 0,
        removedBytes: 0,
        alreadyMissing: 0,
      }
    },
    rollbackDeletion(input) {
      return {
        ...input,
        state: 'rolled_back',
        restoredFiles: 0,
        removedBytes: 0,
        alreadyMissing: 0,
      }
    },
    recoverDeletion(input) {
      return {
        userId: input.userId,
        operationId: input.operationId,
        recovered: false,
        state: 'none',
        digest: null,
        stageToken: null,
      }
    },
    ...overrides,
  }
}

function adapter(overrides = {}) {
  return runtimeAdapter({ ...governanceMethods(), ...overrides })
}

function createInput(overrides = {}) {
  return {
    userId: 'owner-1',
    sessionId: 'session-1',
    archivedMessages: [{ role: 'user', content: 'private' }],
    summaryText: 'summary',
    ...overrides,
  }
}

test('CompactionArchivePort rejects malformed create/get/cleanup inputs before adapter code runs', () => {
  let calls = 0
  const port = createCompactionArchivePort(adapter({
    create(input) {
      calls += 1
      return archive(input)
    },
    get(input) {
      calls += 1
      return archive({ ...input, sessionId: 'session-1', archivedMessages: [] })
    },
    cleanup() {
      calls += 1
      return { removed: 0 }
    },
  }))

  for (const input of [
    { ...createInput(), userId: '' },
    { ...createInput(), sessionId: ' session-1 ' },
    { ...createInput(), archivedMessages: null },
    { ...createInput(), unexpected: true },
  ]) {
    assert.throws(
      () => port.create(input),
      (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_INPUT_INVALID',
    )
  }
  for (const input of [
    { userId: 'owner-1' },
    { userId: '', id: 'archive-1' },
    { userId: 'owner-1', id: ' archive-1 ' },
  ]) {
    assert.throws(
      () => port.get(input),
      (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_INPUT_INVALID',
    )
  }
  assert.throws(
    () => port.cleanup({ userId: '', maxEntries: -1 }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_INPUT_INVALID',
  )
  assert.equal(calls, 0)
})

test('CompactionArchivePort rejects archive identity drift and malformed async receipts', async () => {
  const wrongCreateOwner = createCompactionArchivePort(adapter({
    create(input) {
      return archive(input, { userId: 'owner-2' })
    },
  }))
  assert.throws(
    () => wrongCreateOwner.create(createInput()),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_IDENTITY_MISMATCH',
  )

  const wrongCreateSession = createCompactionArchivePort(adapter({
    create: async (input) => archive(input, { sessionId: 'session-2' }),
  }))
  await assert.rejects(
    wrongCreateSession.create(createInput()),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_IDENTITY_MISMATCH',
  )

  const wrongGetIdentity = createCompactionArchivePort(adapter({
    get: async (input) => archive({ ...input, sessionId: 'session-1' }, { id: 'archive-2' }),
  }))
  await assert.rejects(
    wrongGetIdentity.get({ userId: 'owner-1', id: 'archive-1' }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_IDENTITY_MISMATCH',
  )

  const malformedCleanup = createCompactionArchivePort(adapter({
    cleanup: async () => ({ removed: -1 }),
  }))
  await assert.rejects(
    malformedCleanup.cleanup({ userId: 'owner-1' }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_OUTPUT_INVALID',
  )
})

test('resolver rejects raw adapters and preserves trusted port clone/deep-freeze boundaries', () => {
  let observedInput = null
  const raw = adapter({
    create(input) {
      observedInput = input
      return archive(input)
    },
  })
  assert.throws(
    () => assertCompactionArchivePort(raw),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_UNTRUSTED',
  )
  assert.throws(
    () => resolveCompactionArchivePort(raw),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_UNTRUSTED',
  )

  const trusted = createCompactionArchivePort(raw)
  const resolved = resolveCompactionArchivePort(trusted)
  assert.equal(resolved, trusted)
  const input = createInput()
  const created = resolved.create(input)
  assert.notEqual(observedInput, input)
  assert.equal(Object.isFrozen(observedInput), true)
  assert.equal(Object.isFrozen(observedInput.archivedMessages), true)
  assert.equal(Object.isFrozen(observedInput.archivedMessages[0]), true)
  assert.equal(Object.isFrozen(created), true)
  assert.equal(Object.isFrozen(created.archivedMessages), true)
})

test('legacy runtime adapters remain usable while governance acquisition fails closed', () => {
  const port = createCompactionArchivePort(runtimeAdapter())
  assert.equal(port.create(createInput()).id, 'archive-1')
  assert.equal(port.governanceApiVersion, null)
  assert.throws(
    () => assertCompactionArchiveGovernancePort(port),
    (error) => error?.code === 'COMPACTION_ARCHIVE_GOVERNANCE_NOT_CONFIGURED',
  )

  const partial = runtimeAdapter({
    governanceApiVersion: 1,
    createExportSnapshot() {},
  })
  assert.throws(
    () => createCompactionArchivePort(partial),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_INVALID'
      && error.message.includes('listExportEntries()'),
  )
})

test('governance methods reject Promise and binary DTOs synchronously', () => {
  const asyncPort = createCompactionArchivePort(adapter({
    previewDeletion: async () => ({}),
  }))
  assert.throws(
    () => asyncPort.previewDeletion({ userId: 'owner-1', scope: { kind: 'user' } }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_GOVERNANCE_ASYNC_UNSUPPORTED',
  )

  const binaryPort = createCompactionArchivePort(adapter({
    createExportSnapshot(input) {
      return {
        userId: input.userId,
        snapshotToken: 'snapshot-1',
        entryCount: 0,
        bytes: Buffer.from('private'),
      }
    },
  }))
  assert.throws(
    () => binaryPort.createExportSnapshot({ userId: 'owner-1' }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_OUTPUT_INVALID'
      && /Buffer|typed-array/u.test(error.message),
  )
})

test('governance boundary rejects identity drift and freezes detached receipts', () => {
  let observedInput = null
  const port = createCompactionArchivePort(adapter({
    createExportSnapshot(input) {
      observedInput = input
      return {
        userId: input.userId,
        snapshotToken: 'snapshot-1',
        entryCount: 0,
      }
    },
  }))

  const receipt = assertCompactionArchiveGovernancePort(port)
    .createExportSnapshot({ userId: 'owner-1' })
  assert.equal(Object.isFrozen(observedInput), true)
  assert.equal(Object.isFrozen(receipt), true)

  const drifting = createCompactionArchivePort(adapter({
    previewDeletion(input) {
      return {
        userId: 'owner-2',
        scope: input.scope,
        digest: DIGEST,
        fileCount: 0,
        totalBytes: 0,
        alreadyMissing: 0,
      }
    },
  }))
  assert.throws(
    () => drifting.previewDeletion({ userId: 'owner-1', scope: { kind: 'user' } }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_IDENTITY_MISMATCH',
  )
})

test('governance recovery binds terminal evidence and rejects incoherent states', () => {
  const input = {
    userId: 'owner-1',
    operationId: 'operation-1',
    databaseCommitted: true,
    expectedDigest: DIGEST,
    expectedStageToken: 'stage-1',
  }
  const valid = createCompactionArchivePort(adapter({
    recoverDeletion(current) {
      return {
        userId: current.userId,
        operationId: current.operationId,
        recovered: true,
        state: 'committed',
        digest: current.expectedDigest,
        stageToken: current.expectedStageToken,
      }
    },
  }))
  assert.equal(valid.recoverDeletion(input).state, 'committed')

  for (const output of [
    {
      userId: input.userId,
      operationId: input.operationId,
      recovered: false,
      state: 'committed',
      digest: DIGEST,
      stageToken: 'stage-1',
    },
    {
      userId: input.userId,
      operationId: input.operationId,
      recovered: true,
      state: 'committed',
      digest: '1'.repeat(64),
      stageToken: 'stage-1',
    },
    {
      userId: input.userId,
      operationId: input.operationId,
      recovered: true,
      state: 'committed',
      digest: DIGEST,
      stageToken: 'stage-2',
    },
  ]) {
    const port = createCompactionArchivePort(adapter({ recoverDeletion: () => output }))
    assert.throws(
      () => port.recoverDeletion(input),
      (error) => [
        'COMPACTION_ARCHIVE_PORT_OUTPUT_INVALID',
        'COMPACTION_ARCHIVE_PORT_IDENTITY_MISMATCH',
      ].includes(error?.code),
    )
  }
})
