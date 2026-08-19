import { AsyncLocalStorage } from 'node:async_hooks'

import { LOOP_EVENT_NAMES } from '../services/loop/eventNames.js'
import { CONNECTOR_TOOL_NAMES } from '../services/connectorTools.js'
import {
  getBuiltinSpec,
  registerDynamicTool,
} from '../utils/toolSchemaCatalog.js'
import { createPluginContext } from './pluginContext.js'
import { registerModelProviderAdapter } from '../adapters/modelProviderRegistry.js'
import {
  createEffectTracker,
  normalizeRuntimePluginManifest,
} from './pluginLifecycle.js'

const LOOP_EVENT_NAME_SET = new Set(LOOP_EVENT_NAMES)
const CONNECTOR_TOOL_NAME_SET = new Set(CONNECTOR_TOOL_NAMES)
const MAX_PLUGIN_SCHEMA_DEPTH = 32
const MAX_PLUGIN_SCHEMA_NODES = 8_192
const MAX_PLUGIN_SCHEMA_BYTES = 512 * 1024
const PLUGIN_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
const PLUGIN_TOOL_RISK_METADATA = Object.freeze({
  riskClass: 'external',
  category: 'external',
  riskLevel: 'high',
  requiredApproval: true,
  requiresApproval: true,
  isReadOnly: false,
  readOnly: false,
  isConcurrencySafe: false,
  isIdempotent: false,
  interruptBehavior: 'block',
  isDestructive: true,
  source: 'fallback',
  reason: 'Runtime plugin tools require explicit host approval.',
})

function snapshotPluginToolSpec(input) {
  const seen = new WeakSet()
  let nodes = 0
  let bytes = 0

  const clone = (value, depth) => {
    nodes += 1
    if (nodes > MAX_PLUGIN_SCHEMA_NODES) throw new TypeError('plugin tool schema is too large')
    if (depth > MAX_PLUGIN_SCHEMA_DEPTH) throw new TypeError('plugin tool schema is too deep')
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('plugin tool schema numbers must be finite')
      return value
    }
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value, 'utf8')
      if (bytes > MAX_PLUGIN_SCHEMA_BYTES) throw new TypeError('plugin tool schema is too large')
      return value
    }
    if (!value || typeof value !== 'object') {
      throw new TypeError('plugin tool schema must contain JSON values only')
    }
    if (seen.has(value)) throw new TypeError('plugin tool schema must not contain cycles')
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const out = []
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = descriptors[index]
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('plugin tool schema arrays must be dense data arrays')
          }
          out.push(clone(descriptor.value, depth + 1))
        }
        return Object.freeze(out)
      }
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('plugin tool schema objects must be plain JSON objects')
      }
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const out = Object.create(null)
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') throw new TypeError('plugin tool schema keys must be strings')
        const descriptor = descriptors[key]
        if (!Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('plugin tool schema getters and setters are not allowed')
        }
        bytes += Buffer.byteLength(key, 'utf8')
        if (bytes > MAX_PLUGIN_SCHEMA_BYTES) throw new TypeError('plugin tool schema is too large')
        Object.defineProperty(out, key, {
          value: clone(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false,
        })
      }
      return Object.freeze(out)
    } finally {
      seen.delete(value)
    }
  }

  const snapshot = clone(input, 0)
  if (!snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || !Object.hasOwn(snapshot, 'type')
    || snapshot.type !== 'function'
    || !Object.hasOwn(snapshot, 'function')
    || !snapshot.function
    || typeof snapshot.function !== 'object'
    || Array.isArray(snapshot.function)
    || !Object.hasOwn(snapshot.function, 'name')
    || typeof snapshot.function.name !== 'string'
    || !Object.hasOwn(snapshot.function, 'parameters')
    || !snapshot.function.parameters
    || typeof snapshot.function.parameters !== 'object'
    || Array.isArray(snapshot.function.parameters)) {
    throw new TypeError('plugin tool spec must be a function schema with object parameters')
  }
  if (!PLUGIN_TOOL_NAME_RE.test(snapshot.function.name)) {
    throw new TypeError('plugin tool name must match [A-Za-z0-9_-]{1,64}')
  }
  if (!Object.hasOwn(snapshot.function.parameters, 'type')
    || snapshot.function.parameters.type !== 'object') {
    throw new TypeError('plugin tool parameters.type must be object')
  }
  return snapshot
}

