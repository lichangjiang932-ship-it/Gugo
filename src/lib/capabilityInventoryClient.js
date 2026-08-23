import {
  CAPABILITY_INVENTORY_SCHEMA_VERSION,
  createCapabilityDescriptor,
  createCapabilityInventorySnapshot,
  stableCapabilityKey,
} from '../../shared/capabilityInventory.js'
import { authHeaders, jsonOk } from './agentClient.js'
import { listCommands as listGlobalCommands } from './commandRegistry.js'
import { slashCommandRegistry as globalSlashCommandRegistry } from './slashCommandRegistry.js'
import {
  UI_CONTRIBUTION_SLOTS,
  listUiContributions,
  listUiPlugins,
} from '../plugins/uiContributionRegistry.js'

const MAX_LOCAL_ENTRIES = 10_000
const MAX_TEXT_LENGTH = 2_048

function invalidInventory(message, cause) {
  const error = new TypeError(message, cause ? { cause } : undefined)
  error.code = 'CAPABILITY_INVENTORY_INVALID'
  error.retryable = false
  return error
}

function ownDataValue(input, key) {
  if (!input || (typeof input !== 'object' && typeof input !== 'function')) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function dataMethod(input, key) {
  let current = input
  for (let depth = 0; current && depth < 8; depth += 1) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key)
    } catch {
      return undefined
    }
    if (descriptor) return Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
    try {
      current = Object.getPrototypeOf(current)
    } catch {
      return undefined
    }
  }
  return undefined
}

function boundedString(input, key, fallback = '') {
  const value = ownDataValue(input, key)
  if (typeof value !== 'string') return fallback
  return value.trim().slice(0, MAX_TEXT_LENGTH) || fallback
}

function ownArrayValues(input, label) {
  if (!Array.isArray(input)) throw invalidInventory(`${label} must be an array`)
  const length = ownDataValue(input, 'length')
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LOCAL_ENTRIES) {
    throw invalidInventory(`${label} has an invalid length`)
  }
  const values = []
  for (let index = 0; index < length; index += 1) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, String(index))
    } catch {
      throw invalidInventory(`${label}[${index}] cannot be inspected safely`)
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw invalidInventory(`${label}[${index}] must be an own data property`)
    }
    values.push(descriptor.value)
  }
  return values
}

function stringList(input, key) {
  const value = ownDataValue(input, key)
  if (value === undefined) return []
  let entries
  try {
    entries = ownArrayValues(value, key)
  } catch {
    return []
  }
  const unique = new Set()
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const text = entry.trim().slice(0, MAX_TEXT_LENGTH)
    if (text) unique.add(text)
  }
  return [...unique]
}

function localState({ active = true, callable = false, status = active ? 'active' : 'inactive' } = {}) {
  return {
    discovered: true,
    configured: true,
    enabled: active,
    active,
    connected: false,
    selected: false,
    callable,
    status,
  }
}

function localDescriptor(input) {
  try {
    return createCapabilityDescriptor(input)
  } catch {
    return null
  }
}

function uiPluginDescriptor(plugin) {
  const id = boundedString(plugin, 'id')
  if (!id) return null
  const state = boundedString(plugin, 'state', 'active')
  const active = state === 'active'
  return localDescriptor({
    key: stableCapabilityKey('ui-plugin', id),
    kind: 'ui-plugin',
    id,
    name: boundedString(plugin, 'name', id),
    description: '',
    origin: 'ui-plugin-registry',
    scope: 'client',
    version: boundedString(plugin, 'version'),
    state: localState({ active, status: state }),
    executionName: '',
    contributes: stringList(plugin, 'contributes'),
    requirements: stringList(plugin, 'requires'),
    permissions: stringList(plugin, 'permissions'),
    provenance: {
      pluginId: id,
      updatedAt: boundedString(plugin, 'installedAt'),
    },
  })
}

function uiContributionDescriptor(contribution, slot) {
  const id = boundedString(contribution, 'id')
  const pluginId = boundedString(contribution, 'pluginId')
  if (!id || !pluginId) return null
  const compoundId = `${pluginId}:${slot}:${id}`
  return localDescriptor({
    key: stableCapabilityKey('ui-contribution', compoundId),
    kind: 'ui-contribution',
    id: compoundId,
    name: boundedString(contribution, 'label', boundedString(contribution, 'labelKey', id)),
    description: '',
    origin: 'ui-contribution-registry',
    scope: 'client',
    state: localState(),
    executionName: '',
    contributes: [`ui:${slot}:${id}`],
    provenance: { pluginId },
  })
}

function commandDescriptor(command) {
  const id = boundedString(command, 'id', boundedString(command, 'name'))
  if (!id) return null
  const kind = boundedString(command, 'kind')
  const handler = ownDataValue(command, 'handler')
  const callable = typeof handler === 'function' || kind === 'skill'
  return localDescriptor({
    key: stableCapabilityKey('command', id),
    kind: 'command',
    id,
    name: boundedString(command, 'name', id),
    description: boundedString(command, 'description'),
    origin: 'command-registry',
    scope: 'client',
    state: localState({ callable }),
    executionName: id,
    contributes: [`command:${kind || 'unknown'}`],
  })
}

