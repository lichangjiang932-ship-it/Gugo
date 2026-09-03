import { getDb } from '../db.js'
import { reconcileEvolutionConfigJournal } from './evolutionConfigJournalService.js'
import { readRuntimePluginConfigSourceSnapshot } from '../plugins/runtimePluginConfigFile.js'
import {
  applyRuntimeConfig,
  applyRuntimeStorageBootstrap,
  assertRuntimeStartupIdentityStable,
  resolveRuntimeStartupEnvironment,
} from '../utils/runtimeEnv.js'

/**
 * Complete any interrupted reviewed config change before the runtime imports
 * or starts components that can consume configuration. The journal recovery
 * is synchronous and fail-closed; callers must not continue startup if it
 * throws.
 */
export function runRuntimeConfigStartupPreflight({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  // Resolve and publish only the storage identity before opening SQLite. The
  // complete runtime configuration remains inactive until its pending journal
  // has been reconciled against the migrated audit tables.
  const storageEnv = applyRuntimeStorageBootstrap({ cwd, env })
  getDb()
  const recovery = reconcileEvolutionConfigJournal({
    userId: null,
    cwd,
    env: {
      ...env,
      APP_DATA_DIR: storageEnv.APP_DATA_DIR,
      APP_DB_PATH: storageEnv.APP_DB_PATH,
      ARTIFACT_DIR: storageEnv.ARTIFACT_DIR,
      ...(storageEnv.APP_CONFIG_PATH
        ? { APP_CONFIG_PATH: storageEnv.APP_CONFIG_PATH }
        : {}),
    },
  })
  const resolvedRuntimeEnv = resolveRuntimeStartupEnvironment({ cwd, env })
  assertRuntimeStartupIdentityStable(storageEnv, resolvedRuntimeEnv)
  // Validate the exact post-journal plugin layer sources before importing the
  // application host. This shares the same deep layer contract as activation,
  // while retaining sourcePath so only user runtime.json can enter recovery.
  readRuntimePluginConfigSourceSnapshot({ cwd, env: resolvedRuntimeEnv })
  const runtimeEnv = applyRuntimeConfig({ cwd, env, resolvedEnv: resolvedRuntimeEnv })
  return Object.freeze({ recovery, runtimeEnv })
}
