// @ts-check
import { validateTurnWebSocketClientFrame } from '../../shared/turnWebSocketProtocol.js'
import { createTurnEventTransportEnvelope } from '../../shared/turnEventTransport.js'

/**
 * Validate at the external JSON boundary; callers must narrow the result by ok/type.
 * @param {string} raw
 * @returns {import('../../types/turn-protocol.js').ClientFrameDecodeResult}
 */
export function decodeTurnWebSocketClientFrame(raw) {
  /** @type {unknown} */
  let message
  try {
    message = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'INVALID_JSON' }
  }
  return validateTurnWebSocketClientFrame(message)
}

/** @param {import('../../types/turn-protocol.js').TurnWebSocketServerFrame} frame */
export function encodeTurnWebSocketServerFrame(frame) {
  return JSON.stringify(frame)
}

/** @param {import('../../types/turn-protocol.js').TurnEvent} event */
export function encodeTurnWebSocketEvent(event) {
  // This is a real checked caller of the shared v1 constructor, not a duplicate schema.
  return encodeTurnWebSocketServerFrame(createTurnEventTransportEnvelope(event))
}
