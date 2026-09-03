import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { logger, newTraceId, withLogContext } from './utils/logger.js'
import {
  corsMiddleware,
  securityHeaders,
  errorBoundary,
  requestLogger,
  requireAuth,
  createApiRateLimitMiddleware,
} from './middleware.js'
import { bootstrap, gracefulShutdown } from './core/lifecycle.js'
import { createCompactionArchivePortController } from './core/compactionArchivePort.js'
import { installHttpServerDrain } from './core/httpServerDrain.js'
import { createHttpCapabilityRegistry } from './core/httpCapabilityRegistry.js'
import { registerBuiltinHttpCapabilities } from './core/builtinHttpCapabilities.js'
import { startBuiltinBackgroundRuntimes } from './core/builtinLifecycleAssembly.js'
import { createStartupAbortGuard } from './core/startupAbortGuard.js'
import { registerServerShutdownFinalizer } from './core/serverShutdownFinalizers.js'
import {
  createRuntimeReadinessController,
  isRuntimeLivenessRequest,
  requiresRuntimeReadiness,
} from './core/runtimeReadiness.js'
import {
  acquireHostTurnPersistenceCapability,
  createBoundTurnPersistenceAdapter,
  prepareRuntimeCapabilitySnapshot,
  selectedToolLoopBinding,
} from './core/runtimeCapabilityHost.js'
import {
  bindRuntimePluginHttpCapabilities,
  initPlugins,
  initializeRuntimePluginConfig,
} from './plugins/pluginRegistry.js'
import { getRuntimeEnv } from './adapters/modelProxy.js'
import { isLocalHtmlPreviewTicketActive } from './services/localHtmlPreviewService.js'
import { runRuntimeConfigStartupPreflight } from './services/runtimeConfigStartupService.js'
import { restoreEnabledRuntimePlugins } from './services/runtimePluginControlService.js'
import { recoverPendingSessionDeletion } from './services/sessionDeletionGovernanceRuntime.js'
import { attachTurnWebSocketServer } from './services/turnWebSocket.js'
import { getTurnEngine } from './services/turnEngineHost.js'
import { createSqliteFileCompactionArchiveAdapter } from './services/sqliteFileCompactionArchiveAdapter.js'
import {
  enforceLocalAuthExposurePolicy,
  healthCheck,
  healthCheckFull,
  isApiRequest,
  sendApiNotFound,
  sendRuntimeNotReady,
  serveStatic,
} from './appServerHttpSurface.js'
import { RUNTIME_KERNEL_REVISION } from '../shared/runtimeCapabilities.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')
const runtimePluginRoot = path.join(rootDir, 'plugins')
export { RUNTIME_KERNEL_REVISION }
export { createRuntimeReadinessController }
export {
  enforceLocalAuthExposurePolicy,
  getLocalAuthExposurePolicy,
  healthCheck,
  healthCheckFull,
  isLoopbackBindAddress,
  resolveEffectiveExposureAddress,
} from './appServerHttpSurface.js'

function applyMiddlewares(handler, apiRateLimitMiddleware, runtimeReadiness) {
  return (req, res) => {
    // 请求级关联 ID：客户端可透传 x-request-id，否则生成一个，
    // 让这一整条请求链上的结构化日志都能按 requestId 串起来。
    const requestId = String(req.headers['x-request-id'] || '').trim().slice(0, 128) || newTraceId()
    req.requestId = requestId
    res.setHeader('X-Request-Id', requestId)
    // 顺序：CORS → 安全头 → 日志 → runtime readiness → 限流 → 错误边界 → 业务逻辑
    corsMiddleware(req, res, () => {
      securityHeaders(req, res, () => {
        requestLogger(req, res, () => {
          if (!runtimeReadiness.isReady()) {
            if (requiresRuntimeReadiness(req)) {
              sendRuntimeNotReady(res, runtimeReadiness)
              return
            }
            errorBoundary(req, res, () => withLogContext({ requestId }, () => handler(req, res)))
            return
          }
          apiRateLimitMiddleware(req, res, () => {
            errorBoundary(req, res, () => withLogContext({ requestId }, () => handler(req, res)))
          })
        })
      })
    })
  }
}

