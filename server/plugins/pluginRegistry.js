/**
 * server/plugins/pluginRegistry.js
 *
 * 内存级 plugin 注册表。bootstrap 阶段 initPlugins 调一次，后续 list/get 同步读。
 * 严格只读：listPlugins / getPlugin 返回浅拷贝，外部不能改内部缓存。
 */

import path from 'node:path'

import {
  discoverPluginDistribution,
  localDirectoryPluginDistributionPort,
} from './pluginDistribution.js'
import {
  createDistributedPluginDefinition,
  createHostPluginDefinition,
  distributedPluginFromDefinition,
  runtimeManifestFromPluginDefinition,
} from './pluginDefinition.js'
import {
  builtinManagedPluginDistributionPort,
  resolveManagedUserPluginRoot,
} from './pluginDistributionSources.js'
import { logger } from '../utils/logger.js'
import { resolveRuntimeConfigPaths } from '../utils/runtimeEnv.js'
import { createRuntimePluginRegistry } from './runtimePluginRegistry.js'
import {
  assertRuntimePluginConfigSourceSnapshot,
  readRuntimePluginConfigSourceSnapshot,
} from './runtimePluginConfigFile.js'
import {
  getRuntimeCapabilityConfigFingerprint,
  listEffectiveRuntimeCapabilityBindings,
  listRuntimeCapabilityAuditEvents,
  listRuntimeCapabilityContributions,
  registerRuntimeCapabilityContribution,
} from '../core/runtimeCapabilityHost.js'
import { getToolLoopAdapterStatus } from '../core/toolLoopAdapter.js'
import {
  configureContextCompactionStrategyServiceInvoker,
} from '../services/contextCompactionStrategy.js'

let CURRENT_DEFINITIONS = new Map()
let LAST_ERRORS = []
let INITIALIZED = false
let PLUGIN_DISCOVERY_SOURCE = null
let PLUGIN_DISCOVERY_REVISION = 0
let PROTECTED_PLUGIN_IDS = Object.freeze([])
let PROTECTED_PLUGIN_IDENTITY_COMPLETE = true
let runtimeHttpCapabilityBinding = null

function registerRuntimeHttpCapability(definition) {
  if (!runtimeHttpCapabilityBinding) {
    const error = new Error('runtime plugin HTTP capability host is not bound')
    error.code = 'PLUGIN_HTTP_CAPABILITY_HOST_UNAVAILABLE'
    error.retryable = false
    throw error
  }
  return runtimeHttpCapabilityBinding.register(definition)
}

const RUNTIME = createRuntimePluginRegistry({
  registerRuntimeCapability: registerRuntimeCapabilityContribution,
  isRuntimeCapabilityInUse(definition) {
    return definition?.type === 'loop'
      && getToolLoopAdapterStatus().configured
      && getToolLoopAdapterStatus().adapterId === definition?.implementation?.id
  },
  isRuntimeCapabilitySlotActive(definition) {
    return definition?.type === 'loop' && getToolLoopAdapterStatus().configured
  },
  registerHttpCapability: registerRuntimeHttpCapability,
})
let runtimePluginConfigSnapshot = null
let runtimePluginConfigSourceContext = null

const RUNTIME_PLUGIN_CONFIG_SOURCE_ENV_KEYS = Object.freeze([
  'APP_DATA_DIR',
  'APP_CONFIG_PATH',
])

function snapshotRuntimePluginConfigSourceContext(cwd, env) {
  const sourceEnv = {}
  for (const key of RUNTIME_PLUGIN_CONFIG_SOURCE_ENV_KEYS) {
    if (env?.[key] !== undefined) sourceEnv[key] = String(env[key])
  }
  const resolvedCwd = path.resolve(cwd)
  return Object.freeze({
    cwd: resolvedCwd,
    env: Object.freeze(sourceEnv),
    paths: Object.freeze(resolveRuntimeConfigPaths({ cwd: resolvedCwd, env: sourceEnv })),
  })
}

