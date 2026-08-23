/**
 * Process lifecycle façade.
 *
 * The kernel owns only capability composition, dependency-ordered startup,
 * reverse shutdown, HTTP drain, timeout handling, and error isolation. Concrete
 * business services live in builtinLifecycleAssembly.js.
 */

import {
  BUILTIN_LIFECYCLE_CAPABILITY_IDS,
  createBuiltinLifecycleCapabilities,
} from './builtinLifecycleAssembly.js'
import {
  createLifecycleCapabilityGraph,
  createLifecycleCapabilityRegistry,
} from './lifecycleCapabilityGraph.js'
import { drainHttpServer } from './httpServerDrain.js'
import { runServerShutdownFinalizers } from './serverShutdownFinalizers.js'
import { logger } from '../utils/logger.js'
import { createToolLoopAdapterController } from './toolLoopAdapter.js'
import { createTurnPersistenceAdapterController } from './turnPersistenceAdapter.js'
import { createSubagentRunPersistencePortController } from './subagentRunPersistencePort.js'

const MIN_SHUTDOWN_TIMEOUT_MS = 10_000
const HTTP_DRAIN_BUDGET_MS = 15_000
const MAX_SHUTDOWN_TIMEOUT_MS = 10 * 60 * 1_000
const shutdowns = new WeakMap()
let defaultRuntime = null

const INERT_HOST_ADAPTER_CONTROLLER = Object.freeze({
  activate() {
    return null
  },
  release() {
    return false
  },
})

function logCapabilityFailure({ capability, phase, error }) {
  const prefix = phase === 'start' ? '[server]' : '[lifecycle]'
  console.error(`${prefix} ${capability.errorLabel} failed:`, error?.message || error)
}

function validateShutdownTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SHUTDOWN_TIMEOUT_MS) {
    throw new TypeError('Lifecycle shutdown timeoutMs must be an integer between 1 and 600000')
  }
  return timeoutMs
}

function shouldReleaseHostController(graphResult, logicalSlotId) {
  if (!graphResult || !Array.isArray(graphResult.results)) return false
  const slotResult = graphResult.results.find((result) => (
    result?.capability?.slotId === logicalSlotId
  ))
  // Minimal profiles own these controllers outside their graph. Their whole
  // graph is therefore the release barrier.
  if (!slotResult) return graphResult.exitCode === 0
  // The built-in capability already invokes this controller. Only a replacing
  // capability needs the composition-root fallback after a safe stop result.
  return slotResult.capability.id !== logicalSlotId
    && (slotResult.status === 'succeeded'
      || (slotResult.status === 'skipped' && !slotResult.skipReason))
}

export function resolveLifecycleShutdownTimeoutMs({ timeoutMs, capabilities = [] } = {}) {
  if (timeoutMs !== undefined) return validateShutdownTimeout(timeoutMs)
  let serialStopBudgetMs = 0
  for (const capability of Array.isArray(capabilities) ? capabilities : []) {
    // Registry entries identify start-only nodes explicitly. Treat missing
    // metadata as stoppable for compatibility with embedded runtime fixtures.
    if (capability?.hasStop === false) continue
    const stopTimeoutMs = capability?.stopTimeoutMs
    if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1) continue
    serialStopBudgetMs = Math.min(
      MAX_SHUTDOWN_TIMEOUT_MS,
      serialStopBudgetMs + Math.min(stopTimeoutMs, MAX_SHUTDOWN_TIMEOUT_MS),
    )
  }
  return Math.min(
    MAX_SHUTDOWN_TIMEOUT_MS,
    Math.max(MIN_SHUTDOWN_TIMEOUT_MS, HTTP_DRAIN_BUDGET_MS + serialStopBudgetMs),
  )
}

