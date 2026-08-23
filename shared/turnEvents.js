import { z } from 'zod'
import {
  INLINE_SKILL_DEFINITION_LIMITS,
  unicodeCharacterLength,
  utf8ByteLength,
} from './inlineSkillDefinitions.js'

export const TURN_EVENT_TYPES = Object.freeze([
  'turn.started', 'turn.attempt', 'model.phase', 'model.failover', 'assistant.delta', 'reasoning.delta',
  'tool.call', 'tool.started', 'tool.completed', 'turn.progress', 'approval.required',
  'approval.resolved', 'turn.checkpoint', 'turn.interrupted', 'turn.blocked', 'turn.paused', 'turn.resumed',
  'turn.completed', 'turn.cancelled',
  'turn.failed', 'heartbeat',
])

export const TURN_EVENT_TRANSPORT_VERSION = 1
export const TURN_EVENT_TRANSPORT_TYPE = 'turn.event'
export const TURN_EVENT_TRANSPORT_QUERY_PARAM = 'turnEventVersion'

const jsonRecord = z.record(z.string(), z.unknown())
const nullableText = z.string().nullable().optional()
const verifiedLocalFileSchema = z.object({
  id: z.string().min(1).max(160),
  path: z.string().min(1).max(32_768),
  filename: z.string().min(1).max(1_024),
  size: z.number().nonnegative().optional(),
  verifiedAt: z.number().int().nonnegative().optional(),
  relatedArtifactIds: z.array(z.string().min(1).max(160)).max(32).optional(),
}).strict()
const verifiedLocalFilesSchema = z.array(verifiedLocalFileSchema).max(64).optional()
const retainedLocalFileSchema = z.object({
  id: z.string().min(1).max(160),
  path: z.string().min(1).max(32_768),
  filename: z.string().min(1).max(1_024),
  size: z.number().nonnegative().optional(),
  retainedAt: z.number().int().nonnegative().optional(),
  relatedArtifactIds: z.array(z.string().min(1).max(160)).max(32).optional(),
}).strict()
const retainedLocalFilesSchema = z.array(retainedLocalFileSchema).max(64).optional()
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
const turnFailureSchema = toolFailureSchema.extend({
  persistence: z.object({
    failedEventCount: z.number().int().nonnegative(),
    blockedEventCount: z.number().int().nonnegative(),
    failedEventTypes: z.array(z.string().min(1)).max(32),
    firstFailedSequence: z.number().int().nonnegative().optional(),
    lastFailedSequence: z.number().int().nonnegative().optional(),
    failedAt: z.number().int().nonnegative().optional(),
  }).strict().optional(),
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
  authorization_scope: z.enum(['session', 'persistent']).optional(),
  authorizationScope: z.enum(['session', 'persistent']).optional(),
  grant_id: z.string().min(1).max(160).optional(),
  grantId: z.string().min(1).max(160).optional(),
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
    modelProviderId: nullableText,
    modelConfigRevision: z.number().int().positive().nullable().optional(),
    modelMode: z.enum(['agent', 'chat_only']).optional(),
    model: z.string().optional(),
    agentId: nullableText, skillIds: z.array(z.string()).optional(),
    skillDefinitions: z.array(inlineSkillDefinitionSchema).max(inlineSkillLimits.maxDefinitions).optional(),
    toolsConfig: z.object({
      enabled: z.array(z.string()).optional(),
      disabled: z.array(z.string()).optional(),
    }).strict().optional(),
    intentMode: z.enum(['auto', 'answer', 'execute']).optional(),
    approvalMode: z.enum(['normal', 'acceptEdits', 'plan', 'bypass']).optional(),
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
    risk: z.unknown().optional(), metadataSource: z.enum(['declared', 'fallback']).optional(),
    reason: nullableText, expiresAt: z.number().int().nonnegative().optional(),
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
    retainedLocalFiles: retainedLocalFilesSchema,
    iterations: z.number().int().nonnegative().optional(),
    usage: jsonRecord.nullable().optional(),
    turnModelUsage: jsonRecord.nullable().optional(),
    estimatedPromptTokens: z.number().int().nonnegative().optional(),
  }).strict(),
  'turn.blocked': z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.literal(false),
    manualRetryable: z.literal(true),
    recoveryStatus: z.literal('dead_letter'),
    recoveryKind: z.enum([
      'side_effect_unknown',
      'side_effect_outcome_unknown',
      'model_request_outcome_unknown',
    ]).optional(),
    turnId: z.string().min(1).max(256).optional(),
    toolCallId: z.string().min(1).max(256).optional(),
    modelRequestId: z.string().min(1).max(256).optional(),
    requiresUserVerification: z.literal(true).optional(),
    recoveryAction: z.object({
      kind: z.literal('open_settings'),
      path: z.literal('/settings?tab=recovery'),
    }).strict().optional(),
    checkpointSequence: z.number().int().nonnegative().nullable().optional(),
    artifactIds: z.array(z.string()).optional(),
    deliveryArtifactIds: z.array(z.string()).optional(),
    verifiedLocalFiles: verifiedLocalFilesSchema,
    retainedLocalFiles: retainedLocalFilesSchema,
    iterations: z.number().int().nonnegative().optional(),
  }).strict().superRefine((payload, context) => {
    if (['side_effect_unknown', 'side_effect_outcome_unknown', 'model_request_outcome_unknown'].includes(payload.recoveryKind)
      && !payload.recoveryAction) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recoveryAction'],
        message: 'side-effect recovery requires the safe settings action',
      })
    }
    if (payload.recoveryKind === 'side_effect_outcome_unknown') {
      for (const key of ['turnId', 'toolCallId', 'requiresUserVerification']) {
        if (payload[key]) continue
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `side-effect outcome recovery requires ${key}`,
        })
      }
    }
    if (payload.recoveryKind === 'model_request_outcome_unknown') {
      for (const key of ['turnId', 'modelRequestId', 'requiresUserVerification']) {
        if (payload[key]) continue
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `model request outcome recovery requires ${key}`,
        })
      }
    }
    if (!payload.recoveryKind && (
      payload.turnId || payload.toolCallId || payload.modelRequestId
        || payload.requiresUserVerification || payload.recoveryAction
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recoveryKind'],
        message: 'recovery metadata requires recoveryKind',
      })
    }
  }),
  'turn.paused': z.object({
    text: z.string(),
    clarification: z.union([jsonRecord, z.string().min(1)]),
    artifactIds: z.array(z.string()).optional(),
    deliveryArtifactIds: z.array(z.string()).optional(),
    verifiedLocalFiles: verifiedLocalFilesSchema,
    retainedLocalFiles: retainedLocalFilesSchema,
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
    retainedLocalFiles: retainedLocalFilesSchema,
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
    retainedLocalFiles: retainedLocalFilesSchema,
    iterations: z.number().int().nonnegative().optional(),
    usage: jsonRecord.nullable().optional(),
    turnModelUsage: jsonRecord.nullable().optional(),
    estimatedPromptTokens: z.number().int().nonnegative().optional(),
  }).strict(),
  'turn.failed': z.object({
    // Keep the legacy top-level fields so older clients can still render the failure.
    code: z.string().optional(),
    message: z.string().optional(),
    error: turnFailureSchema.optional(),
    partialText: z.string().optional(),
    artifactIds: z.array(z.string()).optional(),
    deliveryArtifactIds: z.array(z.string()).optional(),
    verifiedLocalFiles: verifiedLocalFilesSchema,
    retainedLocalFiles: retainedLocalFilesSchema,
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
  // Replay-only metadata. A retained event may legitimately jump over
  // superseded checkpoint history at or before this durable boundary.
  compactedThrough: z.number().int().nonnegative().optional(),
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

export const TurnEventTransportEnvelopeSchema = z.object({
  v: z.literal(TURN_EVENT_TRANSPORT_VERSION),
  type: z.literal(TURN_EVENT_TRANSPORT_TYPE),
  event: TurnEventSchema,
}).strict()

export function parseTurnEvent(value) {
  return TurnEventSchema.parse(value)
}

export function parseTurnEventTransportEnvelope(value) {
  return TurnEventTransportEnvelopeSchema.parse(value)
}

export function createTurnEventTransportEnvelope(event) {
  return parseTurnEventTransportEnvelope({
    v: TURN_EVENT_TRANSPORT_VERSION,
    type: TURN_EVENT_TRANSPORT_TYPE,
    event: parseTurnEvent(event),
  })
}

/**
 * Decode the versioned transport envelope while retaining the pre-v1 SSE
 * payload as an explicit compatibility path. Invalid envelope-like values do
 * not fall back to a bare event, so a version mismatch remains fail closed.
 */
export function parseTurnEventTransportPayload(value) {
  const envelopeLike = value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (
      value.type === TURN_EVENT_TRANSPORT_TYPE
      || Object.prototype.hasOwnProperty.call(value, 'v')
      || Object.prototype.hasOwnProperty.call(value, 'event')
    )
  return envelopeLike
    ? parseTurnEventTransportEnvelope(value).event
    : parseTurnEvent(value)
}

export function createTurnEvent({
  id,
  sessionId,
  turnId,
  sequence,
  compactedThrough,
  type,
  payload = {},
  createdAt = Date.now(),
}) {
  return parseTurnEvent({
    id,
    sessionId,
    turnId,
    sequence,
    ...(compactedThrough === undefined ? {} : { compactedThrough }),
    type,
    payload,
    createdAt,
  })
}

export function canAdvanceTurnEventCursor(event, after = -1) {
  const cursor = Number.isInteger(after) ? after : Math.max(-1, Math.floor(Number(after) || 0))
  const expectedSequence = cursor + 1
  if (event?.sequence === expectedSequence) return true
  return Number.isInteger(event?.sequence)
    && event.sequence > expectedSequence
    && Number.isInteger(event.compactedThrough)
    && event.sequence <= event.compactedThrough
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
