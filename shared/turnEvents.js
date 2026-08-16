import { z } from 'zod'
import {
  INLINE_SKILL_DEFINITION_LIMITS,
  unicodeCharacterLength,
  utf8ByteLength,
} from './inlineSkillDefinitions.js'

export const TURN_EVENT_TYPES = Object.freeze([
  'turn.started', 'turn.attempt', 'model.phase', 'model.failover', 'assistant.delta', 'reasoning.delta',
  'tool.call', 'tool.started', 'tool.completed', 'turn.progress', 'approval.required',
  'approval.resolved', 'turn.checkpoint', 'turn.interrupted', 'turn.paused', 'turn.resumed',
  'turn.completed', 'turn.cancelled',
  'turn.failed', 'heartbeat',
])

const jsonRecord = z.record(z.string(), z.unknown())
const nullableText = z.string().nullable().optional()
const verifiedLocalFileSchema = z.object({
  id: z.string().min(1).max(160),
  path: z.string().min(1).max(32_768),
  filename: z.string().min(1).max(1_024),
  size: z.number().nonnegative().optional(),
  verifiedAt: z.number().int().nonnegative().optional(),
}).strict()
const verifiedLocalFilesSchema = z.array(verifiedLocalFileSchema).max(64).optional()
const managedAttachmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  status: z.string().optional(),
  sessionId: nullableText,
  messageId: nullableText,
  uri: z.string().optional(),
  downloadUrl: z.string().optional(),
  createdAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
}).strict()
const toolFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  status: z.number().int().min(100).max(599).optional(),
  retryable: z.boolean(),
  hint: z.string().optional(),
  attempts: z.number().int().positive().optional(),
}).strict()
const completedArtifactSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  type: z.string().min(1).optional(),
  url: z.string().min(1),
  title: z.string().optional(),
  mimeType: z.string().min(1).optional(),
}).strict()
function inlineSkillTextSchema({ maxCharacters = null, maxUtf8Bytes = null, minCharacters = 0 } = {}) {
  return z.string().superRefine((value, context) => {
    const characterLength = unicodeCharacterLength(value)
    if (characterLength < minCharacters) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `must contain at least ${minCharacters} Unicode character(s)` })
    }
    if (maxCharacters !== null && characterLength > maxCharacters) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `must contain at most ${maxCharacters} Unicode characters` })
    }
    const byteLength = utf8ByteLength(value)
    if (maxUtf8Bytes !== null && byteLength > maxUtf8Bytes) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `must contain at most ${maxUtf8Bytes} UTF-8 bytes` })
    }
  })
}

const inlineSkillLimits = INLINE_SKILL_DEFINITION_LIMITS
const inlineSkillDefinitionSchema = z.object({
  id: inlineSkillTextSchema({ ...inlineSkillLimits.id, minCharacters: 1 }),
  name: inlineSkillTextSchema(inlineSkillLimits.name),
  description: inlineSkillTextSchema(inlineSkillLimits.description),
  permissions: z.array(inlineSkillTextSchema(inlineSkillLimits.permission)).max(inlineSkillLimits.maxPermissions),
  systemPrompt: inlineSkillTextSchema({ ...inlineSkillLimits.systemPrompt, minCharacters: 1 }),
  promptTruncated: z.boolean().optional(),
}).strict()
const turnResolutionSchema = z.object({
  type: z.string().min(1).optional(),
  approved: z.boolean().optional(),
  path: z.string().min(1).optional(),
  access_mode: z.enum(['read_only', 'read_write']).optional(),
  accessMode: z.enum(['read_only', 'read_write']).optional(),
  resource_type: z.string().min(1).optional(),
  resourceType: z.string().min(1).optional(),
  response: z.string().min(1).optional(),
  answer: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  purpose: z.string().optional(),
  paused_sequence: z.number().int().nonnegative().optional(),
  pausedSequence: z.number().int().nonnegative().optional(),
}).catchall(z.unknown()).superRefine((resolution, context) => {
  if (!Object.values(resolution).some((value) => value !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'turn resolution cannot be empty' })
  }
})

