/**
 * In-session search: `/search <query>` over the current session's turn history.
 *
 * The runtime searches canonical messages using the same FTS service as the web UI.
 * Pure legacy event-folding helpers remain available for transcript consumers; they
 * are not used as an incomplete, retention-limited history index.
 */
import { CliUsageError } from './errors.js'
import { findSessionLiteralMatch, sessionSearchExcerpt } from '../../shared/sessionSearchText.js'

/** Characters of context kept on each side of a match in the rendered excerpt. */
export const SEARCH_EXCERPT_PADDING = 48

/** Default cap on returned matches; a chatty session can match hundreds of times. */
export const SEARCH_DEFAULT_LIMIT = 20

/**
 * Fold raw turn events into one record per turn.
 *
 * Assistant text arrives as deltas, so it is concatenated in event order. Events are
 * sorted by `sequence` when present: the store returns append order, but a caller that
 * filtered or paged the list must not change what the reply says.
 */
export function extractTurnRecords(events = []) {
  const list = Array.isArray(events) ? events : []
  const ordered = [...list].sort((left, right) => {
    const a = Number(left?.sequence ?? 0)
    const b = Number(right?.sequence ?? 0)
    return a - b
  })

  const byTurn = new Map()
  const turnOrder = []
  for (const event of ordered) {
    const turnId = String(event?.turnId ?? '').trim()
    if (!turnId) continue
    const type = String(event?.type ?? '')
    const payload = event?.payload ?? {}
    if (!byTurn.has(turnId)) {
      byTurn.set(turnId, { turnId, user: '', assistant: '' })
      turnOrder.push(turnId)
    }
    const record = byTurn.get(turnId)
    if (type === 'turn.started' && typeof payload.content === 'string') {
      record.user = payload.content
    } else if (type === 'assistant.delta' && typeof payload.text === 'string') {
      record.assistant += payload.text
    }
  }
  return turnOrder.map((turnId) => byTurn.get(turnId))
}

/** A window of text around a match, with an ellipsis only where text was actually cut. */
export function excerptAround(text, index, length, padding = SEARCH_EXCERPT_PADDING) {
  return sessionSearchExcerpt(text, index, length, padding)
}

/**
 * Find every place a query appears, in turn order, user text before assistant text.
 *
 * Case-insensitive and Unicode-safe (NFKC + lower case), so a query typed with full-width
 * characters or different case still matches. Returns at most `limit` matches.
 */
export function matchTurnRecords(records = [], query, { limit = SEARCH_DEFAULT_LIMIT } = {}) {
  const needle = String(query ?? '').normalize('NFKC').trim().toLowerCase()
  if (!needle) return []
  const list = Array.isArray(records) ? records : []
  const matches = []
  for (const record of list) {
    for (const role of ['user', 'assistant']) {
      const text = String(record?.[role] ?? '')
      if (!text) continue
      const match = findSessionLiteralMatch(text, needle)
      if (!match) continue
      matches.push({
        turnId: record.turnId,
        role,
        index: match.index,
        excerpt: excerptAround(text, match.index, match.length),
      })
      if (matches.length >= limit) return matches
    }
  }
  return matches
}

/** Render matches for the terminal. `styler` is optional; without it the text is plain. */
export function formatSearchMatches(matches = [], { query = '', styler } = {}) {
  const page = Array.isArray(matches) ? null : matches
  const list = Array.isArray(matches) ? matches : Array.isArray(page?.matches) ? page.matches : []
  const safe = (value) => String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
  const paint = styler?.enabled === true ? styler : null
  const incomplete = page?.truncated === true || page?.totalIsExact === false
  const lines = []
  if (list.length === 0) {
    const message = page?.diagnostics?.code === 'SESSION_SEARCH_ABORTED' ? 'Search cancelled; no complete result is available.'
      : page?.restartRequired ? 'Stored history changed; restart this search to avoid mixing pages.'
      : incomplete ? 'Search is incomplete; continue the bounded scan or retry.'
      : page?.total > 0 ? `No more matches on this page (${page.total} total).`
        : `No match for "${safe(query)}" in this session.`
    lines.push(paint ? paint.dim(message) : message)
  } else {
    const header = `${list.length} match${list.length === 1 ? '' : 'es'} for "${safe(query)}":`
    lines.push(paint ? paint.bold(header) : header)
  }
  for (const match of list) {
    const label = `${match.role === 'user' ? 'you' : 'agent'} · ${safe(match.turnId || match.messageId).slice(0, 8)}`
    lines.push(`  ${paint ? paint.cyan(label) : label}  ${safe(match.excerpt)}`)
  }
  if (page && !page.restartRequired) lines.push(incomplete
    ? `At least ${page.total} matches found; search incomplete (scanned ${page.diagnostics?.scanned || 0} messages).`
    : `${page.total} total; search complete.`)
  if (page?.nextOffset != null) lines.push(`Next page: /search ${safe(query)} --limit ${page.limit} --offset ${page.nextOffset}`)
  if (page?.nextCursor) lines.push(`Continue: /search ${safe(query)} --limit ${page.limit} --cursor ${safe(page.nextCursor)}`)
  return lines.join('\n')
}

/** Parse a query with bounded trailing --limit/--offset or an opaque --cursor continuation. */
export function parseSearchArgs(args = '') {
  let text = String(args ?? '').trim()
  const result = { query: '', limit: SEARCH_DEFAULT_LIMIT }
  const seen = new Set()
  let match
  while ((match = /(?:^|\s)--(limit|offset|cursor)\s+(\S+)\s*$/u.exec(text))) {
    if (match[1] === 'cursor') {
      if (seen.has('cursor') || !/^[A-Za-z0-9_-]{1,2048}$/u.test(match[2])) {
        throw new CliUsageError('CLI_SEARCH_PAGINATION_INVALID', 'search cursor must be one bounded opaque value')
      }
      seen.add('cursor')
      result.cursor = match[2]
      text = text.slice(0, match.index).trim()
      continue
    }
    const value = Number(match[2])
    if (seen.has(match[1]) || !/^\d+$/u.test(match[2]) || !Number.isSafeInteger(value)) {
      throw new CliUsageError('CLI_SEARCH_PAGINATION_INVALID', 'search pagination must use unique non-negative safe integers')
    }
    seen.add(match[1])
    result[match[1]] = match[1] === 'limit' ? (value > 0 ? Math.min(value, 200) : SEARCH_DEFAULT_LIMIT) : value
    text = text.slice(0, match.index).trim()
  }
  result.query = text
  return result
}

/**
 * Search canonical session messages. The store is imported lazily so a
 * session that never searches pays nothing, and so this module stays usable in tests
 * without booting the runtime database.
 */
export async function searchTurnEvents({ userId, sessionId, query, limit, offset = 0, cursor = null, signal = null } = {}) {
  const { searchMessagesPage } = await import('../../server/services/sessionSearchService.js')
  return searchMessagesPage({ userId, sessionId, query, limit, offset, cursor, signal })
}
