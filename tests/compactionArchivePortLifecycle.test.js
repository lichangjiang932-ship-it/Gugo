import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acquireCompactionArchivePort,
  createCompactionArchivePort,
  createCompactionArchivePortController,
  getCompactionArchivePortStatus,
  listCompactionArchivePortAuditEvents,
} from '../server/core/compactionArchivePort.js'

function adapter(id) {
  return {
    apiVersion: 1,
    id,
    create(input) {
      return {
        id: 'archive-1',
        userId: input.userId,
        sessionId: input.sessionId,
        replacedMessageCount: input.archivedMessages.length,
        archivedMessages: input.archivedMessages,
        summaryText: input.summaryText,
        createdAt: 1,
      }
    },
    get() {
      return null
    },
    cleanup() {
      return { removed: 0 }
    },
  }
}

test('CompactionArchivePort acquire fails closed until a controller activates it', () => {
  assert.deepEqual(getCompactionArchivePortStatus(), {
    configured: false,
    portId: null,
    apiVersion: 1,
    activeLeases: 0,
    source: null,
  })
  assert.throws(
    () => acquireCompactionArchivePort(),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_NOT_CONFIGURED',
  )
})

test('controller enforces one active port and refuses release while a lease is active', () => {
  const firstPort = createCompactionArchivePort(adapter('test.lifecycle-first'))
  const first = createCompactionArchivePortController(firstPort, { source: 'test.lifecycle' })
  const second = createCompactionArchivePortController(adapter('test.lifecycle-second'))
  const firstCapability = first.activate()
  assert.notEqual(firstCapability, firstPort)
  assert.equal(first.activate(), firstCapability)
  assert.throws(
    () => second.activate(),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_ALREADY_ACTIVE',
  )

  const lease = acquireCompactionArchivePort()
  assert.equal(Object.isFrozen(lease), true)
  assert.notEqual(lease.port, firstCapability)
  assert.equal(lease.port.id, firstPort.id)
  assert.deepEqual(getCompactionArchivePortStatus(), {
    configured: true,
    portId: 'test.lifecycle-first',
    apiVersion: 1,
    activeLeases: 1,
    source: 'test.lifecycle',
  })
  assert.throws(
    () => first.release(),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_IN_USE',
  )
  assert.equal(lease.port.get({ userId: 'owner-1', id: 'archive-1' }), null)
  assert.equal(lease.release(), true)
  assert.equal(lease.release(), false)
  assert.throws(
    () => lease.port.get({ userId: 'owner-1', id: 'archive-1' }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_REVOKED',
  )
  assert.equal(first.release(), true)
  assert.equal(first.release(), false)
  assert.throws(
    () => firstCapability.get({ userId: 'owner-1', id: 'archive-1' }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_REVOKED',
  )

  const secondCapability = second.activate()
  assert.equal(getCompactionArchivePortStatus().portId, 'test.lifecycle-second')
  assert.equal(secondCapability.get({ userId: 'owner-1', id: 'archive-1' }), null)
  assert.throws(
    () => firstCapability.get({ userId: 'owner-1', id: 'archive-1' }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_REVOKED',
  )
  assert.equal(second.release(), true)

  const reactivated = first.activate()
  assert.notEqual(reactivated, firstCapability)
  assert.equal(reactivated.get({ userId: 'owner-1', id: 'archive-1' }), null)
  assert.throws(
    () => firstCapability.get({ userId: 'owner-1', id: 'archive-1' }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_REVOKED',
  )
  assert.equal(first.release(), true)

  // A trusted host port passed explicitly remains usable; only capabilities
  // issued by the controller/lease lifecycle are revocable.
  assert.equal(firstPort.get({ userId: 'owner-1', id: 'archive-1' }), null)
})

test('lifecycle audit is immutable and orders lease release before controller release', () => {
  const id = 'test.lifecycle-audit'
  const controller = createCompactionArchivePortController(adapter(id), {
    source: 'test.audit',
  })
  controller.activate()
  const first = acquireCompactionArchivePort()
  const second = acquireCompactionArchivePort()
  assert.equal(getCompactionArchivePortStatus().activeLeases, 2)
  first.release()
  second.release()
  controller.release()

  const audit = listCompactionArchivePortAuditEvents().filter((entry) => entry.portId === id)
  assert.deepEqual(audit.map((entry) => entry.event), [
    'compaction_archive.configured',
    'compaction_archive.lease_acquired',
    'compaction_archive.lease_acquired',
    'compaction_archive.lease_released',
    'compaction_archive.lease_released',
    'compaction_archive.released',
  ])
  assert.deepEqual(audit.map((entry) => entry.activeLeases ?? null), [null, 1, 2, 1, 0, null])
  assert.ok(audit.every((entry) => Object.isFrozen(entry)))
  assert.ok(audit.every((entry, index) => index === 0 || entry.sequence > audit[index - 1].sequence))
  assert.equal(Object.isFrozen(listCompactionArchivePortAuditEvents()), true)
})
