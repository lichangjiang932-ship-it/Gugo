import {
  embedMemoryTexts, memoryEmbeddingSpaceId, resolveMemoryEmbeddingConfig, serializeMemoryVector,
} from './memoryEmbeddingService.js'

export function assertPromptContextActive(signal) {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException('Prompt context cancelled', 'AbortError')
}

function safeEmbeddingCode(code) {
  const value = String(code || '')
  return /^MEMORY_EMBEDDING_(?:HTTP_\d{1,3}|TIMEOUT|ABORTED|FAILED|RESPONSE_INVALID|DIMENSIONS_MISMATCH|FETCH_UNAVAILABLE)$/u.test(value)
    ? value : 'MEMORY_EMBEDDING_FAILED'
}

/** One request, no retry/failover; the returned vector always carries its producing space. */
export async function prepareBackgroundMemoryQuery({ query = '', env = process.env, signal, resuming = false } = {}, dependencies = {}) {
  assertPromptContextActive(signal)
  const snapshot = Object.freeze({ ...env })
  const base = { env: snapshot, queryVector: null, querySpace: null }
  if (resuming) return { ...base, embedding: { status: 'skipped', code: 'MEMORY_EMBEDDING_RESUME_SKIPPED' } }
  const config = resolveMemoryEmbeddingConfig(snapshot)
  if (!config) return { ...base, embedding: String(snapshot.MEMORY_EMBEDDINGS_ENABLED || '').trim() === '1'
    ? { status: 'degraded', code: 'MEMORY_EMBEDDING_CONFIG_INVALID' }
    : { status: 'disabled', code: 'MEMORY_EMBEDDINGS_DISABLED' } }
  if (!String(query || '').trim()) return { ...base, embedding: { status: 'skipped', code: 'MEMORY_EMBEDDING_EMPTY_QUERY' } }
  const space = memoryEmbeddingSpaceId(config)
  try {
    const fetchImpl = dependencies.fetchImpl || (await import('../adapters/proxyFetch.js')).fetchWithEnvProxy
    assertPromptContextActive(signal)
    const result = await (dependencies.embedMemoryTexts || embedMemoryTexts)({ config, texts: [String(query)], fetchImpl, signal })
    assertPromptContextActive(signal)
    const vector = result?.vectors?.[0]
    if (!result?.ok || !serializeMemoryVector(vector) || (config.dimensions && vector.length !== config.dimensions)) {
      return { ...base, embedding: { status: 'degraded', code: safeEmbeddingCode(result?.code || 'MEMORY_EMBEDDING_RESPONSE_INVALID') } }
    }
    return { ...base, queryVector: vector, querySpace: space,
      embedding: { status: 'ready', code: 'MEMORY_EMBEDDING_READY', space, dimensions: vector.length } }
  } catch {
    assertPromptContextActive(signal)
    return { ...base, embedding: { status: 'degraded', code: 'MEMORY_EMBEDDING_FAILED' } }
  }
}

function retrievalSummary(value) {
  if (!value || typeof value !== 'object') return null
  return {
    code: typeof value.code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(value.code) ? value.code : null,
    coverage: ['complete', 'partial', 'none'].includes(value.coverage) ? value.coverage : null,
    truncated: value.truncated === true, scanned: Math.max(0, Number(value.scanned) || 0),
    candidateTruncated: value.candidateTruncated === true,
    ...(value.index && typeof value.index === 'object' ? { index: {
      complete: value.index.complete === true,
      coverage: ['complete', 'partial'].includes(value.index.coverage) ? value.index.coverage : null,
      code: /^[A-Z0-9_]{1,80}$/u.test(String(value.index.code || '')) ? value.index.code : null,
    } } : {}),
  }
}

/** Safe diagnostics allowlist shared by chat, job and subagent; never copy query/error strings. */
export function promptMemoryDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return null
  const semantic = retrievalSummary(diagnostics.retrieval?.semantic || diagnostics.semantic)
  const lexical = retrievalSummary(diagnostics.retrieval?.lexical || diagnostics.lexical)
  const raw = diagnostics.embedding
  const embedding = raw && typeof raw === 'object' ? {
    status: ['ready', 'disabled', 'skipped', 'degraded'].includes(raw.status) ? raw.status : 'degraded',
    code: /^MEMORY_[A-Z0-9_]{1,80}$/u.test(String(raw.code || '')) ? raw.code : 'MEMORY_EMBEDDING_FAILED',
    ...(typeof raw.space === 'string' && /^memspace:v\d+:[a-f0-9]{32}$/u.test(raw.space) ? { space: raw.space } : {}),
    ...(Number.isSafeInteger(raw.dimensions) && raw.dimensions > 0 ? { dimensions: raw.dimensions } : {}),
  } : null
  return {
    failed: diagnostics.failed === true, touchFailed: diagnostics.touchFailed === true,
    linkedCount: Math.max(0, Number(diagnostics.linkedCount) || 0),
    ...(semantic ? { semantic } : {}), ...(lexical ? { lexical } : {}), ...(embedding ? { embedding } : {}),
  }
}
