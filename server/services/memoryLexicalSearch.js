/** Bounded exact top-k lexical recall, independent of recency and pinned candidates. */
import { performance } from 'node:perf_hooks'
import { row2memory } from './memoryRowMapper.js'
import { compareMemoryRelevance, normalizedSearchText, scoreMemoryRelevance } from './memoryRelevance.js'
import {
  boundedMemoryInteger, memoryMatchHash, memorySearchFingerprint, memorySearchScope, prepareMemorySearchIndex,
} from './memorySearchIndex.js'

export const MEMORY_LEXICAL_LIMITS = Object.freeze({ topK: 240, maxScanned: 20_000, maxTextChars: 4_000_000, maxDurationMs: 50 })

function lexicalLimits(requested = {}) {
  return {
    topK: boundedMemoryInteger(requested.topK, MEMORY_LEXICAL_LIMITS.topK, 2000),
    maxScanned: boundedMemoryInteger(requested.maxScanned, MEMORY_LEXICAL_LIMITS.maxScanned, 100_000),
    maxTextChars: boundedMemoryInteger(requested.maxTextChars, MEMORY_LEXICAL_LIMITS.maxTextChars, 16_000_000),
    maxDurationMs: boundedMemoryInteger(requested.maxDurationMs, MEMORY_LEXICAL_LIMITS.maxDurationMs, 1000),
  }
}

function retainCandidate(best, memory, score, topK) {
  if (score <= 0 || best.some((entry) => entry.memory.id === memory.id)) return
  const candidate = { memory, score }
  if (best.length === topK && compareMemoryRelevance(candidate, best.at(-1)) >= 0) return
  let low = 0
  let high = best.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compareMemoryRelevance(candidate, best[middle]) < 0) high = middle
    else low = middle + 1
  }
  best.splice(low, 0, candidate)
  if (best.length > topK) best.pop()
}

function exactCandidates(db, scope, params, query, limit) {
  const rows = []
  for (const column of ['search_title', 'search_slug']) {
    rows.push(...db.prepare(`SELECT m.*,i.source_fingerprint FROM memory_search_index i
      JOIN memories m ON m.id=i.memory_id AND m.user_id=i.user_id
      WHERE ${scope} AND i.${column} = ?
      ORDER BY m.pinned DESC,COALESCE(m.last_used_at,m.updated_at) DESC,m.id ASC LIMIT ?`)
      .all(...params, query, limit + 1))
  }
  return [...new Map(rows.map((row) => [row.id, row])).values()]
}

function stopCode({ signal, scanned, chars, limits, now, deadline }) {
  if (signal?.aborted) return 'MEMORY_LEXICAL_ABORTED'
  if (scanned >= limits.maxScanned) return 'MEMORY_LEXICAL_SCAN_LIMIT'
  if (chars >= limits.maxTextChars) return 'MEMORY_LEXICAL_TEXT_LIMIT'
  if (now() >= deadline) return 'MEMORY_LEXICAL_TIME_LIMIT'
  return null
}

export function searchLexicalMemories(db, options = {}, dependencies = {}) {
  const limits = lexicalLimits(options.limits)
  const now = dependencies.now || (() => performance.now())
  const index = prepareMemorySearchIndex(db, { ...options, limits: options.indexLimits })
  const deadline = now() + limits.maxDurationMs
  const query = normalizedSearchText(options.query)
  const params = []
  const scope = memorySearchScope('i', options, params)
  const identity = memoryMatchHash(JSON.stringify([options.userId, options.agentId || null,
    !!options.includeGlobal, !!options.includeAllAgents, options.type || null, query]))
  let cursor = Number.isSafeInteger(options.cursor?.rowId) && options.cursor.rowId > 0 ? options.cursor.rowId : 0
  const startedAfterRowId = cursor
  let code = options.cursor && options.cursor.identity !== identity ? 'MEMORY_LEXICAL_CURSOR_MISMATCH' : null
  const best = []
  let scanned = 0
  let matched = 0
  let chars = 0
  let stale = 0
  let complete = false
  if (!code && !options.signal?.aborted) {
    for (const row of exactCandidates(db, scope, params, query, Math.min(limits.topK, 240))) {
      if (row.source_fingerprint !== memorySearchFingerprint(row)) { stale += 1; continue }
      const memory = row2memory(row)
      retainCandidate(best, memory, scoreMemoryRelevance(memory, query), limits.topK)
    }
  }
  const statement = db.prepare(`SELECT m.*,i.memory_order,i.source_fingerprint FROM memory_search_index i
    JOIN memories m ON m.id=i.memory_id AND m.user_id=i.user_id
    WHERE ${scope} AND i.memory_order > ? ORDER BY i.memory_order ASC LIMIT ?`)
  while (!code && !complete) {
    code = stopCode({ signal: options.signal, scanned, chars, limits, now, deadline })
    if (code) break
    const pageSize = Math.min(64, limits.maxScanned - scanned)
    const rows = statement.all(...params, cursor, pageSize + 1)
    let consumed = 0
    for (const row of rows.slice(0, pageSize)) {
      code = stopCode({ signal: options.signal, scanned, chars, limits, now, deadline })
      if (code) break
      const size = String(row.title).length + String(row.body).length + String(row.frontmatter_json || '').length
      if (chars + size > limits.maxTextChars) { code = 'MEMORY_LEXICAL_TEXT_LIMIT'; break }
      cursor = row.memory_order
      scanned += 1
      consumed += 1
      chars += size
      if (row.source_fingerprint !== memorySearchFingerprint(row)) { stale += 1; continue }
      const memory = row2memory(row)
      const score = scoreMemoryRelevance(memory, query)
      if (score > 0) matched += 1
      retainCandidate(best, memory, score, limits.topK)
    }
    complete = consumed === rows.length
  }
  if (!index.complete && !code) code = 'MEMORY_LEXICAL_INDEX_INCOMPLETE'
  if (stale && !code) code = 'MEMORY_LEXICAL_INDEX_STALE'
  const fullCoverage = complete && index.complete && !stale && !startedAfterRowId && !code
  return {
    memories: best.map(({ memory }) => memory),
    diagnostics: { coverage: fullCoverage ? 'complete' : 'partial', truncated: !fullCoverage,
      candidateTruncated: matched > limits.topK, code, scanned, matched, stale, textChars: chars,
      startedAfterRowId, rangeComplete: complete, limits, index,
      nextCursor: complete ? null : { rowId: cursor, identity } },
  }
}
