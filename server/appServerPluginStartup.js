export function createRuntimePluginStartupReady({
  listeningReady,
  startupAbortGuard,
  createCompactionArchiveController,
  compactionArchiveAdapter,
  createDefaultCompactionArchiveAdapter,
  runtimeEnv,
  recoverPendingSessionDeletion,
  initializeRuntimePluginConfig,
  cwd,
  acquireHostTurnPersistenceCapability,
  turnPersistenceAdapter,
  registerServerShutdownFinalizer,
  server,
  initPlugins,
  runtimePluginRoot,
  restoreEnabledRuntimePlugins,
  logger,
  releasePreparedCompactionArchive,
}) {
  return listeningReady.then(async () => {
    let compactionArchiveController = null
    let persistenceLease = null
    let persistenceFinalizerRegistered = false
    try {
      startupAbortGuard.assertNotRequested()
      compactionArchiveController = createCompactionArchiveController(
        compactionArchiveAdapter || createDefaultCompactionArchiveAdapter({ env: runtimeEnv }),
        { source: 'app.server' },
      )
      compactionArchiveController.activate()
      recoverPendingSessionDeletion()
      startupAbortGuard.assertNotRequested()
      initializeRuntimePluginConfig({ cwd, env: runtimeEnv })
      persistenceLease = acquireHostTurnPersistenceCapability(turnPersistenceAdapter)
      registerServerShutdownFinalizer(server, () => persistenceLease.release())
      persistenceFinalizerRegistered = true
      const discovery = initPlugins({
        rootDir: runtimePluginRoot,
        silent: process.env.NODE_ENV === 'production',
        includeManaged: true,
        cwd,
        env: runtimeEnv,
      })
      const restored = await restoreEnabledRuntimePlugins({ env: runtimeEnv })
      for (const result of restored || []) {
        if (!result?.ok) {
          logger.warn(
            `[plugins] runtime restore failed for ${result?.pluginId}: ${result?.error?.message || result?.error}`,
          )
        }
      }
      startupAbortGuard.assertNotRequested()
      return Object.freeze({
        compactionArchiveController,
        discovery,
        restored: Object.freeze([...(restored || [])]),
      })
    } catch (error) {
      if (persistenceLease && !persistenceFinalizerRegistered) {
        try {
          persistenceLease.release()
        } catch (releaseError) {
          return releasePreparedCompactionArchive(
            compactionArchiveController,
            new AggregateError(
              [error, releaseError],
              'application startup failed and the host persistence lease could not be released',
              { cause: releaseError },
            ),
          )
        }
      }
      return releasePreparedCompactionArchive(compactionArchiveController, error)
    }
  })
}
