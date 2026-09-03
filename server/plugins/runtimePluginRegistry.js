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
import { snapshotTrustedRuntimePluginDurableIdentity } from './runtimePluginDurableIdentity.js'
import { createRuntimePluginEventRegistry } from './runtimePluginEventRegistry.js'
import { createRuntimePluginInstallController } from './runtimePluginInstallController.js'
import { createRuntimePluginContextForRecord } from './runtimePluginContextFactory.js'
import { createRuntimePluginRegistryPolicy } from './runtimePluginRegistryPolicy.js'
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
    durableAgentEventConsumerHost,
    audit,
  } = snapshotRuntimePluginHostOptions(options)
  const supportsRuntimeCapabilityReplacement = (
    registerRuntimeCapability !== compatibilityRuntimeCapabilityHost
  )

  const configSourceController = createRuntimePluginConfigSourceController({
    config,
    configLayers,
    configLayerSources,
  })
  const plugins = new Map()
  const stagingRecords = new Set()
  const configReloads = new Set()
  const {
    assertRecordCanDeactivate,
    assertPluginWritable,
    registerConfigHealthCheck,
    assertContributionDeclared,
    assertManifestCompatible,
    isConsumerRecordCurrent,
  } = createRuntimePluginRegistryPolicy({ plugins, stagingRecords })
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

  const {
    registerAgentEventContribution,
    listAgentEventResetAudit,
  } = createRuntimePluginAgentEventRegistry({
    host: agentEventConsumerHost,
    durableHost: durableAgentEventConsumerHost,
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
    isConsumerRecordCurrent,
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

  const createContextForRecord = (record) => createRuntimePluginContextForRecord(record, {
    registerConfigHealthCheck,
    registerToolContribution,
    registerEventContribution,
    registerAgentEventContribution,
    registerModelProviderContribution,
    registerLoopContribution,
    registerPolicyContribution,
    registerHttpCapabilityContribution,
    registerPromptContribution,
    provideService,
    invokeServiceForConsumer,
    hasServiceForConsumer,
    emitAudit,
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
    snapshotDurableIdentity: snapshotTrustedRuntimePluginDurableIdentity,
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
    listAgentEventResetAudit,
    hasService,
    invokeService,
    renderPromptBlocks,
    shutdown,
  })
}
