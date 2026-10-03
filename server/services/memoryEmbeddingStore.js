/**
 * Local vector storage for memory semantic recall.
 *
 * Kept separate from `memoryStore.js` so the CRUD/ranking module stays focused
 * and under the runtime size gate. This module owns only the `memory_embeddings`
 * table; it never contacts a provider (see `memoryEmbeddingService`).
 */
import { getDb } from '../db.js'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { row2memory } from './memoryRowMapper.js'
import {
  cosineSimilarity,
  deserializeMemoryVector,
  memoryContentFingerprint,
  MEMORY_EMBEDDING_MAX_DIMENSIONS,
  serializeMemoryVector,
} from './memoryEmbeddingService.js'

export const MEMORY_SEMANTIC_LIMITS = Object.freeze({
  topK: 80,
  pageSize: 64,
  maxScanned: 20_000,
  maxVectorElements: 16_000_000,
  maxTextChars: 4_000_000,
  maxDurationMs: 50,
  maxMemoryChars: 64_000,
})

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(maximum, Math.floor(parsed))
}

function scopePredicate(agentId, params, includeAllAgents = false) {
  if (includeAllAgents) return ''
  if (!agentId) return ' AND m.agent_id IS NULL'
  params.push(String(agentId))
  return ' AND (m.agent_id IS NULL OR m.agent_id = ?)'
}

/** Persist or replace one memory vector (Float32 BLOB). */
export function setMemoryEmbedding({
  userId, memoryId, model, vector, contentFingerprint, embeddingSpace = null, agentId, now = Date.now(),
} = {}) {
  if (!userId || !memoryId) return false
  const buffer = serializeMemoryVector(vector)
  if (!buffer) return false
  const db = getDb()
  // Provider work is asynchronous. Check ownership and the input fingerprint
  // again in the same write transaction so a late response cannot overwrite an
  // edited memory, resurrect a deleted one, or move another user's vector.
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM memories WHERE user_id = ? AND id = ?')
      .get(String(userId), String(memoryId))
    if (!row || memoryContentFingerprint(row2memory(row)) !== contentFingerprint) return false
    if (agentId !== undefined && (row.agent_id || null) !== (agentId || null)) return false
    db.prepare(`
    INSERT INTO memory_embeddings
      (memory_id, user_id, model, dimensions, vector, content_fingerprint, embedding_space, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET
      user_id = excluded.user_id,
      model = excluded.model,
      dimensions = excluded.dimensions,
      vector = excluded.vector,
      content_fingerprint = excluded.content_fingerprint,
      embedding_space = excluded.embedding_space,
      updated_at = excluded.updated_at
    `).run(
      String(memoryId),
      String(userId),
      String(model || '').slice(0, 200),
      vector.length,
      buffer,
      String(contentFingerprint || ''),
      String(embeddingSpace || 'unknown').slice(0, 200),
      Math.max(0, Number(now) || Date.now()),
    )
    return true
  }).immediate()
}

