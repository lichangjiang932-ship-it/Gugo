// @ts-check
import { z } from 'zod'
import { modelProviderStopDiagnostic } from './modelProviderStopDiagnostic.js'
import { MODEL_PHASE_PROGRESS_FIELDS } from './modelPhaseProgress.js'
import { modelContextDiagnosticsSchema } from './modelContextDiagnostics.js'
import { modelWireDiagnosticsSchema } from './modelWireDiagnostics.js'
import { toolFailureSchema, terminalReasonSchema, terminalNextActionSchema,
  completionPoliciesSchema, taskVerificationSchema, turnFailureSchema } from './turnFailureSchemas.js'
import {
  INLINE_SKILL_DEFINITION_LIMITS,
  unicodeCharacterLength,
  utf8ByteLength,
} from './inlineSkillDefinitions.js'

export {
  TURN_ACTIVITY_KINDS,
  TurnActivitySchema,
  createTurnActivity,
  parseTurnActivity,
} from './turnActivity.js'
export {
  canAdvanceTurnEventCursor, createTurnEventTransportEnvelope,
  parseTurnEventTransportEnvelope, parseTurnEventTransportPayload,
} from './turnEventTransport.js'

export const TURN_EVENT_TYPES = Object.freeze(/** @type {const} */ ([
  'turn.started', 'turn.attempt', 'model.phase', 'model.failover', 'assistant.delta', 'reasoning.delta',
  'tool.call', 'tool.started', 'tool.completed', 'turn.progress', 'approval.required',
  'approval.resolved', 'turn.checkpoint', 'turn.interrupted', 'turn.blocked', 'turn.paused', 'turn.resumed',
  'turn.completed', 'turn.cancelled',
  'turn.failed', 'heartbeat',
]))

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
const completedArtifactSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  type: z.string().min(1).optional(),
  url: z.string().min(1),
  title: z.string().optional(),
  mimeType: z.string().min(1).optional(),
  previewRevision: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict()
