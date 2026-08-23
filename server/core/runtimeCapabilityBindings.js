import { createHash } from 'node:crypto'

import { readRuntimeConfigFileSnapshot, resolveRuntimeConfigPaths } from '../utils/runtimeEnv.js'
import { RUNTIME_CAPABILITY_TYPES } from './runtimeCapabilityRegistry.js'

const TYPE_SET = new Set(RUNTIME_CAPABILITY_TYPES)
const MULTI_SLOT_TYPES = new Set(['tool', 'provider'])
const ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const SLOT_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/i

function bindingError(message) {
  const error = new TypeError(message)
  error.code = 'RUNTIME_CAPABILITY_BINDINGS_INVALID'
  error.retryable = false
  return error
}

function normalizeId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value.trim())) {
    throw bindingError(`${label} must match [a-z0-9][a-z0-9._:-]{0,127}`)
  }
  return value.trim()
}

function normalizeSlot(value, label) {
  if (typeof value !== 'string' || !SLOT_RE.test(value.trim())) {
    throw bindingError(`${label} must match [a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}`)
  }
  return value.trim()
}

export function normalizeRuntimeCapabilityBindings(input, { source = 'host' } = {}) {
  if (input === undefined) return Object.freeze({ bindings: Object.freeze({}), provenance: Object.freeze({}) })
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw bindingError('capabilityBindings must be an object')
  }
  const bindings = {}
  const provenance = {}
  for (const [type, value] of Object.entries(input)) {
    if (!TYPE_SET.has(type)) throw bindingError(`unsupported capability binding type: ${type}`)
    if (!MULTI_SLOT_TYPES.has(type)) {
      bindings[type] = normalizeId(value, `capabilityBindings.${type}`)
      provenance[`${type}:${type}`] = source
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw bindingError(`capabilityBindings.${type} must be an object`)
    }
    bindings[type] = {}
    for (const [slot, id] of Object.entries(value)) {
      const normalizedSlot = normalizeSlot(slot, `capabilityBindings.${type} slot`)
      bindings[type][normalizedSlot] = normalizeId(id, `capabilityBindings.${type}.${normalizedSlot}`)
      provenance[`${type}:${normalizedSlot}`] = source
    }
    Object.freeze(bindings[type])
  }
  return Object.freeze({ bindings: Object.freeze(bindings), provenance: Object.freeze(provenance) })
}

function readSource(filePath, source) {
  const snapshot = readRuntimeConfigFileSnapshot(filePath)
  if (!snapshot.exists) {
    return Object.freeze({ source, path: filePath, content: null, bindings: {}, provenance: {} })
  }
  const normalized = normalizeRuntimeCapabilityBindings(snapshot.document.capabilityBindings, { source })
  return Object.freeze({ source, path: filePath, content: snapshot.content, ...normalized })
}

function mergeBindings(target, incoming) {
  const output = { ...target }
  for (const [type, value] of Object.entries(incoming)) {
    output[type] = MULTI_SLOT_TYPES.has(type)
      ? { ...(output[type] || {}), ...value }
      : value
  }
  return output
}

export function readRuntimeCapabilityBindings({ cwd = process.cwd(), env = process.env } = {}) {
  const paths = resolveRuntimeConfigPaths({ cwd, env })
  const descriptors = [
    readSource(paths.user, 'user_config'),
    readSource(paths.project, 'project_config'),
  ]
  if (paths.explicit && ![paths.user, paths.project].includes(paths.explicit)) {
    descriptors.push(readSource(paths.explicit, 'explicit_config'))
  }
  let bindings = {}
  const provenance = {}
  const hash = createHash('sha256').update('gugo-runtime-capability-bindings-v1\0')
  for (const descriptor of descriptors) {
    bindings = mergeBindings(bindings, descriptor.bindings)
    Object.assign(provenance, descriptor.provenance)
    hash.update(descriptor.source)
    hash.update('\0')
    hash.update(descriptor.content || Buffer.from('missing'))
    hash.update('\0')
  }
  for (const type of MULTI_SLOT_TYPES) {
    if (bindings[type]) Object.freeze(bindings[type])
  }
  return Object.freeze({
    bindings: Object.freeze(bindings),
    provenance: Object.freeze(provenance),
    fingerprint: `sha256-${hash.digest('hex')}`,
  })
}
