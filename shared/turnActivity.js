import { z } from 'zod'

export const TURN_ACTIVITY_KINDS = Object.freeze(['tool_call_ready', 'tool_output_delta'])

export const TurnActivitySchema = z.object({
  sessionId: z.string().min(1).max(160),
  turnId: z.string().min(1).max(160),
  kind: z.enum(TURN_ACTIVITY_KINDS),
  toolName: z.string().min(1).max(160),
  modelName: z.string().min(1).max(320).nullable().optional(),
  toolCallId: z.string().min(1).max(160).nullable().optional(),
  stream: z.enum(['stdout', 'stderr']).nullable().optional(),
  chunk: z.string().max(64 * 1024).nullable().optional(),
  createdAt: z.number().int().nonnegative(),
}).strict()

export function parseTurnActivity(value) {
  return TurnActivitySchema.parse(value)
}

export function createTurnActivity({
  sessionId,
  turnId,
  kind,
  toolName,
  modelName = null,
  toolCallId = null,
  stream = null,
  chunk = null,
  createdAt = Date.now(),
}) {
  const activity = { sessionId, turnId, kind, toolName, createdAt }
  if (modelName != null) activity.modelName = modelName
  if (toolCallId != null) activity.toolCallId = toolCallId
  if (stream != null) activity.stream = stream
  if (chunk != null) activity.chunk = chunk
  return parseTurnActivity(activity)
}