/** @param {{ maxCharacters?: number | null, maxUtf8Bytes?: number | null, minCharacters?: number }} [options] */
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
    locale: z.enum(['zh', 'en']).optional(),
    approvalMode: z.enum(['normal', 'acceptEdits', 'plan', 'bypass']).optional(),
    workspacePath: nullableText,
    projectDirectory: nullableText,
    sessionWorkspaceMode: z.enum(['follow-turn', 'create-only']).optional(),
    userMessageId: z.string().optional(),
    attachments: z.array(managedAttachmentSchema).optional(),
    importedHistoryCount: z.number().int().nonnegative().optional(),
  }).strict(),
  'turn.attempt': z.object({
    attempt: z.number().int().positive(),
    reason: z.string(),
    manualRetry: z.literal(true).optional(),
    resetStreaming: z.boolean(),
    checkpointSequence: z.number().int().nonnegative().nullable(),
    previousStreamSequence: z.number().int().nonnegative(),
    assistantText: z.string(),
    reasoningText: z.string(),
  }).strict(),
  'model.phase': z.object({
    ...MODEL_PHASE_PROGRESS_FIELDS,
    phase: z.string(), iteration: z.number().int().nonnegative().optional(),
    usage: jsonRecord.nullable().optional(), modelName: nullableText, error: nullableText,
    contextDiagnostics: modelContextDiagnosticsSchema.optional(),
    wireDiagnostics: modelWireDiagnosticsSchema.optional(),
    modelRequestId: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/u).optional(),
    physicalAttempt: z.number().int().positive().optional(),
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
    // Legacy runtimes included localized copy here. New runtimes send code.
    message: z.string().min(1).optional(),
    reason: terminalReasonSchema.optional(),
    nextAction: terminalNextActionSchema.optional(),
    error: turnFailureSchema.optional(),
    incompleteReason: z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*$/u).optional(),
    missingRequirements: z.array(z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*$/u)).max(16).optional(),
    taskVerification: taskVerificationSchema.optional(),
    completionPolicies: completionPoliciesSchema,
    retryable: z.boolean(),
    text: z.string().optional(),
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
  'turn.blocked': z.object({
    code: z.string().min(1),
    // Kept for backwards-compatible event replay only.
    message: z.string().min(1).optional(),
    reason: terminalReasonSchema.optional(),
    nextAction: terminalNextActionSchema.optional(),
    error: turnFailureSchema.optional(),
    incompleteReason: z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*$/u).optional(),
    missingRequirements: z.array(z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*$/u)).max(16).optional(),
    taskVerification: taskVerificationSchema.optional(),
    completionPolicies: completionPoliciesSchema,
    partialText: z.string().optional(),
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
    recoveryAction: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('confirm_side_effect') }).strict(),
      // Retained for persisted side-effect records and model-request recovery.
      z.object({
        kind: z.literal('open_settings'),
        path: z.literal('/settings?tab=recovery'),
      }).strict(),
    ]).optional(),
    checkpointSequence: z.number().int().nonnegative().nullable().optional(),
    artifactIds: z.array(z.string()).optional(),
    deliveryArtifactIds: z.array(z.string()).optional(),
    verifiedLocalFiles: verifiedLocalFilesSchema,
    retainedLocalFiles: retainedLocalFilesSchema,
    iterations: z.number().int().nonnegative().optional(),
  }).strict().superRefine((payload, context) => {
    if (payload.recoveryKind && ['side_effect_unknown', 'side_effect_outcome_unknown', 'model_request_outcome_unknown'].includes(payload.recoveryKind)
      && !payload.recoveryAction) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recoveryAction'],
        message: 'outcome recovery requires a safe recovery action',
      })
    }
    if (payload.recoveryAction?.kind === 'confirm_side_effect') {
      if (payload.code !== 'SIDE_EFFECT_OUTCOME_UNKNOWN'
        || payload.recoveryKind !== 'side_effect_outcome_unknown'
        || payload.modelRequestId !== undefined
        || (payload.error && (payload.error.code !== 'SIDE_EFFECT_OUTCOME_UNKNOWN'
          || payload.error.retryable !== false))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recoveryAction'],
          message: 'side-effect confirmation requires an exact non-retryable side-effect outcome boundary',
        })
      }
      for (const key of /** @type {const} */ (['turnId', 'toolCallId'])) {
        const id = payload[key]
        const exact = typeof id === 'string' && id.length > 0 && !/\s/u.test(id)
          && [...id].every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
        if (exact) continue
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'side-effect confirmation requires an exact ' + key,
        })
      }
    }
    if (payload.recoveryKind === 'side_effect_outcome_unknown') {
      for (const key of /** @type {const} */ (['turnId', 'toolCallId', 'requiresUserVerification'])) {
        if (payload[key]) continue
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `side-effect outcome recovery requires ${key}`,
        })
      }
    }
    if (payload.recoveryKind === 'model_request_outcome_unknown') {
      for (const key of /** @type {const} */ (['turnId', 'modelRequestId', 'requiresUserVerification'])) {
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
    reason: terminalReasonSchema.optional(),
    nextAction: terminalNextActionSchema.optional(),
    incompleteReason: z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*$/u).optional(),
    missingRequirements: z.array(z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*$/u)).max(16).optional(),
    completionPolicies: completionPoliciesSchema,
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
    completionPolicies: completionPoliciesSchema,
  }).strict(),
  'turn.cancelled': z.object({
    // `reason` is retained for persisted legacy events. Public projections
    // replace server-authored copy with the stable cancellation code.
    code: z.string().optional(),
    reason: z.string().optional(),
    nextAction: terminalNextActionSchema.optional(),
    incompleteReason: z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*$/u).optional(),
    missingRequirements: z.array(z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*$/u)).max(16).optional(),
    completionPolicies: completionPoliciesSchema,
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
  'turn.failed': z.object({
    // Keep the legacy top-level fields so older clients can still render the failure.
    code: z.string().optional(),
    message: z.string().optional(),
    reason: terminalReasonSchema.optional(),
    nextAction: terminalNextActionSchema.optional(),
    error: turnFailureSchema.optional(),
    incompleteReason: z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*$/u).optional(),
    missingRequirements: z.array(z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*$/u)).max(16).optional(),
    taskVerification: taskVerificationSchema.optional(),
    completionPolicies: completionPoliciesSchema,
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

