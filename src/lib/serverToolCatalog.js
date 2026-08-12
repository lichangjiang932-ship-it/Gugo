import { callJson } from './tools/toolHttpClient.js'
import { BROWSER_TOOL_NAMES, BROWSER_TOOL_SPECS } from './tools/browserToolSpecs.js'

const DYNAMIC_CONTEXT_TOOL_NAMES = new Set(BROWSER_TOOL_NAMES)

function toolName(spec) {
  return String(spec?.function?.name || '').trim()
}

function sortSpecs(specs) {
  return [...specs].sort((left, right) => toolName(left).localeCompare(toolName(right), 'en'))
}

/**
 * Normalize the public registry response into the OpenAI tool objects used by
 * client-side context estimation. Specs remain owned by the server.
 */
export function normalizeServerToolCatalog(payload) {
  const byName = new Map()
  for (const entry of Array.isArray(payload?.specs) ? payload.specs : []) {
    const spec = entry?.tool || entry
    const name = toolName(spec)
    if (name) byName.set(name, spec)
  }
  return sortSpecs(byName.values())
}

/**
 * Keep context estimation aware of every enabled server tool when the live
 * catalog endpoint is temporarily unavailable. These placeholders are never
 * executed and intentionally do not duplicate the server-owned JSON schema.
 */
export function buildServerToolCatalogFallback(enabledNames, localSpecs = []) {
  const byName = new Map()
  for (const spec of [...Object.values(BROWSER_TOOL_SPECS), ...(Array.isArray(localSpecs) ? localSpecs : [])]) {
    const name = toolName(spec)
    if (name) byName.set(name, spec)
  }
  for (const value of enabledNames || []) {
    const name = String(value || '').trim()
    if (!name || byName.has(name)) continue
    byName.set(name, {
      type: 'function',
      function: {
        name,
        description: 'Server-managed tool placeholder for context estimation while the live catalog is unavailable; never used for execution.',
        parameters: { type: 'object', additionalProperties: true },
      },
    })
  }
  return sortSpecs(byName.values())
}

export async function fetchServerToolCatalog({ mode = 'chat' } = {}) {
  const safeMode = ['chat', 'plan', 'code'].includes(mode) ? mode : 'chat'
  const payload = await callJson(`/api/tools/specs?mode=${encodeURIComponent(safeMode)}`, undefined, {
    method: 'GET',
  })
  return normalizeServerToolCatalog(payload)
}

export function selectEnabledServerToolSpecs(catalog, toolsConfig = {}) {
  return (Array.isArray(catalog) ? catalog : []).filter((spec) => (
    DYNAMIC_CONTEXT_TOOL_NAMES.has(toolName(spec)) || toolsConfig?.[toolName(spec)] === true
  ))
}
