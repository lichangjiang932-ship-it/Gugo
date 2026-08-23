import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

function localAuthExposureGuardPlugin({
  devHost,
  enforceLocalAuthExposurePolicy,
  runtimeEnv,
}) {
  return {
    name: 'local-auth-exposure-guard',
    enforce: 'pre',
    configureServer(server) {
      const configuredHost = server.config.server.host
      const listenerHost = configuredHost === true
        ? '0.0.0.0'
        : (configuredHost || devHost)
      enforceLocalAuthExposurePolicy(runtimeEnv, {
        listenerHost,
        surface: 'Vite development server',
        warn: (message) => server.config.logger.warn(message),
      })
    },
  }
}

export function runtimeLifecyclePlugin({
  acquireHostTurnPersistenceCapability,
  bootstrap,
  createBoundTurnPersistenceAdapter,
  gracefulShutdown,
  prepareRuntimeCapabilitySnapshot,
  runtimeCwd,
  runtimeEnv,
  selectedToolLoopAdapter,
  subagentRunPersistenceAdapter,
  turnPersistenceAdapter,
}) {
  let lifecycleBootstrapped = false
  let shutdownPromise = null
  let runtimeLogger = null
  let persistenceLease = null

  const releasePersistenceLease = () => {
    if (!persistenceLease) return false
    const lease = persistenceLease
    const released = lease.release()
    if (!released) {
      const error = new Error('development runtime persistence lease could not be released')
      error.code = 'DEV_RUNTIME_PERSISTENCE_LEASE_RELEASE_FAILED'
      throw error
    }
    if (persistenceLease === lease) persistenceLease = null
    return true
  }

  const shutdownRuntime = async () => {
    if (!lifecycleBootstrapped) {
      releasePersistenceLease()
      return 0
    }
    if (shutdownPromise) return shutdownPromise
    // Defer the host call into the promise chain so even a synchronous throw
    // happens after shutdownPromise owns this attempt and can clear it.
    const attempt = Promise.resolve()
      .then(() => gracefulShutdown(null, { silent: true, exit: false }))
      .then((exitCode) => {
        if (exitCode === 0) releasePersistenceLease()
        return exitCode
      })
      .finally(() => {
        // A failed lifecycle stop retains the lease and must remain retryable.
        // A successful stop clears the lease and keeps the settled promise as
        // the one-shot shutdown receipt for concurrent/repeated close hooks.
        if (shutdownPromise === attempt && persistenceLease) shutdownPromise = null
      })
    shutdownPromise = attempt
    return shutdownPromise
  }

  const reportShutdownFailure = (error) => {
    runtimeLogger?.error(`[runtime] development shutdown failed: ${error?.message || error}`)
  }

  return {
    name: 'builtin-runtime-lifecycle',
    enforce: 'pre',
    async configureServer(server) {
      if (persistenceLease || lifecycleBootstrapped) {
        const error = new Error('development runtime lifecycle is already configured')
        error.code = 'DEV_RUNTIME_LIFECYCLE_ALREADY_CONFIGURED'
        throw error
      }
      runtimeLogger = server.config.logger
      try {
        persistenceLease = acquireHostTurnPersistenceCapability(turnPersistenceAdapter)
        const snapshot = await prepareRuntimeCapabilitySnapshot({
          cwd: runtimeCwd,
          env: runtimeEnv,
        })
        const startup = bootstrap({
          cwd: runtimeCwd,
          runtimeEnv,
          subagentRunPersistenceAdapter,
          turnPersistenceAdapter: createBoundTurnPersistenceAdapter(snapshot),
          toolLoopAdapter: selectedToolLoopAdapter(snapshot),
        })
        lifecycleBootstrapped = true
        const result = await startup.ready
        const fatal = result.failures.find((entry) => entry.capability.startFailure === 'fail')
        if (fatal) {
          const error = new Error(
            `development runtime capability failed: ${fatal.capability.id}: ${fatal.error?.message || 'unknown error'}`,
          )
          error.code = 'DEV_RUNTIME_STARTUP_CAPABILITY_FAILED'
          error.cause = fatal.error
          throw error
        }
      } catch (error) {
        try {
          const exitCode = await shutdownRuntime()
          if (exitCode !== 0) {
            const shutdownError = new Error(
              `development runtime rollback failed with exit code ${exitCode}`,
            )
            shutdownError.code = 'DEV_RUNTIME_ROLLBACK_FAILED'
            shutdownError.exitCode = exitCode
            throw shutdownError
          }
        } catch (shutdownError) {
          throw new AggregateError(
            [error, shutdownError],
            'development runtime startup and rollback failed',
            { cause: shutdownError },
          )
        }
        throw error
      }
      server.httpServer?.once('close', () => {
        void shutdownRuntime().catch(reportShutdownFailure)
      })
    },
    async closeBundle() {
      const exitCode = await shutdownRuntime()
      if (exitCode !== 0) {
        const error = new Error(`development runtime shutdown failed with exit code ${exitCode}`)
        error.code = 'DEV_RUNTIME_SHUTDOWN_FAILED'
        throw error
      }
    },
  }
}

