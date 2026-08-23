import { createCompactionArchivePortController } from '../core/compactionArchivePort.js'
import { getDb } from '../db.js'
import { recoverPendingSessionDeletion } from '../services/sessionDeletionGovernanceRuntime.js'
import { createSqliteFileCompactionArchiveAdapter } from '../services/sqliteFileCompactionArchiveAdapter.js'

function requireController(controller) {
  if (typeof controller?.activate !== 'function' || typeof controller?.release !== 'function') {
    const error = new TypeError(
      'Hub session deletion recovery requires a compaction archive controller',
    )
    error.code = 'HUB_SESSION_DELETION_RECOVERY_DEPENDENCY_MISSING'
    throw error
  }
  return controller
}

/**
 * Hub-owned startup barrier for the shared SQLite/user-data runtime.
 *
 * This is deliberately smaller than either Web lifecycle assembly: Hub only
 * needs the production archive binding long enough to reconcile durable
 * session deletion before a queue handler can observe the shared database.
 */
export function createHubSessionDeletionRecoveryBarrier(dependencies = {}) {
  const openDatabase = dependencies.getDb || getDb
  const createAdapter = dependencies.createCompactionArchiveAdapter
    || createSqliteFileCompactionArchiveAdapter
  const createController = dependencies.createCompactionArchivePortController
    || createCompactionArchivePortController
  const recover = dependencies.recoverPendingSessionDeletion
    || recoverPendingSessionDeletion
  let activeController = null

  return Object.freeze({
    start({ env = process.env } = {}) {
      if (activeController) {
        const error = new Error('Hub session deletion recovery barrier is already active')
        error.code = 'HUB_SESSION_DELETION_RECOVERY_STATE_CONFLICT'
        throw error
      }

      const db = openDatabase()
      const controller = requireController(createController(
        createAdapter({ db, env }),
        { source: 'hub.runtime' },
      ))
      let activated = false
      try {
        controller.activate()
        activated = true
        const result = recover({ db })
        activeController = controller
        return result
      } catch (error) {
        if (!activated) throw error
        try {
          controller.release()
        } catch (releaseError) {
          throw new AggregateError(
            [error, releaseError],
            'Hub session deletion recovery failed and its compaction archive port could not be released',
            { cause: releaseError },
          )
        }
        throw error
      }
    },

    stop() {
      if (!activeController) return false
      const controller = activeController
      controller.release()
      activeController = null
      return true
    },
  })
}
