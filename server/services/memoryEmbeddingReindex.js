/**
 * Bounded, restartable full reindex of one user's memory embeddings.
 *
 * The per-turn indexer only ever embeds a small batch so a turn is never
 * blocked by embedding work. That leaves no way to catch up after enabling
 * embeddings on an existing store, or after switching embedding models. This
 * loops the same bounded batch until the backlog is drained, with hard caps so
 * a failing endpoint cannot spin forever.
 */
import { ALL_AGENTS, indexMemoryEmbeddings } from './memoryEmbeddingIndexer.js'
import { scanMemoriesNeedingEmbedding } from './memoryEmbeddingStore.js'
import { memoryEmbeddingSpaceId, resolveMemoryEmbeddingConfig } from './memoryEmbeddingService.js'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

/**
 * Bounded probe of what is still pending, so a caller can tell "done" from
 * "done for the scope I was given". A value equal to the probe size means
 * "at least that many remain".
 */
function scopeAgentId(agentId) {
  if (agentId === ALL_AGENTS) return ALL_AGENTS
  return agentId || null
}

async function remainingBacklog({ userId, agentId, config, signal, maxScanned }) {
  let cursor = null
  let count = 0
  let scanned = 0
  while (scanned < maxScanned && count < REINDEX_REMAINING_PROBE) {
    if (signal?.aborted) return { count: null, exact: false, scanned, code: 'MEMORY_EMBEDDING_ABORTED' }
    let scan
    try {
      scan = scanMemoriesNeedingEmbedding({
        userId, agentId: agentId === ALL_AGENTS ? null : (agentId || null),
        includeAllAgents: agentId === ALL_AGENTS, model: config.model,
        space: memoryEmbeddingSpaceId(config), dimensions: config.dimensions,
        limit: REINDEX_REMAINING_PROBE - count, cursor, signal,
        maxScanned: Math.min(4_000, maxScanned - scanned),
      })
    } catch {
      return { count: null, exact: false, scanned, code: 'MEMORY_EMBEDDING_QUERY_FAILED' }
    }
    count += scan.memories.length
    scanned += scan.scanned
    if (scan.code) return { count, exact: false, scanned, code: scan.code }
    if (scan.reachedEnd) return { count, exact: true, scanned }
    if (!scan.scanned || !scan.nextCursor) {
      return { count, exact: false, scanned, code: 'MEMORY_EMBEDDING_SCAN_STALLED' }
    }
    cursor = scan.nextCursor
    await yieldToEventLoop()
  }
  return { count, exact: false, scanned }
}

export const REINDEX_MAX_TOTAL = 2_000
export const REINDEX_REMAINING_PROBE = 50
export const REINDEX_DEFAULT_BATCH = 8
export const REINDEX_MAX_SCANNED = 100_000

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(maximum, Math.floor(parsed)) : fallback
}

function describeScope(agentId) {
  const resolved = scopeAgentId(agentId)
  if (resolved === ALL_AGENTS) return { kind: 'all_agents', agentId: null }
  return resolved ? { kind: 'agent', agentId: resolved } : { kind: 'global', agentId: null }
}

export async function reindexUserMemoryEmbeddings({
  userId = '',
  agentId = null,
  env = process.env,
  batchSize = REINDEX_DEFAULT_BATCH,
  maxTotal = REINDEX_MAX_TOTAL,
  fetchImpl = null,
  onProgress = null,
  signal = null,
  cursor: initialCursor = null,
} = {}) {
  if (!userId) return Object.freeze({ ok: false, code: 'MEMORY_EMBEDDING_USER_REQUIRED', indexed: 0, batches: 0 })
  const config = resolveMemoryEmbeddingConfig(env)
  if (!config) {
    return Object.freeze({ ok: false, code: 'MEMORY_EMBEDDINGS_DISABLED', indexed: 0, batches: 0 })
  }
  const boundedBatch = boundedInteger(batchSize, REINDEX_DEFAULT_BATCH, 32)
  const boundedTotal = boundedInteger(maxTotal, REINDEX_MAX_TOTAL, REINDEX_MAX_TOTAL)
  // Successful batches and clean scan pages have independent bounds. Neither a
  // large indexed head nor a failing endpoint can turn this into an endless job.
  const maxRounds = Math.ceil(boundedTotal / boundedBatch) + 32

  let indexed = 0
  let batches = 0
  let rounds = 0
  let scanned = 0
  let code = null
  let complete = false
  let cursor = initialCursor
  while (rounds < maxRounds && scanned < REINDEX_MAX_SCANNED) {
    if (signal?.aborted) { code = 'MEMORY_EMBEDDING_ABORTED'; break }
    const remaining = boundedTotal - indexed
    if (remaining <= 0) break
    rounds += 1
    const batch = await indexMemoryEmbeddings({
      userId,
      // Never coerce an absent scope into "all agents": the default stays
      // global-only (as it always was) and the report says which one ran.
      agentId: scopeAgentId(agentId),
      env,
      fetchImpl,
      limit: Math.min(boundedBatch, remaining),
      cursor,
      signal,
      maxScanned: Math.min(4_000, REINDEX_MAX_SCANNED - scanned),
    })
    scanned += Number(batch.scanned) || 0
    indexed += Number(batch.indexed) || 0
    cursor = batch.nextCursor || null
    if (batch.indexed > 0) {
      batches += 1
      if (typeof onProgress === 'function') {
        try { onProgress({ indexed, batches, model: config.model }) } catch { /* progress is advisory */ }
      }
    }
    if (batch.code) { code = batch.code; break }
    if (batch.skipped) { code = 'MEMORY_EMBEDDINGS_DISABLED'; break }
    if (batch.reachedEnd) { complete = true; break }
    if (!batch.scanned || !cursor) { code = 'MEMORY_EMBEDDING_SCAN_STALLED'; break }
    // Cursor checks alone do not let cancellation timers run between clean
    // synchronous DB scans. Yield once before the next bounded batch.
    await yieldToEventLoop()
  }
  if (signal?.aborted) code = 'MEMORY_EMBEDDING_ABORTED'
  const backlog = signal?.aborted ? { count: null, exact: false, scanned: 0 }
    : await remainingBacklog({ userId, agentId, config, signal, maxScanned: REINDEX_MAX_SCANNED - scanned })
  if (!code && backlog.code) code = backlog.code
  const truncated = !complete || !backlog.exact || backlog.count > 0
  return Object.freeze({
    ok: code === null,
    ...(code ? { code } : {}),
    indexed,
    batches,
    rounds,
    scanned,
    truncated,
    coverage: truncated ? 'partial' : 'complete',
    scanComplete: complete,
    nextCursor: complete ? null : cursor,
    model: config.model,
    space: memoryEmbeddingSpaceId(config),
    // The caller must be able to tell what was actually covered: a global-only
    // pass silently skipping agent-scoped memories used to report success.
    scope: Object.freeze(describeScope(agentId)),
    remaining: backlog.count,
    remainingIsExact: backlog.exact,
    remainingScanned: backlog.scanned,
    totalScanned: scanned + backlog.scanned,
  })
}
