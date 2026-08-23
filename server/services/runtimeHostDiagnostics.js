import { getCompactionArchivePortStatus } from '../core/compactionArchivePort.js'
import { getTurnPersistenceAdapterStatus } from '../core/turnPersistenceAdapter.js'

/**
 * Return a public, read-only host health snapshot without acquiring a lease or
 * initializing TurnEngine. Adapter identities, sources, paths, and audit data
 * intentionally stay on the server side.
 */
export function getRuntimeHostDiagnostics({
  readPersistenceStatus = getTurnPersistenceAdapterStatus,
  readCompactionStatus = getCompactionArchivePortStatus,
} = {}) {
  if (typeof readPersistenceStatus !== 'function' || typeof readCompactionStatus !== 'function') {
    throw new TypeError('runtime host diagnostics readers must be functions')
  }

  const persistenceConfigured = readPersistenceStatus()?.configured === true
  const compactionArchiveConfigured = readCompactionStatus()?.configured === true

  return Object.freeze({
    turnHost: Object.freeze({
      ready: persistenceConfigured && compactionArchiveConfigured,
      persistenceConfigured,
      compactionArchiveConfigured,
    }),
  })
}
