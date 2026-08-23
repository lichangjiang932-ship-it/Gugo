export const CAPABILITY_INVENTORY_SCHEMA_VERSION = 1

const KIND_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u
const SCOPE_SET = new Set(['host', 'user', 'client'])
const RISK_SET = new Set(['low', 'medium', 'high', 'unknown'])
const MAX_ID_CHARACTERS = 256
const MAX_NAME_CHARACTERS = 256
const MAX_DESCRIPTION_CHARACTERS = 500
const MAX_LABEL_CHARACTERS = 256
const MAX_LIST_ITEMS = 128

function inventoryError(code, message) {
  const error = new TypeError(message)
  error.code = code
  return error
}

function boundedString(value, maxCharacters, { required = false, label = 'value' } = {}) {
  if (typeof value !== 'string') {
    if (!required) return ''
    throw inventoryError('CAPABILITY_DESCRIPTOR_INVALID', `${label} must be a string`)
  }
  const output = Array.from(value.trim()).slice(0, maxCharacters).join('')
  if (required && !output) {
    throw inventoryError('CAPABILITY_DESCRIPTOR_INVALID', `${label} must not be empty`)
  }
  return output
}

function nullableString(value, maxCharacters) {
  if (value === null || value === undefined) return null
  const normalized = boundedString(value, maxCharacters)
  return normalized || null
}

function stringList(value) {
  if (!Array.isArray(value)) return Object.freeze([])
  const seen = new Set()
  const output = []
  for (const item of value) {
    if (output.length >= MAX_LIST_ITEMS) break
    const normalized = boundedString(item, MAX_LABEL_CHARACTERS)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    output.push(normalized)
  }
  return Object.freeze(output)
}

function normalizedState(value) {
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return Object.freeze({
    discovered: state.discovered === true,
    configured: state.configured === true,
    enabled: state.enabled === true,
    active: state.active === true,
    connected: state.connected === true,
    selected: state.selected === true,
    callable: state.callable === true,
    status: boundedString(state.status, 64),
  })
}

function normalizedProvenance(value) {
  const provenance = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const updatedAt = typeof provenance.updatedAt === 'number' ? provenance.updatedAt : Number.NaN
  return Object.freeze({
    pluginId: nullableString(provenance.pluginId, MAX_ID_CHARACTERS),
    serverId: nullableString(provenance.serverId, MAX_ID_CHARACTERS),
    releaseDigest: nullableString(provenance.releaseDigest, 128),
    updatedAt: Number.isSafeInteger(updatedAt) && updatedAt >= 0 ? updatedAt : null,
  })
}

function normalizedHealth(value) {
  const health = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return Object.freeze({
    status: boundedString(health.status, 64) || 'unknown',
    errorCode: nullableString(health.errorCode, 128),
  })
}

export function stableCapabilityKey(kind, id) {
  const normalizedKind = boundedString(kind, 64, { required: true, label: 'kind' }).toLowerCase()
  if (!KIND_RE.test(normalizedKind)) {
    throw inventoryError(
      'CAPABILITY_DESCRIPTOR_INVALID',
      'kind must match [a-z0-9][a-z0-9-]{0,63}',
    )
  }
  const normalizedId = boundedString(id, MAX_ID_CHARACTERS, { required: true, label: 'id' })
  return `${normalizedKind}:${normalizedId}`
}

export function createCapabilityDescriptor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw inventoryError('CAPABILITY_DESCRIPTOR_INVALID', 'capability descriptor must be an object')
  }
  const kind = boundedString(input.kind, 64, { required: true, label: 'kind' }).toLowerCase()
  const id = boundedString(input.id, MAX_ID_CHARACTERS, { required: true, label: 'id' })
  const expectedKey = stableCapabilityKey(kind, id)
  const key = input.key === undefined
    ? expectedKey
    : boundedString(input.key, 384, { required: true, label: 'key' })
  if (key !== expectedKey) {
    throw inventoryError('CAPABILITY_DESCRIPTOR_INVALID', `key must equal ${expectedKey}`)
  }
  const scope = boundedString(input.scope, 16, { required: true, label: 'scope' }).toLowerCase()
  if (!SCOPE_SET.has(scope)) {
    throw inventoryError('CAPABILITY_DESCRIPTOR_INVALID', 'scope must be host, user, or client')
  }
  const risk = nullableString(input.risk, 16)
  return Object.freeze({
    key,
    kind,
    id,
    name: boundedString(input.name, MAX_NAME_CHARACTERS) || id,
    description: boundedString(input.description, MAX_DESCRIPTION_CHARACTERS),
    origin: boundedString(input.origin, 64),
    scope,
    version: nullableString(input.version, 128),
    state: normalizedState(input.state),
    executionName: nullableString(input.executionName, MAX_ID_CHARACTERS),
    contributes: stringList(input.contributes),
    requirements: stringList(input.requirements),
    permissions: stringList(input.permissions),
    risk: risk && RISK_SET.has(risk.toLowerCase()) ? risk.toLowerCase() : null,
    provenance: normalizedProvenance(input.provenance),
    health: normalizedHealth(input.health),
  })
}

export function createCapabilityInventorySnapshot(entries) {
  if (!Array.isArray(entries)) {
    throw inventoryError('CAPABILITY_INVENTORY_INVALID', 'capability inventory entries must be an array')
  }
  const byKey = new Map()
  for (const entry of entries) {
    const descriptor = createCapabilityDescriptor(entry)
    if (byKey.has(descriptor.key)) {
      throw inventoryError(
        'CAPABILITY_INVENTORY_DUPLICATE',
        `duplicate capability key: ${descriptor.key}`,
      )
    }
    byKey.set(descriptor.key, descriptor)
  }
  return Object.freeze([...byKey.values()].sort((left, right) => (
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  )))
}