function sameRuntimePluginConfigSourceIdentity(left, right) {
  return ['user', 'project', 'explicit'].every((key) => (
    (left?.paths?.[key] || null) === (right?.paths?.[key] || null)
  ))
}

function runtimePluginConfigSourceIdentityError() {
  const error = new Error('runtime plugin configuration source identity cannot change after startup')
  error.code = 'PLUGIN_CONFIG_SOURCE_IDENTITY_CHANGED'
  error.statusCode = 409
  error.retryable = false
  return error
}

function resolveRuntimePluginConfigReloadSourceContext(options = {}) {
  ensureRuntimePluginConfigInitialized()
  const sourceEnv = { ...runtimePluginConfigSourceContext.env }
  if (options.env !== undefined && options.env !== null) {
    for (const key of RUNTIME_PLUGIN_CONFIG_SOURCE_ENV_KEYS) {
      if (!Object.hasOwn(options.env, key)) continue
      if (options.env[key] === undefined) delete sourceEnv[key]
      else sourceEnv[key] = String(options.env[key])
    }
  }
  const sourceContext = snapshotRuntimePluginConfigSourceContext(
    options.cwd ?? runtimePluginConfigSourceContext.cwd,
    sourceEnv,
  )
  if (!sameRuntimePluginConfigSourceIdentity(runtimePluginConfigSourceContext, sourceContext)) {
    throw runtimePluginConfigSourceIdentityError()
  }
  return sourceContext
}

function sameRuntimePluginConfigSnapshot(left, right) {
  return Buffer.isBuffer(left?.fingerprint)
    && Buffer.isBuffer(right?.fingerprint)
    && left.fingerprint.equals(right.fingerprint)
}

/** Bind startup-owned plugin config sources before the first runtime plugin is installed. */
export function initializeRuntimePluginConfig({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const sourceContext = snapshotRuntimePluginConfigSourceContext(cwd, env)
  const snapshot = readRuntimePluginConfigSourceSnapshot(sourceContext)
  if (runtimePluginConfigSnapshot) {
    if (!sameRuntimePluginConfigSnapshot(runtimePluginConfigSnapshot, snapshot)) {
      const error = new Error('runtime plugin configuration source changed after initialization')
      error.code = 'PLUGIN_CONFIG_INITIALIZATION_CONFLICT'
      error.retryable = false
      throw error
    }
    runtimePluginConfigSourceContext = sourceContext
    return true
  }
  RUNTIME.initializeConfigLayerSources(snapshot.layerSources)
  runtimePluginConfigSnapshot = snapshot
  runtimePluginConfigSourceContext = sourceContext
  return true
}

function ensureRuntimePluginConfigInitialized() {
  if (!runtimePluginConfigSnapshot) initializeRuntimePluginConfig()
}

configureContextCompactionStrategyServiceInvoker((name, method, args) => (
  RUNTIME.invokeService(name, method, args)
))

export function bindRuntimePluginHttpCapabilities(registry) {
  const methods = {}
  for (const method of ['register', 'list', 'listAuditEvents']) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(registry, method)
    } catch {
      descriptor = null
    }
    if (!descriptor
      || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function') {
      const error = new TypeError(`HTTP capability registry must expose an own ${method} function`)
      error.code = 'PLUGIN_HTTP_CAPABILITY_HOST_INVALID'
      error.retryable = false
      throw error
    }
    methods[method] = descriptor.value
  }
  if (runtimeHttpCapabilityBinding) {
    const error = new Error('runtime plugin HTTP capability host is already bound')
    error.code = 'PLUGIN_HTTP_CAPABILITY_HOST_ALREADY_BOUND'
    error.retryable = false
    throw error
  }
  const binding = Object.freeze({
    registry,
    register: (definition) => methods.register.call(registry, definition),
    list: () => methods.list.call(registry),
    listAuditEvents: () => methods.listAuditEvents.call(registry),
  })
  runtimeHttpCapabilityBinding = binding
  let disposed = false
  return () => {
    if (disposed) return false
    disposed = true
    if (runtimeHttpCapabilityBinding !== binding) return false
    runtimeHttpCapabilityBinding = null
    return true
  }
}

