import { acquireTurnPersistenceAdapterForEngine } from '../core/turnPersistenceAdapter.js'
import { acquireCompactionArchivePort } from '../core/compactionArchivePort.js'
import {
  acquireManagedAttachmentRuntimePort,
  getManagedAttachmentRuntimePortStatus,
} from '../core/managedAttachmentRuntimePort.js'
import { listRuntimePlugins } from '../plugins/pluginRegistry.js'
import {
  callBackgroundModel,
  callStreamingModelWithTools,
  getModelContextWindow,
} from '../adapters/modelProxy.js'
import { reconcileModelRequestWithProvider } from '../adapters/modelRequestReconciler.js'
import { TurnEngine } from './TurnEngine.js'
import { runToolLoop } from './loop/index.js'
import { SERVER_TOOL_SPECS } from './toolLoopRuntime.js'
import { prepareTurnPromptContext } from './turnPromptContext.js'
import { prepareInlineSkillsForPrompt } from './promptCompiler.js'
import {
  resolveAgentModelRuntimeBinding,
  resolveChatModelRuntimeBinding,
} from './modelReadinessService.js'
import { configureSubagentModelBindingResolver } from './subagentModelBindingRuntime.js'
import { createTurnEnginePersistenceBundle } from './turnEnginePersistenceBundle.js'
import { normalizeTurnModelMode } from './turnStartRuntime.js'
import {
  releaseTurnEngineHostResources,
  releaseTurnEngineHostResourcesSync,
  throwTurnEngineHostFailures,
} from './turnEngineHostCleanup.js'

let singleton = null
let singletonPersistenceLease = null
let singletonCompactionArchiveLease = null
let singletonManagedAttachmentLease = null
let singletonModelBindingLease = null
let singletonClosePromise = null
let singletonShutdownCompleted = false
let pendingInitializationCleanupSteps = Object.freeze([])

export { isTurnEngineHostUnavailableError } from './turnEngineHostErrorContract.js'

function turnEngineShuttingDownError() {
  const error = new Error('TurnEngine host is shutting down')
  error.code = 'TURN_ENGINE_SHUTTING_DOWN'
  error.statusCode = 503
  error.retryable = true
  return error
}

function retryPendingInitializationCleanup() {
  if (pendingInitializationCleanupSteps.length === 0) return
  const cleanup = releaseTurnEngineHostResourcesSync(pendingInitializationCleanupSteps)
  pendingInitializationCleanupSteps = cleanup.pending
  throwTurnEngineHostFailures(cleanup.failures, {
    code: 'TURN_ENGINE_HOST_PENDING_INITIALIZATION_CLEANUP_FAILED',
    message: 'TurnEngine host is still cleaning up a failed initialization',
  })
}

/**
 * Process-host composition root for the shared TurnEngine.
 *
 * Persistence must already be activated by the embedding host. Importing this
 * module selects no backend; the first acquisition fails closed when no
 * complete adapter is active.
 */
export function getTurnEngine() {
  if (singletonClosePromise || singletonShutdownCompleted) {
    throw turnEngineShuttingDownError()
  }
  if (!singleton) {
    retryPendingInitializationCleanup()
    const lease = acquireTurnPersistenceAdapterForEngine()
    let compactionArchiveLease = null
    let managedAttachmentLease = null
    let releaseModelBindingResolver = null
    try {
      if (getManagedAttachmentRuntimePortStatus().configured) {
        managedAttachmentLease = acquireManagedAttachmentRuntimePort()
      }
      compactionArchiveLease = acquireCompactionArchivePort()
      releaseModelBindingResolver = configureSubagentModelBindingResolver(
        resolveAgentModelRuntimeBinding,
      )
      const persistence = createTurnEnginePersistenceBundle(lease.adapter, {
        leaseMs: Number(process.env.TURN_EXECUTION_LEASE_MS) || undefined,
        renewalTimeoutMs: Number(process.env.TURN_EXECUTION_LEASE_RENEWAL_TIMEOUT_MS) || undefined,
        attachmentRuntime: managedAttachmentLease?.port || null,
      })
      singleton = new TurnEngine({
        persistence,
        runLoop: (options = {}) => runToolLoop({
          ...options,
          compactionArchivePort: compactionArchiveLease.port,
        }),
        runModel: callStreamingModelWithTools,
        toolSpecs: SERVER_TOOL_SPECS,
        directoryAuthorizationToolSpecs: SERVER_TOOL_SPECS,
        runMemoryModel: callBackgroundModel,
        getContextWindow: getModelContextWindow,
        reconcileModelRequest: reconcileModelRequestWithProvider,
        preparePromptContext: (options = {}) => prepareTurnPromptContext({
          ...options,
          compactionArchivePort: compactionArchiveLease.port,
        }),
        prepareInlineSkills: prepareInlineSkillsForPrompt,
        attachmentRuntime: managedAttachmentLease?.port || null,
        resolveModelBinding: (options = {}) => (
          normalizeTurnModelMode(options.modelMode) === 'chat_only'
            ? resolveChatModelRuntimeBinding(options)
            : resolveAgentModelRuntimeBinding(options)
        ),
        readRuntimePlugins: listRuntimePlugins,
      })
      singletonPersistenceLease = lease
      singletonCompactionArchiveLease = compactionArchiveLease
      singletonManagedAttachmentLease = managedAttachmentLease
      singletonModelBindingLease = releaseModelBindingResolver
    } catch (error) {
      const cleanupFailures = releaseTurnEngineHostResourcesSync([
        ...(releaseModelBindingResolver ? [{
          label: 'TurnEngine model binding resolver',
          failureCode: 'TURN_ENGINE_MODEL_BINDING_RELEASE_FAILED',
          acceptAlreadyReleased: true,
          release: releaseModelBindingResolver,
        }] : []),
        ...(compactionArchiveLease ? [{
          label: 'TurnEngine compaction archive lease',
          failureCode: 'TURN_ENGINE_COMPACTION_ARCHIVE_RELEASE_FAILED',
          acceptAlreadyReleased: true,
          release: () => compactionArchiveLease.release(),
        }] : []),
        ...(managedAttachmentLease ? [{
          label: 'TurnEngine managed attachment runtime lease',
          failureCode: 'TURN_ENGINE_MANAGED_ATTACHMENT_RELEASE_FAILED',
          acceptAlreadyReleased: true,
          release: () => managedAttachmentLease.release(),
        }] : []),
        {
          label: 'TurnEngine persistence lease',
          failureCode: 'TURN_ENGINE_PERSISTENCE_RELEASE_FAILED',
          acceptAlreadyReleased: true,
          release: () => lease.release(),
        },
      ])
      pendingInitializationCleanupSteps = cleanupFailures.pending
      throwTurnEngineHostFailures(cleanupFailures.failures, {
        primaryError: error,
        code: 'TURN_ENGINE_HOST_INITIALIZATION_AND_CLEANUP_FAILED',
        message: 'TurnEngine initialization failed and host resources could not be released',
      })
    }
  }
  return singleton
}

