/** Persistent derived search keys, with a bounded durable queue for legacy and externally edited rows. */
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { row2memory } from './memoryRowMapper.js'
import { normalizedSearchText } from './memoryRelevance.js'

export const MEMORY_SEARCH_INDEX_LIMITS = Object.freeze({ maxRows: 256, maxTextChars: 4_000_000, maxDurationMs: 50 })

export function normalizeMemoryMatchText(value) {
  // Deliberately preserve existing automatic matching semantics: no NFKC.
  return String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

export function memoryMatchHash(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex')
}

export function memorySearchFingerprint(row) {
  return memoryMatchHash(JSON.stringify([row.user_id, row.agent_id || null, row.type,
    row.title, row.slug, row.body, row.frontmatter_json]))
}

export function memorySearchScope(alias, { userId, agentId = null, includeGlobal = false, includeAllAgents = false, type = null }, params) {
  params.push(String(userId))
  let sql = `${alias}.user_id = ?`
  if (!includeAllAgents) {
    if (agentId) {
      sql += includeGlobal ? ` AND (${alias}.agent_id IS NULL OR ${alias}.agent_id = ?)` : ` AND ${alias}.agent_id = ?`
      params.push(String(agentId))
    } else sql += ` AND ${alias}.agent_id IS NULL`
  }
  if (type) { sql += ` AND ${alias}.type = ?`; params.push(type) }
  return sql
}

export function boundedMemoryInteger(value, fallback, maximum) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? Math.min(maximum, number) : fallback
}

export function memorySearchError(code, diagnostics = null) {
  return Object.assign(new Error(code === 'MEMORY_MATCH_ABORTED' ? 'Memory lookup cancelled.'
    : 'Memory lookup is incomplete; no new memory was written. Retry after the bounded index catches up.'), {
    code, retryable: code !== 'MEMORY_MATCH_ABORTED', ...(diagnostics ? { diagnostics } : {}),
  })
}

/** Caller holds the same transaction that writes the source row. */
export function indexMemoryRow(db, row) {
  const memory = row2memory(row)
  const tags = Array.isArray(memory.frontmatter?.tags) ? memory.frontmatter.tags.map(normalizedSearchText) : []
  db.prepare(`INSERT INTO memory_search_index
    (memory_id,user_id,agent_id,type,source_auto,memory_order,search_title,search_slug,search_body,
     search_tags_json,exact_title_key,dedup_title_key,dedup_body_key,source_fingerprint)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(memory_id) DO UPDATE SET user_id=excluded.user_id,agent_id=excluded.agent_id,
      type=excluded.type,source_auto=excluded.source_auto,memory_order=excluded.memory_order,
      search_title=excluded.search_title,search_slug=excluded.search_slug,search_body=excluded.search_body,
      search_tags_json=excluded.search_tags_json,exact_title_key=excluded.exact_title_key,
      dedup_title_key=excluded.dedup_title_key,dedup_body_key=excluded.dedup_body_key,
      source_fingerprint=excluded.source_fingerprint`).run(
    row.id, row.user_id, row.agent_id || null, row.type, memory.frontmatter?.source === 'auto_chat' ? 1 : 0,
    row.memory_order, normalizedSearchText(row.title), normalizedSearchText(row.slug), normalizedSearchText(row.body),
    JSON.stringify(tags), String(row.title || '').trim(), normalizeMemoryMatchText(row.title),
    memoryMatchHash(normalizeMemoryMatchText(row.body)), memorySearchFingerprint(row),
  )
  db.prepare('DELETE FROM memory_search_pending WHERE memory_id = ? AND user_id = ?').run(row.id, row.user_id)
}

function indexLimitCode({ signal, indexed, chars, limits, deadline, now }) {
  if (signal?.aborted) return 'MEMORY_SEARCH_INDEX_ABORTED'
  if (indexed >= limits.maxRows) return 'MEMORY_SEARCH_INDEX_ROW_LIMIT'
  if (chars >= limits.maxTextChars) return 'MEMORY_SEARCH_INDEX_TEXT_LIMIT'
  if (now() >= deadline) return 'MEMORY_SEARCH_INDEX_TIME_LIMIT'
  return null
}