export function listRuntimePluginHttpCapabilities() {
  if (!runtimeHttpCapabilityBinding) return Object.freeze([])
  const capabilities = runtimeHttpCapabilityBinding.list()
  if (!Array.isArray(capabilities)) {
    const error = new TypeError('HTTP capability registry list must return an array')
    error.code = 'PLUGIN_HTTP_CAPABILITY_HOST_INVALID'
    error.retryable = false
    throw error
  }
  return capabilities
}

export function listRuntimePluginHttpCapabilityAudit() {
  if (!runtimeHttpCapabilityBinding) return Object.freeze([])
  const events = runtimeHttpCapabilityBinding.listAuditEvents()
  if (!Array.isArray(events)) {
    const error = new TypeError('HTTP capability registry audit must return an array')
    error.code = 'PLUGIN_HTTP_CAPABILITY_HOST_INVALID'
    error.retryable = false
    throw error
  }
  return events
}

export function listRuntimeCapabilities() {
  return listRuntimeCapabilityContributions()
}

export function listRuntimeCapabilityBindings() {
  return listEffectiveRuntimeCapabilityBindings()
}

export function listRuntimeCapabilityAudit() {
  return listRuntimeCapabilityAuditEvents()
}

export function runtimeCapabilityConfigFingerprint() {
  return getRuntimeCapabilityConfigFingerprint()
}

/**
 * @param {{ rootDir?: string, silent?: boolean, distributionPort?: object }} [opts]
 * @returns {{ plugins: object[], errors: object[] }}
 */
const PLUGIN_DISCOVERY_ENV_KEYS = Object.freeze(['APP_CONFIG_PATH', 'APP_DATA_DIR'])