function turnRealtimePlugin({ attachTurnWebSocketServer, getTurnEngine }) {
  return {
    name: 'turn-realtime-websocket',
    configureServer(server) {
      if (!server.httpServer) {
        throw new Error('Vite HTTP server is unavailable for /api/realtime')
      }
      attachTurnWebSocketServer(server.httpServer, {
        listEvents: (scope) => getTurnEngine().listEvents(scope),
      })
    },
  }
}

function developmentHttpCapabilityPlugin({
  bindRuntimePluginHttpCapabilities,
  createHttpCapabilityRegistry,
  healthCheck,
  healthCheckFull,
  registerBuiltinHttpCapabilities,
  requireAuth,
  runtimeCwd,
  runtimeEnv,
}) {
  return {
    name: 'local-runtime-http-capabilities',
    enforce: 'pre',
    configureServer(server) {
      const registry = createHttpCapabilityRegistry()
      const getEnv = () => runtimeEnv
      const disposeBuiltins = registerBuiltinHttpCapabilities(registry, {
        cwd: runtimeCwd,
        getEnv,
      })
      let disposePluginBinding = null
      try {
        disposePluginBinding = bindRuntimePluginHttpCapabilities(registry)
      } catch (error) {
        disposeBuiltins()
        registry.disposeAll()
        throw error
      }

      let disposed = false
      const dispose = () => {
        if (disposed) return false
        disposed = true
        disposePluginBinding?.()
        registry.disposeAll()
        return true
      }
      server.httpServer?.once('close', dispose)

      server.middlewares.use((req, res, next) => {
        if (req.url === '/api/health') {
          healthCheck(req, res)
          return
        }
        if (req.url === '/api/health/full') {
          requireAuth(req, res, () => healthCheckFull(req, res, getEnv))
          return
        }
        const dispatched = registry.dispatch(req, res, {
          cwd: runtimeCwd,
          getEnv,
        })
        if (dispatched.handled) return
        next()
      })
    },
  }
}

async function loadDevelopmentRuntime({ runtimeCwd, startupEnv }) {
  // This must be the first server-side import. Preflight publishes the final
  // storage identity before a runtime singleton can open SQLite or recover.
  const { resolveBuiltinSqliteTurnPersistenceBootstrap } = await import(
    './server/adapters/builtinSqliteTurnPersistenceBootstrap.js'
  )
  const persistenceBootstrap = await resolveBuiltinSqliteTurnPersistenceBootstrap({
    cwd: runtimeCwd,
    env: startupEnv,
  })
  const { runRuntimeConfigStartupPreflight } = await import(
    './server/services/runtimeConfigStartupService.js'
  )
  const { runtimeEnv } = runRuntimeConfigStartupPreflight({
    cwd: runtimeCwd,
    env: startupEnv,
  })

  const [
    appServer,
    builtinHttpCapabilities,
    httpCapabilityRegistry,
    middleware,
    pluginRegistry,
    turnWebSocket,
    turnEngineHost,
    lifecycle,
    runtimeCapabilityHost,
    sqliteSubagentRunPersistence,
    database,
  ] = await Promise.all([
    import('./server/appServer.js'),
    import('./server/core/builtinHttpCapabilities.js'),
    import('./server/core/httpCapabilityRegistry.js'),
    import('./server/middleware.js'),
    import('./server/plugins/pluginRegistry.js'),
    import('./server/services/turnWebSocket.js'),
    import('./server/services/turnEngineHost.js'),
    import('./server/core/lifecycle.js'),
    import('./server/core/runtimeCapabilityHost.js'),
    import('./server/adapters/sqliteSubagentRunPersistenceAdapter.js'),
    import('./server/db.js'),
  ])

  pluginRegistry.initializeRuntimePluginConfig({ cwd: runtimeCwd, env: runtimeEnv })
  const subagentRunPersistenceAdapter = (
    sqliteSubagentRunPersistence.createSqliteSubagentRunPersistenceAdapter({
      getDb: database.getDb,
    })
  )
  const devHost = runtimeEnv.SERVER_HOST || '127.0.0.1'
  const devPort = Number(runtimeEnv.VITE_DEV_PORT || runtimeEnv.SERVER_PORT || 5175)

  return {
    devHost,
    devPort,
    runtimeEnv,
    plugins: [
      developmentHttpCapabilityPlugin({
        bindRuntimePluginHttpCapabilities: pluginRegistry.bindRuntimePluginHttpCapabilities,
        createHttpCapabilityRegistry: httpCapabilityRegistry.createHttpCapabilityRegistry,
        healthCheck: appServer.healthCheck,
        healthCheckFull: appServer.healthCheckFull,
        registerBuiltinHttpCapabilities: builtinHttpCapabilities.registerBuiltinHttpCapabilities,
        requireAuth: middleware.requireAuth,
        runtimeCwd,
        runtimeEnv,
      }),
      localAuthExposureGuardPlugin({
        devHost,
        enforceLocalAuthExposurePolicy: appServer.enforceLocalAuthExposurePolicy,
        runtimeEnv,
      }),
      runtimeLifecyclePlugin({
        acquireHostTurnPersistenceCapability:
          runtimeCapabilityHost.acquireHostTurnPersistenceCapability,
        bootstrap: lifecycle.bootstrap,
        createBoundTurnPersistenceAdapter: runtimeCapabilityHost.createBoundTurnPersistenceAdapter,
        gracefulShutdown: lifecycle.gracefulShutdown,
        prepareRuntimeCapabilitySnapshot: runtimeCapabilityHost.prepareRuntimeCapabilitySnapshot,
        runtimeCwd,
        runtimeEnv,
        selectedToolLoopAdapter: runtimeCapabilityHost.selectedToolLoopAdapter,
        subagentRunPersistenceAdapter,
        turnPersistenceAdapter: persistenceBootstrap.adapter,
      }),
      turnRealtimePlugin({
        attachTurnWebSocketServer: turnWebSocket.attachTurnWebSocketServer,
        getTurnEngine: turnEngineHost.getTurnEngine,
      }),
    ],
  }
}

