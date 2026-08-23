import { runRuntimeConfigStartupPreflight } from './runtimeConfigStartupService.js'
import { readRuntimeEnvFile } from '../utils/runtimeEnv.js'

async function resolvePersistenceBootstrap({ cwd, env }, dependencies) {
  const bootstrapEnv = dependencies.persistenceBootstrapEnv || Object.freeze({
    ...(env.GUGO_LOAD_DOTENV !== '0' ? readRuntimeEnvFile(cwd) : {}),
    ...env,
  })
  const resolveBootstrap = dependencies.resolveBuiltinSqliteTurnPersistenceBootstrap
    || (await import('../adapters/builtinSqliteTurnPersistenceBootstrap.js'))
      .resolveBuiltinSqliteTurnPersistenceBootstrap
  return resolveBootstrap({
    cwd,
    env: bootstrapEnv,
  })
}

async function resolveSubagentRunPersistenceAdapter(dependencies) {
  if (dependencies.subagentRunPersistenceAdapter) {
    return dependencies.subagentRunPersistenceAdapter
  }
  const createAdapter = dependencies.createSqliteSubagentRunPersistenceAdapter
    || (await import('../adapters/sqliteSubagentRunPersistenceAdapter.js'))
      .createSqliteSubagentRunPersistenceAdapter
  const getDb = dependencies.getDb || (await import('../db.js')).getDb
  return createAdapter({ getDb })
}

/**
 * Shared composition entry for the Node process and Electron's in-process
 * fallback. Recoverable user configuration failures start only the local
 * recovery host; every other startup failure remains fail-closed.
 */
export async function startRuntimeServer({
  cwd = process.cwd(),
  env = process.env,
} = {}, dependencies = {}) {
  const preflight = dependencies.runRuntimeConfigStartupPreflight
    || runRuntimeConfigStartupPreflight

  try {
    // Persistence selection is a host bootstrap concern. Resolve and validate
    // it before preflight can open SQLite for the distribution's remaining
    // local stores or run migrations. Ordinary runtime plugin state is not
    // available on this path, avoiding a storage/plugin bootstrap cycle.
    const persistenceBootstrap = await resolvePersistenceBootstrap({ cwd, env }, dependencies)
    const subagentRunPersistenceAdapter = await resolveSubagentRunPersistenceAdapter(dependencies)
    const { runtimeEnv } = preflight({ cwd, env })
    const startAppServer = dependencies.startAppServer
      || (await import('../appServer.js')).startAppServer
    return startAppServer({
      cwd,
      runtimeEnv,
      turnPersistenceAdapter: persistenceBootstrap.adapter,
      subagentRunPersistenceAdapter,
    })
  } catch (error) {
    const recovery = dependencies.runtimeConfigRecovery
      || await import('./runtimeConfigRecoveryServer.js')
    if (!recovery.isRecoverableUserRuntimeConfigError({ error, cwd, env })) throw error

    // Semantic plugin configuration failures may occur after startup journal
    // reconciliation opened SQLite. Recovery mode must retain no DB handle.
    const closeDb = dependencies.closeDb || (await import('../db.js')).closeDb
    await closeDb()
    return recovery.startRuntimeConfigRecoveryServer({ startupError: error, cwd, env })
  }
}
