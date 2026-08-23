import path from 'node:path'

import { createCompactionArchivePortController } from '../core/compactionArchivePort.js'
import { createManagedAttachmentRuntimePortController } from '../core/managedAttachmentRuntimePort.js'
import { createHeadlessLifecycleCapabilities } from '../core/headlessLifecycleAssembly.js'
import { createLifecycleRuntime } from '../core/lifecycle.js'
import { createSqliteSubagentRunPersistenceAdapter } from './sqliteSubagentRunPersistenceAdapter.js'
import { createSqliteFileManagedAttachmentRuntimeAdapter } from './sqliteFileManagedAttachmentRuntimeAdapter.js'
import {
  acquireHostTurnPersistenceCapability,
  createBoundTurnPersistenceAdapter,
  prepareRuntimeCapabilitySnapshot,
  selectedToolLoopBinding,
} from '../core/runtimeCapabilityHost.js'
import { getDb } from '../db.js'
import { runHeadlessTurn } from '../services/headlessTurnRuntime.js'
import { runRuntimeConfigStartupPreflight } from '../services/runtimeConfigStartupService.js'
import { createSqliteFileCompactionArchiveAdapter } from '../services/sqliteFileCompactionArchiveAdapter.js'

function releasePersistenceLease(lease) {
  const released = lease.release()
  if (released !== true) {
    const error = new Error('headless runtime persistence lease could not be released')
    error.code = 'HEADLESS_TURN_PERSISTENCE_RELEASE_FAILED'
    error.retryable = true
    throw error
  }
  return true
}

function createHeadlessAggregateError(primaryError, cleanupError, message, code) {
  const error = new AggregateError(
    [primaryError, cleanupError],
    message,
    { cause: primaryError },
  )
  error.code = code
  return error
}

function resolveSubagentRunPersistenceAdapter(dependencies) {
  if (dependencies.subagentRunPersistenceAdapter) {
    return dependencies.subagentRunPersistenceAdapter
  }
  const createAdapter = dependencies.createSqliteSubagentRunPersistenceAdapter
    || createSqliteSubagentRunPersistenceAdapter
  return createAdapter({ getDb: dependencies.getDb || getDb })
}

/**
 * CLI composition root. It selects concrete built-ins explicitly, activates
 * them for one headless invocation, then drains the shared engine and releases
 * both bindings before the process exits.
 */