// Build and preview are pure frontend operations. Only a real Vite development
// server owns the local backend runtime; preview serves already-built assets.
export default defineConfig(async ({ command, mode, isPreview }) => {
  const runtimeCwd = process.cwd()
  const fileEnv = process.env.GUGO_LOAD_DOTENV !== '0'
    ? loadEnv(mode, runtimeCwd, '')
    : {}
  const frontendEnv = { ...fileEnv, ...process.env }
  const runsDevelopmentRuntime = command === 'serve' && !isPreview
  const development = runsDevelopmentRuntime
    ? await loadDevelopmentRuntime({ runtimeCwd, startupEnv: frontendEnv })
    : null
  const serverEnv = development?.runtimeEnv || frontendEnv
  const devHost = development?.devHost || serverEnv.SERVER_HOST || '127.0.0.1'
  const devPort = development?.devPort
    || Number(serverEnv.VITE_DEV_PORT || serverEnv.SERVER_PORT || 5175)

  return {
    plugins: [...(development?.plugins || []), react()],
    base: serverEnv.PUBLIC_BASE_PATH || '/',
    server: {
      host: devHost,
      port: devPort,
      watch: {
        ignored: [
          '**/.tmp/**',
          '**/output/**',
          '**/release/**',
          '**/release-*/**',
        ],
      },
      strictPort: true,
    },
    build: {
      chunkSizeWarningLimit: 1100,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/react-router')) return 'vendor-react'
            if (id.includes('node_modules/react-dom')) return 'vendor-react'
            if (id.includes('node_modules/react/')) return 'vendor-react'
            if (id.includes('node_modules/scheduler')) return 'vendor-react'
            if (id.includes('node_modules/framer-motion')) return 'vendor-motion'
            if (id.includes('node_modules/lucide-react')) return 'vendor-icons'
            if (id.includes('node_modules/highlight.js')) return 'vendor-hljs'
            if (id.includes('node_modules/react-markdown')
                || id.includes('node_modules/remark-')
                || id.includes('node_modules/rehype-')
                || id.includes('node_modules/micromark')
                || id.includes('node_modules/mdast-')
                || id.includes('node_modules/hast-')
                || id.includes('node_modules/unist-')
                || id.includes('node_modules/unified')
                || id.includes('node_modules/vfile')
                || id.includes('node_modules/property-information')
                || id.includes('node_modules/space-separated-tokens')
                || id.includes('node_modules/comma-separated-tokens')) return 'vendor-markdown'
            if (id.includes('node_modules/dompurify')) return 'vendor-purify'
            if (id.includes('node_modules/zod')) return 'vendor-zod'
            return undefined
          },
        },
      },
    },
  }
})
