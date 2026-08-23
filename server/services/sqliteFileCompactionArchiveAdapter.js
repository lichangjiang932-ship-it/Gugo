import {
  createCompactionArchiveRecord,
  getCompactionArchiveRecord,
} from './compactionArchiveStore.js'
import { cleanupCompactionArchiveOrphans } from './compactionArchiveStorageGc.js'
import { createSqliteFileCompactionArchiveGovernance } from './sqliteFileCompactionArchiveGovernance.js'

export function createSqliteFileCompactionArchiveAdapter({
  db,
  env,
  fileSystem,
  idFactory,
  now = Date.now,
  governanceTokenFactory,
  governanceTerminalRetentionMs,
} = {}) {
  const storageOptions = { db, env, fileSystem }
  const governance = createSqliteFileCompactionArchiveGovernance({
    ...storageOptions,
    now,
    tokenFactory: governanceTokenFactory,
    terminalRetentionMs: governanceTerminalRetentionMs,
  })
  return Object.freeze({
    apiVersion: 1,
    governanceApiVersion: 1,
    id: 'builtin.sqlite-file',
    create(input) {
      governance.assertMutationAllowed(input)
      cleanupCompactionArchiveOrphans({
        ...storageOptions,
        userId: input.userId,
        now: now(),
        maxEntries: 1_000,
      })
      return createCompactionArchiveRecord({
        ...storageOptions,
        ...input,
        ...(typeof idFactory === 'function' ? { id: idFactory() } : {}),
        now: now(),
      })
    },
    get(input) {
      return getCompactionArchiveRecord({ ...storageOptions, ...input })
    },
    cleanup(input) {
      return cleanupCompactionArchiveOrphans({
        ...storageOptions,
        ...input,
        now: now(),
      })
    },
    createExportSnapshot: governance.createExportSnapshot,
    listExportEntries: governance.listExportEntries,
    readExportChunk: governance.readExportChunk,
    releaseExportSnapshot: governance.releaseExportSnapshot,
    previewDeletion: governance.previewDeletion,
    stageDeletion: governance.stageDeletion,
    assertDeletionStable: governance.assertDeletionStable,
    commitDeletion: governance.commitDeletion,
    rollbackDeletion: governance.rollbackDeletion,
    recoverDeletion: governance.recoverDeletion,
  })
}