/** Stored vectors for a bounded set of memory ids. */
export function getMemoryEmbeddings({ userId, memoryIds = [] } = {}) {
  const ids = [...new Set((Array.isArray(memoryIds) ? memoryIds : [])
    .map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 500)
  if (!userId || ids.length === 0) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb().prepare(`
    SELECT e.memory_id, e.model, e.dimensions, e.vector, e.content_fingerprint, e.embedding_space
    FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id AND m.user_id = e.user_id
    WHERE e.user_id = ? AND e.memory_id IN (${placeholders})
  `).all(String(userId), ...ids)
  const out = new Map()
  for (const row of rows) {
    const vector = deserializeMemoryVector(row.vector, row.dimensions)
    if (!vector) continue
    out.set(row.memory_id, {
      model: row.model,
      dimensions: row.dimensions,
      vector,
      contentFingerprint: row.content_fingerprint,
      embeddingSpace: row.embedding_space || 'unknown',
    })
  }
  return out
}

/**
 * Bounded work list for the background indexer: memories that have no vector,
 * a vector from another model, or a vector whose content fingerprint is stale.
 *
 * Staleness is decided in JS (the fingerprint includes a hash), so a SQL LIMIT
 * would cut the page *before* the predicate and let a backlog larger than one
 * batch starve forever. This scans bounded pages instead. Pass the returned
 * `nextCursor` back in to continue where the scan stopped; `reachedEnd` says
 * the last page of the table was seen, so the caller can wrap around.
 */
export function scanMemoriesNeedingEmbedding({
  userId, agentId = null, model = '', space = null, dimensions = null, includeAllAgents = false,
  limit = 8, cursor = null, signal = null, maxScanned = 4_000,
} = {}) {
  if (!userId) return { memories: [], nextCursor: null, reachedEnd: true, scanned: 0 }
  const wanted = boundedInteger(limit, 8, 64)
  const pageSize = Math.min(Math.max(wanted * 4, 32), 400)
  const maxScan = boundedInteger(maxScanned, 4_000, 4_000)
  const baseParams = [String(userId)]
  let baseSql = `
    SELECT m.*, m.rowid AS scan_rowid, e.model AS embedding_model,
           e.content_fingerprint AS embedding_fingerprint, e.embedding_space,
           e.dimensions AS embedding_dimensions, e.vector AS embedding_vector
    FROM memories m
    LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.user_id = m.user_id
    WHERE m.user_id = ?`
  baseSql += scopePredicate(agentId, baseParams, includeAllAgents)
  const out = []
  let scanned = 0
  let reachedEnd = false
  let afterRowId = scanCursorRowId(userId, cursor)
  let lastRow = null
  const db = getDb()
  while (out.length < wanted && scanned < maxScan) {
    if (signal?.aborted) break
    const params = [...baseParams]
    let sql = baseSql
    if (afterRowId) {
      // Stable insertion order is independent of last_used_at, which prompt
      // injection updates while a background scan is in progress.
      sql += ' AND m.rowid > ?'
      params.push(afterRowId)
    }
    const pageLimit = Math.min(pageSize, maxScan - scanned)
    sql += ' ORDER BY m.rowid ASC LIMIT ?'
    // One lookahead row distinguishes a consumed final page from a partial one.
    params.push(pageLimit + 1)
    const rows = db.prepare(sql).all(...params)
    if (rows.length === 0) { reachedEnd = true; break }
    let consumed = 0
    for (const row of rows.slice(0, pageLimit)) {
      if (out.length >= wanted || signal?.aborted) break
      lastRow = row
      scanned += 1
      consumed += 1
      if (needsEmbedding(row, { model, space, dimensions })) out.push(row2memory(row))
    }
    reachedEnd = consumed === rows.length
    afterRowId = Number(lastRow?.scan_rowid) || afterRowId
    if (reachedEnd) break
  }
  return {
    memories: out,
    nextCursor: reachedEnd ? null : (cursorFor(lastRow) || cursor),
    reachedEnd,
    scanned,
    truncated: !reachedEnd,
    ...(signal?.aborted ? { code: 'MEMORY_EMBEDDING_ABORTED' } : {}),
  }
}

function cursorFor(row) {
  if (!row) return null
  return Object.freeze({ rowId: Number(row.scan_rowid), id: String(row.id) })
}

function scanCursorRowId(userId, cursor) {
  if (Number.isSafeInteger(cursor?.rowId) && cursor.rowId > 0) return cursor.rowId
  // Legacy cursors named the last memory. Resolve it without trusting mutable
  // recency timestamps; a deleted legacy cursor safely restarts the scan.
  if (!cursor?.id) return 0
  return getDb().prepare('SELECT rowid AS row_id FROM memories WHERE user_id = ? AND id = ?')
    .get(String(userId), String(cursor.id))?.row_id || 0
}

function needsEmbedding(row, { model, space, dimensions }) {
  if (!row.embedding_model || (model && row.embedding_model !== model)) return true
  if (space && (row.embedding_space || 'unknown') !== space) return true
  if (dimensions && row.embedding_dimensions !== dimensions) return true
  if (!deserializeMemoryVector(row.embedding_vector, row.embedding_dimensions)) return true
  return row.embedding_fingerprint !== memoryContentFingerprint(row2memory(row))
}

/** Back-compat wrapper: the memories only, no cursor. */
export function listMemoriesNeedingEmbedding(options = {}) {
  return scanMemoriesNeedingEmbedding(options).memories
}

function semanticLimits(options = {}) {
  if (!options || typeof options !== 'object') options = {}
  return {
    topK: boundedInteger(options.topK, MEMORY_SEMANTIC_LIMITS.topK, 240),
    pageSize: boundedInteger(options.pageSize, MEMORY_SEMANTIC_LIMITS.pageSize, 128),
    maxScanned: boundedInteger(options.maxScanned, MEMORY_SEMANTIC_LIMITS.maxScanned, 100_000),
    maxVectorElements: boundedInteger(options.maxVectorElements, MEMORY_SEMANTIC_LIMITS.maxVectorElements, 32_000_000),
    maxTextChars: boundedInteger(options.maxTextChars, MEMORY_SEMANTIC_LIMITS.maxTextChars, 16_000_000),
    maxDurationMs: boundedInteger(options.maxDurationMs, MEMORY_SEMANTIC_LIMITS.maxDurationMs, 1_000),
    maxMemoryChars: boundedInteger(options.maxMemoryChars, MEMORY_SEMANTIC_LIMITS.maxMemoryChars, 64_000),
  }
}

function compareSemanticCandidates(left, right) {
  return right.similarity - left.similarity
    || Number(right.memory.lastUsedAt || right.memory.updatedAt) - Number(left.memory.lastUsedAt || left.memory.updatedAt)
    || String(left.memory.id).localeCompare(String(right.memory.id))
}

/** Retain at most k candidates; no array grows with the size of the store. */
function retainSemanticCandidate(best, candidate, topK) {
  if (best.length === topK && compareSemanticCandidates(candidate, best[best.length - 1]) >= 0) return
  let low = 0
  let high = best.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compareSemanticCandidates(candidate, best[middle]) < 0) high = middle
    else low = middle + 1
  }
  best.splice(low, 0, candidate)
  if (best.length > topK) best.pop()
}

