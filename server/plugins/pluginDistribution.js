import { types as nodeTypes } from 'node:util'

import { loadPlugins } from './pluginLoader.js'
import { snapshotPluginDistribution } from './pluginDistributionContract.js'

export const LOCAL_DIRECTORY_PLUGIN_SOURCE = 'local-directory-development'
export const PLUGIN_DISTRIBUTION_SCHEMA_VERSION = 1
const MAX_SNAPSHOT_DEPTH = 32
const MAX_SNAPSHOT_NODES = 8_192

function distributionError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function ownDataValue(value, field, code = 'PLUGIN_DISTRIBUTION_PORT_INVALID') {
  if (
    value
    && (typeof value === 'object' || typeof value === 'function')
    && nodeTypes.isProxy(value)
  ) {
    throw distributionError(
      code,
      `plugin distribution ${field} must not be read from a Proxy`,
    )
  }
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, field)
  } catch {
    throw distributionError(
      code,
      `plugin distribution ${field} cannot be inspected safely`,
    )
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw distributionError(
      code,
      `plugin distribution ${field} must be an own data property`,
    )
  }
  return descriptor.value
}

function ownMethod(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_PORT_INVALID',
      'plugin distribution port must be an object',
    )
  }
  const method = ownDataValue(value, field)
  if (typeof method !== 'function' || nodeTypes.isProxy(method)) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_PORT_INVALID',
      `plugin distribution port.${field} must be a function`,
    )
  }
  return method
}

function rejectThenableSnapshot(value) {
  let current = value
  let depth = 0
  while (current !== null) {
    if (nodeTypes.isProxy(current)) {
      throw distributionError(
        'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
        'plugin distribution snapshot must not be a Proxy',
      )
    }
    if (depth > MAX_SNAPSHOT_DEPTH) {
      throw distributionError(
        'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
        'plugin distribution snapshot prototype chain is too deep',
      )
    }
    let descriptor
    let prototype
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, 'then')
      prototype = Object.getPrototypeOf(current)
    } catch {
      throw distributionError(
        'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
        'plugin distribution snapshot cannot be inspected safely',
      )
    }
    if (descriptor) {
      throw distributionError(
        'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
        'plugin distribution discover() must not return a thenable snapshot',
      )
    }
    current = prototype
    depth += 1
  }
}

function snapshotPlainData(value, field, state, depth = 0) {
  if (depth > MAX_SNAPSHOT_DEPTH) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      `plugin distribution ${field} exceeds maximum depth`,
    )
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      `plugin distribution ${field} must contain finite numbers`,
    )
  }
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      `plugin distribution ${field} must contain plain data`,
    )
  }
  if (state.seen.has(value)) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      `plugin distribution ${field} must not contain cycles`,
    )
  }
  state.nodes += 1
  if (state.nodes > MAX_SNAPSHOT_NODES) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      `plugin distribution ${field} contains too many values`,
    )
  }
  state.seen.add(value)
  try {
    if (Array.isArray(value)) {
      const length = ownDataValue(value, 'length', 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID')
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SNAPSHOT_NODES) {
        throw distributionError(
          'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
          `plugin distribution ${field}.length is invalid`,
        )
      }
      return Object.freeze(Array.from({ length }, (_, index) => (
        snapshotPlainData(
          ownDataValue(value, String(index), 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID'),
          `${field}[${index}]`,
          state,
          depth + 1,
        )
      )))
    }
    let prototype
    let keys
    try {
      prototype = Object.getPrototypeOf(value)
      keys = Reflect.ownKeys(value)
    } catch {
      throw distributionError(
        'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
        `plugin distribution ${field} cannot be inspected safely`,
      )
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw distributionError(
        'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
        `plugin distribution ${field} must contain plain objects`,
      )
    }
    const output = {}
    for (const key of keys) {
      if (typeof key !== 'string') {
        throw distributionError(
          'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
          `plugin distribution ${field} must not contain symbol keys`,
        )
      }
      Object.defineProperty(output, key, {
        value: snapshotPlainData(
          ownDataValue(value, key, 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID'),
          `${field}.${key}`,
          state,
          depth + 1,
        ),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return Object.freeze(output)
  } finally {
    state.seen.delete(value)
  }
}

function freezePlugin(plugin) {
  const snapshot = snapshotPlainData(
    plugin,
    'candidate.plugin',
    { seen: new WeakSet(), nodes: 0 },
  )
  if (!snapshot || Array.isArray(snapshot)) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      'plugin distribution candidate.plugin must be an object',
    )
  }
  return snapshot
}

function freezeError(error) {
  if (!error || typeof error !== 'object' || nodeTypes.isProxy(error) || Array.isArray(error)) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      'plugin distribution errors must contain objects',
    )
  }
  const dir = ownDataValue(error, 'dir', 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID')
  const message = ownDataValue(error, 'message', 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID')
  if (typeof dir !== 'string' || typeof message !== 'string') {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      'plugin distribution error dir/message must be strings',
    )
  }
  return Object.freeze({ dir, message })
}

function mapDenseArray(value, field, mapper) {
  if (nodeTypes.isProxy(value) || !Array.isArray(value)) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      `plugin distribution ${field} must be an array`,
    )
  }
  const length = ownDataValue(value, 'length', 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID')
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SNAPSHOT_NODES) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      `plugin distribution ${field}.length is invalid`,
    )
  }
  const output = []
  for (let index = 0; index < length; index += 1) {
    output.push(mapper(
      ownDataValue(value, String(index), 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID'),
      index,
    ))
  }
  return output
}

