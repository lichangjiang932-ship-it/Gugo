import { z } from 'zod'

export const TURN_WEBSOCKET_PROTOCOL_VERSION = 1

const versionSchema = z.literal(TURN_WEBSOCKET_PROTOCOL_VERSION)
const targetSchema = {
  sessionId: z.string().min(1).max(160),
  turnId: z.string().min(1).max(160),
}

export const TURN_WEBSOCKET_CLIENT_FRAME_SCHEMA = z.discriminatedUnion('type', [
  z.object({
    v: versionSchema,
    type: z.literal('subscribe.turn'),
    ...targetSchema,
    after: z.number().int().min(-1),
  }).strict(),
  z.object({
    v: versionSchema,
    type: z.literal('approval.decide'),
    approvalId: z.string().min(1).max(160),
    decision: z.enum(['approve', 'deny', 'edit']),
    args: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
])

export const TURN_WEBSOCKET_SERVER_FRAME_SCHEMA = z.discriminatedUnion('type', [
  z.object({ v: versionSchema, type: z.literal('ready') }).strict(),
  z.object({ v: versionSchema, type: z.literal('subscribed.turn'), ...targetSchema }).strict(),
  z.object({ v: versionSchema, type: z.literal('turn.event'), event: z.unknown() }).strict(),
  z.object({ v: versionSchema, type: z.literal('turn.activity'), activity: z.unknown() }).strict(),
  z.object({
    v: versionSchema,
    type: z.literal('approval.resolved'),
    approvalId: z.string().min(1).max(160),
    result: z.unknown(),
  }).strict(),
  z.object({
    v: versionSchema,
    type: z.literal('error'),
    code: z.string().min(1).max(160),
    message: z.string().optional(),
    expectedVersion: z.number().int().positive().optional(),
    receivedVersion: z.union([z.number().int(), z.null()]).optional(),
    sessionId: z.string().optional(),
    turnId: z.string().optional(),
  }).strict(),
])

function versionMismatch(value) {
  return !value || typeof value !== 'object' || value.v !== TURN_WEBSOCKET_PROTOCOL_VERSION
}

function validationFailure(value, result) {
  if (versionMismatch(value)) {
    return {
      ok: false,
      code: 'VERSION_MISMATCH',
      message: `Realtime protocol v${TURN_WEBSOCKET_PROTOCOL_VERSION} is required. Refresh this page and try again.`,
      expectedVersion: TURN_WEBSOCKET_PROTOCOL_VERSION,
      receivedVersion: Number.isInteger(value?.v) ? value.v : null,
    }
  }
  return {
    ok: false,
    code: 'INVALID_FRAME',
    message: 'Realtime protocol frame is invalid.',
    issues: result.error.issues.map((issue) => issue.message),
  }
}

export function validateTurnWebSocketClientFrame(value) {
  const result = TURN_WEBSOCKET_CLIENT_FRAME_SCHEMA.safeParse(value)
  return result.success ? { ok: true, value: result.data } : validationFailure(value, result)
}

export function validateTurnWebSocketServerFrame(value) {
  const result = TURN_WEBSOCKET_SERVER_FRAME_SCHEMA.safeParse(value)
  return result.success ? { ok: true, value: result.data } : validationFailure(value, result)
}

export function createTurnWebSocketFrame(type, payload = {}) {
  return { ...payload, v: TURN_WEBSOCKET_PROTOCOL_VERSION, type }
}