function semanticPageReader({ userId, agentId, querySpace, dimensions, maxMemoryChars }) {
  const params = [String(userId), String(querySpace), dimensions]
  const scope = scopePredicate(agentId, params)
  // idx_memory_embeddings_space includes rowid as its implicit tie-breaker:
  // keyset pages do not repeatedly sort the complete vector collection.
  const statement = getDb().prepare(`
    SELECT m.*, e.rowid AS vector_rowid, e.vector, e.content_fingerprint
    FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id AND m.user_id = e.user_id
    WHERE e.user_id = ? AND e.embedding_space = ? AND e.dimensions = ? ${scope}
      AND length(m.title) + length(m.body) + COALESCE(length(m.frontmatter_json), 0) <= ?
      AND e.rowid > ? ORDER BY e.rowid ASC LIMIT ?
  `)
  return (afterRowId, limit) => statement.all(...params, maxMemoryChars, afterRowId, limit)
}

function semanticStopCode(state, limits, signal, now, deadline, dimensions) {
  if (signal?.aborted) return 'MEMORY_SEMANTIC_ABORTED'
  if (state.scanned >= limits.maxScanned) return 'MEMORY_SEMANTIC_SCAN_LIMIT'
  if ((state.scanned + 1) * dimensions > limits.maxVectorElements) return 'MEMORY_SEMANTIC_VECTOR_LIMIT'
  if (now() >= deadline) return 'MEMORY_SEMANTIC_TIME_LIMIT'
  return null
}

function semanticCursorIdentity(userId, agentId, querySpace, queryVector) {
  return createHash('sha256').update(JSON.stringify([
    String(userId || ''), agentId || null, querySpace || null, queryVector || null,
  ])).digest('hex')
}

/**
 * Exact top-k over the eligible history, independent of memory recency.
 * SQLite is read in bounded keyset pages; only top-k rows survive each page.
 * A partial scan is explicitly reported (and resumable), never described as
 * complete recall. Querying uses no network or additional native dependency.
 */
