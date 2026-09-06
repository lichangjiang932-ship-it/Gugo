import { createHash } from 'node:crypto'

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]))
}

/** Canonicalize wire JSON, not permissions or the contents/order of schema arrays. */
export function canonicalizeModelTools(tools) {
  if (!Array.isArray(tools)) return tools
  const stable = stableJsonValue(JSON.parse(JSON.stringify(tools)))
  const names = stable.map((tool) => tool?.type === 'function' ? tool.function?.name : null)
  if (names.every((name) => typeof name === 'string' && name.length > 0)
    && new Set(names).size === names.length) {
    stable.sort((left, right) => left.function.name < right.function.name ? -1 : left.function.name > right.function.name ? 1 : 0)
  }
  return stable
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
