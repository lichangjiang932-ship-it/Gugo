import { getDb } from '../db.js'
import { createHash, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { findSessionLiteralMatch, normalizedSessionSearchText, sessionSearchExcerpt } from '../../shared/sessionSearchText.js'

function clampLimit(limit) {
  const value = Number(limit)
  if (!Number.isFinite(value) || value <= 0) return 20
  return Math.min(100, Math.floor(value))
}

function clampOffset(offset) {
  const value = Number(offset)
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
}

export function buildFtsQuery(query) {
  const raw = String(query || '').trim()
  if (!raw) return ''
  const tokens = raw
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}_-]+|[^\p{L}\p{N}_-]+$/gu, ''))
    .filter(Boolean)
    .slice(0, 12)
  if (!tokens.length) return ''
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ')
}

function mapSearchRow(row) {
  return {
    messageId: row.message_id,
    sessionId: row.session_id,
    sessionTitle: row.session_title || 'Untitled',
    role: row.role,
    snippet: row.snippet || '',
    createdAt: row.created_at,
    rank: row.rank,
  }
}

function searchScope({ userId, query, sessionId = null } = {}) {
  if (!userId) return null
  const ftsQuery = buildFtsQuery(query)
  if (!ftsQuery) return null
  const params = {
    userId,
    query: ftsQuery,
    ...(sessionId ? { sessionId } : {}),
  }
  const sessionClause = sessionId ? 'AND m.session_id = @sessionId' : ''
  return { params, from: `FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    JOIN sessions s ON s.token = m.session_id AND s.user_id = m.user_id
    WHERE messages_fts MATCH @query AND m.user_id = @userId ${sessionClause}` }
}

function searchRows(db, scope, limit, offset, upper = null) {
  return db.prepare(`
    SELECT
      m.id AS message_id,
      m.session_id AS session_id,
      COALESCE(s.title, m.session_title, '') AS session_title,
      m.role AS role,
      m.model_context_json,
      snippet(messages_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet,
      m.created_at AS created_at,
      bm25(messages_fts) AS rank
    ${scope.from} ${upper == null ? '' : 'AND m.rowid<=@upper'}
    ORDER BY rank, m.created_at DESC, m.id ASC
    LIMIT @limit OFFSET @offset
  `).all({ ...scope.params, limit, offset, ...(upper == null ? {} : { upper }) })
}

export function searchMessages(input = {}) {
  const scope = searchScope(input)
  return scope ? searchRows(getDb(), scope, clampLimit(input.limit), clampOffset(input.offset)).map(mapSearchRow) : []
}

export const SESSION_SEARCH_LIMITS = Object.freeze({ maxScanned: 20_000, maxTextChars: 8_000_000, maxDurationMs: 100 })
const databaseIds = new WeakMap()
const CURSOR_FIELDS = ['v', 'binding', 'dbId', 'dataVersion', 'changes', 'upper', 'sourceCount',
  'beforeTime', 'beforeRow', 'ftsOffset', 'extraBefore', 'remainingOffset', 'knownTotal']

function searchError(code) {
  return Object.assign(new Error(code === 'SESSION_SEARCH_QUERY_TOO_LONG' ? 'Search query must contain at most 4096 characters.'
    : code === 'SESSION_SEARCH_CURSOR_SCOPE_MISMATCH'
    ? 'This search cursor belongs to a different owner, session or query.'
    : 'Invalid search cursor; restart the search.'), { code, retryable: false, statusCode: 400 })
}

function cursorBinding(input, query) {
  return createHash('sha256').update(JSON.stringify([String(input.userId), input.sessionId || null, query])).digest('hex')
}

function decodeSearchCursor(value, binding) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/u.test(value)) throw searchError('SESSION_SEARCH_CURSOR_INVALID')
  let cursor
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { throw searchError('SESSION_SEARCH_CURSOR_INVALID') }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || cursor.v !== 1
    || Object.keys(cursor).length !== CURSOR_FIELDS.length || CURSOR_FIELDS.some((key) => !Object.hasOwn(cursor, key))
    || typeof cursor.binding !== 'string' || typeof cursor.dbId !== 'string'
    || !/^[a-f0-9]{64}$/u.test(cursor.binding) || !/^[a-f0-9]{24}$/u.test(cursor.dbId)
    || CURSOR_FIELDS.filter((key) => !['binding', 'dbId'].includes(key)).some((key) => (
      !Number.isSafeInteger(cursor[key]) || (key !== 'beforeTime' && cursor[key] < 0)
    )) || cursor.ftsOffset + cursor.extraBefore > cursor.sourceCount
    || cursor.knownTotal > cursor.sourceCount || cursor.knownTotal < cursor.ftsOffset + cursor.extraBefore
    || (cursor.beforeRow > cursor.upper && !(cursor.beforeRow === Number.MAX_SAFE_INTEGER
      && cursor.beforeTime === Number.MAX_SAFE_INTEGER && cursor.extraBefore === 0))) {
    throw searchError('SESSION_SEARCH_CURSOR_INVALID')
  }
  if (cursor.binding !== binding) throw searchError('SESSION_SEARCH_CURSOR_SCOPE_MISMATCH')
  return cursor
}

