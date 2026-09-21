/**
 * Read-only usage report aggregated from persisted Turn events.
 *
 * The runtime keeps live counters in memory, so restarting a process forgets
 * every token it spent. Model invocations and turn terminals already persist
 * their usage, so this report is *derived* from those events: nothing new is
 * written, no schema changes, and turns recorded before this command existed
 * are included.
 *
 * Two facts come from two event types, deliberately:
 *   · a turn terminal carries the turn's cumulative usage, which survives
 *     context compaction and is therefore the authoritative total;
 *   · a `model.phase` names the model, so only it can break usage down per
 *     model.
 * The two can disagree, and the report says which way instead of presenting a
 * partial figure as complete: compaction can drop phases from an old turn (the
 * breakdown is smaller), while a turn that stopped without persisting cumulative
 * usage contributes phases only (the breakdown is larger).
 */
import { getDb } from '../db.js'
import { mapPersistedTurnEventRow } from './turnEventStore.js'
import { withLocalTurnTraceReader } from './localTurnTraceReader.js'
import { USAGE_REPORT_LIMITS } from '../../shared/usageReportLimits.js'

const USAGE_FIELDS = Object.freeze([
  'promptTokens',
  'completionTokens',
  'cacheHitTokens',
  'cacheMissTokens',
])
const { DEFAULT_EVENTS, MAX_EVENTS, MAX_MODELS, MAX_SESSIONS } = USAGE_REPORT_LIMITS
// Every type that ends a turn, matching the runtime's stop set. A deny, a pause
// or a cancellation still spent tokens, so none of them may be omitted here.
const TERMINAL_TURN_EVENT_TYPES = new Set([
  'turn.completed',
  'turn.failed',
  'turn.blocked',
  'turn.cancelled',
  'turn.paused',
  'turn.interrupted',
])

