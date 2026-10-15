import { normalizeOptionalUsageNumber } from '../../shared/modelUsage.js'
import { modelRequestSourceSchema } from '../../shared/modelRequestSource.js'

export const USAGE_TOTAL_FIELDS = Object.freeze(['promptTokens', 'completionTokens', 'cacheHitTokens', 'cacheMissTokens', 'cacheCreationTokens', 'uncachedInputTokens'])
export const USAGE_BOUNDARY_TYPES = new Set(['turn.completed', 'turn.failed', 'turn.blocked', 'turn.cancelled', 'turn.paused', 'turn.interrupted'])
const scope = event => [event?.userId ?? null, event?.sessionId ?? null, event?.turnId ?? null]
const identity = value => typeof value === 'string' && value.length > 0

/** Sequence is authoritative within a Turn, including when the wall clock moves. */
export function latestUsageBoundaries(events) {
  const turns = new Map()
  for (const [index, event] of events.entries()) {
    if (!USAGE_BOUNDARY_TYPES.has(event?.type)) continue
    const key = identity(event.turnId) ? JSON.stringify(scope(event)) : `legacy:${index}`
    const current = turns.get(key)
    const newer = !current || (Number(event.sequence) || 0) > (Number(current.event.sequence) || 0)
      || (event.sequence === current.event.sequence && Number(event.createdAt) > Number(current.event.createdAt))
    const usage = event.payload?.turnModelUsage || event.payload?.usage
    const record = current || { event, usage: null, usageSequence: -1 }
    if (newer) record.event = event
    if (usage && typeof usage === 'object' && !Array.isArray(usage) && USAGE_TOTAL_FIELDS.some(field => normalizeOptionalUsageNumber(usage[field]) !== null) && (Number(event.sequence) || 0) >= record.usageSequence) {
      record.usage = usage
      record.usageSequence = Number(event.sequence) || 0
    }
    turns.set(key, record)
  }
  return [...turns.values()]
}

/** Do not infer identity from equal counters: distinct genuine calls often have equal usage. */
export function physicalUsageKey(event) {
  const payload = event?.payload
  return identity(payload?.modelRequestId) && Number.isInteger(payload.physicalAttempt) && payload.physicalAttempt > 0
    ? JSON.stringify([...scope(event), payload.modelRequestId, payload.physicalAttempt]) : null
}

export function usageModelIdentity(payload) {
  const modelName = String(payload.modelName || '(unknown model)')
  const parsed = modelRequestSourceSchema.safeParse(payload.modelSource)
  const source = parsed.success ? parsed.data : null
  return { modelName, providerId: source?.providerId ?? null,
    key: source ? JSON.stringify([modelName, source.providerId, source.endpointFingerprint, source.configFingerprint]) : modelName }
}