function storageRevision(db) {
  if (!databaseIds.has(db)) databaseIds.set(db, randomBytes(12).toString('hex'))
  return { dbId: databaseIds.get(db), dataVersion: Number(db.pragma('data_version', { simple: true })),
    changes: Number(db.prepare('SELECT total_changes() AS total').get().total) }
}

function canonicalScope(input) {
  const params = { userId: input.userId, ...(input.sessionId ? { sessionId: input.sessionId } : {}) }
  return { params, from: `FROM messages m JOIN sessions s ON s.token=m.session_id AND s.user_id=m.user_id
    WHERE m.user_id=@userId ${input.sessionId ? 'AND m.session_id=@sessionId' : ''}` }
}

function scanLimits(requested = {}) {
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) requested = {}
  const positive = (value, fallback, maximum) => Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? Math.min(maximum, Number(value)) : fallback
  return { maxScanned: positive(requested.maxScanned, SESSION_SEARCH_LIMITS.maxScanned, 100_000),
    maxTextChars: positive(requested.maxTextChars, SESSION_SEARCH_LIMITS.maxTextChars, 16_000_000),
    maxDurationMs: positive(requested.maxDurationMs, SESSION_SEARCH_LIMITS.maxDurationMs, 1000) }
}

function scanStopCode(scan, limits, signal, now, deadline) {
  if (signal?.aborted) return 'SESSION_SEARCH_ABORTED'
  if (scan.keys.length >= limits.maxScanned) return 'SESSION_SEARCH_SCAN_LIMIT'
  if (scan.textChars >= limits.maxTextChars) return 'SESSION_SEARCH_TEXT_LIMIT'
  if (now() >= deadline) return 'SESSION_SEARCH_TIME_LIMIT'
  return null
}

/** Only a bounded canonical range is read; no FTS ID list grows with the complete archive. */
function scanLiteralRange(db, scope, state, query, limits, { signal, now }) {
  const scan = { keys: [], literal: new Map(), textChars: 0, code: null, complete: false }
  const deadline = now() + limits.maxDurationMs
  const readPage = db.prepare(`SELECT m.rowid AS row_id,m.created_at,
    length(m.content) AS content_chars,length(COALESCE(s.title,m.session_title,'')) AS title_chars
    ${scope.from} AND m.rowid<=@upper AND (m.created_at,m.rowid)<(@beforeTime,@beforeRow)
    ORDER BY m.created_at DESC,m.rowid DESC LIMIT @limit`)
  const readText = db.prepare(`SELECT substr(m.content,1,@maxChars) AS content,
    substr(COALESCE(s.title,m.session_title,''),1,@maxChars) AS session_title
    ${scope.from} AND m.rowid=@rowId`)
  let beforeTime = state.beforeTime
  let beforeRow = state.beforeRow
  while (!scan.complete && !scan.code) {
    scan.code = scanStopCode(scan, limits, signal, now, deadline)
    if (scan.code) break
    const pageSize = Math.min(128, limits.maxScanned - scan.keys.length)
    const rows = readPage.all({ ...scope.params, upper: state.upper, beforeTime, beforeRow, limit: pageSize + 1 })
    let consumed = 0
    for (const row of rows.slice(0, pageSize)) {
      scan.code = scanStopCode(scan, limits, signal, now, deadline)
      if (scan.code) break
      const remaining = limits.maxTextChars - scan.textChars
      if (row.content_chars + row.title_chars > remaining) { scan.code = 'SESSION_SEARCH_TEXT_LIMIT'; break }
      const text = readText.get({ ...scope.params, rowId: row.row_id, maxChars: remaining + 1 })
      const size = text.content.length + text.session_title.length
      if (size > remaining) { scan.code = 'SESSION_SEARCH_TEXT_LIMIT'; break }
      const bodyMatch = findSessionLiteralMatch(text.content, query)
      const titleMatch = bodyMatch ? null : findSessionLiteralMatch(text.session_title, query)
      if (bodyMatch) scan.literal.set(row.row_id, sessionSearchExcerpt(text.content, bodyMatch.index, bodyMatch.length))
      else if (titleMatch) scan.literal.set(row.row_id, sessionSearchExcerpt(text.session_title, titleMatch.index, titleMatch.length))
      scan.keys.push(row)
      scan.textChars += size
      consumed += 1
      beforeTime = row.created_at
      beforeRow = row.row_id
    }
    scan.complete = consumed === rows.length
  }
  return scan
}

