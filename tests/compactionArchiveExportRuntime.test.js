import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import { createCompactionArchivePort } from '../server/core/compactionArchivePort.js'
import { createCompactionArchiveExportSnapshot } from '../server/services/compactionArchiveExportRuntime.js'

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    stream.once('error', reject)
    stream.once('end', () => resolve(Buffer.concat(chunks)))
  })
}

function governancePort({ body = Buffer.from('archive-body'), overrides = {} } = {}) {
  const snapshotToken = 'snapshot-1'
  const contentToken = 'content-1'
  const calls = { chunks: [], releases: 0 }
  const adapter = {
    apiVersion: 1,
    governanceApiVersion: 1,
    id: 'test.export-governance',
    create() {},
    get() {},
    cleanup() {},
    createExportSnapshot: ({ userId }) => ({ userId, snapshotToken, entryCount: 1 }),
    listExportEntries: ({ userId }) => ({
      userId,
      snapshotToken,
      entries: [{
        id: 'archive-1',
        userId,
        sessionId: 'session-1',
        contentToken,
        sizeBytes: body.length,
        sha256: digest(body),
      }],
    }),
    readExportChunk: ({ userId, offset, maxBytes }) => {
      calls.chunks.push({ offset, maxBytes })
      const bytes = body.subarray(offset, Math.min(body.length, offset + maxBytes))
      return {
        userId,
        snapshotToken,
        contentToken,
        dataBase64: bytes.toString('base64'),
        byteLength: bytes.length,
        nextOffset: offset + bytes.length,
        done: offset + bytes.length >= body.length,
      }
    },
    releaseExportSnapshot: ({ userId }) => {
      calls.releases += 1
      return { userId, snapshotToken, released: true }
    },
    previewDeletion() {},
    stageDeletion() {},
    assertDeletionStable() {},
    commitDeletion() {},
    rollbackDeletion() {},
    recoverDeletion() {},
    ...overrides,
  }
  return { port: createCompactionArchivePort(adapter), calls }
}

test('compaction export streams bounded chunks and verifies the declared body', async () => {
  const body = Buffer.from('0123456789')
  const { port, calls } = governancePort({ body })
  const snapshot = createCompactionArchiveExportSnapshot({
    userId: 'owner-1',
    port,
    chunkBytes: 4,
  })

  assert.equal(snapshot.portId, 'test.export-governance')
  assert.equal(snapshot.manifestEntries[0].sessionId, 'session-1')
  assert.match(snapshot.manifestEntries[0].archivePath, /^compaction-archives\/[0-9a-f]{64}\.json$/)
  assert.deepEqual(await collect(snapshot.files[0].createReadStream()), body)
  assert.deepEqual(calls.chunks, [
    { offset: 0, maxBytes: 4 },
    { offset: 4, maxBytes: 4 },
    { offset: 8, maxBytes: 2 },
  ])
  assert.equal(snapshot.releaseSnapshot(), true)
  assert.equal(snapshot.releaseSnapshot(), false)
  assert.equal(calls.releases, 1)
})

test('compaction export rejects digest drift and cannot read after release', async () => {
  const { port } = governancePort({
    body: Buffer.from('actual'),
    overrides: {
      listExportEntries: ({ userId }) => ({
        userId,
        snapshotToken: 'snapshot-1',
        entries: [{
          id: 'archive-1',
          userId,
          sessionId: 'session-1',
          contentToken: 'content-1',
          sizeBytes: 6,
          sha256: digest(Buffer.from('wanted')),
        }],
      }),
    },
  })
  const snapshot = createCompactionArchiveExportSnapshot({ userId: 'owner-1', port })
  await assert.rejects(
    collect(snapshot.files[0].createReadStream()),
    (error) => error?.code === 'USER_DATA_EXPORT_COMPACTION_INTEGRITY_FAILED',
  )
  assert.equal(snapshot.releaseSnapshot(), true)
  await assert.rejects(
    collect(snapshot.files[0].createReadStream()),
    (error) => error?.code === 'USER_DATA_EXPORT_COMPACTION_SNAPSHOT_RELEASED',
  )
})

test('compaction export releases its snapshot when listing count changes', () => {
  const { port, calls } = governancePort({
    overrides: {
      listExportEntries: ({ userId }) => ({
        userId,
        snapshotToken: 'snapshot-1',
        entries: [],
      }),
    },
  })
  assert.throws(
    () => createCompactionArchiveExportSnapshot({ userId: 'owner-1', port }),
    (error) => error?.code === 'USER_DATA_EXPORT_COMPACTION_SNAPSHOT_CHANGED',
  )
  assert.equal(calls.releases, 1)
})

test('compaction export rejects a non-terminal empty chunk', async () => {
  const { port } = governancePort({
    overrides: {
      readExportChunk: ({ userId, offset }) => ({
        userId,
        snapshotToken: 'snapshot-1',
        contentToken: 'content-1',
        dataBase64: '',
        byteLength: 0,
        nextOffset: offset,
        done: false,
      }),
    },
  })
  const snapshot = createCompactionArchiveExportSnapshot({ userId: 'owner-1', port })
  await assert.rejects(
    collect(snapshot.files[0].createReadStream()),
    (error) => error?.code === 'USER_DATA_EXPORT_COMPACTION_STALLED',
  )
  snapshot.releaseSnapshot()
})