function assertLoopEventBus(events) {
  if (!events || typeof events.on !== 'function' || typeof events.off !== 'function') {
    throw new TypeError('loop event bus must provide on/off')
  }
}

function reservedToolOwner(name) {
  if (getBuiltinSpec(name)) return 'builtin'
  if (CONNECTOR_TOOL_NAME_SET.has(name)) return 'connector'
  if (name.startsWith('mcp__')) return 'MCP'
  if (name.startsWith('browser_')) return 'browser'
  return null
}

function pluginSnapshot(record) {
  if (!record) return null
  return {
    ...record.manifest,
    requires: [...record.manifest.requires],
    contributes: [...record.manifest.contributes],
    state: record.state,
    installedAt: record.installedAt,
  }
}

export function createRuntimePluginRegistry({
  config = {},
  registerTool = registerDynamicTool,
  registerModelProvider = registerModelProviderAdapter,
  audit = null,
} = {}) {
  const plugins = new Map()
  const services = new Map()
  const loopBindings = new Set()
  const callbackScope = new AsyncLocalStorage()
  let installSequence = 0
  let shuttingDown = false
  let shutdownPromise = null

  const pluginToolUnavailableError = (record, name) => {
    const error = new Error(`plugin tool is unavailable: ${record.manifest.id}/${name}`)
    error.code = 'PLUGIN_TOOL_UNAVAILABLE'
    error.retryable = false
    return error
  }

  const finishCallback = (record) => {
    record.activeCallbacks -= 1
    if (record.activeCallbacks !== 0) return
    for (const resolve of record.callbackDrainWaiters) resolve()
    record.callbackDrainWaiters.clear()
  }

  const waitForCallbacksToDrain = (record) => {
    if (record.activeCallbacks === 0) return Promise.resolve()
    return new Promise((resolve) => record.callbackDrainWaiters.add(resolve))
  }

  const invokePluginCallback = async (record, kind, callback, args) => {
    record.activeCallbacks += 1
    const invocation = { record, kind, active: true }
    try {
      return await callbackScope.run(invocation, () => callback(...args))
    } finally {
      invocation.active = false
      finishCallback(record)
    }
  }

  const callbackDrainDeadlockError = (operation, record) => {
    const error = new Error(operation === 'unregister'
      ? `plugin callback cannot unregister its own plugin before returning because that would deadlock callback drain: ${record.manifest.id}`
      : `plugin callback cannot shut down the runtime plugin registry before returning because that would deadlock callback drain: ${record.manifest.id}`)
    error.code = operation === 'unregister'
      ? 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK'
      : 'PLUGIN_CALLBACK_SHUTDOWN_DEADLOCK'
    error.retryable = false
    return error
  }

  const activeCallbackInvocation = () => {
    const invocation = callbackScope.getStore()
    return invocation?.active === true ? invocation : null
  }

  const assertPluginWritable = (record) => {
    if (record.state !== 'installing' && record.state !== 'active') {
      throw new Error(`plugin lifecycle is closed: ${record.manifest.id}`)
    }
  }

  const emitAudit = (event, details = {}) => {
    if (typeof audit !== 'function') return
    try {
      audit({ event, ...details })
    } catch {
      // Observability must never change lifecycle correctness.
    }
  }

  const trackVisibleEffect = (record, effect) => {
    let tracked = null
    const visibleEffect = () => {
      record.visibleEffects.delete(tracked)
      return effect()
    }
    tracked = record.effects.track(visibleEffect)
    record.visibleEffects.add(tracked)
    return tracked
  }

  const revokeVisibleEffects = (record) => {
    for (const dispose of [...record.visibleEffects].reverse()) {
      try {
        dispose()
      } catch (error) {
        record.revocationErrors.push(error)
      }
    }
    record.visibleEffects.clear()
  }

  const detachBinding = (binding) => {
    if (!loopBindings.delete(binding)) return false
    for (const dispose of [...binding.attachments.values()].reverse()) {
      try { dispose() } catch { /* best-effort per-loop cleanup */ }
    }
    binding.attachments.clear()
    return true
  }

  const attachContribution = (binding, contribution) => {
    if (binding.attachments.has(contribution)) return
    const dispose = binding.events.on(contribution.event, contribution.listener)
    if (typeof dispose !== 'function') {
      throw new TypeError('loop event registration must return a disposer')
    }
    binding.attachments.set(contribution, dispose)
  }

  const detachContribution = (contribution) => {
    for (const binding of loopBindings) {
      const dispose = binding.attachments.get(contribution)
      if (!dispose) continue
      binding.attachments.delete(contribution)
      dispose()
    }
  }

  const registerEventContribution = (record, event, listener) => {
    assertPluginWritable(record)
    if (!LOOP_EVENT_NAME_SET.has(event)) {
      throw new TypeError(`Unknown loop event: ${String(event)}`)
    }
    if (typeof listener !== 'function') {
      throw new TypeError('plugin event listener must be a function')
    }
    const contribution = {
      pluginId: record.manifest.id,
      event,
      async listener(...args) {
        if (record.state !== 'active') return undefined
        return invokePluginCallback(record, 'event', listener, args)
      },
    }
    record.eventContributions.add(contribution)
    try {
      for (const binding of loopBindings) attachContribution(binding, contribution)
    } catch (error) {
      detachContribution(contribution)
      record.eventContributions.delete(contribution)
      throw error
    }
    return trackVisibleEffect(record, () => {
      record.eventContributions.delete(contribution)
      detachContribution(contribution)
    })
  }

  const provideService = (record, name, value) => {
    assertPluginWritable(record)
    const normalizedName = String(name || '').trim()
    if (!normalizedName) throw new TypeError('plugin service name is required')
    if (services.has(normalizedName)) {
      throw new Error(`plugin service already provided: ${normalizedName}`)
    }
    const contribution = { pluginId: record.manifest.id, record, value }
    services.set(normalizedName, contribution)
    return trackVisibleEffect(record, () => {
      if (services.get(normalizedName) !== contribution) return false
      return services.delete(normalizedName)
    })
  }

  const registerToolContribution = (record, definition) => {
    assertPluginWritable(record)
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new TypeError('plugin tool definition must be an object')
    }
    const name = String(definition.name || '').trim()
    const spec = snapshotPluginToolSpec(definition.spec)
    const specName = String(spec.function.name || '').trim()
    if (!name || name !== specName) {
      throw new TypeError('plugin tool name must match spec.function.name')
    }
    const reservedOwner = reservedToolOwner(name)
    if (reservedOwner) {
      throw new Error(`plugin tool cannot shadow ${reservedOwner} tool: ${name}`)
    }
    const pluginExec = definition.exec
    if (typeof pluginExec !== 'function') {
      throw new TypeError('plugin tool exec must be a function')
    }
    const dispose = registerTool({
      name,
      spec,
      async exec(...args) {
        if (record.state !== 'active') throw pluginToolUnavailableError(record, name)
        return invokePluginCallback(record, 'tool', pluginExec, args)
      },
      // Runtime plugins are process-level host contributions. A plugin has no
      // authenticated request identity here, so accepting a caller-supplied
      // userId would let it forge tenant scope. User-scoped tools must be
      // registered by an authenticated host integration instead.
      userId: null,
      // Trust labels belong to the host, never to plugin-controlled input.
      origin: 'plugin',
      source: record.manifest.id,
      metadata: PLUGIN_TOOL_RISK_METADATA,
    })
    if (typeof dispose !== 'function') {
      throw new TypeError('tool registration must return a disposer')
    }
    return trackVisibleEffect(record, dispose)
  }

  const registerModelProviderContribution = (record, kind, adapter) => {
    assertPluginWritable(record)
    const dispose = registerModelProvider(kind, adapter)
    if (typeof dispose !== 'function') {
      throw new TypeError('model provider registration must return a disposer')
    }
    return trackVisibleEffect(record, dispose)
  }

  const registerPlugin = async (manifest, setup) => {
    if (shuttingDown) {
      const error = new Error('runtime plugin registry is shutting down')
      error.code = 'PLUGIN_REGISTRY_SHUTTING_DOWN'
      throw error
    }
    const normalized = normalizeRuntimePluginManifest(manifest)
    if (typeof setup !== 'function') throw new TypeError('plugin setup must be a function')
    if (plugins.has(normalized.id)) throw new Error(`plugin already registered: ${normalized.id}`)
    const missing = normalized.requires.filter((id) => plugins.get(id)?.state !== 'active')
    if (missing.length > 0) {
      throw new Error(`plugin dependencies are not active: ${missing.join(', ')}`)
    }

    const record = {
      manifest: normalized,
      state: 'installing',
      cancelRequested: false,
      installedAt: null,
      sequence: ++installSequence,
      effects: createEffectTracker(),
      eventContributions: new Set(),
      visibleEffects: new Set(),
      revocationErrors: [],
      activeCallbacks: 0,
      callbackDrainWaiters: new Set(),
    }
    record.installSettled = new Promise((resolve) => {
      record.resolveInstallSettled = resolve
    })
    plugins.set(normalized.id, record)
    emitAudit('plugin.installing', { pluginId: normalized.id, version: normalized.version })

    const context = createPluginContext({
      manifest: normalized,
      config,
      track: record.effects.track,
      registerTool: (definition) => registerToolContribution(record, definition),
      registerEvent: (event, listener) => registerEventContribution(record, event, listener),
      registerModelProvider: (kind, adapter) => registerModelProviderContribution(record, kind, adapter),
      provideService: (name, value) => provideService(record, name, value),
      getService: (name) => {
        const contribution = services.get(String(name || '').trim())
        return contribution?.record?.state === 'active' ? contribution.value : undefined
      },
      hasService: (name) => {
        const contribution = services.get(String(name || '').trim())
        return contribution?.record?.state === 'active'
      },
      emitAudit: (event, details) => emitAudit(event, {
        pluginId: normalized.id,
        details,
      }),
    })

    try {
      const setupEffects = await setup(context)
      if (setupEffects != null) record.effects.track(setupEffects)
      if (record.cancelRequested) {
        const cancelled = new Error(`plugin install cancelled: ${normalized.id}`)
        cancelled.code = 'PLUGIN_INSTALL_CANCELLED'
        throw cancelled
      }
      const missingAfterSetup = normalized.requires
        .filter((id) => plugins.get(id)?.state !== 'active')
      if (missingAfterSetup.length > 0) {
        throw new Error(`plugin dependencies changed during setup: ${missingAfterSetup.join(', ')}`)
      }
      record.state = 'active'
      record.installedAt = new Date().toISOString()
      emitAudit('plugin.installed', { pluginId: normalized.id, version: normalized.version })
      return pluginSnapshot(record)
    } catch (error) {
      record.state = 'failed'
      revokeVisibleEffects(record)
      const rollbackErrors = [
        ...record.revocationErrors,
        ...await record.effects.disposeAll(),
      ]
      record.revocationErrors.length = 0
      plugins.delete(normalized.id)
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

  const unregisterPlugin = async (id) => {
    const normalizedId = String(id || '').trim()
    const record = plugins.get(normalizedId)
    if (!record) return false
    const invocation = activeCallbackInvocation()
    if (invocation?.record === record) {
      throw callbackDrainDeadlockError('unregister', record)
    }
    if (record.state === 'cancelling') {
      await record.cancelPromise
      return !plugins.has(normalizedId)
    }
    if (record.state === 'installing') {
      record.cancelRequested = true
      record.state = 'cancelling'
      revokeVisibleEffects(record)
      record.cancelPromise = record.installSettled
      await record.cancelPromise
      return !plugins.has(normalizedId)
    }
    if (record.state === 'failed') {
      await record.installSettled
      return !plugins.has(normalizedId)
    }
    if (record.state === 'uninstalling') return record.uninstallPromise
    const dependents = [...plugins.values()]
      .filter((candidate) => (
        candidate !== record
        && candidate.manifest.requires.includes(normalizedId)
      ))
      .map((candidate) => candidate.manifest.id)
    if (dependents.length > 0) {
      throw new Error(`plugin is required by active plugins: ${dependents.join(', ')}`)
    }
    record.state = 'uninstalling'
    revokeVisibleEffects(record)
    emitAudit('plugin.uninstalling', { pluginId: normalizedId })
    record.uninstallPromise = (async () => {
      await waitForCallbacksToDrain(record)
      const errors = [
        ...record.revocationErrors,
        ...await record.effects.disposeAll(),
      ]
      record.revocationErrors.length = 0
      plugins.delete(normalizedId)
      emitAudit('plugin.uninstalled', {
        pluginId: normalizedId,
        errors: errors.map((item) => item?.message || String(item)),
      })
      if (errors.length > 0) {
        throw new AggregateError(errors, `plugin uninstall failed: ${normalizedId}`)
      }
      return true
    })()
    return record.uninstallPromise
  }

  const bindLoopEvents = (events, context = {}) => {
    assertLoopEventBus(events)
    const binding = { events, context: { ...context }, attachments: new Map() }
    try {
      for (const record of plugins.values()) {
        if (record.state !== 'active') continue
        for (const contribution of record.eventContributions) {
          attachContribution(binding, contribution)
        }
      }
      loopBindings.add(binding)
    } catch (error) {
      for (const dispose of [...binding.attachments.values()].reverse()) {
        try { dispose() } catch { /* preserve original bind error */ }
      }
      throw error
    }
    let disposed = false
    return () => {
      if (disposed) return false
      disposed = true
      return detachBinding(binding)
    }
  }

  const shutdown = () => {
    const invocation = activeCallbackInvocation()
    if (invocation) {
      return Promise.reject(callbackDrainDeadlockError('shutdown', invocation.record))
    }
    if (shutdownPromise) return shutdownPromise
    shuttingDown = true
    shutdownPromise = (async () => {
      const errors = []
      const ordered = [...plugins.values()].sort((a, b) => b.sequence - a.sequence)
      for (const record of ordered) {
        try {
          await unregisterPlugin(record.manifest.id)
        } catch (error) {
          errors.push(error)
        }
      }
      for (const binding of [...loopBindings]) detachBinding(binding)
      if (errors.length > 0) throw new AggregateError(errors, 'runtime plugin shutdown failed')
    })().finally(() => {
      shuttingDown = false
      shutdownPromise = null
    })
    return shutdownPromise
  }

  return Object.freeze({
    registerPlugin,
    unregisterPlugin,
    bindLoopEvents,
    listPlugins: () => [...plugins.values()].map(pluginSnapshot),
    getPlugin: (id) => pluginSnapshot(plugins.get(String(id || '').trim())),
    getService: (name) => {
      const contribution = services.get(String(name || '').trim())
      return contribution?.record?.state === 'active' ? contribution.value : undefined
    },
    shutdown,
  })
}
