/**
 * Read-only local Turn trace.
 *
 * Reconstructs one turn's timeline and aggregate counters from the persisted
 * Turn events, so CLI/service/model/tool activity can be inspected with one
 * command instead of hand-joining sessionId/turnId/toolCallId. It uses the
 * existing local identity and a read-only database snapshot. It never runs
 * migrations, creates accounts/sessions, or changes process storage identity.
 */
import { turnEventForClient } from './turnEventStore.js'
import { listTurnEvents, resolveTurnSession } from './turnEventStore.js'
import { buildTurnTraceSpans } from './turnTraceSpans.js'
import { localTraceReadFailure, withLocalTurnTraceReader } from './localTurnTraceReader.js'

const DEFAULT_LIMIT = 2_000
const MAX_LIMIT = 10_000

function boundedLimit(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(parsed, MAX_LIMIT)
}

function usageTotals(usage, totals) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return
  for (const [key, field] of [
    ['promptTokens', 'promptTokens'],
    ['completionTokens', 'completionTokens'],
    ['cacheHitTokens', 'cacheHitTokens'],
    ['cacheMissTokens', 'cacheMissTokens'],
  ]) {
    const value = Number(usage[key])
    if (Number.isFinite(value) && value >= 0) totals[field] += value
  }
}

/** Aggregate facts a human or script wants from a trace. */
export function summarizeTurnTrace(events = []) {
  const totals = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
  const tools = new Map()
  const aggregates = {
    modelPhases: 0,
    modelFailovers: 0,
    toolCalls: 0,
    toolFailures: 0,
    approvalsRequired: 0,
    approvalsDenied: 0,
    checkpoints: 0,
    steeringResumes: 0,
    contextPreparations: 0,
    prefixChanges: 0,
    toolSchemaChanges: 0,
    partialMemoryRecalls: 0,
    wirePreparations: 0,
    wirePrefixChanges: 0,
    wireToolSchemaChanges: 0,
    wireUnavailable: 0,
    cacheUsageReported: false,
    usage: totals,
  }
  for (const event of Array.isArray(events) ? events : []) {
    const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {}
    switch (event?.type) {
      case 'model.phase':
        aggregates.modelPhases += 1
        usageTotals(payload.usage, totals)
        if (payload.contextDiagnostics) {
          aggregates.contextPreparations += 1
          if (payload.contextDiagnostics.stablePrefixChanged === true) aggregates.prefixChanges += 1
          if (payload.contextDiagnostics.toolsChanged === true) aggregates.toolSchemaChanges += 1
          if (payload.contextDiagnostics.memory?.semantic?.truncated === true
            || payload.contextDiagnostics.memory?.lexical?.truncated === true) aggregates.partialMemoryRecalls += 1
        }
        if (payload.wireDiagnostics) {
          aggregates.wirePreparations += 1
          if (!payload.wireDiagnostics.available) aggregates.wireUnavailable += 1
          if (payload.wireDiagnostics.prefixChanged === true) aggregates.wirePrefixChanges += 1
          if (payload.wireDiagnostics.toolsChanged === true) aggregates.wireToolSchemaChanges += 1
        }
        if (['cacheHitTokens', 'cacheMissTokens'].some((key) => {
          const value = payload.usage?.[key]
          return typeof value === 'number' && Number.isFinite(value) && value >= 0
        })) aggregates.cacheUsageReported = true
        break
      case 'model.failover':
        aggregates.modelFailovers += 1
        break
      case 'tool.started':
        aggregates.toolCalls += 1
        break
      case 'tool.completed': {
        const name = String(payload.name || payload.toolName || 'unknown')
        const failed = Boolean(payload.error)
        if (failed) aggregates.toolFailures += 1
        const entry = tools.get(name) || { name, calls: 0, failures: 0 }
        entry.calls += 1
        if (failed) entry.failures += 1
        tools.set(name, entry)
        break
      }
      case 'approval.required':
        aggregates.approvalsRequired += 1
        break
      case 'approval.resolved':
        if (payload.proceed !== true) aggregates.approvalsDenied += 1
        break
      case 'turn.checkpoint':
        aggregates.checkpoints += 1
        break
      case 'turn.resumed':
        aggregates.steeringResumes += 1
        break
      default:
        break
    }
  }
  aggregates.tools = [...tools.values()].sort((left, right) => left.name.localeCompare(right.name))
  return aggregates
}

function unavailableTrace(turnId, blocking) {
  return { ok: false, sessionId: null, turnId, events: [], aggregates: summarizeTurnTrace([]), blocking }
}

function boundedTraceEvents(scope, limit) {
  const events = []
  let after = -1
  // The canonical store caps a page at 2000. Request one additional event to
  // prove coverage rather than silently treating one page as the whole trace.
  while (events.length <= limit) {
    const count = Math.min(2_000, limit + 1 - events.length)
    const page = listTurnEvents({ ...scope, after, limit: count })
    events.push(...page)
    if (page.length < count) break
    after = page.at(-1).sequence
  }
  return { events: events.slice(0, limit).map(turnEventForClient), truncated: events.length > limit }
}

function reconstructTrace({ userId, databaseReadMode }, { turnId, sessionId, limit }) {
  let resolvedSessionId = sessionId
  if (!resolvedSessionId) {
    const resolved = resolveTurnSession({ userId, turnId })
    if (resolved?.status === 'found') resolvedSessionId = String(resolved.sessionId || '')
  }
  const missing = { code: 'TURN_NOT_FOUND', action: 'pass_session_id' }
  if (!resolvedSessionId) return unavailableTrace(turnId, missing)
  const { events, truncated } = boundedTraceEvents({ userId, sessionId: resolvedSessionId, turnId }, limit)
  if (!events.length) return unavailableTrace(turnId, missing)
  const { traceId, spans } = buildTurnTraceSpans({ events, turnId, sessionId: resolvedSessionId })
  const coverage = truncated ? 'partial' : 'complete'
  const root = spans.find((span) => !span.parentSpanId)
  if (root) root.attributes['gugo.trace.coverage'] = coverage
  return {
    ok: true,
    sessionId: resolvedSessionId,
    turnId,
    traceId,
    events,
    spans,
    coverage,
    truncated,
    databaseReadMode,
    aggregates: summarizeTurnTrace(events),
  }
}

/** Read only existing state; failures are explicit and never fall back to bootstrapping. */
export async function readLocalTurnTrace({ turnId = '', sessionId = '', cwd = process.cwd(), env = process.env,
  limit = DEFAULT_LIMIT } = {}) {
  const normalizedTurnId = String(turnId || '').trim()
  if (!normalizedTurnId) return unavailableTrace('', { code: 'TURN_ID_REQUIRED', action: 'pass_turn_id' })
  try {
    return await withLocalTurnTraceReader({ cwd, env }, (scope) => reconstructTrace(scope, {
      turnId: normalizedTurnId, sessionId: String(sessionId || '').trim(), limit: boundedLimit(limit),
    }))
  } catch (error) { return unavailableTrace(normalizedTurnId, localTraceReadFailure(error)) }
}
