import { listUserToolSpecs } from '../mcp/mcpManager.js'
import { listRegisteredBrowserToolSpecs } from './browserTools.js'
import { CONNECTOR_TOOL_NAMES } from './connectorTools.js'
import { listEnabledIntegrationToolNames } from './integrationsStore.js'
import { isWebSearchReady } from './webSearchService.js'

function normalizeNames(values, limit = 256) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).map((name) => name.trim()).filter(Boolean))]
    .slice(0, limit)
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = canonicalizeJson(value[key])
    return result
  }, {})
}

function canonicalizeToolSpec(spec) {
  return canonicalizeJson(spec)
}

export function normalizeServerToolsConfig(value) {
  const disabled = normalizeNames(value?.disabled)
  const disabledSet = new Set(disabled)
  const enabled = normalizeNames(value?.enabled).filter((name) => !disabledSet.has(name))
  return { enabled, disabled }
}

export function applyDirectoryAuthorizationToolsConfig(toolsConfig, resolution) {
  const normalized = normalizeServerToolsConfig(toolsConfig)
  if (resolution?.type !== 'directory_authorization' || resolution?.approved !== true) {
    return normalized
  }
  const accessMode = String(resolution.access_mode || resolution.accessMode || '').trim()
  if (!['read_only', 'read_write'].includes(accessMode)) return normalized

  const required = [
    'list_directory',
    'read_file',
    ...(accessMode === 'read_write'
      ? ['write_file', 'edit_file', 'apply_patch', 'patch_file', 'bash_exec', 'run_command']
      : []),
  ]
  const enabled = new Set(normalized.enabled)
  const disabled = new Set(normalized.disabled)
  for (const name of required) {
    enabled.add(name)
    disabled.delete(name)
  }
  return {
    enabled: [...enabled].sort(),
    disabled: [...disabled].sort(),
  }
}

export function restoreDirectoryAuthorizationToolSpecs(baseSpecs, resolution, fallbackSpecs = []) {
  const current = Array.isArray(baseSpecs) ? baseSpecs : []
  if (resolution?.type !== 'directory_authorization' || resolution?.approved !== true) {
    return current
  }
  const accessMode = String(resolution.access_mode || resolution.accessMode || '').trim()
  if (!['read_only', 'read_write'].includes(accessMode)) return current

  const requiredNames = new Set([
    'list_directory',
    'read_file',
    ...(accessMode === 'read_write'
      ? ['write_file', 'edit_file', 'apply_patch', 'patch_file', 'bash_exec', 'run_command']
      : []),
  ])
  const restored = new Map()
  for (const spec of current) {
    const name = String(spec?.function?.name || '')
    if (name) restored.set(name, spec)
  }
  for (const spec of Array.isArray(fallbackSpecs) ? fallbackSpecs : []) {
    const name = String(spec?.function?.name || '')
    if (requiredNames.has(name) && !restored.has(name)) restored.set(name, spec)
  }
  return [...restored.values()]
}

export function applyServerToolsConfig(specs, toolsConfig) {
  const normalized = normalizeServerToolsConfig(toolsConfig)
  const disabled = new Set(normalized.disabled)
  const enabled = new Set(normalized.enabled)
  // File mutation and post-mutation verification are one capability contract.
  // Older/persisted UI state may explicitly enable a write tool while keeping
  // the read tools at their historical false defaults. Keep the dangerous
  // mutation switches authoritative, but never advertise a write capability
  // without its read-only verification companions.
  if (enabled.has('write_file') || enabled.has('edit_file')
    || enabled.has('apply_patch') || enabled.has('patch_file')) {
    disabled.delete('list_directory')
    disabled.delete('read_file')
  }
  if (enabled.has('git_commit') || enabled.has('git_push')
    || enabled.has('git_rollback') || enabled.has('git_write')) {
    disabled.delete('git_status')
    disabled.delete('git_diff')
  }
  return (Array.isArray(specs) ? specs : []).filter((spec) => {
    const name = String(spec?.function?.name || '')
    return name && !disabled.has(name)
  })
}

export async function resolveTurnToolSpecs({
  userId,
  baseSpecs = [],
  toolsConfig,
  webSearchReady = isWebSearchReady({ userId }),
  enabledConnectorTools,
} = {}) {
  let mcpSpecs = []
  try {
    const result = await listUserToolSpecs(userId)
    mcpSpecs = Array.isArray(result?.specs) ? result.specs : []
  } catch {
    // Optional MCP discovery must not block the chat turn.
  }
  let browserSpecs = []
  try { browserSpecs = listRegisteredBrowserToolSpecs() } catch { /* optional browser tools */ }
  const merged = new Map()
  for (const spec of [...baseSpecs, ...mcpSpecs, ...browserSpecs]) {
    const name = String(spec?.function?.name || '')
    if (name) merged.set(name, spec)
  }
  let connectorTools = enabledConnectorTools
  if (!Array.isArray(connectorTools)) {
    try {
      connectorTools = listEnabledIntegrationToolNames({ userId })
    } catch {
      connectorTools = []
    }
  }
  const connectorNames = new Set(CONNECTOR_TOOL_NAMES)
  const enabledConnectorNames = new Set(connectorTools)
  const readySpecs = [...merged.values()].filter((spec) => {
    const name = String(spec?.function?.name || '')
    if (name === 'web_search' && webSearchReady !== true) return false
    return !connectorNames.has(name) || enabledConnectorNames.has(name)
  })
  return applyServerToolsConfig(readySpecs, toolsConfig)
    .map(canonicalizeToolSpec)
    .sort((left, right) => String(left?.function?.name || '').localeCompare(String(right?.function?.name || ''), 'en'))
}
