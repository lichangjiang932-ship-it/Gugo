import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createFileDeliveryPolicy } from './policy.mjs'
import { startVerificationHostLifecycle } from './hostLifecycle.mjs'
import { offlineVerificationTransportPlugin } from './offlineHttpGuard.mjs'

async function acquireOfflineVerificationPolicy() {
  const { configureHostVerificationPolicy } = await import('../../server/core/hostVerificationPolicy.js')
  const policy = createFileDeliveryPolicy({
    workspace: process.env.WORKSPACE_ROOT,
    allowedTools: ['list_directory', 'read_file', 'write_file', 'create_docx', 'set_deliverables'],
    modelBaseUrl: '',
  })
  const offlinePolicy = {
    ...policy,
    beforeModelRequest: () => { throw Object.assign(new Error('Offline verification cannot call a model'), {
      code: 'FILE_DELIVERY_OFFLINE', retryable: false, unsafeToReplay: true, modelRequestOutcome: 'not_sent',
    }) },
  }
  return { policy, lease: configureHostVerificationPolicy(offlinePolicy) }
}

async function createVerificationServer({ runRoot, projectRoot, port, registerRuntimeCleanup }) {
  const { resolveBuiltinSqliteTurnPersistenceBootstrap } = await import('../../server/adapters/builtinSqliteTurnPersistenceBootstrap.js')
  const persistence = await resolveBuiltinSqliteTurnPersistenceBootstrap({ cwd: runRoot, env: process.env })
  const { runRuntimeConfigStartupPreflight } = await import('../../server/services/runtimeConfigStartupService.js')
  const { runtimeEnv } = runRuntimeConfigStartupPreflight({ cwd: runRoot, env: process.env })
  const [
    vite, config, app, http, registry, middleware, plugins, lifecycle, capabilities, subagents, database, localRequest,
  ] = await Promise.all([
    import('vite'), import(pathToFileURL(path.join(projectRoot, 'vite.config.js')).href),
    import('../../server/appServer.js'), import('../../server/core/builtinHttpCapabilities.js'),
    import('../../server/core/httpCapabilityRegistry.js'), import('../../server/middleware.js'),
    import('../../server/plugins/pluginRegistry.js'), import('../../server/core/lifecycle.js'),
    import('../../server/core/runtimeCapabilityHost.js'), import('../../server/adapters/sqliteSubagentRunPersistenceAdapter.js'),
    import('../../server/db.js'), import('../../server/utils/localRequestPolicy.js'),
  ])
  const frontend = await config.default({ command: 'build', mode: 'development', isPreview: true })
  plugins.initializeRuntimePluginConfig({ cwd: runRoot, env: runtimeEnv })
  const runtimeLifecycle = config.runtimeLifecyclePlugin({
    acquireHostTurnPersistenceCapability: capabilities.acquireHostTurnPersistenceCapability,
    bootstrap: lifecycle.bootstrap, createBoundTurnPersistenceAdapter: capabilities.createBoundTurnPersistenceAdapter,
    gracefulShutdown: lifecycle.gracefulShutdown, prepareRuntimeCapabilitySnapshot: capabilities.prepareRuntimeCapabilitySnapshot,
    runtimeCwd: runRoot, runtimeEnv, selectedToolLoopAdapter: capabilities.selectedToolLoopAdapter,
    subagentRunPersistenceAdapter: subagents.createSqliteSubagentRunPersistenceAdapter({ getDb: database.getDb }),
    turnPersistenceAdapter: persistence.adapter,
  })
  // createServer can fail after configureServer bootstraps the runtime, before
  // returning a closeable Vite handle. Retain its existing drain hook for rollback.
  registerRuntimeCleanup(() => runtimeLifecycle.closeBundle())
  const backendPlugins = [
    offlineVerificationTransportPlugin(),
    config.developmentHttpCapabilityPlugin({
      enforceLocalRequestBoundary: localRequest.enforceLocalRequestBoundary,
      bindRuntimePluginHttpCapabilities: plugins.bindRuntimePluginHttpCapabilities,
      createHttpCapabilityRegistry: registry.createHttpCapabilityRegistry,
      healthCheck: app.healthCheck, healthCheckFull: app.healthCheckFull,
      registerBuiltinHttpCapabilities: http.registerBuiltinHttpCapabilities,
      requireAuth: middleware.requireAuth, runtimeCwd: runRoot, runtimeEnv,
    }),
    runtimeLifecycle,
  ]
  return vite.createServer({
    ...frontend, configFile: false, envDir: false,
    cacheDir: path.join(runRoot, 'vite-cache'),
    plugins: [...backendPlugins, ...frontend.plugins],
    server: { host: '127.0.0.1', port, strictPort: true, open: false, hmr: false },
  })
}

/** Compose production HTTP/Turn consumers against fresh storage, never the source runtime cwd. */
export async function serveFileDeliveryVerification({ runRoot, projectRoot, port, modelBinding }, dependencies = {}) {
  // Both direct composition and IPC injection must fail before touching env or
  // loading a runtime. The live runner has not met its activation prerequisites.
  if (modelBinding != null) {
    throw Object.assign(new Error('Live verification is not available'), { code: 'FILE_DELIVERY_LIVE_UNAVAILABLE' })
  }
  return startVerificationHostLifecycle({
    acquirePolicy: dependencies.acquirePolicy || acquireOfflineVerificationPolicy,
    createServer: dependencies.createServer || (cleanup => createVerificationServer({ runRoot, projectRoot, port, ...cleanup })),
    saveSummary: dependencies.saveSummary || (policy => writeFileSync(path.join(runRoot, 'verification-host.json'), JSON.stringify({
      kind: 'file-delivery-verification-host', live: false, ...policy.snapshot(),
    }, null, 2))),
    onReady: dependencies.onReady || (() => console.log(`[file-delivery] ready: http://127.0.0.1:${port}; offline model denied`)),
    processHost: dependencies.processHost || process,
  })
}
