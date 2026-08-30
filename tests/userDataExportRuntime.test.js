import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createAuthoritativeUserDataArchive } from '../server/services/userDataExportRuntime.js'

class ControlledArchiveStream extends EventEmitter {
  constructor() {
    super()
    this.destroyed = false
    this.destroyError = null
  }

  destroy(error) {
    this.destroyed = true
    this.destroyError = error || null
    return this
  }
}

function createRuntimeFixture({
  compactionReleaseError = null,
  leaseReleaseError = null,
} = {}) {
  const stream = new ControlledArchiveStream()
  const releases = { compaction: 0, lease: 0 }
  const archive = createAuthoritativeUserDataArchive(
    { userId: 'user-export-runtime' },
    {
      acquireGovernanceLease() {
        return {
          port: { id: 'test-port' },
          release() {
            releases.lease += 1
            if (leaseReleaseError) throw leaseReleaseError
          },
        }
      },
      buildSnapshot() {
        return {
          manifest: {
            exportedAt: '2026-08-30T00:00:00.000Z',
          },
          files: [],
          compactionExport: {
            releaseSnapshot() {
              releases.compaction += 1
              if (compactionReleaseError) throw compactionReleaseError
            },
          },
        }
      },
      createZip() {
        return {
          file() {},
          generateNodeStream() { return stream },
        }
      },
    },
  )
  return { archive, releases, stream }
}

test('archive terminal events and explicit disposal release each export resource once', () => {
  for (const terminal of ['error', 'end', 'close', 'dispose']) {
    const fixture = createRuntimeFixture()
    if (terminal === 'error') fixture.stream.emit('error', new Error('stream failed'))
    else if (terminal === 'dispose') assert.equal(fixture.archive.dispose(), true)
    else fixture.stream.emit(terminal)

    fixture.stream.emit('close')
    assert.equal(fixture.archive.dispose(), false)
    assert.deepEqual(fixture.releases, { compaction: 1, lease: 1 }, terminal)
  }
})

test('archive disposal aggregates independent compaction and lease cleanup failures', () => {
  const compactionError = new Error('compaction release failed')
  const leaseError = new Error('lease release failed')
  const fixture = createRuntimeFixture({ compactionReleaseError: compactionError, leaseReleaseError: leaseError })

  let cleanupError
  assert.throws(
    () => fixture.archive.dispose(),
    (error) => {
      cleanupError = error
      return error instanceof AggregateError
        && error.errors[0] === compactionError
        && error.errors[1] === leaseError
    },
  )
  assert.throws(() => fixture.archive.dispose(), (error) => error === cleanupError)
  assert.deepEqual(fixture.releases, { compaction: 1, lease: 1 })
})

test('archive stream errors retain aggregate cleanup diagnostics', () => {
  const fixture = createRuntimeFixture({
    compactionReleaseError: new Error('compaction release failed'),
    leaseReleaseError: new Error('lease release failed'),
  })
  const streamError = new Error('archive stream failed')

  fixture.stream.emit('error', streamError)

  assert.ok(streamError.cleanupError instanceof AggregateError)
  assert.equal(streamError.cleanupError.errors.length, 2)
  assert.deepEqual(fixture.releases, { compaction: 1, lease: 1 })
})

test('archive end destroys the stream with aggregate cleanup diagnostics', () => {
  const fixture = createRuntimeFixture({
    compactionReleaseError: new Error('compaction release failed'),
    leaseReleaseError: new Error('lease release failed'),
  })

  fixture.stream.emit('end')

  assert.ok(fixture.stream.destroyError instanceof AggregateError)
  assert.equal(fixture.stream.destroyError.errors.length, 2)
  assert.deepEqual(fixture.releases, { compaction: 1, lease: 1 })
})

test('archive close retains cleanup failures without retrying resource release', () => {
  const fixture = createRuntimeFixture({
    compactionReleaseError: new Error('compaction release failed'),
    leaseReleaseError: new Error('lease release failed'),
  })

  fixture.stream.emit('close')

  assert.ok(fixture.stream.cleanupError instanceof AggregateError)
  assert.throws(
    () => fixture.archive.dispose(),
    (error) => error === fixture.stream.cleanupError,
  )
  assert.deepEqual(fixture.releases, { compaction: 1, lease: 1 })
})

test('synchronous ZIP setup failures release the snapshot and governance lease', () => {
  for (const failureStage of ['create', 'metadata', 'stream']) {
    const failure = new Error(`${failureStage} failed`)
    const releases = { compaction: 0, lease: 0 }

    assert.throws(
      () => createAuthoritativeUserDataArchive(
        { userId: 'user-export-setup-failure' },
        {
          acquireGovernanceLease() {
            return {
              port: { id: 'test-port' },
              release() { releases.lease += 1 },
            }
          },
          buildSnapshot() {
            return {
              manifest: { exportedAt: '2026-08-30T00:00:00.000Z' },
              files: [],
              compactionExport: {
                releaseSnapshot() { releases.compaction += 1 },
              },
            }
          },
          createZip() {
            if (failureStage === 'create') throw failure
            return {
              file() {
                if (failureStage === 'metadata') throw failure
              },
              generateNodeStream() {
                if (failureStage === 'stream') throw failure
                return new ControlledArchiveStream()
              },
            }
          },
        },
      ),
      (error) => error === failure,
    )
    assert.deepEqual(releases, { compaction: 1, lease: 1 }, failureStage)
  }
})
