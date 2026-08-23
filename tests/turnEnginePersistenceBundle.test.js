import assert from 'node:assert/strict'
import test from 'node:test'

import { SQLITE_TURN_PERSISTENCE_ADAPTER } from '../server/adapters/sqliteTurnPersistenceAdapter.js'
import { TurnEngine } from '../server/services/TurnEngine.js'
import {
  createTurnEnginePersistenceBundle,
  requireTurnEnginePersistenceBundle,
  TURN_ENGINE_FLAT_PERSISTENCE_OPTIONS,
} from '../server/services/turnEnginePersistenceBundle.js'
import {
  createTestTurnEnginePersistence,
  PREPARED_SQLITE_TURN_PERSISTENCE_ADAPTER,
} from './helpers/turnEnginePersistence.js'

test('test persistence helper uses the prepared production SQLite adapter and frozen bundle', () => {
  const persistence = createTestTurnEnginePersistence()

  assert.equal(persistence.adapterId, SQLITE_TURN_PERSISTENCE_ADAPTER.id)
  assert.equal(persistence.adapterContractVersion, SQLITE_TURN_PERSISTENCE_ADAPTER.contractVersion)
  assert.equal(Object.isFrozen(persistence), true)
  assert.equal(Object.isFrozen(persistence.session), true)
  assert.equal(Object.isFrozen(persistence.eventLog), true)
  assert.equal(requireTurnEnginePersistenceBundle(persistence), persistence)
})

test('raw, incomplete, non-atomic, and forged persistence bundles fail closed', () => {
  assert.throws(
    () => createTurnEnginePersistenceBundle(SQLITE_TURN_PERSISTENCE_ADAPTER),
    (error) => error?.code === 'TURN_ENGINE_PERSISTENCE_BUNDLE_INVALID',
  )
  assert.throws(
    () => createTurnEnginePersistenceBundle({ id: 'incomplete', contractVersion: 6 }),
    (error) => error?.code === 'TURN_ENGINE_PERSISTENCE_BUNDLE_INVALID',
  )
  assert.throws(
    () => createTurnEnginePersistenceBundle({
      ...PREPARED_SQLITE_TURN_PERSISTENCE_ADAPTER,
      eventLog: {
        ...PREPARED_SQLITE_TURN_PERSISTENCE_ADAPTER.eventLog,
        supportsAtomicCheckpointState: false,
      },
    }),
    (error) => error?.code === 'TURN_ENGINE_PERSISTENCE_BUNDLE_INVALID',
  )
  assert.throws(
    () => requireTurnEnginePersistenceBundle(Object.freeze({
      ...createTestTurnEnginePersistence(),
    })),
    (error) => error?.code === 'TURN_ENGINE_PERSISTENCE_BUNDLE_INVALID',
  )
})

test('TurnEngine rejects every legacy flat persistence option when a bundle is present', () => {
  for (const option of TURN_ENGINE_FLAT_PERSISTENCE_OPTIONS) {
    assert.throws(
      () => new TurnEngine({
        persistence: createTestTurnEnginePersistence(),
        [option]: null,
      }),
      (error) => error?.code === 'TURN_ENGINE_PERSISTENCE_BUNDLE_CONFLICT'
        && error.message.includes(option),
      option,
    )
  }
})

test('test persistence section overlays remain complete and each bundle owns its lease runtime', () => {
  const readSession = () => null
  const first = createTestTurnEnginePersistence({
    sectionOverrides: { session: { getSession: readSession } },
  })
  const second = createTestTurnEnginePersistence()

  assert.equal(first.session.getSession, readSession)
  assert.notEqual(first.runtimeCore.lease.ownerId, second.runtimeCore.lease.ownerId)
  assert.throws(
    () => createTestTurnEnginePersistence({ sectionOverrides: { unknown: {} } }),
    /unknown Turn persistence section/u,
  )
})
