/** Indexed business-key lookup and a fail-closed bounded legacy predicate fallback. */
import { row2memory } from './memoryRowMapper.js'
import { compareMemoryRelevance } from './memoryRelevance.js'
import {
  assertCompleteMemorySearchIndex, boundedMemoryInteger, memoryMatchHash, memorySearchError,
  memorySearchFingerprint, memorySearchScope, normalizeMemoryMatchText,
} from './memorySearchIndex.js'

function matchingKeys({ title, body, mode = 'exact_title' }) {
  const keys = []
  if (mode === 'exact_title') {
    keys.push(['exact_title_key', String(title || '').trim()])
  } else {
    if (title != null) keys.push(['dedup_title_key', normalizeMemoryMatchText(title)])
    if (body != null) keys.push(['dedup_body_key', memoryMatchHash(normalizeMemoryMatchText(body))])
  }
  if (!keys.length) throw new TypeError('An indexed memory match requires a title or body')
  return keys
}

export function findIndexedMemory(db, options) {
  if (!options.userId) return null
  assertCompleteMemorySearchIndex(db, options)
  const agentScopes = options.includeGlobal && options.agentId ? [null, options.agentId] : [options.agentId || null]
  const matches = []
  // Separate equality seeks avoid an OR that can make SQLite scan every
  // project memory before it decides whether either business key matches.
  for (const agentId of agentScopes) {
    const params = []
    const scope = memorySearchScope('i', { ...options, agentId, includeGlobal: false }, params)
    const source = options.source === 'auto' ? ' AND i.source_auto = 1'
      : options.source === 'manual' ? ' AND i.source_auto = 0' : ''
    for (const [column, value] of matchingKeys(options)) {
      const row = db.prepare(`SELECT m.*,i.source_fingerprint FROM memory_search_index i
        JOIN memories m ON m.id=i.memory_id AND m.user_id=i.user_id
        WHERE ${scope}${source} AND i.${column} = ?
        ORDER BY m.pinned DESC,COALESCE(m.last_used_at,m.updated_at) DESC,m.id ASC LIMIT 1`).get(...params, value)
      if (!row) continue
      if (row.source_fingerprint !== memorySearchFingerprint(row)) throw memorySearchError('MEMORY_SEARCH_INDEX_STALE')
      matches.push({ memory: row2memory(row), score: 0 })
    }
  }
  matches.sort((left, right) => compareMemoryRelevance(left, right, { keepPinned: true }))
  return matches[0]?.memory || null
}

export function findMemoryWithPredicate(db, { userId, agentId = null, type = null, signal = null, maxScanned }, matches) {
  if (!userId) return null
  if (signal?.aborted) throw memorySearchError('MEMORY_MATCH_ABORTED')
  const limit = boundedMemoryInteger(maxScanned, 4000, 20_000)
  const params = [userId]
  let sql = 'SELECT rowid AS memory_order,* FROM memories WHERE user_id = ?'
  if (agentId) { sql += ' AND agent_id = ?'; params.push(agentId) }
  else sql += ' AND agent_id IS NULL'
  if (type) { sql += ' AND type = ?'; params.push(type) }
  const statement = db.prepare(`${sql} AND rowid < ? ORDER BY rowid DESC LIMIT ?`)
  let cursor = Number.MAX_SAFE_INTEGER
  let scanned = 0
  return db.transaction(() => {
    while (scanned < limit) {
      if (signal?.aborted) throw memorySearchError('MEMORY_MATCH_ABORTED')
      const rows = statement.all(...params, cursor, Math.min(200, limit - scanned))
      for (const row of rows) {
        if (signal?.aborted) throw memorySearchError('MEMORY_MATCH_ABORTED')
        scanned += 1
        cursor = row.memory_order
        const memory = row2memory(row)
        if (matches(memory)) return memory
      }
      if (!rows.length) return null
    }
    if (statement.all(...params, cursor, 1).length) {
      throw memorySearchError('MEMORY_MATCH_SCAN_INCOMPLETE', { scanned, coverage: 'partial' })
    }
    return null
  })()
}
