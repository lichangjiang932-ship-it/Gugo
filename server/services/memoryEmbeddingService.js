/**
 * Opt-in long-term memory embeddings.
 *
 * Local-first rules:
 * - Nothing here runs unless a deployment explicitly sets
 *   `MEMORY_EMBEDDINGS_ENABLED=1` AND configures an OpenAI-compatible
 *   embeddings endpoint (`MEMORY_EMBEDDING_MODEL` plus a base URL/key).
 * - With no explicit configuration every function degrades to "disabled", so
 *   lexical recall keeps working and no network call is ever made.
 * - Vectors are stored locally (`memory_embeddings`) and compared in-process;
 *   no vector service is contacted at query time beyond the embedding request.
 */
import { createHash } from 'node:crypto'

export const MEMORY_EMBEDDING_SCHEMA_VERSION = 1
/** Bump when the space identity definition changes, to force a rebuild. */
export const MEMORY_EMBEDDING_SPACE_VERSION = 2
export const MEMORY_EMBEDDING_MAX_DIMENSIONS = 8192
export const MEMORY_EMBEDDING_MAX_BATCH = 32
export const MEMORY_EMBEDDING_MAX_TEXT_CHARS = 8_000
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 60_000
// Semantic evidence is additive to the lexical score. It is intentionally
// smaller than a title match so semantic recall cannot override an exact hit.
const SEMANTIC_MAX_POINTS = 70

function positiveInt(value, fallback, maximum) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback
  return Math.min(maximum, parsed)
}

/**
 * @returns {{enabled: true, baseUrl: string, apiKey: string, model: string, timeoutMs: number, dimensions: number|null, revision: string}|null}
 */