export const TURN_EVENT_PAYLOAD_SCHEMAS = Object.freeze({
  'turn.started': z.object({
    content: z.string().optional(), displayContent: nullableText, modelName: nullableText,
    model: z.string().optional(),
    agentId: nullableText, skillIds: z.array(z.string()).optional(),
    skillDefinitions: z.array(inlineSkillDefinitionSchema).max(inlineSkillLimits.maxDefinitions).optional(),
    toolsConfig: z.object({
      enabled: z.array(z.string()).optional(),
      disabled: z.array(z.string()).optional(),
    }).strict().optional(),
    intentMode: z.enum(['auto', 'answer', 'execute']).optional(),
    userMessageId: z.string().optional(),
    attachments: z.array(managedAttachmentSchema).optional(),
    importedHistoryCount: z.number().int().nonnegative().optional(),
  }).strict(),
  'turn.attempt': z.object({
    attempt: z.number().int().positive(),
    reason: z.string(),
    resetStreaming: z.boolean(),
    checkpointSequence: z.number().int().nonnegative().nullable(),
    previousStreamSequence: z.number().int().nonnegative(),
    assistantText: z.string(),
    reasoningText: z.string(),
  }).strict(),
  'model.phase': z.object({
    phase: z.string(), iteration: z.number().int().nonnegative().optional(),
    usage: jsonRecord.nullable().optional(), modelName: nullableText, error: nullableText,
  }).strict(),
  'model.failover': z.object({
    kind: z.enum(['retry', 'failover']),
    from: z.string().optional(),
    to: z.string().optional(),
    modelName: nullableText,
    attempt: z.number().int().positive().optional(),
    delayMs: z.number().int().nonnegative().optional(),
  }).strict(),
  'assistant.delta': z.object({
    text: z.string(), iteration: z.number().int().nonnegative().optional(), modelName: nullableText,
  }).strict(),
  'reasoning.delta': z.object({
    text: z.string(), iteration: z.number().int().nonnegative().optional(), modelName: nullableText,
  }).strict(),
  'tool.call': z.object({ toolCallId: z.string().optional(), name: z.string().optional(), args: jsonRecord.optional() }).strict(),
  'tool.started': z.object({
    toolCallId: z.string().optional(),
    name: z.string().optional(),
    args: jsonRecord.optional(),
    // stdout/stderr deltas are intentionally process-local. A replayed
    // running tool can restore its identity and arguments, while making the
    // missing pre-reconnect output explicit instead of implying an empty log.
    outputReplay: z.literal('live_only').optional(),
  }).strict(),
  'tool.completed': z.object({
    toolCallId: z.string().optional(), name: z.string().optional(), args: jsonRecord.optional(),
    result: z.unknown().optional(), error: toolFailureSchema.nullable().optional(), artifactId: nullableText,
    artifacts: z.array(completedArtifactSchema).optional(),
  }).strict(),
  'turn.progress': z.object({
    completed: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
    iteration: z.number().int().nonnegative().optional(),
    filesChanged: z.number().int().nonnegative().optional(),
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
    phase: z.string().min(1).optional(),
  }).strict().superRefine((payload, context) => {
    if (!Object.values(payload).some((value) => value !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'turn.progress requires at least one progress field' })
    }
    if (payload.completed !== undefined && payload.total !== undefined && payload.completed > payload.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completed'],
        message: 'completed cannot exceed total',
      })
    }
  }),
  'approval.required': z.object({
    approvalId: z.string().optional(), toolName: z.string().optional(), args: jsonRecord.optional(),
    risk: z.unknown().optional(), reason: nullableText, expiresAt: z.number().int().nonnegative().optional(),
  }).strict(),
  'approval.resolved': z.object({
    approvalId: nullableText, proceed: z.boolean(), edited: z.boolean(), args: jsonRecord.nullable().optional(),
    reason: nullableText,
  }).strict(),
  'turn.checkpoint': z.object({
    // `state` remains accepted for v50-and-earlier event-log checkpoints.
    // New checkpoints keep state in the upsert table and emit bounded metadata.
    state: z.unknown().optional(),
    storage: z.literal('turn_checkpoints').optional(),
    checkpointVersion: z.number().int().positive().optional(),
    iterations: z.number().int().nonnegative().optional(),
    toolCallCount: z.number().int().nonnegative().optional(),
  }).strict(),
  'turn.interrupted': z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    text: z.string().optional(),
    artifactIds: z.array(z.string()).optional(),
    deliveryArtifactIds: z.array(z.string()).optional(),
    verifiedLocalFiles: verifiedLocalFilesSchema,
    iterations: z.number().int().nonnegative().optional(),
    usage: jsonRecord.nullable().optional(),
    turnModelUsage: jsonRecord.nullable().optional(),
    estimatedPromptTokens: z.number().int().nonnegative().optional(),
  }).strict(),
  'turn.paused': z.object({
    text: z.string(),
    clarification: z.union([jsonRecord, z.string().min(1)]),
    artifactIds: z.array(z.string()).optional(),
    deliveryArtifactIds: z.array(z.string()).optional(),
    verifiedLocalFiles: verifiedLocalFilesSchema,
    iterations: z.number().int().nonnegative().optional(),
    usage: jsonRecord.nullable().optional(),
    turnModelUsage: jsonRecord.nullable().optional(),
    estimatedPromptTokens: z.number().int().nonnegative().optional(),
  }).strict(),
  'turn.resumed': z.object({
    resolution: turnResolutionSchema,
    pausedSequence: z.number().int().nonnegative(),
  }).strict().superRefine((payload, context) => {
    const resolutionSequence = payload.resolution.paused_sequence
      ?? payload.resolution.pausedSequence
    if (resolutionSequence !== payload.pausedSequence) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resolution', 'paused_sequence'],
        message: 'resolution paused_sequence must match pausedSequence',
      })
    }
  }),
  'turn.completed': z.object({
    text: z.string().optional(), artifactIds: z.array(z.string()).optional(), deliveryArtifactIds: z.array(z.string()).optional(), iterations: z.number().int().nonnegative().optional(),
    verifiedLocalFiles: verifiedLocalFilesSchema,
    usage: jsonRecord.nullable().optional(),
    turnModelUsage: jsonRecord.nullable().optional(),
    estimatedPromptTokens: z.number().int().nonnegative().optional(),
    paused: z.boolean().optional(), clarification: z.unknown().nullable().optional(), interrupted: z.boolean().optional(),
  }).strict(),
  'turn.cancelled': z.object({
    reason: z.string().optional(),
    artifactIds: z.array(z.string()).optional(),
    deliveryArtifactIds: z.array(z.string()).optional(),
    verifiedLocalFiles: verifiedLocalFilesSchema,
    iterations: z.number().int().nonnegative().optional(),
    usage: jsonRecord.nullable().optional(),
    turnModelUsage: jsonRecord.nullable().optional(),
    estimatedPromptTokens: z.number().int().nonnegative().optional(),
  }).strict(),
  'turn.failed': z.object({
    // Keep the legacy top-level fields so older clients can still render the failure.
    code: z.string().optional(),
    message: z.string().optional(),
    error: toolFailureSchema.optional(),
    partialText: z.string().optional(),
    artifactIds: z.array(z.string()).optional(),
    deliveryArtifactIds: z.array(z.string()).optional(),
    verifiedLocalFiles: verifiedLocalFilesSchema,
    iterations: z.number().int().nonnegative().optional(),
    usage: jsonRecord.nullable().optional(),
    turnModelUsage: jsonRecord.nullable().optional(),
    estimatedPromptTokens: z.number().int().nonnegative().optional(),
  }).strict(),
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
