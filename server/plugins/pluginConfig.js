import { snapshotPluginData } from './pluginServiceData.js'
import { snapshotPluginContextConfig } from './pluginContextData.js'

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const LAYER_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const LAYER_KINDS = new Set(['defaults', 'profile', 'bundle', 'installation'])
const FORBIDDEN_DATA_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const SENSITIVE_KEY_RE = /(?:api_?key|token|secret|password|passphrase|credential|private_?key|client_?secret|authorization|cookie)/i
const SENSITIVE_SCHEMA_FORMATS = new Set(['password', 'secret', 'token'])
const REDACTED_VALUE = '[REDACTED]'
const MAX_CONFIG_LAYERS = 128
const MAX_PLUGINS_PER_LAYER = 256
const MAX_SCHEMA_ISSUES = 16

function configError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function snapshotConfigData(value, label, code = 'PLUGIN_CONFIG_LAYERS_INVALID') {
  try {
    return snapshotPluginData(value, {
      code,
      label,
      maxDepth: 32,
      maxNodes: 16_384,
      maxBytes: 1024 * 1024,
      rejectProxies: true,
    })
  } catch {
    throw configError(code, `${label} must contain bounded plain data`)
  }
}

function assertSafeKeys(value, label, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (!Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_DATA_KEYS.has(key)) {
        throw configError(
          'PLUGIN_CONFIG_LAYERS_INVALID',
          `${label} contains a forbidden object key`,
        )
      }
      assertSafeKeys(value[key], label, seen)
    }
    return
  }
  for (const item of value) assertSafeKeys(item, label, seen)
}

function ownString(value, field, label) {
  const candidate = value[field]
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw configError('PLUGIN_CONFIG_LAYERS_INVALID', `${label}.${field} must be a non-empty string`)
  }
  return candidate.trim()
}

function normalizeLayer(layer, index, source) {
  const label = `plugin config layer at index ${index}`
  const allowed = new Set(['id', 'kind', 'priority', 'plugins'])
  const unknown = Object.keys(layer).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw configError('PLUGIN_CONFIG_LAYERS_INVALID', `${label} contains unsupported fields`)
  }
  const id = ownString(layer, 'id', label)
  if (!LAYER_ID_RE.test(id)) {
    throw configError('PLUGIN_CONFIG_LAYERS_INVALID', `${label}.id has an invalid format`)
  }
  const kind = ownString(layer, 'kind', label)
  if (!LAYER_KINDS.has(kind)) {
    throw configError('PLUGIN_CONFIG_LAYERS_INVALID', `${label}.kind is not supported`)
  }
  if (!Number.isSafeInteger(layer.priority)) {
    throw configError('PLUGIN_CONFIG_LAYERS_INVALID', `${label}.priority must be a safe integer`)
  }
  if (!layer.plugins || typeof layer.plugins !== 'object' || Array.isArray(layer.plugins)) {
    throw configError('PLUGIN_CONFIG_LAYERS_INVALID', `${label}.plugins must be an object`)
  }
  const pluginEntries = Object.entries(layer.plugins)
  if (pluginEntries.length > MAX_PLUGINS_PER_LAYER) {
    throw configError('PLUGIN_CONFIG_LAYERS_INVALID', `${label}.plugins contains too many plugins`)
  }
  for (const [pluginId, config] of pluginEntries) {
    if (!PLUGIN_ID_RE.test(pluginId)) {
      throw configError('PLUGIN_CONFIG_LAYERS_INVALID', `${label} contains an invalid plugin id`)
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw configError(
        'PLUGIN_CONFIG_LAYERS_INVALID',
        `${label} config for ${pluginId} must be an object`,
      )
    }
  }
  return Object.freeze({
    id,
    kind,
    priority: layer.priority,
    source,
    plugins: layer.plugins,
  })
}

export function normalizePluginConfigLayers(input, { source = 'host' } = {}) {
  if (!Array.isArray(input)) {
    throw configError('PLUGIN_CONFIG_LAYERS_INVALID', 'plugin config layers must be an array')
  }
  if (input.length > MAX_CONFIG_LAYERS) {
    throw configError('PLUGIN_CONFIG_LAYERS_INVALID', 'plugin config contains too many layers')
  }
  if (typeof source !== 'string' || !source.trim() || source.length > 128) {
    throw configError('PLUGIN_CONFIG_LAYERS_INVALID', 'plugin config layer source is invalid')
  }
  const snapshot = snapshotConfigData(input, 'plugin config layers')
  assertSafeKeys(snapshot, 'plugin config layers')
  const normalized = snapshot.map((layer, index) => normalizeLayer(layer, index, source.trim()))
  const identities = new Set()
  for (const layer of normalized) {
    const identity = `${layer.source}\u0000${layer.id}`
    if (identities.has(identity)) {
      throw configError('PLUGIN_CONFIG_LAYERS_INVALID', 'plugin config layer ids must be unique per source')
    }
    identities.add(identity)
  }
  return Object.freeze(normalized)
}