export function closeTurnEngine() {
  if (singletonClosePromise) return singletonClosePromise
  if (!singleton && pendingInitializationCleanupSteps.length === 0) return Promise.resolve()
  const engine = singleton
  // Publish the shared close barrier before invoking engine.shutdown(). A
  // shutdown implementation may synchronously re-enter the host before it
  // returns its Promise; that re-entry must fail closed instead of observing
  // the engine that is already beginning to shut down.
  const closePromise = Promise.resolve().then(async () => {
    if (!engine) {
      const cleanup = await releaseTurnEngineHostResources(pendingInitializationCleanupSteps)
      pendingInitializationCleanupSteps = cleanup.pending
      throwTurnEngineHostFailures(cleanup.failures, {
        code: 'TURN_ENGINE_HOST_PENDING_INITIALIZATION_CLEANUP_FAILED',
        message: 'TurnEngine host could not finish cleaning up a failed initialization',
      })
      return
    }

    if (!singletonShutdownCompleted) {
      await engine.shutdown()
      if (singleton === engine) singletonShutdownCompleted = true
    }

    const releaseModelBindingResolver = singletonModelBindingLease
    const compactionArchiveLease = singletonCompactionArchiveLease
    const managedAttachmentLease = singletonManagedAttachmentLease
    const persistenceLease = singletonPersistenceLease
    const cleanupFailures = await releaseTurnEngineHostResources([
      ...(releaseModelBindingResolver ? [{
        label: 'TurnEngine model binding resolver',
        failureCode: 'TURN_ENGINE_MODEL_BINDING_RELEASE_FAILED',
        acceptAlreadyReleased: true,
        release: releaseModelBindingResolver,
        onReleased: () => {
          if (singletonModelBindingLease === releaseModelBindingResolver) {
            singletonModelBindingLease = null
          }
        },
      }] : []),
      ...(compactionArchiveLease ? [{
        label: 'TurnEngine compaction archive lease',
        failureCode: 'TURN_ENGINE_COMPACTION_ARCHIVE_RELEASE_FAILED',
        acceptAlreadyReleased: true,
        release: () => compactionArchiveLease.release(),
        onReleased: () => {
          if (singletonCompactionArchiveLease === compactionArchiveLease) {
            singletonCompactionArchiveLease = null
          }
        },
      }] : []),
      ...(managedAttachmentLease ? [{
        label: 'TurnEngine managed attachment runtime lease',
        failureCode: 'TURN_ENGINE_MANAGED_ATTACHMENT_RELEASE_FAILED',
        acceptAlreadyReleased: true,
        release: () => managedAttachmentLease.release(),
        onReleased: () => {
          if (singletonManagedAttachmentLease === managedAttachmentLease) {
            singletonManagedAttachmentLease = null
          }
        },
      }] : []),
      ...(persistenceLease ? [{
        label: 'TurnEngine persistence lease',
        failureCode: 'TURN_ENGINE_PERSISTENCE_RELEASE_FAILED',
        acceptAlreadyReleased: true,
        release: () => persistenceLease.release(),
        onReleased: () => {
          if (singletonPersistenceLease === persistenceLease) {
            singletonPersistenceLease = null
          }
        },
      }] : []),
    ])
    throwTurnEngineHostFailures(cleanupFailures.failures, {
      code: 'TURN_ENGINE_HOST_CLEANUP_FAILED',
      message: 'TurnEngine shutdown completed but host resources could not be released',
    })

    if (singleton === engine) {
      singleton = null
      singletonShutdownCompleted = false
    }
  })
  singletonClosePromise = closePromise
  void closePromise.then(
    () => {
      if (singletonClosePromise === closePromise) singletonClosePromise = null
    },
    () => {
      if (singletonClosePromise === closePromise) singletonClosePromise = null
    },
  )
  return closePromise
}

/**
 * Test-only unsafe escape hatch. This does not drain active Turn work and must
 * never be imported by production code.
 */
export function _resetTurnEngine() {
  singleton = null
  singletonShutdownCompleted = false
  singletonModelBindingLease?.()
  singletonModelBindingLease = null
  singletonCompactionArchiveLease?.release()
  singletonCompactionArchiveLease = null
  singletonManagedAttachmentLease?.release()
  singletonManagedAttachmentLease = null
  singletonPersistenceLease?.release()
  singletonPersistenceLease = null
  pendingInitializationCleanupSteps = Object.freeze([])
}
