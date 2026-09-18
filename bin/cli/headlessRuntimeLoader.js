const environments = new WeakMap()

export function headlessRuntimeEnvironment(runtime, fallback = {}) {
  return environments.get(runtime) || fallback
}

/** Shared lazy host bootstrap for run and chat; never import the CLI entrypoint. */
export async function loadBuiltinHeadlessRuntime({ runtimeCwd = process.cwd(), env = process.env } = {}) {
  // Trusted persistence is selected before preflight/identity can open SQLite.
  // Project .env files may choose data settings, never executable host code.
  const persistenceEnv = Object.freeze({ ...env })
  const { resolveBuiltinSqliteTurnPersistenceBootstrap } = await import(
    '../../server/adapters/builtinSqliteTurnPersistenceBootstrap.js'
  )
  const persistenceBootstrap = await resolveBuiltinSqliteTurnPersistenceBootstrap({ cwd: runtimeCwd, env: persistenceEnv })
  const { runRuntimeConfigStartupPreflight } = await import('../../server/services/runtimeConfigStartupService.js')
  const { runtimeEnv } = runRuntimeConfigStartupPreflight({ cwd: runtimeCwd, env })
  const { runBuiltinHeadlessTurn } = await import('../../server/adapters/headlessTurnHost.js')
  const runtime = (options) => runBuiltinHeadlessTurn({
    ...options, runtimeCwd, runtimeEnv, env: runtimeEnv,
    turnPersistenceAdapter: persistenceBootstrap.adapter,
    turnPersistenceProvenance: persistenceBootstrap.provenance,
  })
  environments.set(runtime, runtimeEnv)
  return runtime
}
