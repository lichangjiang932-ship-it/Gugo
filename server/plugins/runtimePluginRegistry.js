import { assertPluginCompatibility } from '../../shared/pluginCompatibility.js'
import { createPluginContext } from './pluginContext.js'
import { createPluginConfigResolver } from './pluginConfig.js'
import {
  PLUGIN_API_VERSION,
  PLUGIN_HOST_VERSION,
} from './pluginHostContract.js'
import { snapshotPluginAuditEntry } from './pluginContextData.js'
import { normalizeRuntimePluginManifest } from './pluginLifecycle.js'
import {
  listRuntimePluginEffectiveConfigs,
  listRuntimePluginInventory,
  snapshotRuntimePlugin,
} from './runtimePluginInventory.js'
import {
  compatibilityRuntimeCapabilityHost,
  snapshotRuntimePluginHostOptions,
} from './runtimePluginHostOptions.js'
import { createHandledRejectedPromise } from './runtimePluginAsyncBoundary.js'
import { createRuntimePluginCallbackRuntime } from './runtimePluginCallbackRuntime.js'
import { createRuntimePluginCapabilityRegistry } from './runtimePluginCapabilityRegistry.js'
import { createRuntimePluginConfigReloadController } from './runtimePluginConfigReloadController.js'
import { createRuntimePluginContributionCoordinator } from './runtimePluginContributionCoordinator.js'
import { assertNoRuntimePluginDependents } from './runtimePluginDependencyGuard.js'
import { createRuntimePluginAgentEventRegistry } from './runtimePluginAgentEventRegistry.js'
import { createRuntimePluginEventRegistry } from './runtimePluginEventRegistry.js'
import { createRuntimePluginInstallController } from './runtimePluginInstallController.js'
import { createRuntimePluginServiceRegistry } from './runtimePluginServiceRegistry.js'
import { createRuntimePluginPromptRegistry } from './runtimePluginPromptRegistry.js'
import { createRuntimePluginToolRegistry } from './runtimePluginToolRegistry.js'
import { createRuntimePluginUninstallController } from './runtimePluginUninstallController.js'
import {
  createRuntimePluginAuditRuntime,
  createRuntimePluginRecordFactory,
  normalizeRuntimePluginId,
} from './runtimePluginRegistrySupport.js'

