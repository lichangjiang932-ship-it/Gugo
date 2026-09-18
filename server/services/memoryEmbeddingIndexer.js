/**
 * Bounded background indexer for memory embeddings.
 *
 * It is a no-op unless embeddings are explicitly enabled. Run it best-effort at
 * turn start: this turn uses whatever vectors already exist, and the next turn
 * benefits from the freshly indexed memories. Failures are reported as a stable
 * code and never block a turn.
 */
import {
  scanMemoriesNeedingEmbedding,
  setMemoryEmbedding,
} from './memoryEmbeddingStore.js'
import {
  embedMemoryTexts,
  memoryContentFingerprint,
  memoryEmbeddingSpaceId,
  memoryEmbeddingText,
  resolveMemoryEmbeddingConfig,
} from './memoryEmbeddingService.js'
import { getDb } from '../db.js'

/** Sentinel meaning "every memory of this user, regardless of agent". */
export const ALL_AGENTS = '__all__'

// Default per-turn work must advance beyond an already indexed head of more
// than one scan budget. Keep cursors bounded and scoped to the actual database,
// user, persona and space; explicit reindex cursors remain caller-controlled.
const backgroundCursors = new WeakMap()
const MAX_BACKGROUND_SCOPES = 128

function cursorCache(userId, agentId, space) {
  const db = getDb()
  let cache = backgroundCursors.get(db)
  if (!cache) { cache = new Map(); backgroundCursors.set(db, cache) }
  const key = JSON.stringify([String(userId), agentId || null, space])
  return {
    get: () => cache.get(key) || null,
    set: (cursor) => {
      cache.delete(key)
      if (cursor) cache.set(key, cursor)
      if (cache.size > MAX_BACKGROUND_SCOPES) cache.delete(cache.keys().next().value)
    },
  }
}

export async function indexMemoryEmbeddings({
  userId = '',
  agentId = null,
  env = process.env,
  fetchImpl = null,
  limit = 8,
  cursor,
  signal = null,
  maxScanned = 4_000,
} = {}) {
  const config = resolveMemoryEmbeddingConfig(env)
  if (!config || !userId) return Object.freeze({ indexed: 0, skipped: true })
  if (signal?.aborted) return Object.freeze({ indexed: 0, code: 'MEMORY_EMBEDDING_ABORTED', reachedEnd: false })
  // The space must be recorded with the vector and used when deciding what is
  // stale, or a switch of model/endpoint would never converge.
  const space = memoryEmbeddingSpaceId(config)
  let scan
  let cache = null
  let startCursor = cursor || null
  try {
    if (cursor === undefined) { cache = cursorCache(userId, agentId, space); startCursor = cache.get() }
    scan = scanMemoriesNeedingEmbedding({
      userId, agentId, model: config.model, space, dimensions: config.dimensions,
      includeAllAgents: agentId === ALL_AGENTS, limit: Math.min(32, Number(limit) || 8),
      cursor: startCursor, signal, maxScanned,
    })
  } catch {
    return Object.freeze({ indexed: 0, code: 'MEMORY_EMBEDDING_QUERY_FAILED', nextCursor: startCursor, reachedEnd: false })
  }
  const memories = scan.memories
  const progress = { nextCursor: scan.nextCursor, reachedEnd: scan.reachedEnd, scanned: scan.scanned }
  const retryProgress = { ...progress, nextCursor: startCursor, reachedEnd: false }
  if (scan.code) return Object.freeze({ indexed: 0, code: scan.code, ...retryProgress })
  if (memories.length === 0) {
    cache?.set(scan.nextCursor)
    return Object.freeze({ indexed: 0, skipped: false, ...progress })
  }

  let result
  try {
    const doFetch = fetchImpl || ((await import('../adapters/proxyFetch.js')).fetchWithEnvProxy)
    result = await embedMemoryTexts({ config, texts: memories.map(memoryEmbeddingText), fetchImpl: doFetch, signal })
  } catch {
    result = { ok: false, code: 'MEMORY_EMBEDDING_FETCH_UNAVAILABLE' }
  }
  if (!result.ok) return Object.freeze({ indexed: 0, code: result.code, ...retryProgress })

  let indexed = 0
  let superseded = 0
  let failed = 0
  for (let position = 0; position < memories.length; position += 1) {
    if (signal?.aborted) break
    const memory = memories[position]
    try {
      const stored = setMemoryEmbedding({
        userId,
        memoryId: memory.id,
        agentId: memory.agentId,
        model: config.model,
        vector: result.vectors[position],
        contentFingerprint: memoryContentFingerprint(memory),
        embeddingSpace: space,
      })
      if (stored) indexed += 1
      else superseded += 1
    } catch {
      failed += 1
    }
  }
  const code = signal?.aborted ? 'MEMORY_EMBEDDING_ABORTED'
    : failed ? 'MEMORY_EMBEDDING_WRITE_FAILED'
      : superseded ? 'MEMORY_EMBEDDING_INPUT_CHANGED' : null
  if (!code) cache?.set(scan.nextCursor)
  return Object.freeze({ indexed, failed, superseded, ...(code ? { code, ...retryProgress } : progress) })
}