function createRouter(getEnv, staticDir, httpCapabilities, runtimeReadiness) {
  return function router(req, res) {
  // 健康检查
  if (isRuntimeLivenessRequest(req)) {
    healthCheck(req, res, { probeDatabase: runtimeReadiness.isReady() })
    return
  }

  if (req.url === '/api/health/full') {
    requireAuth(req, res, () => healthCheckFull(req, res, getEnv))
    return
  }

    const dispatched = httpCapabilities.dispatch(req, res, { getEnv })
    if (dispatched.handled) return dispatched.result
    if (isApiRequest(req)) return sendApiNotFound(res)
    return serveStatic(req, res, staticDir)
  }
}

export function createAppServer({
  getEnv = getRuntimeEnv,
  runtimeCwd = process.cwd(),
  staticDir = distDir,
  httpCapabilityRegistry = null,
  includeBuiltinHttpCapabilities = true,
  configureHttpCapabilities = null,
  httpCapabilityAudit = null,
  managedAttachmentStoragePort = null,
  runtimeReadiness = createRuntimeReadinessController({ initialState: 'ready' }),
} = {}) {
  if (configureHttpCapabilities !== null && typeof configureHttpCapabilities !== 'function') {
    throw new TypeError('configureHttpCapabilities must be a function or null')
  }
  const ownsHttpCapabilityRegistry = httpCapabilityRegistry === null
  const capabilities = httpCapabilityRegistry || createHttpCapabilityRegistry({
    audit: httpCapabilityAudit,
  })
  if (typeof capabilities.dispatch !== 'function') {
    throw new TypeError('httpCapabilityRegistry must expose dispatch(req, res, context)')
  }
  if (!runtimeReadiness
    || typeof runtimeReadiness.isReady !== 'function'
    || typeof runtimeReadiness.getState !== 'function') {
    throw new TypeError('runtimeReadiness must expose isReady() and getState()')
  }

  let disposeBuiltins = null
  let disposeConfigured = null
  try {
    if (includeBuiltinHttpCapabilities) {
      disposeBuiltins = registerBuiltinHttpCapabilities(capabilities, {
        getEnv,
        cwd: runtimeCwd,
        managedAttachmentStoragePort,
      })
    }
    if (configureHttpCapabilities) {
      disposeConfigured = configureHttpCapabilities(capabilities)
      if (disposeConfigured !== undefined
        && disposeConfigured !== null
        && typeof disposeConfigured !== 'function') {
        throw new TypeError('configureHttpCapabilities must return a disposer, null, or undefined')
      }
    }
  } catch (error) {
    if (ownsHttpCapabilityRegistry && typeof capabilities.disposeAll === 'function') {
      capabilities.disposeAll()
    } else if (disposeBuiltins) {
      disposeBuiltins()
    }
    throw error
  }

  const env = { ...process.env, ...(getEnv() || {}) }
  const apiRateLimitMiddleware = createApiRateLimitMiddleware({
    env,
    isActiveLocalHtmlPreviewTicket: isLocalHtmlPreviewTicketActive,
  })
  const server = http.createServer()
  const webSocketServer = attachTurnWebSocketServer(server, {
    isRuntimeReady: () => runtimeReadiness.isReady(),
    getRuntimeReadinessState: () => runtimeReadiness.getState(),
    listEvents: (scope) => getTurnEngine().listEvents(scope),
  })
  installHttpServerDrain(server, { webSocketServer })
  server.on('request', applyMiddlewares(
    createRouter(getEnv, staticDir, capabilities, runtimeReadiness),
    apiRateLimitMiddleware,
    runtimeReadiness,
  ))
  Object.defineProperty(server, 'httpCapabilities', {
    value: capabilities,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  Object.defineProperty(server, 'runtimeReadiness', {
    value: runtimeReadiness,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  server.once('close', () => {
    apiRateLimitMiddleware.close()
    try {
      disposeConfigured?.()
      if (ownsHttpCapabilityRegistry && typeof capabilities.disposeAll === 'function') {
        capabilities.disposeAll()
      } else {
        disposeBuiltins?.()
      }
    } catch (error) {
      logger.warn('[server] HTTP capability cleanup failed:', error?.message || error)
    }
  })
  return server
}

// 旧 gracefulShutdown 已下沉到 server/core/lifecycle.js
// 这里仅做兼容代理：旧调用点 → 新统一入口
function gracefulShutdownProxy(server, options) {
  return gracefulShutdown(server, options)
}

export function withAppStartupRollback(startup, {
  server,
  runtimeReadiness,
  startupAbortGuard,
  shutdown = (target) => gracefulShutdownProxy(target, { exit: false }),
  onFatal = (error) => {
    process.exitCode = 1
    console.error('[server] startup failed:', error?.stack || error)
  },
  onRollbackError = (error) => {
    console.error('[server] startup rollback failed:', error?.stack || error)
  },
} = {}) {
  if (typeof runtimeReadiness?.markFailed !== 'function') {
    throw new TypeError('runtimeReadiness must expose markFailed(error)')
  }
  if (typeof startupAbortGuard?.request !== 'function'
    || typeof startupAbortGuard?.isRequested !== 'function') {
    throw new TypeError('startupAbortGuard must expose request() and isRequested()')
  }
  if (typeof shutdown !== 'function') throw new TypeError('shutdown must be a function')
  if (typeof onFatal !== 'function') throw new TypeError('onFatal must be a function')
  if (typeof onRollbackError !== 'function') {
    throw new TypeError('onRollbackError must be a function')
  }

  return Promise.resolve(startup).catch(async (error) => {
    runtimeReadiness.markFailed(error)
    if (!startupAbortGuard.isRequested()) {
      startupAbortGuard.request('startup_failed')
      try { onFatal(error) } catch { /* diagnostics cannot prevent rollback */ }
    }
    try {
      const exitCode = await shutdown(server)
      if (Number.isInteger(exitCode) && exitCode !== 0) {
        const rollbackError = new Error(`application startup rollback exited with code ${exitCode}`)
        rollbackError.code = 'APP_STARTUP_ROLLBACK_FAILED'
        rollbackError.exitCode = exitCode
        try { onRollbackError(rollbackError) } catch { /* diagnostics only */ }
      }
    } catch (rollbackError) {
      try { onRollbackError(rollbackError) } catch { /* diagnostics only */ }
    }
    throw error
  })
}

export function bindAppProcessListeners({
  server,
  startupReady,
  startupAbortGuard,
  processTarget = process,
  shutdown = (target) => gracefulShutdownProxy(target),
} = {}) {
  if (!server || typeof server.once !== 'function' || typeof server.off !== 'function') {
    throw new TypeError('server must expose once() and off()')
  }
  if (!startupAbortGuard || typeof startupAbortGuard.request !== 'function') {
    throw new TypeError('startupAbortGuard must expose request()')
  }
  if (!processTarget || typeof processTarget.on !== 'function' || typeof processTarget.off !== 'function') {
    throw new TypeError('processTarget must expose on() and off()')
  }
  if (typeof shutdown !== 'function') throw new TypeError('shutdown must be a function')

  const onUncaughtException = (error) => {
    console.error('[server] uncaughtException:', error?.stack || error)
    // 不立即 exit:让 SIGTERM/SIGINT 走优雅路径;运维侧应靠日志告警
  }
  const onUnhandledRejection = (reason) => {
    console.error('[server] unhandledRejection:', reason?.stack || reason)
  }
  const requestShutdown = (signal) => {
    startupAbortGuard.request(signal)
    return shutdown(server)
  }
  const onSigterm = () => requestShutdown('SIGTERM')
  const onSigint = () => requestShutdown('SIGINT')
  let disposed = false
  const dispose = () => {
    if (disposed) return false
    disposed = true
    processTarget.off('uncaughtException', onUncaughtException)
    processTarget.off('unhandledRejection', onUnhandledRejection)
    processTarget.off('SIGTERM', onSigterm)
    processTarget.off('SIGINT', onSigint)
    server.off('close', dispose)
    return true
  }

  processTarget.on('uncaughtException', onUncaughtException)
  processTarget.on('unhandledRejection', onUnhandledRejection)
  processTarget.on('SIGTERM', onSigterm)
  processTarget.on('SIGINT', onSigint)
  server.once('close', dispose)
  void Promise.resolve(startupReady).catch(() => {
    dispose()
  })
  return dispose
}

export async function completeRuntimeStartup({
  result,
  startupAbortGuard,
  runtimeReadiness,
  startBackgroundRuntimes = startBuiltinBackgroundRuntimes,
} = {}) {
  if (typeof startupAbortGuard?.assertNotRequested !== 'function') {
    throw new TypeError('startupAbortGuard must expose assertNotRequested()')
  }
  if (typeof runtimeReadiness?.markReady !== 'function') {
    throw new TypeError('runtimeReadiness must expose markReady()')
  }
  if (typeof startBackgroundRuntimes !== 'function') {
    throw new TypeError('startBackgroundRuntimes must be a function')
  }
  startupAbortGuard.assertNotRequested()
  await startBackgroundRuntimes()
  startupAbortGuard.assertNotRequested()
  if (!runtimeReadiness.markReady()) {
    const error = new Error('Runtime readiness could not transition from starting to ready')
    error.code = 'APP_RUNTIME_READINESS_TRANSITION_FAILED'
    throw error
  }
  return result
}

export function startAppServer({
  turnPersistenceAdapter,
  managedAttachmentRuntimeAdapter,
  subagentRunPersistenceAdapter,
  compactionArchiveAdapter,
  toolLoopAdapter,
  startBackgroundRuntimes = startBuiltinBackgroundRuntimes,
  cwd = process.cwd(),
  env = process.env,
  runtimeEnv: preflightRuntimeEnv = null,
} = {}) {
  if (typeof startBackgroundRuntimes !== 'function') {
    throw new TypeError('startBackgroundRuntimes must be a function')
  }
  if (!turnPersistenceAdapter) {
    const error = new Error(
      'Turn persistence must be selected by trusted runtime bootstrap before the app server starts',
    )
    error.code = 'APP_TURN_PERSISTENCE_BOOTSTRAP_REQUIRED'
    error.retryable = false
    throw error
  }
  if (!subagentRunPersistenceAdapter) {
    const error = new Error(
      'Subagent run persistence must be selected by trusted runtime bootstrap before the app server starts',
    )
    error.code = 'APP_SUBAGENT_RUN_PERSISTENCE_BOOTSTRAP_REQUIRED'
    error.retryable = false
    throw error
  }
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error('dist/index.html 不存在，请先运行 npm run build。')
    process.exitCode = 1
    return null
  }

  // A config change may have replaced runtime.json immediately before the
  // previous process died, while its append-only SQLite audit was still
  // pending. Reconcile that journal synchronously before constructing the
  // HTTP host or starting plugin/Turn/Job recovery so no runtime work can
  // observe an unaudited configuration revision.
  // runtimeServerStartup resolves configuration before importing this module so
  // import-time consumers observe the recovered environment. Reuse that exact
  // snapshot instead of running preflight again with its values now promoted
  // into process.env. Direct execution remains compatible via this fallback.
  const runtimeEnv = preflightRuntimeEnv
    ?? runRuntimeConfigStartupPreflight({ cwd, env }).runtimeEnv
  const host = runtimeEnv.SERVER_HOST || '127.0.0.1'
  const port = Number(runtimeEnv.SERVER_PORT || 5173)

  enforceLocalAuthExposurePolicy(runtimeEnv, { listenerHost: host })

  const runtimeReadiness = createRuntimeReadinessController({ initialState: 'starting' })
  const startupAbortGuard = createStartupAbortGuard()
  const server = createAppServer({
    configureHttpCapabilities: bindRuntimePluginHttpCapabilities,
    runtimeReadiness,
    runtimeCwd: cwd,
  })

  const listeningReady = new Promise((resolve, reject) => {
    let settled = false
    const onError = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      if (settled) return
      try {
        startupAbortGuard.assertNotRequested()
      } catch (error) {
        settled = true
        void gracefulShutdownProxy(server, { exit: false }).then(
          () => reject(error),
          () => reject(error),
        )
        return
      }
      settled = true
      if (process.env.NODE_ENV !== 'production') logger.info(`Gugo running at http://${host}:${port}/`)
      resolve()
    })
  })

  // ★ 启动时由 lifecycle.bootstrap 统一编排 (包含 seedSystemSkills 等)
  // 先绑定 capability host，恢复中的 runtime plugin 才能原子恢复路由贡献。
  // Listener failure (for example EADDRINUSE) must happen before runtime
  // restoration can create plugin or recovery side effects.
  const releasePreparedCompactionArchive = (controller, startupError) => {
    try {
      controller?.release()
    } catch (releaseError) {
      throw new AggregateError(
        [startupError, releaseError],
        'application startup failed and the compaction archive recovery port could not be released',
        { cause: releaseError },
      )
    }
    throw startupError
  }
  const runtimePluginStartupReady = listeningReady.then(async () => {
    let compactionArchiveController = null
    let persistenceLease = null
    let persistenceFinalizerRegistered = false
    try {
      startupAbortGuard.assertNotRequested()
      compactionArchiveController = createCompactionArchivePortController(
        compactionArchiveAdapter || createSqliteFileCompactionArchiveAdapter({ env: runtimeEnv }),
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
  const runtimeStartupReady = runtimePluginStartupReady.then(async (pluginStartup) => {
    try {
      const capabilitySnapshot = await prepareRuntimeCapabilitySnapshot({ env: runtimeEnv, cwd })
      const loopLifecycleInput = toolLoopAdapter
        ? { toolLoopAdapter }
        : { toolLoopBinding: selectedToolLoopBinding(capabilitySnapshot) }
      startupAbortGuard.assertNotRequested()
      const startup = bootstrap({
        turnPersistenceAdapter: createBoundTurnPersistenceAdapter(capabilitySnapshot),
        managedAttachmentRuntimeAdapter,
        subagentRunPersistenceAdapter,
        compactionArchiveController: pluginStartup.compactionArchiveController,
        ...loopLifecycleInput,
        adapters: {
          initializeRuntimePluginConfig: () => true,
          initPlugins: () => pluginStartup.discovery,
          restoreEnabledRuntimePlugins: () => pluginStartup.restored,
        },
        runtimeEnv,
        cwd,
      })
      return startup.ready
    } catch (error) {
      return releasePreparedCompactionArchive(pluginStartup.compactionArchiveController, error)
    }
  }).then((result) => {
    startupAbortGuard.assertNotRequested()
    const fatal = result.failures.find((entry) => entry.capability.startFailure === 'fail')
    if (fatal) {
      const error = new Error(
        `startup capability failed: ${fatal.capability.id}: ${fatal.error?.message || 'unknown error'}`,
      )
      error.code = 'APP_STARTUP_CAPABILITY_FAILED'
      error.cause = fatal.error
      throw error
    }
    return result
  })
  const startupReady = withAppStartupRollback(
    runtimeStartupReady.then((result) => completeRuntimeStartup({
      result,
      startupAbortGuard,
      runtimeReadiness,
      startBackgroundRuntimes,
    })),
    { server, runtimeReadiness, startupAbortGuard },
  )
  Object.defineProperty(server, 'startupReady', {
    value: startupReady,
    enumerable: false,
    configurable: false,
    writable: false,
  })

  bindAppProcessListeners({
    server,
    startupReady,
    startupAbortGuard,
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { startRuntimeServer } = await import('./services/runtimeServerStartup.js')
  await startRuntimeServer({ cwd: rootDir, env: process.env })
}