function clonePlainData(value) {
  if (Array.isArray(value)) return value.map(clonePlainData)
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(output, key, {
      value: clonePlainData(child),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return output
}

function escapePointerSegment(value) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1')
}

function removeProvenanceAtOrBelow(provenance, path) {
  for (const key of provenance.keys()) {
    if (key === path || key.startsWith(`${path}/`)) provenance.delete(key)
  }
}

function mergeLayerValue(current, incoming, path, metadata, provenance, appliedPaths) {
  if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
    const currentObject = current && typeof current === 'object' && !Array.isArray(current)
      ? clonePlainData(current)
      : {}
    if (!currentObject || typeof currentObject !== 'object' || Array.isArray(currentObject)) {
      removeProvenanceAtOrBelow(provenance, path)
    } else if (!current || typeof current !== 'object' || Array.isArray(current)) {
      removeProvenanceAtOrBelow(provenance, path)
    }
    const entries = Object.entries(incoming)
    if (entries.length === 0) {
      removeProvenanceAtOrBelow(provenance, path)
      provenance.set(path, metadata)
      appliedPaths.add(path)
      return {}
    }
    for (const [key, child] of entries) {
      const childPath = `${path}/${escapePointerSegment(key)}`
      const mergedChild = mergeLayerValue(
        Object.hasOwn(currentObject, key) ? currentObject[key] : undefined,
        child,
        childPath,
        metadata,
        provenance,
        appliedPaths,
      )
      Object.defineProperty(currentObject, key, {
        value: mergedChild,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return currentObject
  }
  removeProvenanceAtOrBelow(provenance, path)
  provenance.set(path, metadata)
  appliedPaths.add(path)
  return clonePlainData(incoming)
}

function layerOrder(left, right) {
  return left.priority - right.priority
    || left.source.localeCompare(right.source)
    || left.id.localeCompare(right.id)
}

function schemaTypeMatches(value, type) {
  switch (type) {
    case 'object': return !!value && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isSafeInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]))
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]))
}

function addSchemaIssue(issues, path, rule) {
  if (issues.length < MAX_SCHEMA_ISSUES) issues.push(Object.freeze({ path, rule }))
}

