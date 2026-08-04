import { z } from 'zod'

export const TURN_EVENT_TYPES = Object.freeze([
  'turn.started', 'model.phase', 'assistant.delta', 'reasoning.delta',
  'tool.call', 'tool.started', 'tool.completed', 'approval.required',
  'approval.resolved', 'turn.checkpoint', 'turn.completed', 'turn.cancelled',
  'turn.failed', 'heartbeat',
])

export const TurnEventSchema = z.object({
  id: z.string().min(1).max(160),
  sessionId: z.string().min(1).max(160),
  turnId: z.string().min(1).max(160),
  sequence: z.number().int().nonnegative(),
  type: z.enum(TURN_EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.number().int().nonnegative(),
}).strict()

export function parseTurnEvent(value) {
  return TurnEventSchema.parse(value)
}

export function createTurnEvent({ id, sessionId, turnId, sequence, type, payload = {}, createdAt = Date.now() }) {
  return parseTurnEvent({ id, sessionId, turnId, sequence, type, payload, createdAt })
}