function freezeCandidate(candidate) {
  if (
    !candidate
    || typeof candidate !== 'object'
    || nodeTypes.isProxy(candidate)
    || Array.isArray(candidate)
  ) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      'plugin distribution candidates must contain objects',
    )
  }
  const plugin = ownDataValue(candidate, 'plugin', 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID')
  const sourceKind = ownDataValue(candidate, 'sourceKind', 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID')
  const mutable = ownDataValue(candidate, 'mutable', 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID')
  const verifiedPackage = ownDataValue(
    candidate,
    'verifiedPackage',
    'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
  )
  const installReceipt = ownDataValue(
    candidate,
    'installReceipt',
    'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
  )
  const distribution = snapshotPluginDistribution({
    sourceKind,
    mutable,
    verifiedPackage,
    installReceipt,
  }, {
    code: 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
    label: 'plugin distribution candidate',
  })
  return Object.freeze({
    plugin: freezePlugin(plugin),
    ...distribution,
  })
}

function freezeSnapshot(snapshot) {
  if (
    !snapshot
    || typeof snapshot !== 'object'
    || nodeTypes.isProxy(snapshot)
    || Array.isArray(snapshot)
  ) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      'plugin distribution discover() must return a synchronous snapshot object',
    )
  }
  rejectThenableSnapshot(snapshot)
  const candidates = ownDataValue(snapshot, 'candidates', 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID')
  const errors = ownDataValue(snapshot, 'errors', 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID')
  if (!Array.isArray(candidates) || !Array.isArray(errors)) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      'plugin distribution snapshot candidates/errors must be arrays',
    )
  }
  const protectedPluginIdsDescriptor = Object.getOwnPropertyDescriptor(
    snapshot,
    'protectedPluginIds',
  )
  const protectedPluginIdentityCompleteDescriptor = Object.getOwnPropertyDescriptor(
    snapshot,
    'protectedPluginIdentityComplete',
  )
  const protectedPluginIds = protectedPluginIdsDescriptor
    ? protectedPluginIdsDescriptor.value
    : []
  const protectedPluginIdentityComplete = protectedPluginIdentityCompleteDescriptor
    ? protectedPluginIdentityCompleteDescriptor.value
    : true
  if (
    (protectedPluginIdsDescriptor && !Object.hasOwn(protectedPluginIdsDescriptor, 'value'))
    || (protectedPluginIdentityCompleteDescriptor
      && !Object.hasOwn(protectedPluginIdentityCompleteDescriptor, 'value'))
    || !Array.isArray(protectedPluginIds)
    || typeof protectedPluginIdentityComplete !== 'boolean'
  ) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      'plugin distribution protected identity metadata is invalid',
    )
  }
  const frozenProtectedPluginIds = mapDenseArray(
    protectedPluginIds,
    'protectedPluginIds',
    (pluginId) => {
      if (typeof pluginId !== 'string' || !pluginId.trim()) {
        throw distributionError(
          'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
          'plugin distribution protected plugin ids must be non-empty strings',
        )
      }
      return pluginId.trim()
    },
  )
  return Object.freeze({
    schemaVersion: PLUGIN_DISTRIBUTION_SCHEMA_VERSION,
    candidates: Object.freeze(mapDenseArray(candidates, 'candidates', freezeCandidate)),
    errors: Object.freeze(mapDenseArray(errors, 'errors', freezeError)),
    protectedPluginIds: Object.freeze([...new Set(frozenProtectedPluginIds)].sort()),
    protectedPluginIdentityComplete,
  })
}

function localDirectorySnapshot(result, {
  sourceKind = LOCAL_DIRECTORY_PLUGIN_SOURCE,
  mutable = true,
  verifiedPackage = false,
  installReceipt = null,
} = {}) {
  if (!result || typeof result !== 'object' || nodeTypes.isProxy(result) || Array.isArray(result)) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      'local plugin discovery must return an object',
    )
  }
  const plugins = ownDataValue(result, 'plugins', 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID')
  const errors = ownDataValue(result, 'errors', 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID')
  if (!Array.isArray(plugins) || !Array.isArray(errors)) {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
      'local plugin discovery plugins/errors must be arrays',
    )
  }
  return freezeSnapshot({
    candidates: mapDenseArray(plugins, 'plugins', (plugin) => ({
      plugin,
      sourceKind,
      mutable,
      verifiedPackage,
      installReceipt,
    })),
    errors,
  })
}

/**
 * Legacy local-directory discovery is an offline development source. It is
 * deliberately not represented as a verified package or an install receipt.
 */
export function createLocalDirectoryPluginDistributionPort({
  load = loadPlugins,
  sourceKind = LOCAL_DIRECTORY_PLUGIN_SOURCE,
  mutable = true,
  verifiedPackage = false,
  installReceipt = null,
} = {}) {
  if (typeof load !== 'function') {
    throw distributionError(
      'PLUGIN_DISTRIBUTION_PORT_INVALID',
      'local plugin distribution load adapter must be a function',
    )
  }
  return Object.freeze({
    discover(options = {}) {
      return localDirectorySnapshot(load(options), {
        sourceKind,
        mutable,
        verifiedPackage,
        installReceipt,
      })
    },
  })
}

export const localDirectoryPluginDistributionPort = createLocalDirectoryPluginDistributionPort()

export function discoverPluginDistribution(distributionPort, options = {}) {
  const discover = ownMethod(distributionPort, 'discover')
  return freezeSnapshot(discover.call(distributionPort, options))
}
