import { createHash } from 'node:crypto'

import { normalizePluginManifest } from '../../shared/pluginManifest.js'
import { snapshotPluginData } from './pluginServiceData.js'
import { validateManifest } from './pluginManifest.js'

export const PLUGIN_DEFINITION_SCHEMA_VERSION = 1
export const PLUGIN_ACTIVATION_KINDS = Object.freeze({
  RESOURCE: 'resource',
  SANDBOX_TRANSFORMER: 'sandbox-transformer',
  HOST_SETUP: 'host-setup',
})

const definitions = new WeakSet()
const DISTRIBUTED_PATH_FIELDS = Object.freeze(['dir', 'rootDir', 'entryPath'])

function definitionError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function ownDataValue(value, field, { optional = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw definitionError('PLUGIN_DEFINITION_INVALID', 'plugin definition input must be an object')
  }
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, field)
  } catch {
    throw definitionError(
      'PLUGIN_DEFINITION_INVALID',
      `plugin definition field ${field} could not be inspected`,
    )
  }
  if (!descriptor) {
    if (optional) return undefined
    throw definitionError('PLUGIN_DEFINITION_INVALID', `plugin definition field ${field} is required`)
  }
  if (!Object.hasOwn(descriptor, 'value')) {
    throw definitionError(
      'PLUGIN_DEFINITION_INVALID',
      `plugin definition field ${field} must be an own data property`,
    )
  }
  return descriptor.value
}

function snapshotDistribution(distribution) {
  if (distribution === null || distribution === undefined) return null
  const snapshot = snapshotPluginData(distribution, {
    code: 'PLUGIN_DEFINITION_DISTRIBUTION_INVALID',
    label: 'plugin definition distribution',
    maxDepth: 32,
    maxNodes: 4_096,
    maxBytes: 256 * 1024,
    rejectProxies: true,
  })
  const sourceKind = ownDataValue(snapshot, 'sourceKind')
  const mutable = ownDataValue(snapshot, 'mutable')
  const verifiedPackage = ownDataValue(snapshot, 'verifiedPackage')
  const installReceipt = ownDataValue(snapshot, 'installReceipt')
  if (typeof sourceKind !== 'string' || !sourceKind.trim()) {
    throw definitionError(
      'PLUGIN_DEFINITION_DISTRIBUTION_INVALID',
      'plugin definition distribution sourceKind must be a non-empty string',
    )
  }
  if (typeof mutable !== 'boolean' || typeof verifiedPackage !== 'boolean') {
    throw definitionError(
      'PLUGIN_DEFINITION_DISTRIBUTION_INVALID',
      'plugin definition distribution trust flags must be booleans',
    )
  }
  if (installReceipt !== null && (
    !installReceipt
    || typeof installReceipt !== 'object'
    || Array.isArray(installReceipt)
  )) {
    throw definitionError(
      'PLUGIN_DEFINITION_DISTRIBUTION_INVALID',
      'plugin definition distribution installReceipt must be null or a plain object',
    )
  }
  if (verifiedPackage && (mutable || installReceipt === null)) {
    throw definitionError(
      'PLUGIN_DEFINITION_DISTRIBUTION_INVALID',
      'verified plugin definitions must be immutable and include an install receipt',
    )
  }
  return snapshotPluginData({
    sourceKind: sourceKind.trim(),
    mutable,
    verifiedPackage,
    installReceipt,
  }, {
    code: 'PLUGIN_DEFINITION_DISTRIBUTION_INVALID',
    label: 'plugin definition distribution',
    maxDepth: 32,
    maxNodes: 4_096,
    maxBytes: 256 * 1024,
    rejectProxies: true,
  })
}

function canonicalDistributedPlugin(plugin) {
  const snapshot = snapshotPluginData(plugin, {
    code: 'PLUGIN_DEFINITION_MANIFEST_INVALID',
    label: 'plugin definition manifest',
    maxDepth: 32,
    maxNodes: 4_096,
    maxBytes: 256 * 1024,
    rejectProxies: true,
  })
  const result = validateManifest(snapshot)
  if (!result.ok) {
    throw definitionError(
      'PLUGIN_DEFINITION_MANIFEST_INVALID',
      `plugin definition manifest is invalid: ${result.errors.join('; ')}`,
    )
  }
  const paths = {}
  for (const field of DISTRIBUTED_PATH_FIELDS) {
    const value = ownDataValue(snapshot, field, { optional: true })
    if (value === undefined) continue
    if (typeof value !== 'string' || !value) {
      throw definitionError(
        'PLUGIN_DEFINITION_PATH_INVALID',
        `plugin definition ${field} must be a non-empty string`,
      )
    }
    paths[field] = value
  }
  return Object.freeze({
    ...result.manifest,
    tags: Object.freeze([...result.manifest.tags]),
    capabilities: Object.freeze([...result.manifest.capabilities]),
    ...paths,
  })
}

