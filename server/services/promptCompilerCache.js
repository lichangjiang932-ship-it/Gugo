import crypto from 'node:crypto'

const BLOCK_TYPES = Object.freeze(['identity', 'ishiki', 'skills', 'sessions'])
const CACHE_LIMIT = 64
const caches = Object.fromEntries(BLOCK_TYPES.map((type) => [type, new Map()]))
const stats = Object.fromEntries(BLOCK_TYPES.map((type) => [type, { hits: 0, misses: 0 }]))

function normalizeStable(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeStable(item))
  if (!value || typeof value !== 'object') return value
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      if (value[key] !== undefined) acc[key] = normalizeStable(value[key])
      return acc
    }, {})
}

export function fingerprintFor(input) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalizeStable(input)))
    .digest('hex')
    .slice(0, 16)
}

function getCachedText(blockType, fingerprint) {
  const cache = caches[blockType]
  const key = `${blockType}:${fingerprint}`
  if (!cache.has(key)) {
    stats[blockType].misses += 1
    return null
  }
  const text = cache.get(key)
  cache.delete(key)
  cache.set(key, text)
  stats[blockType].hits += 1
  return text
}

function setCachedText(blockType, fingerprint, text) {
  const cache = caches[blockType]
  const key = `${blockType}:${fingerprint}`
  if (cache.has(key)) cache.delete(key)
  cache.set(key, text)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
}

export function cachedBuild(blockType, input, sources, buildText) {
  const fingerprint = fingerprintFor(input)
  const cached = getCachedText(blockType, fingerprint)
  if (cached != null) return { text: cached, fingerprint, sources }
  const text = buildText()
  setCachedText(blockType, fingerprint, text)
  return { text, fingerprint, sources }
}

export function getPromptCompilerStats() {
  return Object.fromEntries(BLOCK_TYPES.map((type) => [
    type,
    {
      hits: stats[type].hits,
      misses: stats[type].misses,
      size: caches[type].size,
    },
  ]))
}

export function clearPromptCompilerCache(blockType) {
  const types = blockType ? [blockType] : BLOCK_TYPES
  for (const type of types) {
    if (!caches[type]) continue
    caches[type].clear()
    stats[type].hits = 0
    stats[type].misses = 0
  }
}