export function searchMemoryEmbeddings({
  userId, agentId = null, queryVector, querySpace, signal = null, limits: requestedLimits = {}, cursor = null,
} = {}, dependencies = {}) {
  const limits = semanticLimits(requestedLimits)
  const now = dependencies.now || (() => performance.now())
  const startedAt = now()
  const deadline = startedAt + limits.maxDurationMs
  const best = []
  const state = { scanned: 0, compared: 0, stale: 0, invalid: 0, textChars: 0 }
  let afterRowId = Number.isSafeInteger(cursor?.rowId) && cursor.rowId > 0 ? cursor.rowId : 0
  const startedAfterRowId = afterRowId
  const cursorIdentity = semanticCursorIdentity(userId, agentId, querySpace, queryVector)
  let complete = false
  let code = null
  const dimensions = Array.isArray(queryVector) ? queryVector.length : 0
  if (!userId || typeof querySpace !== 'string' || !querySpace || querySpace === 'unknown'
      || dimensions > MEMORY_EMBEDDING_MAX_DIMENSIONS || !serializeMemoryVector(queryVector)) {
    code = 'MEMORY_SEMANTIC_QUERY_INVALID'
  }
  if (cursor && cursor.identity !== cursorIdentity) code = 'MEMORY_SEMANTIC_CURSOR_MISMATCH'
  try {
    const readPage = code || signal?.aborted ? null : semanticPageReader({
      userId, agentId, querySpace, dimensions, maxMemoryChars: limits.maxMemoryChars,
    })
    while (!code && !complete) {
      code = semanticStopCode(state, limits, signal, now, deadline, dimensions)
      if (code) break
      const pageSize = Math.min(limits.pageSize, limits.maxScanned - state.scanned,
        Math.floor(limits.maxVectorElements / dimensions) - state.scanned)
      const rows = readPage(afterRowId, pageSize + 1)
      let consumed = 0
      for (const row of rows.slice(0, pageSize)) {
        code = semanticStopCode(state, limits, signal, now, deadline, dimensions)
        if (code) break
        const chars = String(row.title).length + String(row.body).length + String(row.frontmatter_json || '').length
        if (state.textChars + chars > limits.maxTextChars) { code = 'MEMORY_SEMANTIC_TEXT_LIMIT'; break }
        consumed += 1
        state.scanned += 1
        state.textChars += chars
        afterRowId = row.vector_rowid
        const vector = deserializeMemoryVector(row.vector, dimensions)
        const similarity = vector && cosineSimilarity(queryVector, vector)
        if (similarity === null) { state.invalid += 1; continue }
        const memory = row2memory(row)
        if (row.content_fingerprint !== memoryContentFingerprint(memory)) { state.stale += 1; continue }
        state.compared += 1
        if (similarity > 0) retainSemanticCandidate(best, { memory, similarity }, limits.topK)
      }
      complete = consumed === rows.length
    }
  } catch {
    code = 'MEMORY_SEMANTIC_QUERY_FAILED'
  }
  return {
    memories: best.map(({ memory }) => memory),
    similarityById: new Map(best.map(({ memory, similarity }) => [memory.id, similarity])),
    diagnostics: {
      mode: 'history_top_k', coverage: complete && startedAfterRowId === 0 ? 'complete' : 'partial',
      truncated: !complete || startedAfterRowId > 0, rangeComplete: complete, startedAfterRowId,
      code, ...state, candidates: best.length, dimensions, limits,
      elapsedMs: Math.max(0, now() - startedAt),
      nextCursor: complete ? null : { rowId: afterRowId, identity: cursorIdentity },
    },
  }
}

/** Cosine similarity per memory, skipping missing or stale vectors. */
export function memorySimilarityById({ userId, memories, queryVector, querySpace = null }) {
  const byId = new Map(memories.map((memory) => [memory.id, memory]))
  const similarity = new Map()
  for (const [memoryId, entry] of getMemoryEmbeddings({ userId, memoryIds: [...byId.keys()] })) {
    const memory = byId.get(memoryId)
    if (!memory) continue
    if (entry.contentFingerprint !== memoryContentFingerprint(memory)) continue
    // Same width is not the same space. Without a matching, known space the
    // comparison is meaningless, so the vector is ignored and lexical recall
    // still decides the result.
    if (!querySpace || querySpace === 'unknown' || entry.embeddingSpace !== querySpace) continue
    const value = cosineSimilarity(queryVector, entry.vector)
    if (value !== null) similarity.set(memoryId, value)
  }
  return similarity
}