export function createRuntimePluginRegistry(options = {}) {
  const {
    config,
    configLayers,
    configLayerSources,
    registerTool,
    registerModelProvider,
    registerRuntimeCapability,
    isRuntimeCapabilityInUse,
    isRuntimeCapabilitySlotActive,
    registerHttpCapability,
    agentEventConsumerHost,
    audit,
  } = snapshotRuntimePluginHostOptions(options)
  const supportsRuntimeCapabilityReplacement = (
    registerRuntimeCapability !== compatibilityRuntimeCapabilityHost
  )

  const assertRecordCanDeactivate = (record) => {
    for (const check of record.deactivationChecks) check()
  }
  let activePluginConfigResolver = createPluginConfigResolver({
    legacyConfig: config,
    layers: configLayers,
    layerSources: configLayerSources,
  })
  const plugins = new Map()
  const stagingRecords = new Set()
  const configReloads = new Set()
  const {
    emitAudit,
    emitConfigReloadAudit,
    listConfigReloadAudit,
  } = createRuntimePluginAuditRuntime(audit)
  const createPluginRecord = createRuntimePluginRecordFactory()
  const registryToken = Object.freeze({})
  const {
    activeCallbackInvocation,
    callbackDrainDeadlockError,
    disposePluginEffects,
    invokePluginCallback,
    invokePluginCallbackSync,
    invokePluginCleanup,
    invokePluginSetup,
    waitForCallbacksToDrain,
  } = createRuntimePluginCallbackRuntime(registryToken)
  let configLayerSourcesSealed = false
  let shuttingDown = false
  let shutdownPromise = null

  const initializeConfigLayerSources = (nextLayerSources) => {
    if (configLayerSourcesSealed) {
      const error = new Error(
        'runtime plugin configuration sources cannot change after plugin installation begins',
      )
      error.code = 'PLUGIN_CONFIG_INITIALIZATION_TOO_LATE'
      error.retryable = false
      throw error
    }
    activePluginConfigResolver = activePluginConfigResolver.withLayerSources(nextLayerSources)
    return true
  }

  const assertPluginWritable = (record) => {
    if (!['installing', 'staging', 'active'].includes(record.state)) {
      throw new Error(`plugin lifecycle is closed: ${record.manifest.id}`)
    }
  }

  const registerConfigHealthCheck = (record, check) => {
    assertPluginWritable(record)
    if (typeof check !== 'function') {
      const error = new TypeError('plugin config health check must be a function')
      error.code = 'PLUGIN_CONFIG_HEALTH_CHECK_INVALID'
      error.retryable = false
      throw error
    }
    record.configHealthChecks.add(check)
    return record.effects.track(() => record.configHealthChecks.delete(check))
  }

  const assertContributionDeclared = (record, declaration) => {
    if (record.manifest.contributes.includes(declaration)) return
    const error = new Error(`plugin contribution is not declared: ${record.manifest.id}/${declaration}`)
    error.code = 'PLUGIN_CONTRIBUTION_UNDECLARED'
    error.retryable = false
    throw error
  }

  const {
    activateManagedContributions,
    beginManagedContributionDeactivation,
    collectManagedDeactivationErrors,
    createManagedContribution,
    retireManagedContributions,
    revokeVisibleEffects,
  } = createRuntimePluginContributionCoordinator({ invokePluginCleanup })

  const {
    registerEventContribution,
    bindLoopEvents,
    detachLoopEventBindings,
  } = createRuntimePluginEventRegistry({
    listActiveRecords: () => plugins.values(),
    assertPluginWritable,
    assertContributionDeclared,
    createManagedContribution,
    invokePluginCallback,
    emitAudit,
  })

  const { registerAgentEventContribution } = createRuntimePluginAgentEventRegistry({
    host: agentEventConsumerHost,
    assertPluginWritable,
    assertContributionDeclared,
    createManagedContribution,
    invokePluginCallback,
    emitAudit,
  })

  const {
    registerPromptContribution,
    renderPromptBlocks,
  } = createRuntimePluginPromptRegistry({
    assertPluginWritable,
    assertContributionDeclared,
    createManagedContribution,
    invokePluginCallbackSync,
    emitAudit,
  })

  const { registerToolContribution } = createRuntimePluginToolRegistry({
    assertPluginWritable,
    assertContributionDeclared,
    createManagedContribution,
    invokePluginCallback,
    registerTool,
    registerRuntimeCapability,
    supportsRuntimeCapabilityReplacement,
  })

  const {
    hasService,
    hasServiceForConsumer,
    invokeService,
    invokeServiceForConsumer,
    provideService,
  } = createRuntimePluginServiceRegistry({
    assertContributionDeclared,
    assertPluginWritable,
    createManagedContribution,
    invokePluginCallback,
    isConsumerRecordCurrent: (record) => (
      plugins.get(record.manifest.id) === record || stagingRecords.has(record)
    ),
  })

  const {
    registerHttpCapabilityContribution,
    registerLoopContribution,
    registerModelProviderContribution,
    registerPolicyContribution,
  } = createRuntimePluginCapabilityRegistry({
    assertContributionDeclared,
    assertPluginWritable,
    createManagedContribution,
    emitAudit,
    invokePluginCallback,
    invokePluginCallbackSync,
    isRuntimeCapabilityInUse,
    isRuntimeCapabilitySlotActive,
    registerHttpCapability,
    registerModelProvider,
    registerRuntimeCapability,
    supportsRuntimeCapabilityReplacement,
  })

  const assertManifestCompatible = (manifest) => assertPluginCompatibility(manifest, {
    hostVersion: PLUGIN_HOST_VERSION,
    apiVersion: PLUGIN_API_VERSION,
    resolveDependencyVersion: (id) => {
      const dependency = plugins.get(id)
      return dependency?.state === 'active' ? dependency.manifest.version : null
    },
  })

  const createContextForRecord = (record) => createPluginContext({
    manifest: record.manifest,
    config: record.configResolution.config,
    track: record.effects.track,
    registerConfigHealthCheck: (check) => registerConfigHealthCheck(record, check),
    registerTool: (definition) => registerToolContribution(record, definition),
    registerEvent: (event, listener) => registerEventContribution(record, event, listener),
    registerAgentEvent: (eventType, listener, options) => (
      registerAgentEventContribution(record, eventType, listener, options)
    ),
    registerModelProvider: (kind, adapter, options) => (
      registerModelProviderContribution(record, kind, adapter, options)
    ),
    registerLoop: (adapter, options) => registerLoopContribution(record, adapter, options),
    registerPolicy: (adapter, options) => registerPolicyContribution(record, adapter, options),
    registerHttpCapability: (definition) => registerHttpCapabilityContribution(record, definition),
    registerPrompt: (definition) => registerPromptContribution(record, definition),
    provideService: (name, value) => provideService(record, name, value),
    invokeService: (name, method, args) => invokeServiceForConsumer(record, name, method, args),
    hasService: (name) => hasServiceForConsumer(record, name),
    emitAudit: (event, details) => {
      const entry = snapshotPluginAuditEntry(event, details)
      emitAudit(entry.event, {
        pluginId: record.manifest.id,
        details: entry.details,
      })
    },
  })

  const { registerPlugin } = createRuntimePluginInstallController({
    activateManagedContributions,
    assertManifestCompatible,
    createContextForRecord,
    createPluginRecord,
    disposePluginEffects,
    emitAudit,
    getActivePluginConfigResolver: () => activePluginConfigResolver,
    getPlugin: (id) => plugins.get(id),
    hasPlugin: (id) => plugins.has(id),
    invokePluginSetup,
    isShuttingDown: () => shuttingDown,
    normalizeManifest: normalizeRuntimePluginManifest,
    publishPlugin: (id, record) => plugins.set(id, record),
    removePlugin: (id) => plugins.delete(id),
    revokeVisibleEffects,
    sealConfigLayerSources: () => {
      configLayerSourcesSealed = true
    },
    snapshotPlugin: snapshotRuntimePlugin,
  })

  const {
    discardStagedRecord,
    reloadPluginConfig: reloadPluginConfigUnchecked,
  } = createRuntimePluginConfigReloadController({
    activeCallbackInvocation,
    activateManagedContributions,
    assertManifestCompatible,
    assertRecordCanDeactivate,
    beginManagedContributionDeactivation,
    collectManagedDeactivationErrors,
    configReloads,
    createContextForRecord,
    createPluginRecord,
    disposePluginEffects,
    emitConfigReloadAudit,
    getActivePluginConfigResolver: () => activePluginConfigResolver,
    invokePluginCallback,
    invokePluginSetup,
    isShuttingDown: () => shuttingDown,
    plugins,
    retireManagedContributions,
    revokeVisibleEffects,
    setActivePluginConfigResolver: (resolver) => {
      activePluginConfigResolver = resolver
    },
    stagingRecords,
    waitForCallbacksToDrain,
  })

  const reloadPluginConfig = (id, options) => {
    const normalizedId = normalizeRuntimePluginId(id)
    const invocation = activeCallbackInvocation()
    if (invocation) {
      return createHandledRejectedPromise(
        callbackDrainDeadlockError('reload', invocation, normalizedId, registryToken),
      )
    }
    return reloadPluginConfigUnchecked(id, options)
  }

  const { unregisterPluginUnchecked } = createRuntimePluginUninstallController({
    assertNoDependents: (record, id) => assertNoRuntimePluginDependents(plugins, record, id),
    assertRecordCanDeactivate,
    disposePluginEffects,
    emitAudit,
    getPlugin: (id) => plugins.get(id),
    hasPlugin: (id) => plugins.has(id),
    listPendingReloads: (id) => [...configReloads]
      .filter((entry) => entry.pluginId === id)
      .map((entry) => entry.promise),
    removePlugin: (id) => plugins.delete(id),
    revokeVisibleEffects,
    waitForCallbacksToDrain,
  })

  const unregisterPlugin = (id) => {
    const normalizedId = normalizeRuntimePluginId(id)
    const invocation = activeCallbackInvocation()
    if (invocation) {
      return createHandledRejectedPromise(
        callbackDrainDeadlockError('unregister', invocation, normalizedId, registryToken),
      )
    }
    return unregisterPluginUnchecked(normalizedId)
  }

  const shutdown = () => {
    const invocation = activeCallbackInvocation()
    if (invocation) {
      return createHandledRejectedPromise(
        callbackDrainDeadlockError('shutdown', invocation, '', registryToken),
      )
    }
    if (shutdownPromise) return shutdownPromise
    shuttingDown = true
    shutdownPromise = (async () => {
      const errors = []
      const pendingReloads = [...configReloads].map((entry) => entry.promise)
      if (pendingReloads.length > 0) await Promise.allSettled(pendingReloads)
      const staged = [...stagingRecords].sort((a, b) => b.sequence - a.sequence)
      for (const record of staged) {
        const outcome = await discardStagedRecord(record)
        if (!outcome.removed) {
          const cleanupErrors = outcome.errors.length > 0
            ? outcome.errors
            : [new Error(`staged runtime plugin cleanup remains incomplete: ${record.manifest.id}`)]
          errors.push(new AggregateError(
            cleanupErrors,
            `staged runtime plugin cleanup failed: ${record.manifest.id}`,
          ))
        }
      }
      const ordered = [...plugins.values()].sort((a, b) => b.sequence - a.sequence)
      for (const record of ordered) {
        try {
          await unregisterPlugin(record.manifest.id)
        } catch (error) {
          errors.push(error)
        }
      }
      try {
        await detachLoopEventBindings()
      } catch (error) {
        errors.push(error)
      }
      if (errors.length > 0) throw new AggregateError(errors, 'runtime plugin shutdown failed')
    })().finally(() => {
      shuttingDown = false
      shutdownPromise = null
    })
    return shutdownPromise
  }

  return Object.freeze({
    initializeConfigLayerSources,
    registerPlugin,
    unregisterPlugin,
    reloadPluginConfig,
    bindLoopEvents,
    listPlugins: () => listRuntimePluginInventory([
      ...plugins.values(),
      ...stagingRecords,
    ]),
    getPlugin: (id) => snapshotRuntimePlugin(plugins.get(normalizeRuntimePluginId(id))),
    listEffectiveConfigs: () => listRuntimePluginEffectiveConfigs(plugins.values()),
    listConfigReloadAudit,
    hasService,
    invokeService,
    renderPromptBlocks,
    shutdown,
  })
}
