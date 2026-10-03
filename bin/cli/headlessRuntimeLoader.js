import { assertCliRuntimeDirectory, resolveCliRuntimeSelection } from './runtimeSelection.js'

const environments = new WeakMap()

export function headlessRuntimeEnvironment(runtime, fallback = {}) {
  return environments.get(runtime) || fallback
}

/** Shared lazy host bootstrap for run and chat; never import the CLI entrypoint. */
export async function loadBuiltinHeadlessRuntime({ runtimeCwd = null, env = process.env } = {}) {
  // Trusted persistence is selected before preflight/identity can open SQLite.
  // Project .env files may choose data settings, never executable host code.
  const persistenceEnv = Object.freeze({ ...env })
  runtimeCwd = resolveCliRuntimeSelection({ runtimeDir: runtimeCwd, env: persistenceEnv }).cwd
  assertCliRuntimeDirectory(runtimeCwd)
  const { resolveBuiltinSqliteTurnPersistenceBootstrap } = await import(
    '../../server/adapters/builtinSqliteTurnPersistenceBootstrap.js'
  )
  const persistenceBootstrap = await resolveBuiltinSqliteTurnPersistenceBootstrap({ cwd: runtimeCwd, env: persistenceEnv })
  const { runRuntimeConfigStartupPreflight } = await import('../../server/services/runtimeConfigStartupService.js')
  let { runtimeEnv } = runRuntimeConfigStartupPreflight({ cwd: runtimeCwd, env: persistenceEnv })
  const initialIdentity = runtimeEnv
  const { runBuiltinHeadlessTurn } = await import('../../server/adapters/headlessTurnHost.js')
  const runtime = async (options) => {
    if (options?.signal?.aborted) {
      throw options.signal.reason || Object.assign(new Error('turn cancelled before configuration reload'), { code: 'CLI_RUN_CANCELLED', exitCode: 130 })
    }
    runtimeEnv = runRuntimeConfigStartupPreflight({
      cwd: runtimeCwd, env: persistenceEnv,
      expectedRuntimeIdentity: initialIdentity, previousRuntimeEnv: runtimeEnv,
    }).runtimeEnv
    environments.set(runtime, runtimeEnv)
    return runBuiltinHeadlessTurn({
      ...options, runtimeCwd, runtimeEnv, env: runtimeEnv,
      turnPersistenceAdapter: persistenceBootstrap.adapter,
      turnPersistenceProvenance: persistenceBootstrap.provenance,
    })
  }
  environments.set(runtime, runtimeEnv)
  return runtime
}
