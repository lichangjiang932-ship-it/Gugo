import { z } from 'zod'
import { TurnActivitySchema, TurnEventSchema } from './turnEvents.js'

export const TURN_WEBSOCKET_PROTOCOL_VERSION = 1

const versionSchema = z.literal(TURN_WEBSOCKET_PROTOCOL_VERSION)
const targetSchema = {
  sessionId: z.string().min(1).max(160),
  turnId: z.string().min(1).max(160),
}
const jsonRecordSchema = z.record(z.string(), z.unknown())
const permissionModeSchema = z.enum(['plan', 'normal', 'acceptEdits', 'bypass'])
const rememberedGrantSchema = z.object({
  toolName: z.string().min(1).max(160),
  commandPrefix: z.string().max(32_768),
}).strict()
const permissionModeTransitionSchema = z.object({
  mode: permissionModeSchema,
  previousMode: permissionModeSchema,
  changed: z.boolean(),
  widened: z.boolean(),
}).strict()
const approvalSettingsSchema = z.object({
  mode: permissionModeSchema,
  rememberedTools: z.array(z.string().min(1).max(160)),
  rememberedGrants: z.array(rememberedGrantSchema),
  riskOverrides: z.array(z.object({
    toolName: z.string().min(1).max(160),
    riskClass: z.enum(['read', 'write_local', 'exec', 'external']),
  }).strict()),
  modes: z.array(permissionModeSchema),
  modeHistory: z.array(z.object({
    id: z.number().int().positive(),
    fromMode: permissionModeSchema,
    toMode: permissionModeSchema,
    transitionKind: z.enum(['widened', 'tightened']),
    justification: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
  }).strict()),
}).strict()
const approvalSchema = z.object({
  id: z.string().min(1).max(160),
  userId: z.string().min(1).max(160),
  origin: z.enum(['job', 'subagent', 'chat']),
  jobId: z.string().nullable(),
  stepId: z.string().nullable(),
  sessionId: z.string().nullable(),
  toolName: z.string().min(1).max(160),
  args: jsonRecordSchema,
  risk: z.enum(['low', 'medium', 'high']),
  metadataSource: z.enum(['declared', 'fallback']),
  reason: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'denied', 'edited', 'expired', 'cancelled']),
  decidedArgs: jsonRecordSchema.nullable(),
  effectiveArgs: jsonRecordSchema,
  decidedBy: z.string().nullable(),
  decidedAt: z.number().int().nonnegative().nullable(),
  expiresAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict()
const approvalDecisionResultSchema = z.object({
  ok: z.boolean(),
  alreadyDecided: z.boolean(),
  approval: approvalSchema,
  modeTransition: permissionModeTransitionSchema.nullable(),
  approvalSettings: approvalSettingsSchema.nullable(),
  rememberedTools: z.array(z.string().min(1).max(160)).nullable(),
  rememberedGrants: z.array(rememberedGrantSchema).nullable(),
}).strict()

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
  z.object({ v: versionSchema, type: z.literal('turn.event'), event: TurnEventSchema }).strict(),
  z.object({ v: versionSchema, type: z.literal('turn.activity'), activity: TurnActivitySchema }).strict(),
  z.object({
    v: versionSchema,
    type: z.literal('approval.resolved'),
    approvalId: z.string().min(1).max(160),
    result: approvalDecisionResultSchema,
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