function snapshotPluginDiscoverySource({
  rootDir = './plugins',
  silent = process.env.NODE_ENV === 'production',
  distributionPort,
  includeManaged = false,
  managedRootDir,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const resolvedCwd = path.resolve(cwd)
  const sourceEnv = {}
  for (const key of PLUGIN_DISCOVERY_ENV_KEYS) {
    if (env?.[key] !== undefined) sourceEnv[key] = String(env[key])
  }
  const activeDistributionPort = distributionPort || (
    includeManaged
      ? builtinManagedPluginDistributionPort
      : localDirectoryPluginDistributionPort
  )
  const resolvedManagedRoot = includeManaged
    ? path.resolve(resolvedCwd, managedRootDir || resolveManagedUserPluginRoot({
        cwd: resolvedCwd,
        env: sourceEnv,
      }))
    : null
  return Object.freeze({
    rootDir: path.resolve(resolvedCwd, rootDir),
    managedRootDir: resolvedManagedRoot,
    cwd: resolvedCwd,
    env: Object.freeze(sourceEnv),
    distributionPort: activeDistributionPort,
    includeManaged: Boolean(includeManaged),
    silent: Boolean(silent),
  })
}

function samePluginDiscoverySource(left, right) {
  return left?.rootDir === right?.rootDir
    && left?.managedRootDir === right?.managedRootDir
    && left?.cwd === right?.cwd
    && left?.distributionPort === right?.distributionPort
    && left?.includeManaged === right?.includeManaged
    && PLUGIN_DISCOVERY_ENV_KEYS.every((key) => left?.env?.[key] === right?.env?.[key])
}

function pluginDiscoverySourceChangedError() {
  const error = new Error('plugin discovery source identity cannot change after startup')
  error.code = 'PLUGIN_DISCOVERY_SOURCE_IDENTITY_CHANGED'
  error.statusCode = 409
  error.retryable = false
  return error
}

function buildPluginDiscoveryState(source) {
  const distribution = discoverPluginDistribution(source.distributionPort, {
    rootDir: source.rootDir,
    managedRootDir: source.managedRootDir || undefined,
    cwd: source.cwd,
    env: source.env,
  })
  const definitions = distribution.candidates.map((candidate) => (
    createDistributedPluginDefinition(candidate.plugin, {
      distribution: {
        sourceKind: candidate.sourceKind,
        mutable: candidate.mutable,
        verifiedPackage: candidate.verifiedPackage,
        installReceipt: candidate.installReceipt,
      },
    })
  ))
  const pluginIds = new Set()
  for (const definition of definitions) {
    if (pluginIds.has(definition.manifest.id)) {
      const error = new TypeError(`duplicate plugin id: ${definition.manifest.id}`)
      error.code = 'PLUGIN_DISTRIBUTION_ID_CONFLICT'
      error.retryable = false
      throw error
    }
    pluginIds.add(definition.manifest.id)
  }
  return Object.freeze({
    definitions: Object.freeze(definitions),
    errors: distribution.errors,
    protectedPluginIds: distribution.protectedPluginIds,
    protectedPluginIdentityComplete: distribution.protectedPluginIdentityComplete,
  })
}

function commitPluginDiscoveryState(source, state) {
  CURRENT_DEFINITIONS = new Map(state.definitions.map((definition) => [
    definition.manifest.id,
    definition,
  ]))
  LAST_ERRORS = state.errors
  PROTECTED_PLUGIN_IDS = state.protectedPluginIds
  PROTECTED_PLUGIN_IDENTITY_COMPLETE = state.protectedPluginIdentityComplete
  PLUGIN_DISCOVERY_SOURCE = source
  PLUGIN_DISCOVERY_REVISION += 1
  INITIALIZED = true
  if (!source.silent) {
    logger.info(`[plugins] loaded ${state.definitions.length} plugin(s) from ${source.rootDir}`)
    for (const error of state.errors) console.warn(`[plugins] skip ${error.dir}: ${error.message}`)
  }
  const plugins = state.definitions.map(distributedPluginFromDefinition)
  const distributedPlugins = state.definitions.map((definition) => Object.freeze({
    ...distributedPluginFromDefinition(definition),
    distribution: definition.distribution,
  }))
  return Object.freeze({
    revision: PLUGIN_DISCOVERY_REVISION,
    plugins: [...plugins],
    // Host-only provenance captured in the same committed revision. Mutation
    // services use this instead of racing a second global-registry read.
    distributedPlugins: Object.freeze(distributedPlugins),
    errors: LAST_ERRORS.slice(),
  })
}

export function initPlugins(options = {}) {
  const source = snapshotPluginDiscoverySource(options)
  if (PLUGIN_DISCOVERY_SOURCE && !samePluginDiscoverySource(PLUGIN_DISCOVERY_SOURCE, source)) {
    throw pluginDiscoverySourceChangedError()
  }
  const state = buildPluginDiscoveryState(source)
  return commitPluginDiscoveryState(source, state)
}

/** Refresh only from the immutable startup-owned discovery source. */
export function refreshPlugins() {
  if (!PLUGIN_DISCOVERY_SOURCE) {
    const error = new Error('plugin discovery has not been initialized')
    error.code = 'PLUGIN_DISCOVERY_NOT_INITIALIZED'
    error.statusCode = 409
    error.retryable = false
    throw error
  }
  const state = buildPluginDiscoveryState(PLUGIN_DISCOVERY_SOURCE)
  return commitPluginDiscoveryState(PLUGIN_DISCOVERY_SOURCE, state)
}

export function getPluginDiscoverySourceSnapshot() {
  if (!PLUGIN_DISCOVERY_SOURCE) return null
  return Object.freeze({
    revision: PLUGIN_DISCOVERY_REVISION,
    rootDir: PLUGIN_DISCOVERY_SOURCE.rootDir,
    managedRootDir: PLUGIN_DISCOVERY_SOURCE.managedRootDir,
    cwd: PLUGIN_DISCOVERY_SOURCE.cwd,
    includeManaged: PLUGIN_DISCOVERY_SOURCE.includeManaged,
    protectedPluginIds: PROTECTED_PLUGIN_IDS,
    protectedPluginIdentityComplete: PROTECTED_PLUGIN_IDENTITY_COMPLETE,
  })
}

/**
 * @param {{ type?: string }} [opts]
 */
export function listPlugins({ type } = {}) {
  const definitions = [...CURRENT_DEFINITIONS.values()]
  const out = type
    ? definitions.filter((definition) => definition.plugin.type === type)
    : definitions
  return out.map((definition) => ({ ...distributedPluginFromDefinition(definition) }))
}

/** Host-only view that keeps DistributionPort provenance out of the public plugin shape. */
export function listDistributedPlugins({ type } = {}) {
  const definitions = [...CURRENT_DEFINITIONS.values()]
  const out = type
    ? definitions.filter((definition) => definition.plugin.type === type)
    : definitions
  return out.map((definition) => ({
    ...distributedPluginFromDefinition(definition),
    distribution: definition.distribution,
  }))
}

/** Host-only canonical definition used to bridge a distributed package into runtime activation. */
export function getPluginDefinition(id) {
  if (!id) return null
  return CURRENT_DEFINITIONS.get(id) || null
}

/**
 * @param {string} id
 */
export function getPlugin(id) {
  const definition = getPluginDefinition(id)
  return definition ? { ...distributedPluginFromDefinition(definition) } : null
}

export function getLoadErrors() {
  return LAST_ERRORS.slice()
}

export function isInitialized() {
  return INITIALIZED
}

/** Install a process-local runtime plugin with reversible side effects. */
export async function registerPlugin(manifest, setup) {
  const definition = createHostPluginDefinition(manifest)
  return registerPluginDefinition(definition, setup)
}

/** Activate one canonical plugin definition through the shared runtime lifecycle. */
export async function registerPluginDefinition(definition, setup) {
  const manifest = runtimeManifestFromPluginDefinition(definition)
  ensureRuntimePluginConfigInitialized()
  return RUNTIME.registerPlugin(manifest, setup)
}

/** Uninstall a runtime plugin after checking active dependants. */
export function unregisterPlugin(id) {
  return RUNTIME.unregisterPlugin(id)
}

export function listRuntimePlugins() {
  return RUNTIME.listPlugins()
}

export function getRuntimePlugin(id) {
  return RUNTIME.getPlugin(id)
}

export function listRuntimePluginEffectiveConfigs() {
  return RUNTIME.listEffectiveConfigs()
}

export function listRuntimePluginConfigReloadAudit() {
  return RUNTIME.listConfigReloadAudit()
}

export function reloadRuntimePluginConfig(id, options = {}) {
  const { expectedRevision } = options
  const sourceContext = resolveRuntimePluginConfigReloadSourceContext(options)
  const snapshot = readRuntimePluginConfigSourceSnapshot(sourceContext)
  return RUNTIME.reloadPluginConfig(id, {
    expectedRevision,
    configLayerSources: snapshot.layerSources,
    verifyBeforeCommit: () => assertRuntimePluginConfigSourceSnapshot(snapshot, sourceContext),
  })
}

export function hasPluginService(name) {
  return RUNTIME.hasService(name)
}

export function invokePluginService(name, method, args = [], executionContext = null) {
  return RUNTIME.invokeService(name, method, args, executionContext)
}

export function renderRuntimePromptBlocks(input = {}) {
  return RUNTIME.renderPromptBlocks(input)
}

export function bindRuntimePluginsToLoop(loopEvents) {
  return RUNTIME.bindLoopEvents(loopEvents)
}

export function shutdownRuntimePlugins() {
  return RUNTIME.shutdown()
}

// 仅供测试使用：重置内部状态
export function _resetForTests() {
  CURRENT_DEFINITIONS = new Map()
  LAST_ERRORS = []
  INITIALIZED = false
  PLUGIN_DISCOVERY_SOURCE = null
  PLUGIN_DISCOVERY_REVISION = 0
  PROTECTED_PLUGIN_IDS = Object.freeze([])
  PROTECTED_PLUGIN_IDENTITY_COMPLETE = true
}

export function _resetRuntimePluginsForTests() {
  return RUNTIME.shutdown()
}