function ftsRange(db, input, query, state, scan) {
  // FTS tokenization discards '_'/'%' and other punctuation. For such queries
  // only literal matching is truthful; never broaden them into token matches.
  const scope = /^[\p{L}\p{N}\p{M}\s]+$/u.test(query) && query.split(/\s+/u).length <= 12
    ? searchScope({ ...input, query }) : null
  if (!scope) return { ids: new Set(), total: 0, scope: null }
  const total = db.prepare(`SELECT COUNT(*) AS total ${scope.from} AND m.rowid<=@upper`)
    .get({ ...scope.params, upper: state.upper }).total
  const last = scan.keys.at(-1)
  if (!last) return { ids: new Set(), total, scope }
  const rows = db.prepare(`SELECT m.rowid AS row_id ${scope.from} AND m.rowid<=@upper
    AND (m.created_at,m.rowid)<(@beforeTime,@beforeRow)
    AND (m.created_at,m.rowid)>=(@lastTime,@lastRow) LIMIT @limit`).all({
    ...scope.params, upper: state.upper, beforeTime: state.beforeTime, beforeRow: state.beforeRow,
    lastTime: last.created_at, lastRow: last.row_id, limit: scan.keys.length,
  })
  return { ids: new Set(rows.map((row) => row.row_id)), total, scope }
}

function searchMessageView(row, excerpt = null) {
  let turnId = null
  try {
    const context = JSON.parse(row.model_context_json || 'null')
    if (typeof context?.turnId === 'string') turnId = context.turnId
  } catch { /* Legacy rows may have no usable Turn linkage. */ }
  return { ...mapSearchRow(row), turnId, excerpt: excerpt ?? String(row.snippet || '').replace(/<\/?mark>/gu, '') }
}

function pageRows(db, scope, keys, scan) {
  if (!keys.length) return []
  const ids = JSON.stringify(keys.map((row) => row.row_id))
  const rows = db.prepare(`SELECT m.rowid AS row_id,m.id AS message_id,m.session_id,
    COALESCE(s.title,m.session_title,'') AS session_title,m.role,m.created_at,
    substr(m.content,1,160) AS snippet,substr(m.model_context_json,1,8192) AS model_context_json
    ${scope.from} AND m.rowid IN (SELECT value FROM json_each(@ids))`).all({ ...scope.params, ids })
  const byId = new Map(rows.map((row) => [row.row_id, row]))
  return keys.map(({ row_id: id }) => {
    const row = byId.get(id)
    const excerpt = scan.literal.get(id) || row.snippet
    return searchMessageView({ ...row, snippet: excerpt, rank: null }, excerpt)
  })
}