function createLifecycleRuntimeInternal({
  silent = process.env.NODE_ENV === 'production',
  includeBuiltins = true,
  capabilities = [],
  adapters,
  pluginRoot,
  hostAdapterSource = 'host.lifecycle',
  turnPersistenceAdapter,
  managedAttachmentRuntimeAdapter,
  subagentRunPersistenceAdapter,
  compactionArchiveAdapter,
  compactionArchiveController,
  toolLoopAdapter,
  toolLoopBinding,
  runtimeEnv = process.env,
  cwd = process.cwd(),
  audit = null,
  now,
  onError = logCapabilityFailure,
} = {}, {
  inertHostAdapters = false,
} = {}) {
  if (typeof includeBuiltins !== 'boolean') {
    throw new TypeError('includeBuiltins must be a boolean')
  }
  if (!Array.isArray(capabilities)) {
    throw new TypeError('Lifecycle capability overrides must be an array')
  }
  if (typeof hostAdapterSource !== 'string' || !hostAdapterSource.trim()) {
    throw new TypeError('hostAdapterSource must be a non-empty string')
  }
  if (toolLoopAdapter !== undefined && toolLoopBinding !== undefined) {
    throw new TypeError('toolLoopAdapter and toolLoopBinding are mutually exclusive')
  }
  const turnPersistenceController = inertHostAdapters
    ? INERT_HOST_ADAPTER_CONTROLLER
    : createTurnPersistenceAdapterController(turnPersistenceAdapter, {
      source: hostAdapterSource.trim(),
    })
  const subagentRunPersistenceController = inertHostAdapters
    ? INERT_HOST_ADAPTER_CONTROLLER
    : createSubagentRunPersistencePortController(subagentRunPersistenceAdapter, {
      source: hostAdapterSource.trim(),
    })
  const toolLoopController = inertHostAdapters
    ? INERT_HOST_ADAPTER_CONTROLLER
    : toolLoopBinding !== undefined
      ? createToolLoopAdapterController(toolLoopBinding)
      : createToolLoopAdapterController(toolLoopAdapter, {
        source: hostAdapterSource.trim(),
      })
  const registry = createLifecycleCapabilityRegistry({ audit, ...(now ? { now } : {}) })
  const definitions = [
    ...(includeBuiltins
      ? createBuiltinLifecycleCapabilities({
        silent,
        adapters,
        pluginRoot,
        turnPersistenceController,
        managedAttachmentRuntimeAdapter,
        subagentRunPersistenceController,
        compactionArchiveAdapter,
        compactionArchiveController,
        toolLoopController,
        runtimeEnv,
        cwd,
      })
      : []),
    ...capabilities,
  ]
  registry.registerAll(definitions)
  const graph = createLifecycleCapabilityGraph({ registry, onError })
  let startRun = null
  let stopRun = null
  return Object.freeze({
    registry,
    graph,
    start() {
      if (startRun) return startRun
      turnPersistenceController.activate()
      try {
        subagentRunPersistenceController.activate()
        toolLoopController.activate()
        startRun = graph.startAll()
        return startRun
      } catch (error) {
        try {
          try {
            toolLoopController.release()
          } finally {
            subagentRunPersistenceController.release()
          }
        } finally {
          turnPersistenceController.release()
        }
        throw error
      }
    },
    stop() {
      if (stopRun) return stopRun
      const attempt = (async () => {
        let graphResult = null
        let graphError = null
        try {
          graphResult = await graph.stopAll()
        } catch (error) {
          graphError = error
        }

        if (graphError) throw graphError
        let releaseError = null
        if (shouldReleaseHostController(
          graphResult,
          BUILTIN_LIFECYCLE_CAPABILITY_IDS.toolLoop,
        )) {
          try {
            toolLoopController.release()
          } catch (error) {
            releaseError = error
          }
        }
        if (shouldReleaseHostController(
          graphResult,
          BUILTIN_LIFECYCLE_CAPABILITY_IDS.turnPersistence,
        )) {
          try {
            turnPersistenceController.release()
          } catch (error) {
            releaseError ||= error
          }
        }
        if (shouldReleaseHostController(
          graphResult,
          BUILTIN_LIFECYCLE_CAPABILITY_IDS.subagentPersistence,
        )) {
          try {
            subagentRunPersistenceController.release()
          } catch (error) {
            releaseError ||= error
          }
        }

        if (releaseError) throw releaseError
        return graphResult
      })()
      stopRun = attempt
      void attempt.then(
        (result) => {
          if (result.exitCode !== 0 && stopRun === attempt) stopRun = null
        },
        () => {
          if (stopRun === attempt) stopRun = null
        },
      )
      return attempt
    },
  })
}

/**
 * Construct a runnable process lifecycle. Real startup is deliberately strict:
 * the composition root must provide one complete persistence adapter.
 */
export function createLifecycleRuntime(options = {}) {
  return createLifecycleRuntimeInternal(options)
}

function createInertLifecycleRuntime({ silent = true } = {}) {
  return createLifecycleRuntimeInternal({ silent }, { inertHostAdapters: true })
}

function ensureDefaultRuntime(options = {}) {
  if (!defaultRuntime) defaultRuntime = createLifecycleRuntime(options)
  return defaultRuntime
}

function lifecycleRuntimeForInspection() {
  // Introspection must not commit the process singleton. Otherwise a harmless
  // list call made before bootstrap() would silently discard bootstrap's
  // adapters, pluginRoot, audit sink, and capability replacements.
  return defaultRuntime || createInertLifecycleRuntime()
}

/**
 * Synchronous compatibility entry point. Dependency-free hooks are invoked
 * before this function returns. The returned `ready` promise is the startup
 * barrier: network listeners must not accept work before it settles.
 */