function emptyTotals() {
  return { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
}

/**
 * The usage-relevant events for one user, newest first.
 *
 * Selects the two shapes that carry billing facts: a per-invocation
 * `model.phase` names the model and its tokens, and a turn terminal carries the
 * turn's cumulative usage. Every terminal is included, not just success and
 * failure — a paused, blocked, interrupted or cancelled turn spent tokens too,
 * and leaving those out made a per-model total exceed the turn total. Every
 * clause is a fixed string with a bound value, so no caller input reaches the
 * SQL text.
 */
function listTurnUsageEvents({ userId, sessionId = '', since = null, limit = DEFAULT_EVENTS } = {}) {
  if (!userId) return []
  const safeLimit = Math.min(MAX_EVENTS, Math.max(1, Math.floor(Number(limit) || DEFAULT_EVENTS)))
  const clauses = [
    'user_id = ?',
    "type IN ('model.phase', 'turn.completed', 'turn.failed', 'turn.blocked', 'turn.cancelled', 'turn.paused', 'turn.interrupted')",
  ]
  const params = [userId]
  if (sessionId) {
    clauses.push('session_id = ?')
    params.push(sessionId)
  }
  const sinceValue = Number(since)
  if (Number.isFinite(sinceValue) && sinceValue > 0) {
    clauses.push('created_at >= ?')
    params.push(Math.floor(sinceValue))
  }
  params.push(safeLimit)
  return getDb().prepare(`SELECT * FROM turn_events
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC, sequence DESC LIMIT ?`).all(...params)
    .map(mapPersistedTurnEventRow)
    .filter(Boolean)
}

function addUsage(target, usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false
  let added = false
  for (const field of USAGE_FIELDS) {
    const value = Number(usage[field])
    if (Number.isFinite(value) && value >= 0) {
      target[field] += value
      if (value > 0) added = true
    }
  }
  return added
}

function cacheHitRatePercent(usage) {
  const hit = Number(usage?.cacheHitTokens) || 0
  const miss = Number(usage?.cacheMissTokens) || 0
  const measured = hit + miss
  if (measured <= 0) return null
  return Math.round((hit / measured) * 10_000) / 100
}

function boundedEntries(map, limit) {
  return [...map.entries()]
    .sort((left, right) => right[1].totalTokens - left[1].totalTokens)
    .slice(0, limit)
    .map(([key, value]) => ({ key, ...value }))
}

/**
 * @returns {{
 *   window: {since: number|null, sessionId: string, truncated: boolean, eventCount: number},
 *   turns: {total: number, completed: number, stopped: number, byType: object},
 *   totals: object, phaseTotals: object, cacheHitRatePercent: number|null,
 *   byModel: Array<object>, bySession: Array<object>,
 *   perModelPhases: number
 * }}
 */
export function summarizeUsageEvents(events = [], { truncated = false } = {}) {
  const totals = emptyTotals()
  const models = new Map()
  const sessions = new Map()
  const turns = { total: 0, completed: 0, stopped: 0, byType: {} }
  const phaseTotals = emptyTotals()
  let perModelPhases = 0

  const sessionEntry = (sessionId) => {
    const key = String(sessionId || '(none)')
    if (!sessions.has(key)) {
      sessions.set(key, { turns: 0, modelPhases: 0, totalTokens: 0, usage: emptyTotals() })
    }
    return sessions.get(key)
  }

  for (const event of Array.isArray(events) ? events : []) {
    const session = sessionEntry(event?.sessionId)
    if (event?.type === 'model.phase') {
      const payload = event.payload || {}
      if (payload.phase !== 'completed') continue
      const name = String(payload.modelName || '(unknown model)')
      if (!models.has(name)) {
        models.set(name, { modelPhases: 0, totalTokens: 0, usage: emptyTotals() })
      }
      const model = models.get(name)
      model.modelPhases += 1
      session.modelPhases += 1
      perModelPhases += 1
      if (addUsage(model.usage, payload.usage)) {
        model.totalTokens = model.usage.promptTokens + model.usage.completionTokens
      }
      addUsage(phaseTotals, payload.usage)
      continue
    }
    if (!TERMINAL_TURN_EVENT_TYPES.has(event?.type)) continue
    turns.total += 1
    session.turns += 1
    const outcome = event.type === 'turn.completed' ? 'completed' : 'stopped'
    turns[outcome] += 1
    turns.byType[event.type] = (turns.byType[event.type] || 0) + 1
    // `turnModelUsage` is the whole turn; a turn terminal that omits it (a
    // failure before any model call) contributes nothing rather than zeroes.
    const payload = event.payload || {}
    const turnUsage = payload.turnModelUsage || payload.usage
    if (addUsage(totals, turnUsage)) {
      session.totalTokens += (Number(turnUsage.promptTokens) || 0) + (Number(turnUsage.completionTokens) || 0)
    }
    addUsage(session.usage, turnUsage)
  }

  for (const entry of models.values()) {
    entry.cacheHitRatePercent = cacheHitRatePercent(entry.usage)
  }
  for (const entry of sessions.values()) {
    entry.cacheHitRatePercent = cacheHitRatePercent(entry.usage)
  }
  return {
    window: {
      since: null,
      sessionId: '',
      truncated,
      eventCount: Array.isArray(events) ? events.length : 0,
    },
    turns,
    totals: { ...totals, totalTokens: totals.promptTokens + totals.completionTokens },
    phaseTotals: {
      ...phaseTotals,
      totalTokens: phaseTotals.promptTokens + phaseTotals.completionTokens,
    },
    cacheHitRatePercent: cacheHitRatePercent(totals),
    byModel: boundedEntries(models, MAX_MODELS),
    bySession: boundedEntries(sessions, MAX_SESSIONS),
    perModelPhases,
  }
}

/**
 * The report for one user, read through whatever database the caller's scope
 * provides. `getDb()` resolves the read-only snapshot inside
 * `readLocalUsageReport` and the live runtime database inside the HTTP route, so
 * both surfaces share one aggregation instead of two implementations.
 */
export function readUsageReport({
  userId,
  sessionId = '',
  since = null,
  limit = DEFAULT_EVENTS,
} = {}) {
  const events = listTurnUsageEvents({ userId, sessionId, since, limit })
  const report = summarizeUsageEvents(events, { truncated: events.length >= limit })
  report.window.since = Number.isFinite(Number(since)) && Number(since) > 0 ? Math.floor(Number(since)) : null
  report.window.sessionId = String(sessionId || '')
  return report
}

/** Read the report from the local runtime without initializing or migrating it. */
export async function readLocalUsageReport({
  cwd = process.cwd(),
  env = process.env,
  sessionId = '',
  since = null,
  limit = DEFAULT_EVENTS,
} = {}) {
  return withLocalTurnTraceReader({ cwd, env }, async ({ userId }) => (
    readUsageReport({ userId, sessionId, since, limit })
  ))
}

export { USAGE_REPORT_LIMITS }
