import { assertPluginCompatibility } from '../../shared/pluginCompatibility.js'
import { validatePolicyAdapter } from '../core/policyAdapter.js'
import {
  BUILTIN_TOOL_LOOP_ADAPTER_ID,
  TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3,
  prepareToolLoopAdapter,
} from '../core/toolLoopAdapter.js'
import { ENDPOINT_KINDS } from '../utils/endpointProfile.js'
import { createPluginContext } from './pluginContext.js'
import { createPluginConfigResolver } from './pluginConfig.js'
import {
  PLUGIN_API_VERSION,
  PLUGIN_HOST_VERSION,
  POLICY_ADAPTER_CONTRACT_VERSION,
} from './pluginHostContract.js'
import { snapshotPluginAuditEntry } from './pluginContextData.js'
import { snapshotOptionalContributionDefinition } from './pluginContributionDefinition.js'
import { snapshotRuntimeModelProvider } from './pluginModelProvider.js'
import { snapshotRuntimePluginHttpCapability } from './pluginHttpCapability.js'
import {
  createEffectTracker,
  normalizeRuntimePluginManifest,
} from './pluginLifecycle.js'
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
import { createRuntimePluginConfigReloadController } from './runtimePluginConfigReloadController.js'
import { createRuntimePluginContributionCoordinator } from './runtimePluginContributionCoordinator.js'
import { assertNoRuntimePluginDependents } from './runtimePluginDependencyGuard.js'
import { createRuntimePluginAgentEventRegistry } from './runtimePluginAgentEventRegistry.js'
import { createRuntimePluginEventRegistry } from './runtimePluginEventRegistry.js'
import { createRuntimePluginServiceRegistry } from './runtimePluginServiceRegistry.js'
import { createRuntimePluginPromptRegistry } from './runtimePluginPromptRegistry.js'
import { createRuntimePluginToolRegistry } from './runtimePluginToolRegistry.js'

