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
 *     context compaction; use only the latest recorded cumulative snapshot per Turn;
 *   · a `model.phase` names the model, so only it can break usage down per
 *     model and attribute completed responses to a date window.
 * Date windows never assign a whole cross-window Turn to the completion date.
 * The two can disagree, and the report says which way instead of presenting a
 * partial figure as complete: compaction can drop phases from an old turn (the
 * breakdown is smaller), while a turn that stopped without persisting cumulative
 * usage contributes phases only (the breakdown is larger).
 */
import { getDb } from '../db.js'
import { mapPersistedTurnEventRow } from './turnEventStore.js'
import { withLocalTurnTraceReader } from './localTurnTraceReader.js'
import { USAGE_REPORT_LIMITS } from '../../shared/usageReportLimits.js'
import { computeCacheWaste, createRateResolver } from '../../shared/modelCacheStats.js'
import { normalizeOptionalUsageNumber } from '../../shared/modelUsage.js'
import { createUsageCoverage, observeUsageCoverage, summarizeUsageCoverage } from '../../shared/modelUsageCoverage.js'
import { latestUsageBoundaries, physicalUsageKey, usageModelIdentity, USAGE_TOTAL_FIELDS as USAGE_FIELDS } from './usageLedger.js'

const { DEFAULT_EVENTS, MAX_EVENTS, MAX_MODELS, MAX_SESSIONS } = USAGE_REPORT_LIMITS

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
    const value = normalizeOptionalUsageNumber(usage[field])
    if (value !== null) {
      target[field] = (target[field] || 0) + value
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
export function summarizeUsageEvents(events = [], { truncated = false, env = process.env, since = null } = {}) {
  const totals = emptyTotals()
  const models = new Map()
  const sessions = new Map()
  const turns = { total: 0, completed: 0, stopped: 0, byType: {} }
  const phaseTotals = emptyTotals()
  const coverage = createUsageCoverage()
  let perModelPhases = 0
  const boundedWindow = Number(since) > 0
  const seenRequests = new Set()
  const orderedEvents = (Array.isArray(events) ? events : []).filter(event => !boundedWindow || Number(event?.createdAt) >= Number(since))
  // Per-request records, in order, grouped by the conversation they belong to.
  // Cache continuity is per conversation — the same prefix in another session is
  // a different prefix — so waste is measured within a session, never across.
  const phasesBySession = new Map()

  const sessionEntry = (sessionId) => {
    const key = String(sessionId || '(none)')
    if (!sessions.has(key)) {
      sessions.set(key, { turns: 0, modelPhases: 0, totalTokens: 0, usage: emptyTotals(), cacheCoverage: createUsageCoverage() })
    }
    return sessions.get(key)
  }

  for (const event of orderedEvents) {
    const session = sessionEntry(event?.sessionId)
    if (event?.type === 'model.phase') {
      const payload = event.payload || {}
      if (payload.phase !== 'completed') continue
      const requestKey = physicalUsageKey(event)
      if (requestKey && seenRequests.has(requestKey)) continue
      if (requestKey) seenRequests.add(requestKey)
      const identity = usageModelIdentity(payload)
      const name = identity.key
      if (!models.has(name)) {
        models.set(name, { modelName: identity.modelName, providerId: identity.providerId,
          modelPhases: 0, totalTokens: 0, usage: emptyTotals(), cacheCoverage: createUsageCoverage() })
      }
      const model = models.get(name)
      model.modelPhases += 1
      session.modelPhases += 1
      perModelPhases += 1
      for (const target of [coverage, model.cacheCoverage, session.cacheCoverage]) observeUsageCoverage(target, payload.usage)
      if (addUsage(model.usage, payload.usage)) {
        model.totalTokens = model.usage.promptTokens + model.usage.completionTokens
      }
      addUsage(phaseTotals, payload.usage)
      // Events arrive newest first; the scan needs them the way they happened.
      const continuityKey = JSON.stringify([event.userId ?? null, event.sessionId, name])
      if (!phasesBySession.has(continuityKey)) phasesBySession.set(continuityKey, [])
      phasesBySession.get(continuityKey).push({
        usage: payload.usage,
        modelName: payload.modelName,
        providerId: identity.providerId,
        timestamp: Number(event.createdAt) || 0,
      })
      continue
    }
  }
  for (const { event, usage: turnUsage } of latestUsageBoundaries(orderedEvents)) {
    const session = sessionEntry(event.sessionId)
    turns.total += 1
    session.turns += 1
    const outcome = event.type === 'turn.completed' ? 'completed' : 'stopped'
    turns[outcome] += 1
    turns.byType[event.type] = (turns.byType[event.type] || 0) + 1
    // `turnModelUsage` is the whole turn; a turn terminal that omits it (a
    // failure before any model call) contributes nothing rather than zeroes.
    if (addUsage(totals, turnUsage)) {
      session.totalTokens += (Number(turnUsage.promptTokens) || 0) + (Number(turnUsage.completionTokens) || 0)
    }
    addUsage(session.usage, turnUsage)
  }

  const turnCumulativeTotals = { ...totals, totalTokens: totals.promptTokens + totals.completionTokens }
  if (boundedWindow) {
    Object.assign(totals, phaseTotals)
    for (const session of sessions.values()) { session.usage = emptyTotals(); session.totalTokens = 0 }
    for (const event of orderedEvents) {
      if (event?.type !== 'model.phase' || event.payload?.phase !== 'completed') continue
      const key = physicalUsageKey(event)
      if (key && !seenRequests.delete(key)) continue
      const session = sessionEntry(event.sessionId)
      addUsage(session.usage, event.payload.usage)
      session.totalTokens = session.usage.promptTokens + session.usage.completionTokens
    }
  }
  for (const entry of [...models.values(), ...sessions.values()]) {
    entry.cacheHitRatePercent = cacheHitRatePercent(entry.usage)
    entry.cacheCoverage = summarizeUsageCoverage(entry.cacheCoverage)
  }

  // A hit rate says a miss happened; this says how much it cost and what likely
  // caused it. Summed per session because that is the unit the cache follows.
  const cacheWaste = { missedTokens: 0, missedCost: 0, missCount: 0 }
  const resolvePrice = createRateResolver(env)
  for (const records of phasesBySession.values()) {
    const waste = computeCacheWaste(records.sort((a, b) => a.timestamp - b.timestamp), { resolvePrice })
    cacheWaste.missedTokens += waste.missedTokens
    cacheWaste.missedCost = cacheWaste.missedCost === null || waste.missedCost === null ? null : cacheWaste.missedCost + waste.missedCost
    cacheWaste.missCount += waste.missCount
  }
  return {
    window: {
      since: null,
      sessionId: '',
      truncated,
      eventCount: Array.isArray(events) ? events.length : 0,
    },
    turns,
    accounting: { basis: boundedWindow ? 'responses_in_window' : 'latest_turn_snapshots', coverage: 'recorded_only' },
    turnCumulativeTotals,
    totals: { ...totals, totalTokens: totals.promptTokens + totals.completionTokens },
    phaseTotals: {
      ...phaseTotals,
      totalTokens: phaseTotals.promptTokens + phaseTotals.completionTokens,
    },
    cacheHitRatePercent: cacheHitRatePercent(totals),
    cacheWaste,
    cacheCoverage: summarizeUsageCoverage(coverage),
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
  const report = summarizeUsageEvents(events, { truncated: events.length >= limit, since })
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
