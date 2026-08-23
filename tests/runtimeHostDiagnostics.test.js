import assert from 'node:assert/strict'
import test from 'node:test'
import { getRuntimeHostDiagnostics } from '../server/services/runtimeHostDiagnostics.js'

test('runtime host diagnostics expose only public readiness booleans', () => {
  const diagnostics = getRuntimeHostDiagnostics({
    readPersistenceStatus: () => ({
      configured: true,
      adapterId: 'private-adapter-id',
      source: 'private.source',
    }),
    readCompactionStatus: () => ({
      configured: true,
      portId: 'private-port-id',
      source: 'private.source',
    }),
  })

  assert.deepEqual(diagnostics, {
    turnHost: {
      ready: true,
      persistenceConfigured: true,
      compactionArchiveConfigured: true,
    },
  })
  assert.equal(Object.isFrozen(diagnostics), true)
  assert.equal(Object.isFrozen(diagnostics.turnHost), true)
})

test('runtime host diagnostics fail closed when either required host port is missing', () => {
  const diagnostics = getRuntimeHostDiagnostics({
    readPersistenceStatus: () => ({ configured: true }),
    readCompactionStatus: () => ({ configured: false }),
  })

  assert.deepEqual(diagnostics, {
    turnHost: {
      ready: false,
      persistenceConfigured: true,
      compactionArchiveConfigured: false,
    },
  })
})

test('runtime host diagnostics reject invalid status readers without touching the host', () => {
  assert.throws(
    () => getRuntimeHostDiagnostics({ readPersistenceStatus: null }),
    /readers must be functions/,
  )
})