function scannedPage(db, input, scope, state, query, empty, dependencies) {
  const limits = scanLimits(input.scanLimits)
  const scan = scanLiteralRange(db, scope, state, query, limits, {
    signal: input.signal, now: dependencies.now || (() => performance.now()),
  })
  if (scan.code === 'SESSION_SEARCH_ABORTED') return { ...empty, totalIsExact: false, truncated: true,
    diagnostics: { coverage: 'partial', code: scan.code, scanned: scan.keys.length, textChars: scan.textChars, limits } }
  const fts = ftsRange(db, input, query, state, scan)
  const nativeSkip = Math.min(empty.offset, Math.max(0, fts.total - state.ftsOffset))
  const nativeOffset = state.ftsOffset + nativeSkip
  // Native indexed hits keep their existing ranking and remain reachable even
  // when the normalized fallback has only covered a small part of the archive.
  const nativeRows = fts.scope ? searchRows(db, fts.scope, empty.limit, nativeOffset, state.upper) : []
  const ftsOffset = nativeOffset + nativeRows.length
  const candidates = scan.keys.filter((row) => scan.literal.has(row.row_id) && !fts.ids.has(row.row_id))
  const skip = state.remainingOffset + empty.offset - nativeSkip
  if (!Number.isSafeInteger(skip)) throw searchError('SESSION_SEARCH_CURSOR_INVALID')
  const selected = candidates.slice(skip, skip + empty.limit - nativeRows.length)
  const consumed = Math.min(candidates.length, skip + selected.length)
  const total = scan.complete ? fts.total + state.extraBefore + candidates.length
    : Math.max(state.knownTotal, fts.total + state.extraBefore + candidates.length)
  const moreMatches = consumed < candidates.length
  const firstPending = moreMatches ? scan.keys.findIndex((row) => row.row_id === candidates[consumed].row_id) : -1
  const boundary = moreMatches ? scan.keys[firstPending - 1] || { created_at: state.beforeTime, row_id: state.beforeRow }
    : scan.keys.at(-1) || { created_at: state.beforeTime, row_id: state.beforeRow }
  const progressed = ftsOffset !== state.ftsOffset || boundary.row_id !== state.beforeRow || boundary.created_at !== state.beforeTime
  const nextCursor = progressed && (moreMatches || ftsOffset < fts.total || !scan.complete) ? Buffer.from(JSON.stringify({
    ...state, beforeTime: boundary.created_at, beforeRow: boundary.row_id,
    ftsOffset, extraBefore: state.extraBefore + consumed,
    remainingOffset: Math.max(0, skip - candidates.length), knownTotal: total,
  })).toString('base64url') : null
  const nextMatchOffset = ftsOffset + state.extraBefore + consumed
  const nextOffset = (selected.length || nativeRows.length) && nextMatchOffset < total ? nextMatchOffset : null
  return { ...empty, matches: [...nativeRows.map((row) => searchMessageView(row)), ...pageRows(db, scope, selected, scan)], total, totalIsExact: scan.complete,
    nextOffset, nextCursor, truncated: !scan.complete,
    diagnostics: { mode: 'fts_and_normalized_literal', coverage: scan.complete ? 'complete' : 'partial',
      code: scan.code, scanned: scan.keys.length, textChars: scan.textChars, limits,
      snapshot: 'connection_revision_guard_not_a_persistent_snapshot' } }
}

/** Indexed results retain FTS order, followed by newest-first normalized literal additions. */
export function searchMessagesPage(input = {}, dependencies = {}) {
  const limit = clampLimit(input.limit)
  const offset = clampOffset(input.offset)
  const empty = { matches: [], total: 0, totalIsExact: true, limit, offset, nextOffset: null, nextCursor: null, truncated: false }
  const rawQuery = String(input.query ?? '')
  if (rawQuery.length > 4096) throw searchError('SESSION_SEARCH_QUERY_TOO_LONG')
  const query = normalizedSessionSearchText(rawQuery).trim()
  if (query.length > 4096) throw searchError('SESSION_SEARCH_QUERY_TOO_LONG')
  if (!input.userId || !query) return empty
  const binding = cursorBinding(input, query)
  const cursor = decodeSearchCursor(input.cursor, binding)
  if (input.signal?.aborted) return { ...empty, totalIsExact: false, truncated: true,
    diagnostics: { coverage: 'partial', code: 'SESSION_SEARCH_ABORTED', scanned: 0 } }
  const db = getDb()
  const scope = canonicalScope(input)
  return db.transaction(() => {
    const revision = storageRevision(db)
    // This is intentionally conservative: writes on this connection, commits
    // from another connection, or a host restart invalidate the cursor. It is
    // not a long-lived SQLite snapshot and grants no access outside the scope.
    if (cursor && Object.keys(revision).some((key) => cursor[key] !== revision[key])) {
      return { ...empty, totalIsExact: false, truncated: true, restartRequired: true,
        diagnostics: { coverage: 'invalidated', code: 'SESSION_SEARCH_HISTORY_CHANGED', scanned: 0 } }
    }
    const head = cursor ? null : db.prepare(`SELECT COALESCE(MAX(m.rowid),0) AS upper,COUNT(*) AS count ${scope.from}`).get(scope.params)
    const state = cursor || { v: 1, binding, ...revision, upper: head.upper, sourceCount: head.count,
      beforeTime: Number.MAX_SAFE_INTEGER, beforeRow: Number.MAX_SAFE_INTEGER,
      ftsOffset: 0, extraBefore: 0, remainingOffset: 0, knownTotal: 0 }
    return scannedPage(db, input, scope, state, query, empty, dependencies)
  })()
}
