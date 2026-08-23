import {
  createCapabilityDescriptor,
  createCapabilityInventorySnapshot,
} from '../../shared/capabilityInventory.js'
import { listMcpServerInventory } from '../mcp/mcpStore.js'
import {
  listRuntimeCapabilities,
  listRuntimeCapabilityBindings,
} from '../plugins/pluginRegistry.js'
import { listRuntimePluginInventory } from './runtimePluginControlService.js'
import { listRuntimeSkillCatalog } from './skillRegistry.js'

function requiredUserId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new TypeError('userId is required')
    error.code = 'CAPABILITY_INVENTORY_USER_REQUIRED'
    throw error
  }
  return value.trim()
}

function pluginDescriptor(plugin) {
  const activeRelease = plugin?.activeRelease || null
  const hasError = !!plugin?.lastError
  return createCapabilityDescriptor({
    kind: 'runtime-plugin',
    id: plugin?.id,
    name: plugin?.name,
    origin: plugin?.source,
    scope: 'host',
    version: plugin?.version,
    state: {
      discovered: true,
      configured: plugin?.available === true || plugin?.controllable === true,
      enabled: plugin?.enabled === true,
      active: plugin?.active === true,
      connected: false,
      selected: plugin?.active === true,
      callable: plugin?.active === true,
      status: plugin?.runtimeState || (plugin?.enabled ? 'enabled' : 'disabled'),
    },
    executionName: plugin?.toolName,
    contributes: plugin?.manifest?.contributes,
    requirements: plugin?.manifest?.requires,
    provenance: {
      pluginId: plugin?.id,
      releaseDigest: activeRelease?.contentDigest || activeRelease?.sourceDigest || null,
      updatedAt: plugin?.updatedAt,
    },
    health: {
      status: hasError ? 'error' : plugin?.active ? 'ok' : 'unknown',
      errorCode: hasError ? 'PLUGIN_RUNTIME_ERROR' : null,
    },
  })
}

function runtimeCapabilityDescriptor(capability, selected) {
  const active = !!selected
  const owner = capability?.owner || selected?.owner || 'builtin'
  const type = capability?.type || selected?.type
  const slot = capability?.slot || selected?.slot
  return createCapabilityDescriptor({
    kind: 'runtime-capability',
    id: capability?.id || selected?.id,
    name: slot || capability?.id || selected?.id,
    description: type ? `${type}:${slot}` : '',
    origin: owner === 'builtin' ? 'builtin' : 'runtime-plugin',
    scope: 'host',
    version: capability?.version || selected?.version,
    state: {
      discovered: true,
      configured: true,
      enabled: true,
      active,
      connected: false,
      selected: active,
      callable: active,
      status: active ? 'selected' : 'available',
    },
    executionName: slot,
    contributes: type && slot ? [`${type}:${slot}`] : [],
    requirements: capability?.replaces ? [`replaces:${capability.replaces}`] : [],
    provenance: {
      pluginId: owner === 'builtin' ? null : owner,
      releaseDigest: capability?.releaseDigest || selected?.releaseDigest || null,
    },
    health: { status: active ? 'ok' : 'unknown' },
  })
}

function skillDescriptor(skill) {
  return createCapabilityDescriptor({
    kind: 'skill',
    id: skill?.id,
    name: skill?.name,
    description: skill?.description,
    origin: 'skill-registry',
    scope: 'user',
    state: {
      discovered: true,
      configured: true,
      enabled: true,
      active: false,
      connected: false,
      selected: false,
      callable: skill?.loadable === true,
      status: skill?.loadable === true ? 'available' : 'unavailable',
    },
    executionName: skill?.loadHint,
    contributes: ['prompt'],
    health: { status: skill?.loadable === true ? 'ok' : 'degraded' },
  })
}

function mcpServerDescriptor(server) {
  return createCapabilityDescriptor({
    kind: 'mcp-server',
    id: server?.id,
    name: server?.name,
    origin: 'mcp',
    scope: 'user',
    state: {
      discovered: true,
      configured: true,
      enabled: server?.enabled === true,
      active: false,
      connected: false,
      selected: false,
      callable: false,
      status: server?.enabled === true ? 'configured' : 'disabled',
    },
    contributes: ['mcp-server'],
    requirements: server?.transport ? [`transport:${server.transport}`] : [],
    provenance: {
      serverId: server?.id,
      updatedAt: server?.updatedAt,
    },
    health: { status: 'unknown' },
  })
}

export function listEffectiveCapabilityInventory({
  userId,
  readRuntimePlugins = listRuntimePluginInventory,
  readRuntimeCapabilities = listRuntimeCapabilities,
  readRuntimeBindings = listRuntimeCapabilityBindings,
  readSkills = listRuntimeSkillCatalog,
  readMcpServers = listMcpServerInventory,
} = {}) {
  const scopedUserId = requiredUserId(userId)
  const selectedBindings = readRuntimeBindings()
  const selectedById = new Map(selectedBindings.map((binding) => [binding.id, binding]))
  const runtimeCapabilities = readRuntimeCapabilities()
  const runtimeCapabilityIds = new Set(runtimeCapabilities.map((capability) => capability.id))
  const descriptors = [
    ...readRuntimePlugins().map(pluginDescriptor),
    ...runtimeCapabilities.map((capability) => (
      runtimeCapabilityDescriptor(capability, selectedById.get(capability.id))
    )),
    ...selectedBindings
      .filter((binding) => !runtimeCapabilityIds.has(binding.id))
      .map((binding) => runtimeCapabilityDescriptor(null, binding)),
    ...readSkills({ userId: scopedUserId }).map(skillDescriptor),
    ...readMcpServers(scopedUserId).map(mcpServerDescriptor),
  ]
  return createCapabilityInventorySnapshot(descriptors)
}