export const PersistedTurnEventSchema = TurnEventBaseSchema.superRefine((event, context) => {
  const result = TURN_EVENT_PAYLOAD_SCHEMAS[event.type].safeParse(event.payload)
  if (result.success) {
    const action = event.payload.recoveryAction
    if (event.type === 'turn.blocked' && action && typeof action === 'object'
      && 'kind' in action && action.kind === 'confirm_side_effect'
      && event.payload.turnId !== event.turnId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'turnId'],
        message: 'side-effect confirmation must belong to the event turn',
      })
    }
    return
  }
  for (const issue of result.error.issues) {
    context.addIssue({ ...issue, path: ['payload', ...issue.path] })
  }
})

const CODE_ONLY_TERMINAL_EVENT_TYPES = new Set([
  'turn.interrupted',
  'turn.blocked',
  'turn.cancelled',
  'turn.failed',
])
/** @type {Readonly<Partial<Record<keyof typeof TURN_EVENT_PAYLOAD_SCHEMAS, readonly string[]>>>} */
const LEGACY_PRESENTATION_FIELDS = Object.freeze({
  'turn.interrupted': ['message', 'hint', 'reason'],
  'turn.blocked': ['message', 'hint', 'reason'],
  'turn.cancelled': ['message', 'hint', 'reason'],
  'turn.failed': ['message', 'hint', 'reason'],
  'turn.paused': ['reason'],
})
const STABLE_EVENT_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u

/** @param {string} field @param {unknown} value */
function isProviderDiagnosticReason(field, value) {
  if (!value || typeof value !== 'object' || !('reason' in value)) return false
  const diagnostic = field === 'reason' ? modelProviderStopDiagnostic(value) : ''
  return diagnostic !== '' && diagnostic === value?.reason
}

export const TurnEventSchema = PersistedTurnEventSchema.superRefine((event, context) => {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
  if (CODE_ONLY_TERMINAL_EVENT_TYPES.has(event.type)
    && !STABLE_EVENT_CODE.test(String(payload.code || ''))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payload', 'code'],
      message: 'new terminal events require a stable code',
    })
  }
  const legacyFields = LEGACY_PRESENTATION_FIELDS[event.type] || []
  for (const field of legacyFields) {
    if (Object.hasOwn(payload, field) && !isProviderDiagnosticReason(field, payload)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', field],
        message: `${field} is accepted only when reading persisted legacy events`,
      })
    }
    if (payload.error && typeof payload.error === 'object'
      && Object.hasOwn(payload.error, field) && !isProviderDiagnosticReason(field, payload.error)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'error', field],
        message: `${field} is accepted only when reading persisted legacy events`,
      })
    }
  }
})

export const TurnEventTransportEnvelopeSchema = z.object({
  v: z.literal(TURN_EVENT_TRANSPORT_VERSION),
  type: z.literal(TURN_EVENT_TRANSPORT_TYPE),
  event: TurnEventSchema,
}).strict()

/** @param {unknown} value */
export function parseTurnEvent(value) {
  return TurnEventSchema.parse(value)
}

/** Read-only compatibility parser for events persisted by pre-code-only runtimes.
 * @param {unknown} value
 */
export function parsePersistedTurnEvent(value) {
  return PersistedTurnEventSchema.parse(value)
}

/** @param {import('../types/turn-protocol.js').CreateTurnEventInput} input */
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
