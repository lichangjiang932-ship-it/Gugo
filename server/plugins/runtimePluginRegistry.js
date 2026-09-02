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
import { createRuntimePluginServiceRegistry } from './runtimePluginServiceRegistry.js'
import { createRuntimePluginPromptRegistry } from './runtimePluginPromptRegistry.js'
import { createRuntimePluginToolRegistry } from './runtimePluginToolRegistry.js'
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

  const registerPlugin = async (manifest, setup) => {
    if (shuttingDown) {
      const error = new Error('runtime plugin registry is shutting down')
      error.code = 'PLUGIN_REGISTRY_SHUTTING_DOWN'
      throw error
    }
    const normalized = normalizeRuntimePluginManifest(manifest)
    if (typeof setup !== 'function') throw new TypeError('plugin setup must be a function')
    if (plugins.has(normalized.id)) throw new Error(`plugin already registered: ${normalized.id}`)
    assertManifestCompatible(normalized)
    configLayerSourcesSealed = true
    const configResolution = activePluginConfigResolver.resolve(normalized.id, normalized.configSchema)

    const record = createPluginRecord({
      manifest: normalized,
      setup,
      configResolver: activePluginConfigResolver,
      configResolution,
      configRevision: 1,
      state: 'installing',
      deferVisibility: false,
    })
    record.installSettled = new Promise((resolve) => {
      record.resolveInstallSettled = resolve
    })
    plugins.set(normalized.id, record)
    emitAudit('plugin.installing', { pluginId: normalized.id, version: normalized.version })

    const context = createContextForRecord(record)

    try {
      await invokePluginSetup(record, setup, context)
      if (record.cancelRequested) {
        const cancelled = new Error(`plugin install cancelled: ${normalized.id}`)
        cancelled.code = 'PLUGIN_INSTALL_CANCELLED'
        throw cancelled
      }
      assertManifestCompatible(normalized)
      record.state = 'active'
      await activateManagedContributions(record)
      record.installedAt = new Date().toISOString()
      emitAudit('plugin.installed', { pluginId: normalized.id, version: normalized.version })
      return snapshotRuntimePlugin(record)
    } catch (error) {
      record.state = 'failed'
      await revokeVisibleEffects(record)
      const rollbackErrors = [...record.revocationErrors]
      if (record.managedContributions.length === 0) {
        rollbackErrors.push(...await disposePluginEffects(record))
      }
      record.revocationErrors.length = 0
      if (rollbackErrors.length === 0 && record.managedContributions.length === 0) {
        plugins.delete(normalized.id)
      } else {
        record.state = 'rollback_failed'
      }
      emitAudit('plugin.install_failed', {
        pluginId: normalized.id,
        error: error?.message || String(error),
        rollbackErrors: rollbackErrors.map((item) => item?.message || String(item)),
      })
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `plugin setup failed: ${normalized.id}`,
          { cause: error },
        )
      }
      throw error
    } finally {
      record.resolveInstallSettled()
    }
  }

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

  const unregisterPluginUnchecked = async (normalizedId) => {
    let record = plugins.get(normalizedId)
    if (!record) return false
    const pendingReloads = [...configReloads]
      .filter((entry) => entry.pluginId === normalizedId)
      .map((entry) => entry.promise)
    if (pendingReloads.length > 0) {
      await Promise.allSettled(pendingReloads)
      const current = plugins.get(normalizedId)
      if (!current) return true
      if (current !== record) return unregisterPluginUnchecked(normalizedId)
      record = current
    }
    if (record.state === 'cancelling') {
      await record.cancelPromise
      return !plugins.has(normalizedId)
    }
    if (record.state === 'installing') {
      record.cancelRequested = true
      record.state = 'cancelling'
      record.cancelPromise = (async () => {
        await revokeVisibleEffects(record)
        await record.installSettled
      })()
      await record.cancelPromise
      return !plugins.has(normalizedId)
    }
    if (record.state === 'failed') {
      await record.installSettled
      return !plugins.has(normalizedId)
    }
    if (record.state === 'uninstalling' && record.uninstallPromise) return record.uninstallPromise
    assertNoRuntimePluginDependents(plugins, record, normalizedId)
    assertRecordCanDeactivate(record)
    record.state = 'uninstalling'
    emitAudit('plugin.uninstalling', { pluginId: normalizedId })
    record.uninstallPromise = (async () => {
      await revokeVisibleEffects(record)
      if (record.revocationErrors.length > 0 || record.managedContributions.length > 0) {
        const errors = [...record.revocationErrors]
        record.revocationErrors.length = 0
        const states = record.managedContributions.map((contribution) => contribution.snapshot().state)
        record.state = states.every((state) => state === 'revoked')
          ? 'inactive_cleanup_failed'
          : 'visibility_indeterminate'
        const failure = errors.length > 0
          ? new AggregateError(errors, `plugin uninstall failed: ${normalizedId}`)
          : new Error(`plugin uninstall visibility was not fully revoked: ${normalizedId}`)
        failure.code = 'PLUGIN_UNINSTALL_INCOMPLETE'
        failure.retryable = true
        emitAudit('plugin.uninstall_failed', {
          pluginId: normalizedId,
          state: record.state,
          errors: errors.map((item) => item?.message || String(item)),
        })
        throw failure
      }
      await waitForCallbacksToDrain(record)
      const errors = await disposePluginEffects(record)
      record.revocationErrors.length = 0
      if (errors.length > 0) {
        record.state = 'inactive_cleanup_failed'
        emitAudit('plugin.uninstall_failed', {
          pluginId: normalizedId,
          state: record.state,
          errors: errors.map((item) => item?.message || String(item)),
        })
        throw new AggregateError(errors, `plugin uninstall failed: ${normalizedId}`)
      }
      plugins.delete(normalizedId)
      emitAudit('plugin.uninstalled', { pluginId: normalizedId, errors: [] })
      return true
    })().finally(() => {
      if (plugins.get(normalizedId) === record) record.uninstallPromise = null
    })
    return record.uninstallPromise
  }

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