function validateAgainstSchema(value, schema, path, issues, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 32) return
  if (Array.isArray(schema.allOf)) {
    for (const candidate of schema.allOf) validateAgainstSchema(value, candidate, path, issues, depth + 1)
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const matched = schema.anyOf.some((candidate) => {
      const candidateIssues = []
      validateAgainstSchema(value, candidate, path, candidateIssues, depth + 1)
      return candidateIssues.length === 0
    })
    if (!matched) addSchemaIssue(issues, path, 'anyOf')
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    let matches = 0
    for (const candidate of schema.oneOf) {
      const candidateIssues = []
      validateAgainstSchema(value, candidate, path, candidateIssues, depth + 1)
      if (candidateIssues.length === 0) matches += 1
    }
    if (matches !== 1) addSchemaIssue(issues, path, 'oneOf')
  }
  if (schema.not && typeof schema.not === 'object') {
    const candidateIssues = []
    validateAgainstSchema(value, schema.not, path, candidateIssues, depth + 1)
    if (candidateIssues.length === 0) addSchemaIssue(issues, path, 'not')
  }

  const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (schema.type !== undefined && !allowedTypes.some((type) => schemaTypeMatches(value, type))) {
    addSchemaIssue(issues, path, 'type')
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameJsonValue(value, candidate))) {
    addSchemaIssue(issues, path, 'enum')
  }
  if (Object.hasOwn(schema, 'const') && !sameJsonValue(value, schema.const)) {
    addSchemaIssue(issues, path, 'const')
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) addSchemaIssue(issues, path, 'minimum')
    if (typeof schema.maximum === 'number' && value > schema.maximum) addSchemaIssue(issues, path, 'maximum')
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      addSchemaIssue(issues, path, 'exclusiveMinimum')
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      addSchemaIssue(issues, path, 'exclusiveMaximum')
    }
  }
  if (typeof value === 'string') {
    const length = [...value].length
    if (Number.isSafeInteger(schema.minLength) && length < schema.minLength) {
      addSchemaIssue(issues, path, 'minLength')
    }
    if (Number.isSafeInteger(schema.maxLength) && length > schema.maxLength) {
      addSchemaIssue(issues, path, 'maxLength')
    }
  }
  if (Array.isArray(value)) {
    if (Number.isSafeInteger(schema.minItems) && value.length < schema.minItems) {
      addSchemaIssue(issues, path, 'minItems')
    }
    if (Number.isSafeInteger(schema.maxItems) && value.length > schema.maxItems) {
      addSchemaIssue(issues, path, 'maxItems')
    }
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => validateAgainstSchema(
        item,
        schema.items,
        `${path}/${index}`,
        issues,
        depth + 1,
      ))
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object'
      && !Array.isArray(schema.properties)
      ? schema.properties
      : {}
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !Object.hasOwn(value, key)) {
          addSchemaIssue(issues, `${path}/${escapePointerSegment(key)}`, 'required')
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}/${escapePointerSegment(key)}`
      if (Object.hasOwn(properties, key)) {
        validateAgainstSchema(child, properties[key], childPath, issues, depth + 1)
      } else if (schema.additionalProperties === false) {
        addSchemaIssue(issues, childPath, 'additionalProperties')
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateAgainstSchema(child, schema.additionalProperties, childPath, issues, depth + 1)
      }
    }
  }
}

function assertConfigSchema(config, schema, pluginId) {
  if (schema === undefined) return Object.freeze([])
  const issues = []
  validateAgainstSchema(config, schema, '', issues)
  if (issues.length === 0) return Object.freeze([])
  const error = configError(
    'PLUGIN_CONFIG_VALIDATION_FAILED',
    `plugin config validation failed for ${pluginId}: ${issues.map((issue) => `${issue.path || '/'}:${issue.rule}`).join(', ')}`,
  )
  error.issues = Object.freeze(issues)
  throw error
}

function schemaMarksSensitive(schema) {
  return !!schema && typeof schema === 'object' && !Array.isArray(schema) && (
    schema.writeOnly === true
    || schema['x-secret'] === true
    || schema['x-sensitive'] === true
    || SENSITIVE_SCHEMA_FORMATS.has(String(schema.format || '').toLowerCase())
  )
}

function redactUrlSecrets(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  try {
    const url = new URL(value)
    let changed = false
    if (url.username || url.password) {
      url.username = REDACTED_VALUE
      url.password = REDACTED_VALUE
      changed = true
    }
    for (const key of [...url.searchParams.keys()]) {
      if (!SENSITIVE_KEY_RE.test(key.replace(/[^a-z0-9]/gi, ''))) continue
      url.searchParams.set(key, REDACTED_VALUE)
      changed = true
    }
    return changed ? url.toString() : value
  } catch {
    return value
  }
}

function redactConfigValue(value, schema, key = '') {
  const normalizedKey = key.replace(/[^a-z0-9]/gi, '')
  if ((normalizedKey && SENSITIVE_KEY_RE.test(normalizedKey)) || schemaMarksSensitive(schema)) {
    return REDACTED_VALUE
  }
  if (Array.isArray(value)) {
    const itemSchema = schema?.items && typeof schema.items === 'object' ? schema.items : undefined
    return value.map((item) => redactConfigValue(item, itemSchema))
  }
  if (value && typeof value === 'object') {
    const output = {}
    const properties = schema?.properties && typeof schema.properties === 'object'
      ? schema.properties
      : {}
    for (const [childKey, child] of Object.entries(value)) {
      const childSchema = Object.hasOwn(properties, childKey)
        ? properties[childKey]
        : schema?.additionalProperties && typeof schema.additionalProperties === 'object'
          ? schema.additionalProperties
          : undefined
      output[childKey] = redactConfigValue(child, childSchema, childKey)
    }
    return output
  }
  return redactUrlSecrets(value)
}

export function createPluginConfigResolver({
  legacyConfig = {},
  layers = [],
  layerSources = [],
} = {}) {
  const base = snapshotPluginContextConfig(legacyConfig)
  const sourceGroups = snapshotConfigData(
    layerSources,
    'plugin config layer sources',
    'PLUGIN_CONFIG_LAYERS_INVALID',
  )
  if (!Array.isArray(sourceGroups)) {
    throw configError('PLUGIN_CONFIG_LAYERS_INVALID', 'plugin config layer sources must be an array')
  }
  const normalizedLayers = [
    ...normalizePluginConfigLayers(layers),
    ...sourceGroups.flatMap((group, index) => {
      if (!group || typeof group !== 'object' || Array.isArray(group)) {
        throw configError('PLUGIN_CONFIG_LAYERS_INVALID', `plugin config layer source at index ${index} is invalid`)
      }
      const unknown = Object.keys(group).filter((key) => !['source', 'layers'].includes(key))
      if (unknown.length > 0 || typeof group.source !== 'string' || !Array.isArray(group.layers)) {
        throw configError('PLUGIN_CONFIG_LAYERS_INVALID', `plugin config layer source at index ${index} is invalid`)
      }
      return normalizePluginConfigLayers(group.layers, { source: group.source })
    }),
  ]
  if (normalizedLayers.length > MAX_CONFIG_LAYERS) {
    throw configError('PLUGIN_CONFIG_LAYERS_INVALID', 'plugin config contains too many layers')
  }
  const layerIdentities = new Set()
  for (const layer of normalizedLayers) {
    const identity = `${layer.source}\u0000${layer.id}`
    if (layerIdentities.has(identity)) {
      throw configError('PLUGIN_CONFIG_LAYERS_INVALID', 'plugin config layer ids must be unique per source')
    }
    layerIdentities.add(identity)
  }

  const resolve = (pluginId, schema) => {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) {
      throw configError('PLUGIN_CONFIG_PLUGIN_ID_INVALID', 'plugin config resolution requires a valid plugin id')
    }
    let effective = clonePlainData(base)
    const provenance = new Map()
    const appliedLayers = []
    const basePaths = new Set()
    const baseMetadata = Object.freeze({
      id: 'legacy-host-config',
      kind: 'defaults',
      priority: null,
      source: 'host',
    })
    effective = mergeLayerValue({}, effective, '', baseMetadata, provenance, basePaths)
    if (basePaths.size > 0) {
      appliedLayers.push(Object.freeze({ ...baseMetadata, appliedPaths: Object.freeze([...basePaths].sort()) }))
    }
    const targeted = normalizedLayers
      .filter((layer) => Object.hasOwn(layer.plugins, pluginId))
      .sort(layerOrder)
    for (const layer of targeted) {
      const metadata = Object.freeze({
        id: layer.id,
        kind: layer.kind,
        priority: layer.priority,
        source: layer.source,
      })
      const appliedPaths = new Set()
      effective = mergeLayerValue(
        effective,
        layer.plugins[pluginId],
        '',
        metadata,
        provenance,
        appliedPaths,
      )
      appliedLayers.push(Object.freeze({
        ...metadata,
        appliedPaths: Object.freeze([...appliedPaths].sort()),
      }))
    }
    const config = snapshotConfigData(effective, `effective plugin config for ${pluginId}`, 'PLUGIN_CONTEXT_CONFIG_INVALID')
    assertConfigSchema(config, schema, pluginId)
    const provenanceEntries = [...provenance.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, metadata]) => Object.freeze({ path: path || '/', ...metadata }))
    return Object.freeze({
      pluginId,
      config,
      layers: Object.freeze(appliedLayers),
      provenance: Object.freeze(provenanceEntries),
      schemaValidated: schema !== undefined,
    })
  }

  const publicSnapshot = (resolution, schema) => Object.freeze({
    pluginId: resolution.pluginId,
    config: snapshotConfigData(
      redactConfigValue(resolution.config, schema),
      `redacted effective plugin config for ${resolution.pluginId}`,
    ),
    layers: resolution.layers,
    provenance: resolution.provenance,
    schemaValidated: resolution.schemaValidated,
  })

  const hostLayers = normalizedLayers
    .filter((layer) => layer.source === 'host')
    .map((layer) => ({
      id: layer.id,
      kind: layer.kind,
      priority: layer.priority,
      plugins: layer.plugins,
    }))

  return Object.freeze({
    resolve,
    publicSnapshot,
    withLayerSources: (nextLayerSources) => createPluginConfigResolver({
      legacyConfig: base,
      layers: hostLayers,
      layerSources: nextLayerSources,
    }),
    layers: normalizedLayers,
  })
}

export { REDACTED_VALUE as PLUGIN_CONFIG_REDACTED_VALUE }
