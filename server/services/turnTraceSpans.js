/**
 * Read-only span projection over the persisted Turn event stream.
 *
 * The Turn event vocabulary carries stable correlation ids (`turnId`,
 * `toolCallId`, `approvalId`, `iteration`) but no explicit span envelope. This
 * module derives deterministic OTel-shaped spans from those ids so a trace can
 * be exported or rendered as a parent/child tree without changing the persisted
 * protocol. It never mutates events.
 */
import { createHash } from 'node:crypto'

export const TRACE_SPAN_SCHEMA_VERSION = 1

function digest(value, length) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, length)
}

/** OTel trace id: 16 bytes / 32 hex chars, deterministic per Turn. */
export function traceIdForTurn(turnId) {
  return digest(`gugo:trace:${String(turnId || '')}`, 32)
}

/** OTel span id: 8 bytes / 16 hex chars. */
export function spanIdFor(key) {
  return digest(`gugo:span:${String(key || '')}`, 16)
}

function payloadOf(event) {
  return event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {}
}

function finiteNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function usageAttributes(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return {}
  const out = {}
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cacheHitTokens', 'cacheMissTokens']) {
    if (typeof usage[key] !== 'number') continue
    const value = finiteNumber(usage[key])
    if (value !== null) out[key] = value
  }
  return out
}

function toolSpanKey(payload, event) {
  return String(payload.toolCallId || '').trim()
    || `${String(payload.name || payload.toolName || 'tool')}:${event.sequence}`
}

function createTraceContext({ traceId, rootSpanId }) {
  return {
    traceId,
    rootSpanId,
    spans: [],
    models: new Map(),
    tools: new Map(),
    approvals: new Map(),
    rootStatus: 'UNSET',
    rootMessage: '',
    firstAt: null,
    lastAt: null,
  }
}

function openSpan(ctx, { key, mapKey, map, name, kind = 'internal', at, attributes = {} }) {
  const record = {
    traceId: ctx.traceId,
    spanId: spanIdFor(key),
    parentSpanId: ctx.rootSpanId,
    name,
    kind,
    startTimeMs: at,
    endTimeMs: null,
    status: { code: 'UNSET', message: '' },
    attributes,
  }
  ctx.spans.push(record)
  if (map) map.set(mapKey ?? key, record)
  return record
}

function closeSpan(record, at, code, message = '') {
  if (record.endTimeMs === null) record.endTimeMs = at
  if (code && code !== 'UNSET') record.status = { code, message }
}

function handleModelPhase(ctx, payload, event, at) {
  const iteration = Number(payload.iteration)
  const named = Number.isSafeInteger(iteration) && iteration >= 0
  const key = named ? `model:${ctx.turnId}:${iteration}` : `model:${ctx.turnId}:seq:${event.sequence}`
  let record = ctx.models.get(key)
  if (!record) {
    record = openSpan(ctx, {
      key,
      map: ctx.models,
      name: `model.iteration.${named ? iteration : '?'}`,
      at,
      attributes: payload.modelName ? { modelName: String(payload.modelName) } : {},
    })
  }
  const phase = String(payload.phase || '').trim()
  if (phase === 'wire_prepared' && payload.wireDiagnostics) {
    record.attributes.modelRequestId = String(payload.modelRequestId || '')
    record.attributes.physicalAttempt = payload.physicalAttempt || 1
    record.attributes.wireAvailable = payload.wireDiagnostics.available === true
    for (const field of ['ownerScopeFingerprint', 'endpointFingerprint', 'modelFingerprint', 'configFingerprint', 'bodyFingerprint', 'prefixFingerprint', 'toolsFingerprint']) {
      const value = payload.wireDiagnostics[field]
      if (typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)) record.attributes[`wire.${field}`] = value
    }
  }
  if (phase === 'completed') {
    Object.assign(record.attributes, usageAttributes(payload.usage))
    closeSpan(record, at, 'OK')
  } else if (phase === 'failed') {
    closeSpan(record, at, 'ERROR', String(payload.error || 'model phase failed').slice(0, 500))
  }
}

function handleToolStarted(ctx, payload, event, at) {
  const key = toolSpanKey(payload, event)
  openSpan(ctx, {
    key: `tool:${ctx.turnId}:${key}`,
    mapKey: key,
    map: ctx.tools,
    name: `tool.${String(payload.name || payload.toolName || 'unknown')}`,
    at,
    attributes: payload.toolCallId ? { toolCallId: String(payload.toolCallId) } : {},
  })
}

function handleToolCompleted(ctx, payload, event, at) {
  const record = ctx.tools.get(toolSpanKey(payload, event))
  if (!record) return
  if (payload.error) {
    closeSpan(record, at, 'ERROR', String(payload.error?.code || payload.error?.message || 'tool failed').slice(0, 500))
  } else {
    closeSpan(record, at, 'OK')
  }
  if (payload.artifactId) record.attributes.artifactId = String(payload.artifactId)
  if (Array.isArray(payload.artifacts) && payload.artifacts.length > 0) {
    record.attributes.artifactCount = payload.artifacts.length
  }
}