export function bootstrap({
  silent = process.env.NODE_ENV === 'production',
  capabilities = [],
  adapters,
  pluginRoot,
  turnPersistenceAdapter,
  managedAttachmentRuntimeAdapter,
  subagentRunPersistenceAdapter,
  compactionArchiveAdapter,
  compactionArchiveController,
  toolLoopAdapter,
  toolLoopBinding,
  runtimeEnv = process.env,
  cwd = process.cwd(),
  audit = null,
} = {}) {
  const runtime = ensureDefaultRuntime({
    silent,
    capabilities,
    adapters,
    pluginRoot,
    turnPersistenceAdapter,
    managedAttachmentRuntimeAdapter,
    subagentRunPersistenceAdapter,
    compactionArchiveAdapter,
    compactionArchiveController,
    toolLoopAdapter,
    toolLoopBinding,
    runtimeEnv,
    cwd,
    audit,
  })
  const startRun = runtime.start()
  if (!silent) logger.info('[lifecycle] bootstrap complete')
  return Object.freeze({ ready: startRun.ready })
}

export function listLifecycleCapabilities() {
  return lifecycleRuntimeForInspection().registry.list()
}

export function listLifecycleAuditEvents() {
  return defaultRuntime
    ? defaultRuntime.registry.listAuditEvents()
    : Object.freeze([])
}

/**
 * Graceful process shutdown:
 *   1. stop accepting HTTP/SSE/WebSocket work;
 *   2. run the capability graph in exact reverse startup order;
 *   3. isolate hook failures/timeouts and return a deterministic exit code.
 */
export function gracefulShutdown(server, {
  silent = process.env.NODE_ENV === 'production',
  exit = true,
  exitProcess = (code) => process.exit(code),
  timeoutMs,
  runtime = null,
} = {}) {
  if (typeof exitProcess !== 'function') {
    throw new TypeError('Lifecycle exitProcess must be a function')
  }
  if (server && (typeof server === 'object' || typeof server === 'function')) {
    const activeShutdown = shutdowns.get(server)
    if (activeShutdown) {
      if (exit) activeShutdown.requestExit(exitProcess)
      return activeShutdown.promise
    }
  }
  // A shutdown signal can arrive before bootstrap (or after a failed startup
  // preparation). Build a one-shot inert graph in that case: concrete process
  // resources still receive their stop hooks, but no persistence/loop adapter
  // is selected or activated merely because the process is shutting down.
  const lifecycleRuntime = runtime || defaultRuntime || createInertLifecycleRuntime({ silent })
  const shutdownTimeoutMs = resolveLifecycleShutdownTimeoutMs({
    timeoutMs,
    capabilities: typeof lifecycleRuntime.registry?.list === 'function'
      ? lifecycleRuntime.registry.list()
      : [],
  })
  if (!silent) logger.info('\n[lifecycle] shutdown signal received')

  let exitRequested = Boolean(exit)
  let requestedExitProcess = exitRequested ? exitProcess : null
  let exitDispatched = false
  let settled = false
  let settledCode = null
  const dispatchExit = () => {
    if (!exitRequested || exitDispatched || !settled) return
    exitDispatched = true
    requestedExitProcess(settledCode)
  }
  const shutdownState = {
    promise: null,
    requestExit(requestedExit) {
      if (!exitRequested) {
        exitRequested = true
        requestedExitProcess = requestedExit
      }
      dispatchExit()
    },
  }
  const shutdown = new Promise((resolve) => {
    let done = false
    let timedOut = false
    let drainFailed = false
    let timeoutId = null
    const finish = (code) => {
      if (done) return
      done = true
      if (timeoutId) clearTimeout(timeoutId)
      if (!silent) logger.info('[lifecycle] shutdown complete')
      resolve(code)
      settled = true
      settledCode = code
      dispatchExit()
    }

    timeoutId = setTimeout(() => {
      if (done) return
      timedOut = true
      console.error('[lifecycle] forced exit (timeout)')
      finish(1)
    }, shutdownTimeoutMs)
    timeoutId.unref?.()

    void Promise.resolve()
      .then(() => drainHttpServer(server))
      .then((result) => {
        if (result?.forced === true) drainFailed = true
      })
      .catch((error) => {
        drainFailed = true
        console.error('[lifecycle] http server drain failed:', error?.message || error)
      })
      .then(async () => {
        if (!silent) logger.info('[lifecycle] http server closed')
        try {
          const result = await lifecycleRuntime.stop()
          if (result.exitCode === 0) {
            if (!runtime && defaultRuntime === lifecycleRuntime) defaultRuntime = null
            await runServerShutdownFinalizers(server)
            if (!silent) logger.info('[lifecycle] db closed')
          }
          const exitCode = drainFailed ? 1 : result.exitCode
          if ((timedOut || exitCode !== 0)
            && server && (typeof server === 'object' || typeof server === 'function')) {
            shutdowns.delete(server)
          }
          finish(exitCode)
        } catch (error) {
          if (server && (typeof server === 'object' || typeof server === 'function')) {
            shutdowns.delete(server)
          }
          console.error('[lifecycle] capability shutdown failed:', error?.message || error)
          finish(1)
        }
      })
  })
  shutdownState.promise = shutdown
  if (server && (typeof server === 'object' || typeof server === 'function')) {
    shutdowns.set(server, shutdownState)
  }
  return shutdown
}
