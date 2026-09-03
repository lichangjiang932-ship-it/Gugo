import { validatePolicyAdapter } from '../core/policyAdapter.js'
import {
  BUILTIN_TOOL_LOOP_ADAPTER_ID,
  TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3,
  prepareToolLoopAdapter,
} from '../core/toolLoopAdapter.js'
import { ENDPOINT_KINDS } from '../utils/endpointProfile.js'
import { snapshotOptionalContributionDefinition } from './pluginContributionDefinition.js'
import { POLICY_ADAPTER_CONTRACT_VERSION } from './pluginHostContract.js'
import { snapshotRuntimePluginHttpCapability } from './pluginHttpCapability.js'
import { snapshotRuntimeModelProvider } from './pluginModelProvider.js'

const PLUGIN_MODEL_PROVIDER_KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const PLUGIN_CAPABILITY_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const BUILTIN_POLICY_CAPABILITY_ID = 'builtin.harness-policy'
const RESERVED_MODEL_PROVIDER_KIND_SET = new Set(ENDPOINT_KINDS)

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function createRuntimePluginCapabilityRegistry({
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
} = {}) {
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

  return Object.freeze({
    registerHttpCapabilityContribution,
    registerLoopContribution,
    registerModelProviderContribution,
    registerPolicyContribution,
  })
}
