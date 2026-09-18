import { createHash } from 'node:crypto'

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]))
}

/**
 * Internal ordering hint set by the loop on tools activated after turn start.
 * It is stripped here, the single point where tools are canonicalized, so it
 * can never reach a provider request body.
 */
const DYNAMIC_TOOL_MARKER = '__gugoDynamicTool'

function withoutDynamicMarker(tool) {
  if (!tool || typeof tool !== 'object' || !Object.hasOwn(tool, DYNAMIC_TOOL_MARKER)) return tool
  const rest = { ...tool }
  delete rest[DYNAMIC_TOOL_MARKER]
  return rest
}

/**
 * Canonicalize wire JSON, not permissions or the contents/order of schema arrays.
 *
 * Stable name order keeps a provider's cached prefix identical between
 * iterations. Tools activated mid-turn are sorted after the base set instead of
 * being merged into it, so activating a skill appends to the tool block instead
 * of reordering it (which would invalidate more of the cached prefix).
 */
export function canonicalizeModelTools(tools) {
  return canonicalizeModelToolSet(tools).tools
}

/** Keep cache-boundary metadata outside the provider-facing tool objects. */
export function canonicalizeModelToolSet(tools) {
  if (!Array.isArray(tools)) return { tools, lastBaseToolIndex: -1 }
  const stable = stableJsonValue(JSON.parse(JSON.stringify(tools)))
  const names = stable.map((tool) => tool?.type === 'function' ? tool.function?.name : null)
  if (names.every((name) => typeof name === 'string' && name.length > 0)
    && new Set(names).size === names.length) {
    stable.sort((left, right) => {
      const leftDynamic = left[DYNAMIC_TOOL_MARKER] === true ? 1 : 0
      const rightDynamic = right[DYNAMIC_TOOL_MARKER] === true ? 1 : 0
      if (leftDynamic !== rightDynamic) return leftDynamic - rightDynamic
      return left.function.name < right.function.name ? -1 : left.function.name > right.function.name ? 1 : 0
    })
  }
  const lastBaseToolIndex = stable.findLastIndex((tool) => tool?.[DYNAMIC_TOOL_MARKER] !== true)
  return { tools: stable.map(withoutDynamicMarker), lastBaseToolIndex }
}

const ANTHROPIC_SHORT_CACHE_CONTROL = Object.freeze({ type: 'ephemeral' })
const ANTHROPIC_LONG_CACHE_CONTROL = Object.freeze({ type: 'ephemeral', ttl: '1h' })

/**
 * Anthropic gates 1-hour cache entries behind this beta header; a request that
 * sends ttl:'1h' without it fails upstream even though the body serializes
 * fine. Keyed by the cache_control ttl that requires it.
 */
export const ANTHROPIC_CACHE_TTL_BETA_HEADERS = Object.freeze({
  '1h': 'extended-cache-ttl-2025-04-11',
})

/** Opt-in Anthropic wire policy; unspecified/unknown values preserve legacy requests. */
export function anthropicPromptCacheControl(env = process.env) {
  const raw = env?.MODEL_PROMPT_CACHE_RETENTION
  const retention = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (retention === 'short') return ANTHROPIC_SHORT_CACHE_CONTROL
  if (retention === 'long') return ANTHROPIC_LONG_CACHE_CONTROL
  return null
}

function isOfficialOpenAiEndpoint(baseUrl) {
  try {
    const url = new URL(baseUrl)
    return url.protocol === 'https:' && url.hostname === 'api.openai.com'
      && (!url.port || url.port === '443')
  } catch {
    return false
  }
}

/** A routing hint, not a cache-hit promise. Never send retention/breakpoint fields. */
export function promptCacheKeyFor({ config = {}, profile = {}, ownerId } = {}) {
  const owner = typeof ownerId === 'string' ? ownerId.trim() : ''
  if (!owner || profile.supportsPromptCacheKey === false) return null
  if (profile.supportsPromptCacheKey !== true && !isOfficialOpenAiEndpoint(config.baseUrl)) return null
  const digest = createHash('sha256').update(JSON.stringify({
    version: 1,
    owner,
    provider: String(config.providerId || ''),
    model: String(config.modelName || ''),
  })).digest('base64url')
  return `gugo-v1-${digest}`
}