function indexPendingMemory(db, pending, remainingChars) {
  return db.transaction(() => {
    const row = db.prepare('SELECT rowid AS memory_order,* FROM memories WHERE id = ? AND user_id = ?')
      .get(pending.memory_id, pending.user_id)
    if (!row) return { code: 'MEMORY_SEARCH_INDEX_INPUT_CHANGED' }
    const chars = String(row.title).length + String(row.body).length + String(row.frontmatter_json || '').length
    if (chars > remainingChars) return { code: 'MEMORY_SEARCH_INDEX_TEXT_LIMIT' }
    indexMemoryRow(db, row)
    return { chars }
  }).immediate()
}

/** Dequeued rows are the durable checkpoint; restarts continue with the next dirty memory. */
export function prepareMemorySearchIndex(db, options = {}, dependencies = {}) {
  const now = dependencies.now || (() => performance.now())
  const limits = {
    maxRows: boundedMemoryInteger(options.limits?.maxRows, MEMORY_SEARCH_INDEX_LIMITS.maxRows, 4000),
    maxTextChars: boundedMemoryInteger(options.limits?.maxTextChars, MEMORY_SEARCH_INDEX_LIMITS.maxTextChars, 16_000_000),
    maxDurationMs: boundedMemoryInteger(options.limits?.maxDurationMs, MEMORY_SEARCH_INDEX_LIMITS.maxDurationMs, 1000),
  }
  const params = []
  let scope = memorySearchScope('p', { ...options, type: null }, params)
  if (options.type) { scope += ' AND m.type = ?'; params.push(options.type) }
  const next = db.prepare(`SELECT p.memory_id,p.user_id,p.memory_order,
    length(m.title)+length(m.body)+COALESCE(length(m.frontmatter_json),0) AS text_chars FROM memory_search_pending p
    JOIN memories m ON m.id=p.memory_id AND m.user_id=p.user_id
    WHERE ${scope} AND p.memory_order > ? ORDER BY p.memory_order ASC LIMIT ?`)
  const pending = db.prepare(`SELECT 1 FROM memory_search_pending p
    JOIN memories m ON m.id=p.memory_id AND m.user_id=p.user_id WHERE ${scope} LIMIT 1`)
  const deadline = now() + limits.maxDurationMs
  let indexed = 0
  let chars = 0
  let cursor = 0
  let code = null
  while (true) {
    const rows = next.all(...params, cursor, Math.min(32, limits.maxRows - indexed + 1))
    if (!rows.length) break
    for (const row of rows) {
      code = indexLimitCode({ signal: options.signal, indexed, chars, limits, deadline, now })
      if (code) break
      const size = row.text_chars
      if (chars + size > limits.maxTextChars) { code = 'MEMORY_SEARCH_INDEX_TEXT_LIMIT'; break }
      const result = indexPendingMemory(db, row, limits.maxTextChars - chars)
      if (result.code) { code = result.code; break }
      indexed += 1
      chars += result.chars
      cursor = row.memory_order
    }
    if (code) break
  }
  const complete = !pending.get(...params)
  return { indexed, textChars: chars, complete, coverage: complete ? 'complete' : 'partial',
    code: complete ? null : code, limits }
}

export function assertCompleteMemorySearchIndex(db, options) {
  if (options.signal?.aborted) throw memorySearchError('MEMORY_MATCH_ABORTED')
  const report = prepareMemorySearchIndex(db, options)
  if (options.signal?.aborted) throw memorySearchError('MEMORY_MATCH_ABORTED', report)
  if (!report.complete) throw memorySearchError('MEMORY_SEARCH_INDEX_INCOMPLETE', report)
  return report
}