export function resolveMemoryEmbeddingConfig(env = process.env) {
  if (String(env?.MEMORY_EMBEDDINGS_ENABLED || '').trim() !== '1') return null
  const model = String(env?.MEMORY_EMBEDDING_MODEL || '').trim()
  if (!model) return null
  const baseUrl = normalizeEmbeddingBaseUrl(String(
    env?.MEMORY_EMBEDDING_BASE_URL || env?.MODEL_BASE_URL || '',
  ).trim())
  if (!baseUrl) return null
  if (!memoryEmbeddingEndpointIdentity(baseUrl)) return null
  const apiKey = String(env?.MEMORY_EMBEDDING_API_KEY || env?.MODEL_API_KEY || '').trim()
  return Object.freeze({
    enabled: true,
    baseUrl,
    apiKey,
    model,
    // Optional deployment revision distinguishes weights changed behind a
    // stable model alias. Width is also checked against every response.
    revision: String(env?.MEMORY_EMBEDDING_REVISION || '').trim().slice(0, 200),
    dimensions: positiveInt(env?.MEMORY_EMBEDDING_DIMENSIONS, null, MEMORY_EMBEDDING_MAX_DIMENSIONS),
    timeoutMs: positiveInt(env?.MEMORY_EMBEDDING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
  })
}

export function isMemoryEmbeddingEnabled(env = process.env) {
  return resolveMemoryEmbeddingConfig(env) !== null
}

function normalizeEmbeddingBaseUrl(value) {
  try {
    const url = new URL(value)
    url.pathname = url.pathname.replace(/\/+$/u, '')
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

/**
 * Identity of the vector space a model produces vectors in.
 *
 * Effective endpoint + model + revision + requested width + definition version.
 * Actual response width is checked separately by retrieval. Two vectors may only be compared when
 * both sides report the same space; a null/`unknown` space is never comparable.
 */
export function memoryEmbeddingSpaceId({ baseUrl = '', model = '', revision = '', dimensions = null } = {}) {
  const endpoint = memoryEmbeddingEndpointIdentity(baseUrl)
  const name = String(model || '').trim()
  if (!endpoint || !name) return null
  const identity = JSON.stringify([
    endpoint, name, String(revision || ''), positiveInt(dimensions, null, MEMORY_EMBEDDING_MAX_DIMENSIONS),
  ])
  const hash = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32)
  return `memspace:v${MEMORY_EMBEDDING_SPACE_VERSION}:${hash}`
}

/** Preserve routing differences; credentials never appear in the returned hash. */
function memoryEmbeddingEndpointIdentity(baseUrl) {
  try {
    const url = new URL(memoryEmbeddingUrl(baseUrl))
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    url.username = ''
    url.password = ''
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

/** Space of the currently configured embedding endpoint, or null when disabled. */
export function resolveMemoryEmbeddingSpace(env = process.env) {
  const config = resolveMemoryEmbeddingConfig(env)
  return config ? memoryEmbeddingSpaceId(config) : null
}

export function memoryEmbeddingUrl(baseUrl = '') {
  const base = String(baseUrl || '').trim()
  const url = new URL(base)
  const pathname = url.pathname.replace(/\/+$/u, '')
  url.pathname = /\/embeddings$/u.test(pathname) ? pathname : `${pathname}/embeddings`
  url.hash = ''
  return url.href
}

/** Stale-vector detector: content changes invalidate a stored embedding. */
export function memoryContentFingerprint(memory = {}) {
  const parts = [
    String(memory.type || ''),
    String(memory.title || ''),
    String(memory.body || ''),
  ]
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex')
}

export function memoryEmbeddingText(memory = {}) {
  const text = [String(memory.title || '').trim(), String(memory.body || '').trim()]
    .filter(Boolean)
    .join('\n\n')
  return text.slice(0, MEMORY_EMBEDDING_MAX_TEXT_CHARS)
}

function isFiniteVector(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= MEMORY_EMBEDDING_MAX_DIMENSIONS
    && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
}

export function cosineSimilarity(left, right) {
  if (!isFiniteVector(left) || !isFiniteVector(right) || left.length !== right.length) return null
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (leftNorm === 0 || rightNorm === 0) return null
  const similarity = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
  return Number.isFinite(similarity) ? Math.max(-1, Math.min(1, similarity)) : null
}

/**
 * Map cosine similarity to additive lexical-equivalent points.
 * Cosine below 0 means no shared direction and contributes nothing.
 */
export function semanticMemoryPoints(similarity) {
  if (!Number.isFinite(similarity) || similarity <= 0) return 0
  return Math.round(Math.min(1, similarity) * SEMANTIC_MAX_POINTS * 1000) / 1000
}

/** Blend lexical and semantic evidence without letting either overflow. */
export function blendMemoryScores({ lexicalScore = 0, similarity = null } = {}) {
  const lexical = Number.isFinite(Number(lexicalScore)) ? Math.max(0, Number(lexicalScore)) : 0
  return Math.round((lexical + semanticMemoryPoints(similarity)) * 1000) / 1000
}

export function serializeMemoryVector(vector) {
  if (!isFiniteVector(vector)) return null
  const buffer = Buffer.allocUnsafe(vector.length * 4)
  let nonzero = false
  for (let index = 0; index < vector.length; index += 1) {
    const value = Math.fround(vector[index])
    if (!Number.isFinite(value)) return null
    if (value !== 0) nonzero = true
    buffer.writeFloatLE(value, index * 4)
  }
  if (!nonzero) return null
  return buffer
}

export function deserializeMemoryVector(buffer, dimensions) {
  const expected = Number(dimensions)
  if (!Number.isSafeInteger(expected) || expected <= 0 || expected > MEMORY_EMBEDDING_MAX_DIMENSIONS) return null
  if (!Buffer.isBuffer(buffer) || buffer.length !== expected * 4) return null
  const vector = new Array(expected)
  let nonzero = false
  for (let index = 0; index < expected; index += 1) {
    const value = buffer.readFloatLE(index * 4)
    if (!Number.isFinite(value)) return null
    if (value !== 0) nonzero = true
    vector[index] = value
  }
  return nonzero ? vector : null
}

/**
 * Best-effort query embedding for one turn. Returns null whenever embeddings
 * are disabled, the query is empty, or the provider fails; callers then use the
 * lexical path unchanged. It never throws.
 */
export async function prepareMemoryQueryVector({
  query = '', env = process.env, fetchImpl = null, signal = null,
} = {}, dependencies = {}) {
  const config = resolveMemoryEmbeddingConfig(env)
  if (!config) return null
  if (signal?.aborted) return null
  const text = String(query || '').trim()
  if (!text) return null
  try {
    const doFetch = fetchImpl || dependencies.fetchImpl || (
      await import('../adapters/proxyFetch.js')
    ).fetchWithEnvProxy
    const result = await embedMemoryTexts({ config, texts: [text], fetchImpl: doFetch, signal })
    return result.ok && Array.isArray(result.vectors?.[0]) ? result.vectors[0] : null
  } catch {
    return null
  }
}

function parseEmbeddingResponse(payload, expectedCount) {
  const rows = Array.isArray(payload?.data) ? payload.data : null
  if (!rows || rows.length !== expectedCount) return null
  const vectors = new Array(expectedCount).fill(null)
  for (const row of rows) {
    const index = Number(row?.index)
    if (!Number.isSafeInteger(index) || index < 0 || index >= expectedCount) return null
    if (vectors[index] !== null) return null
    if (!serializeMemoryVector(row?.embedding)) return null
    vectors[index] = row.embedding
  }
  if (vectors.some((vector) => !vector)) return null
  const dimensions = vectors[0].length
  if (vectors.some((vector) => vector.length !== dimensions)) return null
  return { vectors, dimensions }
}

/**
 * Embed a bounded batch of texts. Never throws: callers degrade to lexical
 * recall and record the stable code.
 *
 * @returns {Promise<{ok: true, vectors: number[][], dimensions: number}|{ok: false, code: string}>}
 */
export async function embedMemoryTexts({
  config,
  texts,
  fetchImpl,
  signal = null,
} = {}) {
  if (!config?.enabled) return { ok: false, code: 'MEMORY_EMBEDDINGS_DISABLED' }
  if (signal?.aborted) return { ok: false, code: 'MEMORY_EMBEDDING_ABORTED' }
  const batch = (Array.isArray(texts) ? texts : [])
    .map((text) => String(text ?? '').slice(0, MEMORY_EMBEDDING_MAX_TEXT_CHARS))
  if (batch.length === 0) return { ok: true, vectors: [], dimensions: 0 }
  if (batch.length > MEMORY_EMBEDDING_MAX_BATCH) return { ok: false, code: 'MEMORY_EMBEDDING_BATCH_TOO_LARGE' }
  if (typeof fetchImpl !== 'function') return { ok: false, code: 'MEMORY_EMBEDDING_FETCH_UNAVAILABLE' }

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(Object.assign(new Error('embedding request timed out'), {
      code: 'MEMORY_EMBEDDING_TIMEOUT',
    }))
  }, positiveInt(config.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS))
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  try {
    const headers = { 'content-type': 'application/json' }
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
    const response = await fetchImpl(memoryEmbeddingUrl(config.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model, input: batch,
        ...(config.dimensions ? { dimensions: config.dimensions } : {}),
      }),
      signal: controller.signal,
    })
    if (controller.signal.aborted) {
      return { ok: false, code: signal?.aborted ? 'MEMORY_EMBEDDING_ABORTED' : 'MEMORY_EMBEDDING_TIMEOUT' }
    }
    if (!response?.ok) return { ok: false, code: `MEMORY_EMBEDDING_HTTP_${Number(response?.status) || 0}` }
    const payload = await response.json().catch(() => null)
    if (controller.signal.aborted) {
      return { ok: false, code: signal?.aborted ? 'MEMORY_EMBEDDING_ABORTED' : 'MEMORY_EMBEDDING_TIMEOUT' }
    }
    const parsed = parseEmbeddingResponse(payload, batch.length)
    if (!parsed) return { ok: false, code: 'MEMORY_EMBEDDING_RESPONSE_INVALID' }
    if (config.dimensions && parsed.dimensions !== config.dimensions) {
      return { ok: false, code: 'MEMORY_EMBEDDING_DIMENSIONS_MISMATCH' }
    }
    return { ok: true, vectors: parsed.vectors, dimensions: parsed.dimensions }
  } catch (error) {
    if (signal?.aborted) return { ok: false, code: 'MEMORY_EMBEDDING_ABORTED' }
    if (controller.signal.aborted) return { ok: false, code: 'MEMORY_EMBEDDING_TIMEOUT' }
    return { ok: false, code: String(error?.code || 'MEMORY_EMBEDDING_FAILED') }
  } finally {
    clearTimeout(timeout)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
