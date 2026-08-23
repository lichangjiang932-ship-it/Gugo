import { createCompactionArchivePortController } from '../../server/core/compactionArchivePort.js'
import { createSqliteFileCompactionArchiveAdapter } from '../../server/services/sqliteFileCompactionArchiveAdapter.js'

export function createTestCompactionArchiveAdapter({ env = process.env } = {}) {
  return createSqliteFileCompactionArchiveAdapter({ env })
}

export function activateTestCompactionArchivePort({
  env = process.env,
  source = 'test.compaction-archive',
} = {}) {
  const controller = createCompactionArchivePortController(
    createTestCompactionArchiveAdapter({ env }),
    { source },
  )
  controller.activate()
  return controller
}