function slashCommandDescriptor(command) {
  const id = boundedString(command, 'name')
  if (!id) return null
  const meta = ownDataValue(command, 'meta')
  const pluginId = boundedString(meta, 'pluginId')
  return localDescriptor({
    key: stableCapabilityKey('slash-command', id),
    kind: 'slash-command',
    id,
    name: id,
    description: boundedString(command, 'description'),
    origin: 'slash-command-registry',
    scope: 'client',
    state: localState({ callable: typeof ownDataValue(command, 'handler') === 'function' }),
    executionName: id,
    contributes: [`slash:${boundedString(command, 'kind', 'command')}`],
    ...(pluginId ? { provenance: { pluginId } } : {}),
  })
}

function deduplicateSnapshots(...snapshots) {
  const byKey = new Map()
  for (const snapshot of snapshots) {
    for (const descriptor of snapshot) {
      const key = ownDataValue(descriptor, 'key')
      if (typeof key === 'string' && key && !byKey.has(key)) byKey.set(key, descriptor)
    }
  }
  return createCapabilityInventorySnapshot([...byKey.values()])
}

function envelope(capabilities) {
  return Object.freeze({
    schemaVersion: CAPABILITY_INVENTORY_SCHEMA_VERSION,
    capabilities,
  })
}

function slashCommandsFrom(registry) {
  if (!registry) return []
  const method = dataMethod(registry, 'listCommands')
  if (typeof method !== 'function') return []
  try {
    const value = method.call(registry, { query: '' })
    return ownArrayValues(value, 'slash commands')
  } catch {
    return []
  }
}

/**
 * Build a detached, data-only snapshot of capabilities registered in the SPA.
 * Registry execution objects (handlers, React components and skill payloads) are
 * deliberately never copied into the returned descriptors.
 */
export function createClientCapabilitySnapshot({
  uiPlugins = listUiPlugins(),
  uiSlots = UI_CONTRIBUTION_SLOTS,
  uiContributionsForSlot = listUiContributions,
  commands = listGlobalCommands(),
  slashRegistry = globalSlashCommandRegistry,
} = {}) {
  const descriptors = []
  for (const plugin of ownArrayValues(uiPlugins, 'UI plugins')) {
    const descriptor = uiPluginDescriptor(plugin)
    if (descriptor) descriptors.push(descriptor)
  }
  for (const slotValue of ownArrayValues(uiSlots, 'UI contribution slots')) {
    if (typeof slotValue !== 'string') continue
    const slot = slotValue.trim()
    if (!slot) continue
    let contributions
    try {
      contributions = uiContributionsForSlot(slot)
    } catch {
      continue
    }
    for (const contribution of ownArrayValues(contributions, `UI contributions for ${slot}`)) {
      const descriptor = uiContributionDescriptor(contribution, slot)
      if (descriptor) descriptors.push(descriptor)
    }
  }
  for (const command of ownArrayValues(commands, 'commands')) {
    const descriptor = commandDescriptor(command)
    if (descriptor) descriptors.push(descriptor)
  }
  for (const command of slashCommandsFrom(slashRegistry)) {
    const descriptor = slashCommandDescriptor(command)
    if (descriptor) descriptors.push(descriptor)
  }
  return deduplicateSnapshots(descriptors)
}

/** Revalidate and detach the authenticated server response. */
export function normalizeEffectiveCapabilityResponse(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalidInventory('effective capability response must be an object')
  }
  if (ownDataValue(payload, 'ok') !== true) {
    throw invalidInventory('effective capability response must confirm ok')
  }
  if (ownDataValue(payload, 'schemaVersion') !== CAPABILITY_INVENTORY_SCHEMA_VERSION) {
    throw invalidInventory('effective capability response schema version is unsupported')
  }
  const source = ownDataValue(payload, 'capabilities')
  try {
    ownArrayValues(source, 'capabilities')
    return envelope(createCapabilityInventorySnapshot(source))
  } catch (error) {
    if (error?.code === 'CAPABILITY_INVENTORY_INVALID') throw error
    throw invalidInventory('effective capability response contains invalid descriptors', error)
  }
}

export async function fetchEffectiveCapabilityInventoryApi() {
  const response = await fetch('/api/capabilities/effective', {
    headers: authHeaders(),
    cache: 'no-store',
  })
  return normalizeEffectiveCapabilityResponse(await jsonOk(response))
}

/** Merge the server snapshot with current client registries; server wins key collisions. */
export function mergeEffectiveCapabilityInventory(serverInventory, options) {
  const normalized = normalizeEffectiveCapabilityResponse({
    ok: true,
    schemaVersion: ownDataValue(serverInventory, 'schemaVersion'),
    capabilities: ownDataValue(serverInventory, 'capabilities'),
  })
  return envelope(deduplicateSnapshots(
    normalized.capabilities,
    createClientCapabilitySnapshot(options),
  ))
}

export async function listEffectiveCapabilityInventory(options) {
  const serverInventory = await fetchEffectiveCapabilityInventoryApi()
  return mergeEffectiveCapabilityInventory(serverInventory, options)
}
