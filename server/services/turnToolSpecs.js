import { listUserToolSpecs } from '../mcp/mcpManager.js'
import { listRegisteredBrowserToolSpecs } from './browserTools.js'
import { isWebSearchReady } from './webSearchService.js'

function normalizeNames(values, limit = 256) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).map((name) => name.trim()).filter(Boolean))]
    .slice(0, limit)
}

export function normalizeServerToolsConfig(value) {
  const disabled = normalizeNames(value?.disabled)
  const disabledSet = new Set(disabled)
  const enabled = normalizeNames(value?.enabled).filter((name) => !disabledSet.has(name))
  return { enabled, disabled }
}

export function applyServerToolsConfig(specs, toolsConfig) {
  const normalized = normalizeServerToolsConfig(toolsConfig)
  const disabled = new Set(normalized.disabled)
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
  const readySpecs = [...merged.values()].filter((spec) => {
    const name = String(spec?.function?.name || '')
    return name !== 'web_search' || webSearchReady === true
  })
  return applyServerToolsConfig(readySpecs, toolsConfig)
    .sort((left, right) => String(left?.function?.name || '').localeCompare(String(right?.function?.name || ''), 'en'))
}