function handleApprovalRequired(ctx, payload, event, at) {
  const approvalId = String(payload.approvalId || '').trim() || `seq:${event.sequence}`
  openSpan(ctx, {
    key: `approval:${ctx.turnId}:${approvalId}`,
    mapKey: approvalId,
    map: ctx.approvals,
    name: `approval.${String(payload.toolName || 'tool')}`,
    at,
    attributes: payload.approvalId ? { approvalId: String(payload.approvalId) } : {},
  })
}

function handleApprovalResolved(ctx, payload, event, at) {
  const approvalId = String(payload.approvalId || '').trim() || `seq:${event.sequence}`
  const record = ctx.approvals.get(approvalId)
  if (!record) return
  record.attributes.proceed = payload.proceed === true
  closeSpan(record, at, payload.proceed === true ? 'OK' : 'ERROR', payload.proceed === true ? '' : 'denied')
}

function handleTerminal(ctx, type, payload) {
  if (type === 'turn.failed' || type === 'turn.interrupted' || type === 'turn.blocked') {
    ctx.rootStatus = 'ERROR'
    ctx.rootMessage = String(payload.code || payload.reason || 'incomplete').slice(0, 200)
    return
  }
  if (ctx.rootStatus === 'ERROR') return
  if (type === 'turn.completed') ctx.rootStatus = 'OK'
}

const EVENT_HANDLERS = Object.freeze({
  'model.phase': handleModelPhase,
  'tool.started': handleToolStarted,
  'tool.completed': handleToolCompleted,
  'approval.required': handleApprovalRequired,
  'approval.resolved': handleApprovalResolved,
})

function finalizeOpenSpans(ctx) {
  for (const record of ctx.spans) {
    if (record.endTimeMs === null) record.endTimeMs = ctx.lastAt ?? record.startTimeMs
    if (record.status.code === 'UNSET') {
      record.status = { code: 'UNSET', message: 'span did not reach a terminal phase' }
    }
  }
}

function buildRootSpan(ctx, { turnId, sessionId, eventCount }) {
  return {
    traceId: ctx.traceId,
    spanId: ctx.rootSpanId,
    parentSpanId: null,
    name: 'turn',
    kind: 'server',
    startTimeMs: ctx.firstAt ?? 0,
    endTimeMs: ctx.lastAt ?? ctx.firstAt ?? 0,
    status: { code: ctx.rootStatus, message: ctx.rootMessage },
    attributes: {
      ...(sessionId ? { sessionId: String(sessionId) } : {}),
      ...(turnId ? { turnId: String(turnId) } : {}),
      eventCount,
    },
  }
}

/**
 * @param {{events?: object[], turnId?: string, sessionId?: string}} input
 * @returns {{traceId: string, rootSpanId: string, spans: object[]}}
 */
export function buildTurnTraceSpans({ events = [], turnId = '', sessionId = '' } = {}) {
  const list = Array.isArray(events) ? events : []
  const traceId = traceIdForTurn(turnId)
  const rootSpanId = spanIdFor(`turn:${turnId}`)
  const ctx = { ...createTraceContext({ traceId, rootSpanId }), turnId }
  for (const event of list) {
    const at = finiteNumber(event?.createdAt) || 0
    if (ctx.firstAt === null || at < ctx.firstAt) ctx.firstAt = at
    if (ctx.lastAt === null || at > ctx.lastAt) ctx.lastAt = at
    const payload = payloadOf(event)
    const handler = EVENT_HANDLERS[event?.type]
    if (handler) handler(ctx, payload, event, at)
    else handleTerminal(ctx, event?.type, payload)
  }
  finalizeOpenSpans(ctx)
  const root = buildRootSpan(ctx, { turnId, sessionId, eventCount: list.length })
  return { traceId, rootSpanId, spans: [root, ...ctx.spans] }
}

const OTLP_STATUS_CODES = Object.freeze({ UNSET: 0, OK: 1, ERROR: 2 })

function otlpAttributeValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return { intValue: String(Math.trunc(value)) }
  if (typeof value === 'boolean') return { boolValue: value }
  return { stringValue: String(value) }
}

/**
 * OTLP/JSON projection. Spans are ordered parent-first; consumers that require
 * a strict tree can key by `parentSpanId`.
 */
export function toOtlpJson({ traceId, spans = [], serviceName = 'gugo' } = {}) {
  return {
    resourceSpans: [{
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: String(serviceName) } }],
      },
      scopeSpans: [{
        scope: { name: 'gugo.turn-trace', version: String(TRACE_SPAN_SCHEMA_VERSION) },
        spans: spans.map((span) => ({
          traceId: String(span.traceId || traceId || ''),
          spanId: String(span.spanId || ''),
          ...(span.parentSpanId ? { parentSpanId: String(span.parentSpanId) } : {}),
          name: String(span.name || 'span'),
          kind: span.kind === 'server' ? 2 : 1,
          startTimeUnixNano: String(Math.round((Number(span.startTimeMs) || 0) * 1e6)),
          endTimeUnixNano: String(Math.round((Number(span.endTimeMs) || 0) * 1e6)),
          attributes: Object.entries(span.attributes || {})
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => ({ key, value: otlpAttributeValue(value) })),
          status: {
            code: OTLP_STATUS_CODES[span.status?.code] ?? 0,
            ...(span.status?.message ? { message: String(span.status.message) } : {}),
          },
        })),
      }],
    }],
  }
}