function effectiveContributions(manifest, additions) {
  return normalizePluginManifest({
    ...manifest,
    contributes: [...new Set([...manifest.contributes, ...additions])],
  }).contributes
}

function createDefinition({ manifest, plugin = null, distribution = null, kind, additions = [] }) {
  const normalizedManifest = normalizePluginManifest(manifest)
  const effective = effectiveContributions(normalizedManifest, additions)
  const definition = Object.freeze({
    schemaVersion: PLUGIN_DEFINITION_SCHEMA_VERSION,
    manifest: normalizedManifest,
    plugin,
    distribution,
    activation: Object.freeze({
      kind,
      declaredContributes: normalizedManifest.contributes,
      effectiveContributes: effective,
    }),
  })
  definitions.add(definition)
  return definition
}

export function runtimeTransformerToolName(pluginId) {
  const normalized = String(pluginId || '').trim().replaceAll('-', '_')
  const base = `plugin_${normalized}`
  if (base.length <= 64) return base
  const suffix = createHash('sha256').update(String(pluginId)).digest('hex').slice(0, 8)
  return `${base.slice(0, 55)}_${suffix}`
}

export function createDistributedPluginDefinition(plugin, { distribution = null } = {}) {
  const canonicalPlugin = canonicalDistributedPlugin(plugin)
  const manifest = normalizePluginManifest(canonicalPlugin)
  const transformer = canonicalPlugin.type === 'transformer'
  return createDefinition({
    manifest,
    plugin: canonicalPlugin,
    distribution: snapshotDistribution(distribution),
    kind: transformer
      ? PLUGIN_ACTIVATION_KINDS.SANDBOX_TRANSFORMER
      : PLUGIN_ACTIVATION_KINDS.RESOURCE,
    additions: transformer ? [`tool:${runtimeTransformerToolName(manifest.id)}`] : [],
  })
}

export function createHostPluginDefinition(manifest) {
  return createDefinition({
    manifest,
    kind: PLUGIN_ACTIVATION_KINDS.HOST_SETUP,
  })
}

export function assertPluginDefinition(definition) {
  if (!definitions.has(definition)) {
    throw definitionError(
      'PLUGIN_DEFINITION_INVALID',
      'plugin definition must be created by the plugin definition host',
    )
  }
  return definition
}

export function distributedPluginFromDefinition(definition) {
  const verified = assertPluginDefinition(definition)
  if (!verified.plugin) {
    throw definitionError(
      'PLUGIN_DEFINITION_NOT_DISTRIBUTED',
      'host runtime plugin definitions do not contain distributed package metadata',
    )
  }
  return verified.plugin
}

export function runtimeManifestFromPluginDefinition(definition) {
  const verified = assertPluginDefinition(definition)
  if (verified.activation.kind === PLUGIN_ACTIVATION_KINDS.RESOURCE) {
    throw definitionError(
      'PLUGIN_DEFINITION_NOT_EXECUTABLE',
      `plugin ${verified.manifest.id} is a resource and cannot be registered as runtime code`,
    )
  }
  return normalizePluginManifest({
    ...verified.manifest,
    contributes: verified.activation.effectiveContributes,
  })
}

export function releasePluginSnapshotFromDefinition(definition) {
  const verified = assertPluginDefinition(definition)
  const plugin = distributedPluginFromDefinition(verified)
  if (verified.activation.kind !== PLUGIN_ACTIVATION_KINDS.SANDBOX_TRANSFORMER) {
    throw definitionError(
      'PLUGIN_DEFINITION_NOT_EXECUTABLE',
      `plugin ${verified.manifest.id} does not produce a sandbox transformer release`,
    )
  }
  return Object.freeze({
    ...verified.manifest,
    type: plugin.type,
    entry: plugin.entry,
    description: plugin.description,
    author: plugin.author,
    license: plugin.license,
    tags: plugin.tags,
    capabilities: plugin.capabilities,
    ...(verified.distribution === null ? {} : { distribution: verified.distribution }),
  })
}
