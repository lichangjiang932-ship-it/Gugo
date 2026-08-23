import assert from 'node:assert/strict'
import test from 'node:test'

import { createCompactionArchivePort } from '../server/core/compactionArchivePort.js'
import { acquireCompactionArchiveGovernanceLease } from '../server/services/compactionArchiveGovernanceRuntime.js'

function runtimeAdapter(overrides = {}) {
  return {
    apiVersion: 1,
    id: 'test.governance-runtime',
    create() {},
    get() {},
    cleanup() {},
    ...overrides,
  }
}

function governanceAdapter() {
  const noop = () => undefined
  return runtimeAdapter({
    governanceApiVersion: 1,
    createExportSnapshot: noop,
    listExportEntries: noop,
    readExportChunk: noop,
    releaseExportSnapshot: noop,
    previewDeletion: noop,
    stageDeletion: noop,
    assertDeletionStable: noop,
    commitDeletion: noop,
    rollbackDeletion: noop,
    recoverDeletion: noop,
  })
}

test('governance runtime returns only the trusted port and an idempotent release', () => {
  const port = createCompactionArchivePort(governanceAdapter())
  let acquireCalls = 0
  let releaseCalls = 0

  const lease = acquireCompactionArchiveGovernanceLease({
    acquire() {
      acquireCalls += 1
      return {
        port,
        release() {
          releaseCalls += 1
          return true
        },
      }
    },
  })

  assert.equal(acquireCalls, 1)
  assert.strictEqual(lease.port, port)
  assert.deepEqual(Object.keys(lease), ['port', 'release'])
  assert.equal(Object.isFrozen(lease), true)
  assert.equal(lease.release(), true)
  assert.equal(lease.release(), false)
  assert.equal(releaseCalls, 1)
})

test('governance runtime releases exactly once when governance validation fails', () => {
  const runtimeOnlyPort = createCompactionArchivePort(runtimeAdapter())
  let releaseCalls = 0

  assert.throws(
    () => acquireCompactionArchiveGovernanceLease({
      acquire: () => ({
        port: runtimeOnlyPort,
        release() {
          releaseCalls += 1
          return true
        },
      }),
    }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_GOVERNANCE_NOT_CONFIGURED',
  )
  assert.equal(releaseCalls, 1)
})

test('governance runtime keeps release idempotent when the underlying release throws', () => {
  const port = createCompactionArchivePort(governanceAdapter())
  let releaseCalls = 0
  const expected = new Error('release failed')
  const lease = acquireCompactionArchiveGovernanceLease({
    acquire: () => ({
      port,
      release() {
        releaseCalls += 1
        throw expected
      },
    }),
  })

  assert.throws(() => lease.release(), (error) => error === expected)
  assert.equal(lease.release(), false)
  assert.equal(releaseCalls, 1)
})

test('governance runtime reports validation and cleanup failures without retrying release', () => {
  const runtimeOnlyPort = createCompactionArchivePort(runtimeAdapter())
  let releaseCalls = 0
  const releaseError = new Error('release failed')

  assert.throws(
    () => acquireCompactionArchiveGovernanceLease({
      acquire: () => ({
        port: runtimeOnlyPort,
        release() {
          releaseCalls += 1
          throw releaseError
        },
      }),
    }),
    (error) => error instanceof AggregateError
      && error.errors?.[0]?.code === 'COMPACTION_ARCHIVE_GOVERNANCE_NOT_CONFIGURED'
      && error.errors?.[1] === releaseError,
  )
  assert.equal(releaseCalls, 1)
})
