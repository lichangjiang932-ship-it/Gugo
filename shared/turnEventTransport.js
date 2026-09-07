// @ts-check
import {
  TURN_EVENT_TRANSPORT_TYPE,
  TURN_EVENT_TRANSPORT_VERSION,
  TurnEventTransportEnvelopeSchema,
  parsePersistedTurnEvent,
  parseTurnEvent,
} from './turnEvents.js'

/** @param {unknown} value */
export function parseTurnEventTransportEnvelope(value) {
  return TurnEventTransportEnvelopeSchema.parse(value)
}

/** @param {import('../types/turn-protocol.js').TurnEvent} event */
export function createTurnEventTransportEnvelope(event) {
  return parseTurnEventTransportEnvelope({
    v: TURN_EVENT_TRANSPORT_VERSION,
    type: TURN_EVENT_TRANSPORT_TYPE,
    event: parseTurnEvent(event),
  })
}

/**
 * Decode v1 envelopes while retaining bare persisted SSE events as an explicit
 * compatibility path. Malformed envelope-like values never use that fallback.
 * @param {unknown} value
 */
export function parseTurnEventTransportPayload(value) {
  const envelopeLike = value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (
      ('type' in value && value.type === TURN_EVENT_TRANSPORT_TYPE)
      || Object.prototype.hasOwnProperty.call(value, 'v')
      || Object.prototype.hasOwnProperty.call(value, 'event')
    )
  return envelopeLike
    ? parseTurnEventTransportEnvelope(value).event
    : parsePersistedTurnEvent(value)
}

/**
 * @param {Partial<Pick<import('../types/turn-protocol.js').TurnEvent, 'sequence' | 'compactedThrough'>> | null | undefined} event
 * @param {number} [after=-1]
 */
export function canAdvanceTurnEventCursor(event, after = -1) {
  const cursor = Number.isInteger(after) ? after : Math.max(-1, Math.floor(Number(after) || 0))
  const expectedSequence = cursor + 1
  if (event?.sequence === expectedSequence) return true
  if (!event || typeof event.sequence !== 'number' || typeof event.compactedThrough !== 'number') return false
  return Number.isInteger(event.sequence)
    && event.sequence > expectedSequence
    && Number.isInteger(event.compactedThrough)
    && event.sequence <= event.compactedThrough
}