export async function runBuiltinHeadlessTurn(options = {}, dependencies = {}) {
  const runtimeCwd = path.resolve(String(options.runtimeCwd || process.cwd()))
  const workspaceCwd = options.workspaceCwd || options.cwd || process.cwd()
  const startupEnv = options.env || process.env
  const runtimeEnv = options.runtimeEnv || (
    dependencies.runRuntimeConfigStartupPreflight || runRuntimeConfigStartupPreflight
  )({ cwd: runtimeCwd, env: startupEnv }).runtimeEnv
  const turnPersistenceAdapter = options.turnPersistenceAdapter
    || dependencies.turnPersistenceAdapter
  if (!turnPersistenceAdapter) {
    const error = new Error(
      'Turn persistence must be selected by trusted runtime bootstrap before Headless starts',
    )
    error.code = 'HEADLESS_TURN_PERSISTENCE_BOOTSTRAP_REQUIRED'
    error.retryable = false
    throw error
  }
  const subagentRunPersistenceAdapter = resolveSubagentRunPersistenceAdapter(dependencies)
  const acquirePersistence = dependencies.acquireHostTurnPersistenceCapability
    || acquireHostTurnPersistenceCapability
  const persistenceLease = acquirePersistence(turnPersistenceAdapter)
  let lifecycle
  try {
    const prepareSnapshot = dependencies.prepareRuntimeCapabilitySnapshot
      || prepareRuntimeCapabilitySnapshot
    const snapshot = await prepareSnapshot({
      cwd: runtimeCwd,
      env: runtimeEnv,
    })
    const assembleLifecycle = dependencies.createHeadlessLifecycleCapabilities
      || createHeadlessLifecycleCapabilities
    const createRuntime = dependencies.createLifecycleRuntime || createLifecycleRuntime
    const explicitToolLoopAdapter = options.toolLoopAdapter || dependencies.toolLoopAdapter
    const loopLifecycleInput = explicitToolLoopAdapter
      ? { toolLoopAdapter: explicitToolLoopAdapter }
      : { toolLoopBinding: selectedToolLoopBinding(snapshot) }
    const createCompactionAdapter = dependencies.createCompactionArchiveAdapter
      || createSqliteFileCompactionArchiveAdapter
    const createCompactionController = dependencies.createCompactionArchivePortController
      || createCompactionArchivePortController
    const compactionArchiveController = createCompactionController(
      createCompactionAdapter({ env: runtimeEnv }),
      { source: 'cli.headless' },
    )
    const createManagedAttachmentAdapter = dependencies.createManagedAttachmentRuntimeAdapter
      || createSqliteFileManagedAttachmentRuntimeAdapter
    const createManagedAttachmentController = dependencies.createManagedAttachmentRuntimePortController
      || createManagedAttachmentRuntimePortController
    const managedAttachmentRuntimeController = createManagedAttachmentController(
      options.managedAttachmentRuntimeAdapter
        || dependencies.managedAttachmentRuntimeAdapter
        || createManagedAttachmentAdapter({ env: runtimeEnv }),
      { source: 'cli.headless' },
    )
    lifecycle = createRuntime({
      includeBuiltins: false,
      silent: true,
      hostAdapterSource: 'cli.headless',
      cwd: runtimeCwd,
      runtimeEnv,
      turnPersistenceAdapter: createBoundTurnPersistenceAdapter(snapshot),
      subagentRunPersistenceAdapter,
      ...loopLifecycleInput,
      capabilities: assembleLifecycle({
        adapters: dependencies.lifecycleAdapters,
        cwd: runtimeCwd,
        pluginRoot: options.pluginRoot,
        runtimeEnv,
        silent: true,
        managedAttachmentRuntimeController,
        compactionArchiveController,
      }),
    })
  } catch (error) {
    try {
      releasePersistenceLease(persistenceLease)
    } catch (releaseError) {
      throw createHeadlessAggregateError(
        error,
        releaseError,
        'headless runtime preparation failed and host persistence could not be released',
        'HEADLESS_TURN_PREPARATION_AND_RELEASE_FAILED',
      )
    }
    throw error
  }
  let result
  let runError = null
  try {
    const startup = await lifecycle.start().ready
    const fatal = startup.failures.find((entry) => entry.capability.startFailure === 'fail')
    if (fatal) {
      const error = new Error(
        `headless runtime capability failed: ${fatal.capability.id}: ${fatal.error?.message || 'unknown error'}`,
      )
      error.code = 'HEADLESS_RUNTIME_STARTUP_CAPABILITY_FAILED'
      error.cause = fatal.error
      throw error
    }
    result = await runHeadlessTurn({
      ...options,
      cwd: workspaceCwd,
      workspaceCwd,
      runtimeCwd,
      runtimeEnv,
      env: runtimeEnv,
    }, {
      ...dependencies,
      persistenceAdapter: persistenceLease.adapter,
    })
  } catch (error) {
    runError = error
  }
  let closeError = null
  try {
    const stopped = await lifecycle.stop()
    if (stopped.exitCode !== 0) {
      const error = new Error('headless runtime shutdown failed')
      error.code = 'HEADLESS_RUNTIME_SHUTDOWN_FAILED'
      closeError = error
    } else {
      releasePersistenceLease(persistenceLease)
    }
  } catch (error) {
    closeError = error
  }
  if (runError && closeError) {
    throw createHeadlessAggregateError(
      runError,
      closeError,
      'headless runtime execution failed and shutdown could not complete',
      'HEADLESS_TURN_AND_SHUTDOWN_FAILED',
    )
  }
  if (runError) throw runError
  if (closeError) throw closeError
  return result
}
