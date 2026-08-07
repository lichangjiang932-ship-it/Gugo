import { z } from 'zod'

export const TURN_EVENT_TYPES = Object.freeze([
  'turn.started', 'model.phase', 'assistant.delta', 'reasoning.delta',
  'tool.call', 'tool.started', 'tool.completed', 'approval.required',
  'approval.resolved', 'turn.checkpoint', 'turn.completed', 'turn.cancelled',
  'turn.failed', 'heartbeat',
])

const jsonRecord = z.record(z.string(), z.unknown())
const nullableText = z.string().nullable().optional()

export const TURN_EVENT_PAYLOAD_SCHEMAS = Object.freeze({
  'turn.started': z.object({
    content: z.string().optional(), displayContent: nullableText, modelName: nullableText,
    model: z.string().optional(),
    agentId: nullableText, skillIds: z.array(z.string()).optional(),
    toolsConfig: z.object({
      enabled: z.array(z.string()).optional(),
      disabled: z.array(z.string()).optional(),
    }).strict().optional(),
    userMessageId: z.string().optional(),
    importedHistoryCount: z.number().int().nonnegative().optional(),
  }).strict(),
  'model.phase': z.object({
    phase: z.string(), iteration: z.number().int().nonnegative().optional(),
    usage: jsonRecord.nullable().optional(), modelName: nullableText, error: nullableText,
  }).strict(),
  'assistant.delta': z.object({
    text: z.string(), iteration: z.number().int().nonnegative().optional(), modelName: nullableText,
  }).strict(),
  'reasoning.delta': z.object({
    text: z.string(), iteration: z.number().int().nonnegative().optional(), modelName: nullableText,
  }).strict(),
  'tool.call': z.object({ toolCallId: z.string().optional(), name: z.string().optional(), args: jsonRecord.optional() }).strict(),
  'tool.started': z.object({ toolCallId: z.string().optional(), name: z.string().optional() }).strict(),
  'tool.completed': z.object({
    toolCallId: z.string().optional(), name: z.string().optional(), result: z.unknown().optional(), artifactId: nullableText,
  }).strict(),
  'approval.required': z.object({
    approvalId: z.string().optional(), toolName: z.string().optional(), args: jsonRecord.optional(),
    risk: z.unknown().optional(), reason: nullableText, expiresAt: z.number().int().nonnegative().optional(),
  }).strict(),
  'approval.resolved': z.object({
    approvalId: nullableText, proceed: z.boolean(), edited: z.boolean(), args: jsonRecord.nullable().optional(),
    reason: nullableText,
  }).strict(),
  'turn.checkpoint': z.object({ state: z.unknown().optional() }).strict(),
  'turn.completed': z.object({
    text: z.string().optional(), artifactIds: z.array(z.string()).optional(), iterations: z.number().int().nonnegative().optional(),
    usage: jsonRecord.nullable().optional(),
    paused: z.boolean().optional(), clarification: z.unknown().nullable().optional(), interrupted: z.boolean().optional(),
  }).strict(),
  'turn.cancelled': z.object({ reason: z.string().optional() }).strict(),
  'turn.failed': z.object({ code: z.string().optional(), message: z.string().optional() }).strict(),
  heartbeat: z.object({ at: z.number().int().nonnegative().optional() }).strict(),
})

const TurnEventBaseSchema = z.object({
  id: z.string().min(1).max(160),
  sessionId: z.string().min(1).max(160),
  turnId: z.string().min(1).max(160),
  sequence: z.number().int().nonnegative(),
  type: z.enum(TURN_EVENT_TYPES),
  payload: jsonRecord.default({}),
  createdAt: z.number().int().nonnegative(),
}).strict()

export const TurnEventSchema = TurnEventBaseSchema.superRefine((event, context) => {
  const result = TURN_EVENT_PAYLOAD_SCHEMAS[event.type].safeParse(event.payload)
  if (result.success) return
  for (const issue of result.error.issues) {
    context.addIssue({ ...issue, path: ['payload', ...issue.path] })
  }
})

export function parseTurnEvent(value) {
  return TurnEventSchema.parse(value)
}

export function createTurnEvent({ id, sessionId, turnId, sequence, type, payload = {}, createdAt = Date.now() }) {
  return parseTurnEvent({ id, sessionId, turnId, sequence, type, payload, createdAt })
}
