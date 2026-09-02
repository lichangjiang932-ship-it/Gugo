import { assertPluginCompatibility } from '../../shared/pluginCompatibility.js'
import { createPluginContext } from './pluginContext.js'
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
import { createRuntimePluginCallbackRuntime } from './runtimePluginCallbackRuntime.js'
import { createRuntimePluginCapabilityRegistry } from './runtimePluginCapabilityRegistry.js'
import { createRuntimePluginConfigReloadController } from './runtimePluginConfigReloadController.js'
import { createRuntimePluginConfigSourceController } from './runtimePluginConfigSourceController.js'
import { createRuntimePluginContributionCoordinator } from './runtimePluginContributionCoordinator.js'
import { assertNoRuntimePluginDependents } from './runtimePluginDependencyGuard.js'
import { createRuntimePluginAgentEventRegistry } from './runtimePluginAgentEventRegistry.js'
import { createRuntimePluginEventRegistry } from './runtimePluginEventRegistry.js'
import { createRuntimePluginInstallController } from './runtimePluginInstallController.js'
import { createRuntimePluginServiceRegistry } from './runtimePluginServiceRegistry.js'
import { createRuntimePluginPromptRegistry } from './runtimePluginPromptRegistry.js'
import { createRuntimePluginReleaseController } from './runtimePluginReleaseController.js'
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
  const configSourceController = createRuntimePluginConfigSourceController({
    config,
    configLayers,
    configLayerSources,
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
  let releaseController = null
  const isShuttingDown = () => releaseController?.isShuttingDown() === true

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
    getActivePluginConfigResolver: configSourceController.getActiveResolver,
    getPlugin: (id) => plugins.get(id),
    hasPlugin: (id) => plugins.has(id),
    invokePluginSetup,
    isShuttingDown,
    normalizeManifest: normalizeRuntimePluginManifest,
    publishPlugin: (id, record) => plugins.set(id, record),
    removePlugin: (id) => plugins.delete(id),
    revokeVisibleEffects,
    sealConfigLayerSources: configSourceController.seal,
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
    getActivePluginConfigResolver: configSourceController.getActiveResolver,
    invokePluginCallback,
    invokePluginSetup,
    isShuttingDown,
    plugins,
    retireManagedContributions,
    revokeVisibleEffects,
    setActivePluginConfigResolver: configSourceController.replaceActiveResolver,
    stagingRecords,
    waitForCallbacksToDrain,
  })

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

  releaseController = createRuntimePluginReleaseController({
    activeCallbackInvocation,
    callbackDrainDeadlockError,
    detachLoopEventBindings,
    discardStagedRecord,
    listActiveRecords: () => plugins.values(),
    listPendingReloads: () => [...configReloads].map((entry) => entry.promise),
    listStagedRecords: () => stagingRecords.values(),
    registryToken,
    reloadPluginConfigUnchecked,
    unregisterPluginUnchecked,
  })
  const {
    reloadPluginConfig,
    shutdown,
    unregisterPlugin,
  } = releaseController

  return Object.freeze({
    initializeConfigLayerSources: configSourceController.initialize,
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