const PLUGIN_MODEL_PROVIDER_KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const PLUGIN_CAPABILITY_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const BUILTIN_POLICY_CAPABILITY_ID = 'builtin.harness-policy'
const RESERVED_MODEL_PROVIDER_KIND_SET = new Set(ENDPOINT_KINDS)
const MAX_CONFIG_RELOAD_AUDIT_EVENTS = 256

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

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
  const configReloadAudit = []
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
  let installSequence = 0
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

  const emitAudit = (event, details = {}) => {
    if (typeof audit !== 'function') return
    try {
      audit(Object.freeze({ event, ...details }))
    } catch {
      // Observability must never change lifecycle correctness.
    }
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

  const registerModelProviderContribution = (record, kind, adapter, options = undefined) => {
    assertPluginWritable(record)
    const normalizedKind = trimmedString(kind).toLowerCase()
    if (!PLUGIN_MODEL_PROVIDER_KIND_RE.test(normalizedKind)) {
      throw new TypeError('model provider kind must match [a-z0-9][a-z0-9_-]{0,63}')
    }
    assertContributionDeclared(record, `model-provider:${normalizedKind}`)
    if (RESERVED_MODEL_PROVIDER_KIND_SET.has(normalizedKind)
      && !supportsRuntimeCapabilityReplacement) {
      const error = new TypeError(`runtime plugin cannot replace built-in model provider kind: ${normalizedKind}`)
      error.code = 'PLUGIN_MODEL_PROVIDER_KIND_RESERVED'
      error.retryable = false
      throw error
    }
    const capabilityOptions = options === undefined
      ? Object.freeze({})
      : snapshotOptionalContributionDefinition(
          options,
          'plugin model provider options',
          ['id', 'version', 'revision', 'priority', 'replaces'],
        )
    const builtinCapabilityId = RESERVED_MODEL_PROVIDER_KIND_SET.has(normalizedKind)
      ? `builtin.provider.${normalizedKind}`
      : null
    const replaces = capabilityOptions.replaces == null
      ? null
      : trimmedString(capabilityOptions.replaces)
    if (builtinCapabilityId && replaces !== builtinCapabilityId) {
      const error = new TypeError(`model provider replacement must declare replaces: ${builtinCapabilityId}`)
      error.code = 'PLUGIN_MODEL_PROVIDER_REPLACEMENT_REQUIRED'
      error.retryable = false
      throw error
    }
    if (!builtinCapabilityId && replaces) {
      const error = new TypeError(`model provider cannot replace a non-builtin capability: ${normalizedKind}`)
      error.code = 'PLUGIN_MODEL_PROVIDER_REPLACEMENT_INVALID'
      error.retryable = false
      throw error
    }
    if (replaces && (!Number.isSafeInteger(capabilityOptions.priority) || capabilityOptions.priority <= 0)) {
      const error = new TypeError('model provider replacement priority must be a positive integer')
      error.code = 'PLUGIN_MODEL_PROVIDER_REPLACEMENT_PRIORITY_INVALID'
      error.retryable = false
      throw error
    }
    const wrappedAdapter = snapshotRuntimeModelProvider({
      record,
      kind: normalizedKind,
      adapter,
      invokeSync: invokePluginCallbackSync,
      invokeAsync: invokePluginCallback,
    })
    const capabilityId = capabilityOptions.id === undefined
      ? `plugin.${record.manifest.id}.provider.${normalizedKind}`
      : trimmedString(capabilityOptions.id)
    if (!PLUGIN_CAPABILITY_ID_RE.test(capabilityId)) {
      throw new TypeError('plugin model provider capability id is invalid')
    }
    const capabilityDefinition = Object.freeze({
      id: capabilityId,
      type: 'provider',
      slot: normalizedKind,
      owner: record.manifest.id,
      version: capabilityOptions.version === undefined
        ? record.manifest.version
        : capabilityOptions.version,
      revision: capabilityOptions.revision === undefined
        ? record.configRevision
        : capabilityOptions.revision,
      priority: capabilityOptions.priority === undefined ? 10 : capabilityOptions.priority,
      replaces,
      ...(record.manifest.integrity ? { releaseDigest: record.manifest.integrity } : {}),
      implementation: wrappedAdapter,
      healthCheck: () => true,
    })
    let activationFailureHandles = null
    const lifecycleParts = (handles) => [
      ...(typeof handles?.capability === 'function'
        ? [{ id: `provider:${normalizedKind}:capability`, handle: handles.capability }]
        : []),
      ...(typeof handles?.provider === 'function'
        ? [{ id: `provider:${normalizedKind}:implementation`, handle: handles.provider }]
        : []),
    ]
    return createManagedContribution(record, {
      activate() {
        const handles = { capability: null, provider: null }
        activationFailureHandles = handles
        handles.capability = registerRuntimeCapability(capabilityDefinition)
        if (typeof handles.capability !== 'function') {
          throw new TypeError('runtime capability registration must return a disposer')
        }
        handles.provider = registerModelProvider(normalizedKind, wrappedAdapter, {
          allowBuiltinReplacement: Boolean(builtinCapabilityId),
        })
        if (typeof handles.provider !== 'function') {
          throw new TypeError('model provider registration must return a disposer')
        }
        activationFailureHandles = null
        return Object.freeze(handles)
      },
      parts: lifecycleParts,
      // Keep a successful first-stage capability registration under the
      // managed V2 lifecycle when provider implementation registration fails.
      // Retained or indeterminate visibility can then be retried on uninstall.
      activationFailureParts: () => lifecycleParts(activationFailureHandles),
    })
  }

  const registerLoopContribution = (record, adapter, options = undefined) => {
    assertPluginWritable(record)
    if (!supportsRuntimeCapabilityReplacement) {
      const error = new Error('runtime plugin loop host is unavailable')
      error.code = 'PLUGIN_LOOP_HOST_UNAVAILABLE'
      error.retryable = false
      throw error
    }
    const capturedAdapter = prepareToolLoopAdapter(adapter)
    const capabilityOptions = options === undefined
      ? Object.freeze({})
      : snapshotOptionalContributionDefinition(
          options,
          'plugin loop options',
          ['version', 'revision', 'priority', 'replaces', 'healthCheck'],
        )
    const capabilityId = capturedAdapter.id
    assertContributionDeclared(record, `loop:${capabilityId}`)
    const replaces = capabilityOptions.replaces == null
      ? null
      : trimmedString(capabilityOptions.replaces)
    if (replaces !== BUILTIN_TOOL_LOOP_ADAPTER_ID) {
      const error = new TypeError(
        `plugin loop replacement must declare replaces: ${BUILTIN_TOOL_LOOP_ADAPTER_ID}`,
      )
      error.code = 'PLUGIN_LOOP_REPLACEMENT_REQUIRED'
      error.retryable = false
      throw error
    }
    const priority = capabilityOptions.priority === undefined ? 10 : capabilityOptions.priority
    if (!Number.isSafeInteger(priority) || priority <= 0) {
      const error = new TypeError('plugin loop replacement priority must be a positive integer')
      error.code = 'PLUGIN_LOOP_REPLACEMENT_PRIORITY_INVALID'
      error.retryable = false
      throw error
    }
    const pluginHealthCheck = capabilityOptions.healthCheck
    if (pluginHealthCheck !== undefined && typeof pluginHealthCheck !== 'function') {
      const error = new TypeError('plugin loop healthCheck must be a function')
      error.code = 'PLUGIN_LOOP_HEALTH_CHECK_INVALID'
      error.retryable = false
      throw error
    }
    const wrappedAdapter = prepareToolLoopAdapter(Object.freeze({
      id: capturedAdapter.id,
      contractVersion: capturedAdapter.contractVersion,
      ...(capturedAdapter.contractVersion === TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3
        ? { hostCapabilities: capturedAdapter.hostCapabilities }
        : {}),
      run(context) {
        if (record.state !== 'active') {
          const error = new Error(`plugin loop is unavailable: ${record.manifest.id}`)
          error.code = 'PLUGIN_LOOP_UNAVAILABLE'
          error.retryable = false
          throw error
        }
        return invokePluginCallback(record, 'loop', capturedAdapter.run, [context])
      },
    }))
    const capabilityDefinition = Object.freeze({
      id: capabilityId,
      type: 'loop',
      owner: record.manifest.id,
      version: capabilityOptions.version === undefined
        ? record.manifest.version
        : capabilityOptions.version,
      revision: capabilityOptions.revision === undefined
        ? record.configRevision
        : capabilityOptions.revision,
      priority,
      replaces,
      ...(record.manifest.integrity ? { releaseDigest: record.manifest.integrity } : {}),
      implementation: wrappedAdapter,
      healthCheck: async () => {
        if (record.state !== 'active') return { ok: false, code: 'PLUGIN_LOOP_UNAVAILABLE' }
        if (!pluginHealthCheck) return true
        return invokePluginCallback(record, 'loop-health-check', pluginHealthCheck, [])
      },
    })
    const assertNotInUse = () => {
      if (!isRuntimeCapabilityInUse(capabilityDefinition)) return true
      const error = new Error(`plugin loop is active and must be stopped before unload: ${capabilityId}`)
      error.code = 'PLUGIN_LOOP_CAPABILITY_IN_USE'
      error.statusCode = 409
      error.retryable = true
      throw error
    }
    const assertSlotInactive = () => {
      if (!isRuntimeCapabilitySlotActive(capabilityDefinition)) return true
      const error = new Error(
        `runtime Loop must be stopped before installing a replacement: ${capabilityId}`,
      )
      error.code = 'PLUGIN_LOOP_CAPABILITY_IN_USE'
      error.statusCode = 409
      error.retryable = true
      throw error
    }
    assertSlotInactive()
    record.deactivationChecks.add(assertNotInUse)
    try {
      return createManagedContribution(record, {
        activate() {
          assertSlotInactive()
          const dispose = registerRuntimeCapability(capabilityDefinition)
          if (typeof dispose !== 'function') {
            const error = new TypeError('runtime loop capability registration must return a disposer')
            error.code = 'PLUGIN_LOOP_HOST_INVALID'
            error.retryable = false
            throw error
          }
          emitAudit('plugin.loop_registered', {
            pluginId: record.manifest.id,
            capabilityId,
            contractVersion: capturedAdapter.contractVersion,
            revision: capabilityDefinition.revision,
            version: capabilityDefinition.version,
          })
          return dispose
        },
        deactivate(dispose) {
          const removed = dispose()
          emitAudit('plugin.loop_unregistered', {
            pluginId: record.manifest.id,
            capabilityId,
            restoredCapabilityId: BUILTIN_TOOL_LOOP_ADAPTER_ID,
          })
          return removed
        },
        onDispose: () => record.deactivationChecks.delete(assertNotInUse),
        activateImmediately: record.state === 'active' && !record.deferVisibility,
      })
    } catch (error) {
      record.deactivationChecks.delete(assertNotInUse)
      throw error
    }
  }

  const registerPolicyContribution = (record, adapter, options = undefined) => {
    assertPluginWritable(record)
    if (!supportsRuntimeCapabilityReplacement) {
      const error = new Error('runtime plugin policy host is unavailable')
      error.code = 'PLUGIN_POLICY_HOST_UNAVAILABLE'
      error.retryable = false
      throw error
    }
    const capturedAdapter = validatePolicyAdapter(adapter)
    const capabilityOptions = options === undefined
      ? Object.freeze({})
      : snapshotOptionalContributionDefinition(
          options,
          'plugin policy options',
          ['id', 'version', 'revision', 'priority', 'replaces'],
        )
    const capabilityId = capabilityOptions.id === undefined
      ? `plugin.${record.manifest.id}.policy`
      : trimmedString(capabilityOptions.id)
    if (!PLUGIN_CAPABILITY_ID_RE.test(capabilityId)) {
      const error = new TypeError('plugin policy capability id is invalid')
      error.code = 'PLUGIN_POLICY_ID_INVALID'
      error.retryable = false
      throw error
    }
    assertContributionDeclared(record, `policy:${capabilityId}`)
    const replaces = capabilityOptions.replaces == null
      ? null
      : trimmedString(capabilityOptions.replaces)
    if (replaces !== BUILTIN_POLICY_CAPABILITY_ID) {
      const error = new TypeError(
        `plugin policy replacement must declare replaces: ${BUILTIN_POLICY_CAPABILITY_ID}`,
      )
      error.code = 'PLUGIN_POLICY_REPLACEMENT_REQUIRED'
      error.retryable = false
      throw error
    }
    const priority = capabilityOptions.priority === undefined ? 10 : capabilityOptions.priority
    if (!Number.isSafeInteger(priority) || priority <= 0) {
      const error = new TypeError('plugin policy replacement priority must be a positive integer')
      error.code = 'PLUGIN_POLICY_REPLACEMENT_PRIORITY_INVALID'
      error.retryable = false
      throw error
    }
    const wrappedAdapter = validatePolicyAdapter(Object.freeze({
      contractVersion: POLICY_ADAPTER_CONTRACT_VERSION,
      classify(request) {
        if (record.state !== 'active') {
          const error = new Error(`plugin policy is unavailable: ${record.manifest.id}`)
          error.code = 'PLUGIN_POLICY_UNAVAILABLE'
          error.retryable = false
          throw error
        }
        return invokePluginCallbackSync(
          record,
          'policy',
          capturedAdapter.classify,
          [request],
        )
      },
    }))
    const capabilityDefinition = Object.freeze({
      id: capabilityId,
      type: 'policy',
      owner: record.manifest.id,
      version: capabilityOptions.version === undefined
        ? record.manifest.version
        : capabilityOptions.version,
      revision: capabilityOptions.revision === undefined
        ? record.configRevision
        : capabilityOptions.revision,
      priority,
      replaces,
      ...(record.manifest.integrity ? { releaseDigest: record.manifest.integrity } : {}),
      implementation: wrappedAdapter,
      healthCheck: () => true,
    })
    return createManagedContribution(record, {
      activate() {
        const dispose = registerRuntimeCapability(capabilityDefinition)
        if (typeof dispose !== 'function') {
          const error = new TypeError('runtime policy capability registration must return a disposer')
          error.code = 'PLUGIN_POLICY_HOST_INVALID'
          error.retryable = false
          throw error
        }
        emitAudit('plugin.policy_registered', {
          pluginId: record.manifest.id,
          capabilityId,
          contractVersion: POLICY_ADAPTER_CONTRACT_VERSION,
          revision: capabilityDefinition.revision,
          version: capabilityDefinition.version,
        })
        return dispose
      },
      deactivate(dispose) {
        const removed = dispose()
        emitAudit('plugin.policy_unregistered', {
          pluginId: record.manifest.id,
          capabilityId,
          restoredCapabilityId: BUILTIN_POLICY_CAPABILITY_ID,
        })
        return removed
      },
      activateImmediately: record.state === 'active' && !record.deferVisibility,
    })
  }

  const emitConfigReloadAudit = (event, details = {}) => {
    const entry = Object.freeze({ event, at: new Date().toISOString(), ...details })
    configReloadAudit.push(entry)
    if (configReloadAudit.length > MAX_CONFIG_RELOAD_AUDIT_EVENTS) configReloadAudit.shift()
    emitAudit(event, details)
  }

  const registerHttpCapabilityContribution = (record, definition) => {
    assertPluginWritable(record)
    const snapshot = snapshotRuntimePluginHttpCapability({
      record,
      definition,
      invoke: invokePluginCallback,
    })
    assertContributionDeclared(record, `http-capability:${snapshot.id}`)
    const contribution = {
      definition: snapshot,
    }
    record.httpCapabilities.add(contribution)
    return createManagedContribution(record, {
      activate() {
        const dispose = registerHttpCapability(contribution.definition)
        if (typeof dispose !== 'function') {
          const error = new TypeError('HTTP capability registration must return a disposer')
          error.code = 'PLUGIN_HTTP_CAPABILITY_HOST_INVALID'
          error.retryable = false
          throw error
        }
        emitAudit('plugin.http_capability_registered', {
          pluginId: record.manifest.id,
          capabilityId: snapshot.id,
          priority: snapshot.priority,
          replaces: snapshot.replaces || null,
        })
        return dispose
      },
      deactivate(dispose) {
        const removed = dispose()
        emitAudit('plugin.http_capability_unregistered', {
          pluginId: record.manifest.id,
          capabilityId: snapshot.id,
          restoredCapabilityId: snapshot.replaces || null,
        })
        return removed
      },
      activateImmediately: record.state === 'active' && !record.deferVisibility,
      onDispose(wasActive) {
        record.httpCapabilities.delete(contribution)
        if (wasActive) return
        emitAudit('plugin.http_capability_discarded', {
        pluginId: record.manifest.id,
        capabilityId: snapshot.id,
        restoredCapabilityId: snapshot.replaces || null,
      })
      },
    })
  }

  const assertManifestCompatible = (manifest) => assertPluginCompatibility(manifest, {
    hostVersion: PLUGIN_HOST_VERSION,
    apiVersion: PLUGIN_API_VERSION,
    resolveDependencyVersion: (id) => {
      const dependency = plugins.get(id)
      return dependency?.state === 'active' ? dependency.manifest.version : null
    },
  })

  const createPluginRecord = ({
    manifest,
    setup,
    configResolver,
    configResolution,
    configRevision,
    state,
    deferVisibility,
    installedAt = null,
  }) => ({
    manifest,
    setup,
    configResolver,
    configResolution,
    configRevision,
    state,
    deferVisibility,
    cancelRequested: false,
    installedAt,
    sequence: ++installSequence,
    effects: createEffectTracker(),
    managedContributions: [],
    deactivationChecks: new Set(),
    configHealthChecks: new Set(),
    eventContributions: new Set(),
    agentEventContributions: new Set(),
    httpCapabilities: new Set(),
    visibleEffects: new Set(),
    revocationErrors: [],
    revocationPromise: null,
    activeCallbacks: 0,
    callbackDrainWaiters: new Set(),
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
    const normalizedId = trimmedString(id)
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
    const normalizedId = trimmedString(id)
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
    getPlugin: (id) => snapshotRuntimePlugin(plugins.get(trimmedString(id))),
    listEffectiveConfigs: () => listRuntimePluginEffectiveConfigs(plugins.values()),
    listConfigReloadAudit: () => Object.freeze([...configReloadAudit]),
    hasService,
    invokeService,
    renderPromptBlocks,
    shutdown,
  })
}
