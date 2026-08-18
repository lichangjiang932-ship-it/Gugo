import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { callBackgroundModel, callStreamingModelWithTools, getModelContextWindow } from '../adapters/modelProxy.js'
import { createTurnActivity, createTurnEvent } from '../../shared/turnEvents.js'
import { canonicalizeSkillId } from '../../shared/artifactIntent.js'
import { normalizeModelUsage } from '../../shared/modelUsage.js'
import { releaseApprovalsForTurn } from './approvalGate.js'
import { runToolLoop, SERVER_TOOL_SPECS } from './toolLoopRuntime.js'
import {
  claimLocalChatSession,
  deleteMessage,
  getPreviousUserMessage,
  getSession,
  listMessages,
  SessionOwnershipError,
  upsertMessage,
  upsertSession,
} from './sessionStore.js'
import { appendTurnEvent, getLastTurnEvent, listTurnEvents } from './turnEventStore.js'
import { getTurnCheckpoint, saveTurnCheckpoint } from './turnCheckpointStore.js'
import { publishTurnActivity } from './turnActivityBus.js'
import { dispatchHooks as dispatchHooksService } from './hooksService.js'
import { getApprovalMode } from './approvalSettingsStore.js'
import {
  buildAssistantModelContext,
  collectToolCallIds,
  expandStoredMessages,
  extractVerifiedLocalFiles,
  materializeManagedAttachmentMessages,
  selectAttachmentIdsForModelRequest,
  selectStoredMessagesAfterCompaction,
} from './turnMessageContext.js'
import { prepareTurnPromptContext } from './turnPromptContext.js'
import { prepareInlineSkillsForPrompt } from './promptCompiler.js'
import {
  applyDirectoryAuthorizationToolsConfig,
  normalizeServerToolsConfig,
  restoreDirectoryAuthorizationToolSpecs,
  resolveTurnToolSpecs,
} from './turnToolSpecs.js'
import { scheduleAutoMemoryExtraction } from './autoMemoryService.js'
import {
  bindManagedAttachmentsToMessage,
  validateManagedAttachmentsForTurn,
} from './managedAttachmentStore.js'
import { prepareManagedAttachmentsForModel } from './managedAttachmentContent.js'
import {
  estimateContextTokens,
  getAutoCompactionThreshold,
} from './contextCompactionRuntime.js'
import { createTurnExecutionLeaseCoordinator } from './turnExecutionLeaseRuntime.js'
import {
  acknowledgeAppliedTurnSteering,
  acknowledgeTurnSteering,
  claimTurnSteering,
  enqueueTurnSteering,
  releaseTurnSteeringLease,
  releaseTurnSteeringLeasesForTurn,
} from './turnSteeringStore.js'
import { normalizeTurnIntentMode } from '../utils/executionIntent.js'
import { getLocalFileAccessStatus } from './localFileAccessService.js'
import { newTraceId, withLogContext } from '../utils/logger.js'

const TERMINAL_TYPES = new Set(['turn.completed', 'turn.cancelled', 'turn.failed'])
const STREAM_DELTA_TYPES = ['assistant.delta', 'reasoning.delta']
const TURN_RESOLUTION_MARKER = '[TURN_RESOLUTION:'
const ATTACHMENT_CONTEXT_HEADROOM_TOKENS = 64
const PUBLIC_TURN_FAILURE = '任务执行遇到问题，尚未完成。请重试；若仍失败，请检查模型配置和工具调用支持。'
const PUBLIC_TURN_INTERRUPTED = '模型服务暂时中断。请重试，系统会继续处理尚未完成的任务。'
const PUBLIC_TURN_INCOMPLETE = '任务未完成，未通过验证的文件不会显示或交付。请重试以继续。'
const PUBLIC_REASONING_RUNAWAY = '模型推理超过安全上限，任务已停止。请重试，或换用更适合执行工具任务的模型。'
const INTERNAL_TERMINAL_FAILURE_PATTERNS = [
  /Model call failed\s*:/i,
  /This reply could not be completed/i,
  /The requested (?:file|artifact|mutation).*?(?:was not|could not|failed)/i,
  /ARTIFACT_NOT_CREATED/i,
  /(?:tool|artifact|model)[_-](?:execution|write|call)?[_-]?failed/i,
  /(?:^|\n)\s*(?:Error|Exception|TypeError|RangeError|AbortError)\s*:/i,
  /任务未完全完成[^\n]*(?:保留|保存)/,
  /(?:已保留|保存当前)[^\n]*(?:残缺|文件|进展|工具结果)/,
]
const SUMMABLE_MODEL_USAGE_KEYS = Object.freeze([
  'cacheHitTokens',
  'cacheMissTokens',
  'cacheCreationTokens',
  'uncachedInputTokens',
])

function modelUsageTotal(usage) {
  if (Object.hasOwn(usage, 'totalTokens')) return usage.totalTokens
  return usage.promptTokens + (usage.completionTokens || 0)
}

function addModelUsage(total, value) {
  const current = normalizeModelUsage(value)
  const previous = normalizeModelUsage(total)
  if (!current) return previous

  const aggregate = {
    promptTokens: (previous?.promptTokens || 0) + current.promptTokens,
    completionTokens: (previous?.completionTokens || 0) + (current.completionTokens || 0),
    totalTokens: (previous ? modelUsageTotal(previous) : 0) + modelUsageTotal(current),
  }
  for (const key of SUMMABLE_MODEL_USAGE_KEYS) {
    if (!Object.hasOwn(previous || {}, key) && !Object.hasOwn(current, key)) continue
    aggregate[key] = (previous?.[key] || 0) + (current[key] || 0)
  }
  if (Object.hasOwn(previous || {}, 'costUsd') || Object.hasOwn(current, 'costUsd')) {
    aggregate.costUsd = (previous?.costUsd || 0) + (current.costUsd || 0)
  }
  return normalizeModelUsage(aggregate)
}

function normalizePromptTokenEstimate(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null
}

function inlineMediaProjectionTokens(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    const marker = ';base64,'
    const markerIndex = value.indexOf(marker)
    if (markerIndex <= 5 || !value.startsWith('data:')) return 0
    const mimeType = value.slice(5, markerIndex).toLowerCase()
    if (!mimeType.startsWith('image/') && mimeType !== 'application/pdf') return 0
    // Base64 is four characters per three bytes. Keep the attachment byte
    // budget separate from visual token pricing so a multi-megabyte image is
    // still downgraded before it is copied into a small-window request.
    return Math.ceil(Math.max(0, value.length - markerIndex - marker.length) / 4) + 64
  }
  if (!value || typeof value !== 'object') return 0
  if (seen.has(value)) return 0
  seen.add(value)
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + inlineMediaProjectionTokens(item, seen), 0)
  }
  return Object.values(value)
    .reduce((total, item) => total + inlineMediaProjectionTokens(item, seen), 0)
}

function replayPersistedTurnEvents(replayEvents, scope) {
  if (typeof replayEvents !== 'function') return []
  const events = []
  let after = -1
  while (true) {
    const page = replayEvents({ ...scope, after, limit: 2000 })
    if (!Array.isArray(page) || page.length === 0) break
    const fresh = page
      .filter((event) => Number.isInteger(event?.sequence) && event.sequence > after)
      .sort((left, right) => left.sequence - right.sequence)
    if (fresh.length === 0) break
    events.push(...fresh)
    const nextAfter = fresh.at(-1).sequence
    if (nextAfter <= after) break
    after = nextAfter
    if (page.length < 2000) break
  }
  return events
}

function confirmedStreamPrefix(events, checkpointSequence) {
  let assistantText = ''
  let reasoningText = ''
  for (const event of events) {
    if (event.sequence > checkpointSequence) break
    if (event.type === 'turn.attempt' && event.payload?.resetStreaming) {
      assistantText = String(event.payload.assistantText || '')
      reasoningText = String(event.payload.reasoningText || '')
    } else if (event.type === 'assistant.delta') {
      assistantText += String(event.payload?.text || '')
    } else if (event.type === 'reasoning.delta') {
      reasoningText += String(event.payload?.text || '')
    }
  }
  return { assistantText, reasoningText }
}

function recoveryAttemptAfterCheckpoint(replayEvents, scope, checkpoint) {
  const events = replayPersistedTurnEvents(replayEvents, scope)
  const checkpointSequence = Number.isInteger(checkpoint?.sequence) ? checkpoint.sequence : -1
  const terminalAfterCheckpoint = events.some((event) => (
    TERMINAL_TYPES.has(event.type) && event.sequence > checkpointSequence
  ))
  if (terminalAfterCheckpoint) return null

  const previousStream = events
    .filter((event) => STREAM_DELTA_TYPES.includes(event.type) && event.sequence > checkpointSequence)
    .at(-1)
  if (!previousStream) return null

  const previousAttempt = events.filter((event) => event.type === 'turn.attempt').at(-1)
  const previousAttemptNumber = Number(previousAttempt?.payload?.attempt)
  const prefix = confirmedStreamPrefix(events, checkpointSequence)
  return {
    attempt: Number.isInteger(previousAttemptNumber) && previousAttemptNumber > 0
      ? previousAttemptNumber + 1
      : 2,
    reason: checkpoint ? 'checkpoint_resume' : 'turn_resume',
    resetStreaming: true,
    checkpointSequence: checkpoint?.sequence ?? null,
    previousStreamSequence: previousStream.sequence,
    ...prefix,
  }
}

function latestVerifiedLocalFiles(replayEvents, scope) {
  return replayPersistedTurnEvents(replayEvents, scope)
    .map((event) => event?.payload?.verifiedLocalFiles)
    .filter(Array.isArray)
    .at(-1) || []
}

function storedCheckpointEvent(checkpoint) {
  if (!checkpoint?.state || !Number.isInteger(checkpoint.eventSequence)) return null
  return {
    sessionId: checkpoint.sessionId,
    turnId: checkpoint.turnId,
    sequence: checkpoint.eventSequence,
    type: 'turn.checkpoint',
    payload: { state: checkpoint.state },
    createdAt: checkpoint.updatedAt,
  }
}

function latestLegacyCheckpoint(replayEvents, scope) {
  return replayPersistedTurnEvents(replayEvents, scope)
    .filter((event) => event.type === 'turn.checkpoint' && isRecord(event.payload?.state))
    .at(-1) || null
}

export class TurnEngineError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'TurnEngineError'
    this.code = code
    this.status = status
  }
}

function activeKey(userId, sessionId, turnId) {
  return `${userId}\u0000${sessionId}\u0000${turnId}`
}

function sessionKey(userId, sessionId) {
  return `${userId}\u0000${sessionId}`
}

function finalClarificationText(result) {
  if (result?.text) return String(result.text)
  const clarification = result?.clarification
  if (typeof clarification === 'string') return clarification
  return String(clarification?.question || clarification?.message || '需要你补充信息后才能继续。')
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeResolutionPath(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const normalized = path.resolve(raw).replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function normalizeTurnResolution(value) {
  if (!isRecord(value)) {
    throw new TurnEngineError('TURN_RESOLUTION_INVALID', 'resolution must be a structured object', 400)
  }
  const pausedSequence = Number(value.paused_sequence ?? value.pausedSequence)
  if (!Number.isInteger(pausedSequence) || pausedSequence < 0) {
    throw new TurnEngineError(
      'TURN_RESOLUTION_SEQUENCE_REQUIRED',
      'resolution must include the pending turn.paused sequence',
      400,
    )
  }
  const type = String(value.type || '').trim()
  const rawPath = String(value.path || '').trim()
  const resourceType = String(value.resource_type || value.resourceType || '').trim()
  const directoryResolution = type === 'directory_authorization'
    || resourceType === 'directory'
    || !!rawPath
  if (directoryResolution) {
    const accessMode = String(value.access_mode || value.accessMode || '').trim()
    if (type && type !== 'directory_authorization') {
      throw new TurnEngineError('TURN_RESOLUTION_INVALID', 'directory resolution type must be directory_authorization', 400)
    }
    if (value.approved !== true) {
      throw new TurnEngineError('TURN_RESOLUTION_NOT_APPROVED', 'directory authorization must be explicitly approved', 400)
    }
    if (!rawPath || (!path.win32.isAbsolute(rawPath) && !path.posix.isAbsolute(rawPath))) {
      throw new TurnEngineError('TURN_RESOLUTION_PATH_REQUIRED', 'directory authorization requires an absolute path', 400)
    }
    if (!['read_only', 'read_write'].includes(accessMode)) {
      throw new TurnEngineError('TURN_RESOLUTION_ACCESS_MODE_INVALID', 'directory authorization requires read_only or read_write access_mode', 400)
    }
    return {
      type: 'directory_authorization',
      approved: true,
      path: rawPath,
      access_mode: accessMode,
      resource_type: 'directory',
      paused_sequence: pausedSequence,
      ...(String(value.purpose || '').trim() ? { purpose: String(value.purpose).trim() } : {}),
    }
  }
  const response = String(value.response ?? value.answer ?? value.content ?? '').trim()
  if (!response) {
    throw new TurnEngineError('TURN_RESOLUTION_RESPONSE_REQUIRED', 'clarification resolution requires a response', 400)
  }
  return { type: type || 'clarification_response', response, paused_sequence: pausedSequence }
}

function validateResolutionForPause(resolution, pausedEvent) {
  if (resolution.paused_sequence !== pausedEvent.sequence) {
    throw new TurnEngineError(
      'TURN_RESOLUTION_STALE',
      'resolution does not match the latest pending pause',
      409,
    )
  }
  const clarification = pausedEvent.payload?.clarification
  const requestType = isRecord(clarification)
    ? String(clarification.request_type || clarification.requestType || '').trim()
    : ''
  const directoryRequest = requestType === 'directory'
  const directoryResolution = resolution.type === 'directory_authorization'
  if (directoryRequest !== directoryResolution) {
    throw new TurnEngineError(
      'TURN_RESOLUTION_TYPE_MISMATCH',
      'resolution type does not match the pending clarification',
      409,
    )
  }
  if (!directoryRequest) return
  const requiredMode = String(
    clarification.access_mode || clarification.accessMode || 'read_only',
  ).trim()
  if (resolution.access_mode !== requiredMode) {
    throw new TurnEngineError(
      'TURN_RESOLUTION_ACCESS_MODE_MISMATCH',
      'directory resolution access mode does not match the pending request',
      409,
    )
  }
}

function hasSufficientDirectoryGrant(grants, resolution) {
  const expectedPath = normalizeResolutionPath(resolution.path)
  return (Array.isArray(grants) ? grants : []).some((grant) => {
    if (grant?.resourceType !== 'directory') return false
    if (grant.available === false) return false
    if (normalizeResolutionPath(grant.path) !== expectedPath) return false
    return resolution.access_mode !== 'read_write' || grant.accessMode === 'read_write'
  })
}

function turnResolutionPrompt(resolution, pausedSequence) {
  const marker = `${TURN_RESOLUTION_MARKER}${pausedSequence}]`
  if (resolution.type === 'directory_authorization') {
    return [
      marker,
      'The requested local directory authorization is already persisted and verified.',
      `Continue the original task using the exact authorized path ${JSON.stringify(resolution.path)} with ${resolution.access_mode} access.`,
      'Do not call request_directory again for this same path and access mode.',
      'If a later operation fails, handle the concrete new error instead of treating this verified grant as missing.',
    ].join(' ')
  }
  return [
    marker,
    `The user answered the pending clarification: ${JSON.stringify(resolution.response)}.`,
    'Continue the original task from the durable checkpoint and do not repeat the same clarification request.',
  ].join(' ')
}

function checkpointStateForResolution(state, resumeContext) {
  if (!isRecord(state) || !resumeContext?.resolution) return state || null
  const marker = `${TURN_RESOLUTION_MARKER}${resumeContext.pausedSequence}]`
  const messages = Array.isArray(state.messages) ? state.messages.map((message) => ({ ...message })) : []
  const resolutionRole = resumeContext.resolution.type === 'directory_authorization' ? 'system' : 'user'
  if (!messages.some((message) => (
    message?.role === resolutionRole && String(message?.content || '').includes(marker)
  ))) {
    messages.push({
      role: resolutionRole,
      content: turnResolutionPrompt(resumeContext.resolution, resumeContext.pausedSequence),
    })
  }
  const restored = { ...state, messages }
  if (isRecord(restored.final) && restored.final.paused === true) delete restored.final
  return restored
}

function pauseState(events) {
  const paused = events.filter((event) => event.type === 'turn.paused').at(-1) || null
  if (!paused) return { paused: null, resumed: null, pending: false }
  const resumed = events
    .filter((event) => event.type === 'turn.resumed' && event.sequence > paused.sequence)
    .at(-1) || null
  return { paused, resumed, pending: !resumed }
}

function publicStatus(lastEvent, running = false) {
  if (!lastEvent) return 'not_found'
  if (lastEvent.type === 'turn.paused') return 'paused'
  if (running) return 'running'
  if (lastEvent.type === 'turn.completed') return 'completed'
  if (lastEvent.type === 'turn.cancelled') return 'cancelled'
  if (lastEvent.type === 'turn.failed') return 'failed'
  if (lastEvent.type === 'turn.interrupted') return 'interrupted'
  if (lastEvent.type === 'approval.required') return 'awaiting_approval'
  return 'paused'
}

function normalizeIds(values, limit = 32) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(canonicalizeSkillId)
    .filter(Boolean))]
    .slice(0, limit)
}

function normalizeOptionalId(value, maxLength = 256) {
  const normalized = String(value || '').trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

function abortError(code, message) {
  return Object.assign(new Error(message), { name: 'AbortError', code })
}

function isExplicitTurnCancellation(signal, error) {
  if (signal?.aborted) return true
  const codes = [error?.code, error?.cause?.code, signal?.reason?.code]
    .map((value) => String(value || '').trim().toUpperCase())
  return codes.includes('TURN_CANCEL_REQUESTED') || codes.includes('USER_STOPPED')
}

function normalizeArtifactIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
}

function sameArtifactIds(left, right) {
  const normalizedLeft = normalizeArtifactIds(left)
  const normalizedRight = normalizeArtifactIds(right)
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((id, index) => id === normalizedRight[index])
}

function optionalDeliveryArtifactIds(value, fallback = undefined) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'deliveryArtifactIds')) {
    return normalizeArtifactIds(value.deliveryArtifactIds)
  }
  return fallback
}

function deliveryArtifactFields(deliveryArtifactIds) {
  return Array.isArray(deliveryArtifactIds)
    ? { deliveryArtifactIds: [...deliveryArtifactIds] }
    : {}
}

function containsInternalTerminalFailure(value) {
  return INTERNAL_TERMINAL_FAILURE_PATTERNS.some((pattern) => pattern.test(String(value || '')))
}

function publicTurnFailureMessage(error, { code = 'TURN_FAILED', fallback = PUBLIC_TURN_FAILURE } = {}) {
  const normalizedCode = String(error?.code || code || 'TURN_FAILED').trim().toUpperCase()
  const rawMessage = String(error?.message || error?.reason || '').trim()
  const status = Number(error?.status ?? error?.statusCode)
  if (normalizedCode === 'TURN_INCOMPLETE') return PUBLIC_TURN_INCOMPLETE
  if (normalizedCode === 'REASONING_RUNAWAY') return PUBLIC_REASONING_RUNAWAY
  if (normalizedCode.includes('TIMEOUT')
    || normalizedCode.includes('UNAVAILABLE')
    || normalizedCode.includes('INTERRUPT')
    || status === 408
    || status === 425
    || status === 429
    || status >= 500) {
    return PUBLIC_TURN_INTERRUPTED
  }
  if (rawMessage
    && /[\u3400-\u9fff]/u.test(rawMessage)
    && !containsInternalTerminalFailure(rawMessage)) {
    return rawMessage
  }
  return fallback
}

function publicIncompleteText(value, fallback = PUBLIC_TURN_INCOMPLETE) {
  const text = String(value || '').trim()
  if (!text || containsInternalTerminalFailure(text)) return fallback
  return text
}

function normalizeFailure(error, {
  code = 'TURN_FAILED',
  message = PUBLIC_TURN_FAILURE,
  retryable,
} = {}) {
  const normalizedCode = String(error?.code || code || 'TURN_FAILED').trim() || 'TURN_FAILED'
  const normalizedMessage = publicTurnFailureMessage(error, {
    code: normalizedCode,
    fallback: String(message || PUBLIC_TURN_FAILURE).trim() || PUBLIC_TURN_FAILURE,
  })
  const rawStatus = Number(error?.status ?? error?.statusCode)
  const status = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus
    : null
  const inferredRetryable = status !== null
    ? status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
    : error?.name === 'AbortError' || /(?:TIMEOUT|TEMPORAR|UNAVAILABLE|INTERRUPT)/i.test(normalizedCode)
  const failure = {
    code: normalizedCode,
    message: normalizedMessage,
    retryable: typeof error?.retryable === 'boolean'
      ? error.retryable
      : (typeof retryable === 'boolean' ? retryable : inferredRetryable),
  }
  if (status !== null) failure.status = status
  const rawHint = String(error?.hint || '').trim()
  if (rawHint && /[\u3400-\u9fff]/u.test(rawHint) && !containsInternalTerminalFailure(rawHint)) {
    failure.hint = rawHint
  } else if (failure.retryable) {
    failure.hint = '请重试本任务；系统会继续处理尚未完成的步骤。'
  }
  const attempts = Number(error?.attempts)
  if (Number.isInteger(attempts) && attempts > 0) failure.attempts = attempts
  return failure
}

function isTemporaryTurnEvidence(message, turnId) {
  return message?.id === `${turnId}:assistant`
    && message?.modelContext?.turnEvidence === true
}

function lostTurnLease(signal, error = null) {
  return error?.code === 'TURN_LEASE_LOST' || signal?.reason?.code === 'TURN_LEASE_LOST'
}

function normalizeAttachmentIds(values) {
  const normalized = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => typeof value === 'object' ? value?.id : value)
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
  if (normalized.length > 32) {
    throw new TurnEngineError('ATTACHMENT_COUNT_EXCEEDED', '单次最多使用 32 个附件', 400)
  }
  return normalized
}

function attachmentTurnError(error) {
  if (error instanceof TurnEngineError) return error
  const wrapped = new TurnEngineError(
    error?.code || 'ATTACHMENT_INVALID',
    error?.message || '附件不可用',
    error?.statusCode || 400,
  )
  wrapped.cause = error
  return wrapped
}

/**
 * I1：turn 链路服务端解析 `/技能前缀`（与 job 链路 resolveJobSkillContext 同规则）。
 * 调用方（前端/移动端/API）不显式传 skillIds 时，从 content 首词解析技能 ID。
 * 只在"确实带 /前缀"时返回，避免把普通文本误当技能。
 */
function resolveSkillPrefixFromContent(content, skillIds) {
  const normalized = normalizeIds(skillIds)
  if (normalized.length) return { skillIds: normalized, content }
  const match = String(content || '').trim().match(/^\/([a-z0-9_-]+)(?:\s|$)/i)
  if (!match) return { skillIds: normalized, content }
  return {
    skillIds: [match[1].toLowerCase()],
    content: String(content || '').trim().slice(match[0].length).trim(),
  }
}

function importedMessageContext(message, sourceRole) {
  if (sourceRole === 'assistant' && Array.isArray(message?.tool_calls)) {
    return { version: 1, toolCalls: message.tool_calls }
  }
  if (sourceRole === 'tool' && message?.tool_call_id) {
    return {
      version: 1,
      toolCallId: String(message.tool_call_id),
      name: message?.name ? String(message.name) : null,
    }
  }
  return null
}

export class TurnEngine {
  constructor({
    runLoop = runToolLoop,
    runModel = callStreamingModelWithTools,
    executeTool,
    appendEvent = appendTurnEvent,
    publishActivity = publishTurnActivity,
    lastEvent = getLastTurnEvent,
    replayEvents = listTurnEvents,
    readCheckpoint = getTurnCheckpoint,
    writeCheckpoint = saveTurnCheckpoint,
    readSession = getSession,
    claimSession = claimLocalChatSession,
    writeSession = upsertSession,
    readMessages = listMessages,
    readPreviousUserMessage = getPreviousUserMessage,
    writeMessage = upsertMessage,
    removeMessage = deleteMessage,
    idFactory = randomUUID,
    now = Date.now,
    toolSpecs = SERVER_TOOL_SPECS,
    readApprovalMode = getApprovalMode,
    preparePromptContext = prepareTurnPromptContext,
    resolveToolSpecs = resolveTurnToolSpecs,
    scheduleMemoryExtraction = scheduleAutoMemoryExtraction,
    runMemoryModel = callBackgroundModel,
    getContextWindow = getModelContextWindow,
    readFileAccessStatus = getLocalFileAccessStatus,
    validateAttachments = validateManagedAttachmentsForTurn,
    bindAttachments = bindManagedAttachmentsToMessage,
    prepareAttachments = prepareManagedAttachmentsForModel,
    executionLeases = createTurnExecutionLeaseCoordinator(),
    enqueueSteering = enqueueTurnSteering,
    claimSteering = claimTurnSteering,
    acknowledgeSteering = acknowledgeTurnSteering,
    acknowledgeAppliedSteering = acknowledgeAppliedTurnSteering,
    releaseSteering = releaseTurnSteeringLease,
    releaseStaleSteering = releaseTurnSteeringLeasesForTurn,
    dispatchHooks = dispatchHooksService,
    env = process.env,
  } = {}) {
    this.deps = {
      runLoop, runModel, executeTool, appendEvent, publishActivity, lastEvent, replayEvents,
      readCheckpoint, writeCheckpoint,
      readSession, claimSession, writeSession, readMessages, readPreviousUserMessage,
      writeMessage, idFactory, now, toolSpecs,
      readApprovalMode, preparePromptContext, resolveToolSpecs, scheduleMemoryExtraction, runMemoryModel, env,
      getContextWindow, readFileAccessStatus, validateAttachments, bindAttachments, prepareAttachments,
      removeMessage, executionLeases,
      enqueueSteering, claimSteering, acknowledgeSteering, acknowledgeAppliedSteering,
      releaseSteering, releaseStaleSteering, dispatchHooks,
    }
    this.active = new Map()
    this.startingSessions = new Map()
  }

  getTurn({ userId, sessionId, turnId }) {
    const key = activeKey(userId, sessionId, turnId)
    const last = this.deps.lastEvent({ userId, sessionId, turnId })
    let running = this.active.has(key)
    if (!running) {
      try { running = !!this.deps.executionLeases.isActive({ userId, sessionId, turnId }) } catch { /* advisory */ }
    }
    return last ? {
      sessionId,
      turnId,
      status: publicStatus(last, running),
      lastEvent: last,
    } : null
  }

  steerTurn({
    userId,
    sessionId,
    turnId,
    content,
    clientRequestId,
    authMode = null,
  } = {}) {
    if (!userId) throw new TurnEngineError('UNAUTHORIZED', 'Unauthorized', 401)
    if (!this.deps.readSession({ userId, sessionId }) && authMode === 'local') {
      this.#claimLegacySession({ userId, sessionId, authMode })
    }
    return this.deps.enqueueSteering({
      userId,
      sessionId,
      turnId,
      content,
      clientRequestId,
      now: this.deps.now(),
    })
  }

  hasActiveSession({ userId, sessionId } = {}) {
    if (!userId || !sessionId) return false
    if (this.startingSessions.has(sessionKey(userId, sessionId))) return true
    const prefix = `${userId}\u0000${sessionId}\u0000`
    if ([...this.active.keys()].some((key) => key.startsWith(prefix))) return true
    try { return !!this.deps.executionLeases.hasActiveSession({ userId, sessionId }) } catch { return false }
  }

  async startTurn(args) {
    // 一轮 turn 的关联上下文：userId/sessionId/turnId/traceId 沿异步链传递，
    // 期间模型代理、工具循环、压缩恢复等结构化日志都能按 turnId 串起来。
    const { userId, sessionId, turnId } = args || {}
    const resolvedTurnId = turnId || this.deps.idFactory()
    return withLogContext(
      { userId, sessionId, turnId: resolvedTurnId, traceId: newTraceId() },
      () => this.#startTurnInner({ ...args, turnId: resolvedTurnId }),
    )
  }

  async #startTurnInner({
    userId,
    sessionId,
    turnId = this.deps.idFactory(),
    content,
    displayContent = null,
    modelName = null,
    history = [],
    agentId = null,
    skillIds = [],
    skillDefinitions = [],
    toolsConfig = null,
    intentMode = 'auto',
    attachments = [],
    authMode = null,
  }) {
    const rawText = String(content || '').trim()
    const normalizedAttachmentIds = normalizeAttachmentIds(attachments)
    // I1：调用方未显式传 skillIds 时，服务端解析 `/技能前缀`（对齐 job 链路）。
    // 模型上下文使用剥离前缀后的正文，展示层保留用户原话。
    const resolvedSkill = resolveSkillPrefixFromContent(rawText, skillIds)
    const text = resolvedSkill.content || (normalizedAttachmentIds.length ? '请分析附件内容。' : '')
    const displayText = String(displayContent ?? rawText ?? '').trim() || text
    if (!userId) throw new TurnEngineError('UNAUTHORIZED', 'Unauthorized', 401)
    if (!sessionId) throw new TurnEngineError('SESSION_REQUIRED', 'sessionId is required')
    if (!text) throw new TurnEngineError('CONTENT_REQUIRED', 'content is required')
    const startingKey = sessionKey(userId, sessionId)
    this.startingSessions.set(startingKey, (this.startingSessions.get(startingKey) || 0) + 1)
    try {
      let session = this.deps.readSession({ userId, sessionId })
      if (!session && authMode === 'local') {
        session = this.#claimLegacySession({ userId, sessionId, authMode })
      }
      if (!session) {
        try {
          session = this.deps.writeSession({
            id: sessionId,
            userId,
            title: displayText.slice(0, 80) || 'Untitled',
            createdAt: this.deps.now(),
          })
        } catch (error) {
          if (error instanceof SessionOwnershipError || error?.code === 'SESSION_OWNERSHIP_CONFLICT') {
            throw new TurnEngineError('SESSION_NOT_FOUND', 'session not found', 404)
          }
          const wrapped = new TurnEngineError('SESSION_CREATE_FAILED', 'failed to create session', 500)
          wrapped.cause = error
          throw wrapped
        }
      }
      const existing = this.deps.lastEvent({ userId, sessionId, turnId })
      if (existing) {
        throw new TurnEngineError('TURN_EXISTS', 'turn already exists; use resume', 409)
      }

      const createdAt = this.deps.now()
      const normalizedAgentId = normalizeOptionalId(agentId)
      const normalizedSkillIds = normalizeIds(resolvedSkill.skillIds)
      const normalizedSkillDefinitions = prepareInlineSkillsForPrompt({
        skillIds: normalizedSkillIds,
        skillDefinitions,
      })
      const normalizedToolsConfig = normalizeServerToolsConfig(toolsConfig)
      const normalizedIntentMode = normalizeTurnIntentMode(intentMode)
      let managedAttachments = []
      try {
        managedAttachments = this.deps.validateAttachments({
          userId,
          sessionId,
          attachmentIds: normalizedAttachmentIds,
        })
      } catch (error) {
        throw attachmentTurnError(error)
      }
      const existingMessages = this.deps.readMessages({ userId, sessionId, limit: 1 })
      const safeHistory = existingMessages.length === 0 && Array.isArray(history) ? history.slice() : []
      const stagedMessageIds = []
      safeHistory.forEach((message, index) => {
        const sourceRole = ['user', 'assistant', 'system', 'tool'].includes(message?.role) ? message.role : null
        const role = sourceRole === 'tool' && !message?.tool_call_id ? 'system' : sourceRole
        if (!role || typeof message?.content !== 'string') return
        const historyMessageId = `${turnId}:history:${index}`
        this.deps.writeMessage({
          id: historyMessageId,
          userId,
          sessionId,
          role,
          modelContext: importedMessageContext(message, sourceRole),
          content: sourceRole === 'tool' ? `[历史工具结果]\n${message.content}` : message.content,
          createdAt: createdAt - safeHistory.length + index,
          updatedAt: createdAt,
        })
        stagedMessageIds.push(historyMessageId)
      })
      const userMessageId = `${turnId}:user`
      this.deps.writeMessage({
        id: userMessageId, userId, sessionId, role: 'user', content: displayText,
        modelContext: { version: 1, turnId, modelContent: text, attachments: managedAttachments },
        createdAt, updatedAt: createdAt,
      })
      stagedMessageIds.push(userMessageId)
      const rollbackStagedMessages = () => {
        for (const messageId of stagedMessageIds.reverse()) {
          try { this.deps.removeMessage({ userId, messageId }) } catch { /* best-effort compensation */ }
        }
      }
      try {
        this.deps.bindAttachments({
          userId,
          sessionId,
          messageId: `${turnId}:user`,
          attachmentIds: normalizedAttachmentIds,
          now: createdAt,
        })
      } catch (error) {
        rollbackStagedMessages()
        throw attachmentTurnError(error)
      }
      const emitter = this.#createEmitter({ userId, sessionId, turnId, sequence: 0 })
      try {
        await emitter('turn.started', {
          content: text,
          displayContent: displayText,
          modelName: modelName || null,
          agentId: normalizedAgentId,
          skillIds: normalizedSkillIds,
          skillDefinitions: normalizedSkillDefinitions,
          toolsConfig: normalizedToolsConfig,
          intentMode: normalizedIntentMode,
          userMessageId,
          attachments: managedAttachments,
          importedHistoryCount: safeHistory.length,
        })
      } catch (error) {
        rollbackStagedMessages()
        throw error
      }
      this.#schedule({
        userId,
        sessionId,
        turnId,
        turnStartedAt: createdAt,
        content: text,
        displayContent: displayText,
        modelName,
        agentId: normalizedAgentId,
        skillIds: normalizedSkillIds,
        skillDefinitions: normalizedSkillDefinitions,
        toolsConfig: normalizedToolsConfig,
        intentMode: normalizedIntentMode,
        emitter,
      })
      return this.getTurn({ userId, sessionId, turnId })
    } finally {
      const remainingStarts = (this.startingSessions.get(startingKey) || 1) - 1
      if (remainingStarts > 0) this.startingSessions.set(startingKey, remainingStarts)
      else this.startingSessions.delete(startingKey)
    }
  }

  async resumeTurn(scope) {
    const outcome = await this.recoverTurn(scope)
    return outcome.turn
  }

  /**
   * Startup recovery needs to distinguish "another process owns the lease"
   * from "this process scheduled the turn". The public resume response stays
   * unchanged; this explicit outcome is only used by durable recovery workers.
   */
  async recoverTurn({ userId, sessionId, turnId, resolution = null, authMode = null }) {
    if (!this.deps.readSession({ userId, sessionId }) && authMode === 'local') {
      this.#claimLegacySession({ userId, sessionId, authMode })
    }
    const key = activeKey(userId, sessionId, turnId)
    const started = this.deps.lastEvent({ userId, sessionId, turnId, type: 'turn.started' })
    if (!started) throw new TurnEngineError('TURN_NOT_FOUND', 'turn not found', 404)
    let last = this.deps.lastEvent({ userId, sessionId, turnId })
    if (TERMINAL_TYPES.has(last?.type)) {
      return {
        turn: this.getTurn({ userId, sessionId, turnId }),
        scheduled: false,
        locallyActive: false,
        terminal: true,
      }
    }
    const scope = { userId, sessionId, turnId }
    const persistedEvents = replayPersistedTurnEvents(this.deps.replayEvents, scope)
    const pause = pauseState(persistedEvents)
    const normalizedResolution = resolution == null ? null : normalizeTurnResolution(resolution)
    let resumeContext = pause.resumed ? {
      resolution: pause.resumed.payload.resolution,
      pausedSequence: pause.resumed.payload.pausedSequence,
    } : null
    const running = this.active.get(key)

    if (pause.pending) {
      if (!normalizedResolution) {
        return {
          turn: { ...this.getTurn(scope), status: 'paused' },
          scheduled: false,
          locallyActive: false,
          terminal: false,
          paused: true,
        }
      }
      validateResolutionForPause(normalizedResolution, pause.paused)
      if (normalizedResolution.type === 'directory_authorization') {
        let grants
        try {
          grants = this.deps.readFileAccessStatus({ userId })?.grants || []
        } catch (error) {
          const wrapped = new TurnEngineError(
            'TURN_DIRECTORY_GRANT_CHECK_FAILED',
            'failed to verify the persisted directory authorization',
            500,
          )
          wrapped.cause = error
          throw wrapped
        }
        if (!hasSufficientDirectoryGrant(grants, normalizedResolution)) {
          throw new TurnEngineError(
            'TURN_DIRECTORY_GRANT_NOT_FOUND',
            'the requested directory authorization is not persisted for this user',
            403,
          )
        }
      }
      const resumeEmitter = this.#createEmitter({
        userId,
        sessionId,
        turnId,
        sequence: last.sequence + 1,
      })
      const resumedEvent = await resumeEmitter('turn.resumed', {
        resolution: normalizedResolution,
        pausedSequence: pause.paused.sequence,
      })
      resumeContext = {
        resolution: normalizedResolution,
        pausedSequence: pause.paused.sequence,
      }
      last = resumedEvent
      if (running?.promise) await running.promise
      last = this.deps.lastEvent({ userId, sessionId, turnId }) || last
      if (TERMINAL_TYPES.has(last?.type)) {
        return {
          turn: this.getTurn(scope),
          scheduled: false,
          locallyActive: false,
          terminal: true,
        }
      }
    } else if (running) {
      return {
        turn: this.getTurn(scope),
        scheduled: false,
        locallyActive: true,
        terminal: false,
      }
    }

    const emitter = this.#createEmitter({ userId, sessionId, turnId, sequence: last.sequence + 1 })
    const scheduled = this.#schedule({
      userId,
      sessionId,
      turnId,
      turnStartedAt: started.createdAt,
      content: String(started.payload.content || ''),
      displayContent: String(started.payload.displayContent || started.payload.content || ''),
      modelName: started.payload.modelName || null,
      agentId: normalizeOptionalId(started.payload.agentId),
      skillIds: normalizeIds(started.payload.skillIds),
      skillDefinitions: prepareInlineSkillsForPrompt({
        skillIds: normalizeIds(started.payload.skillIds),
        skillDefinitions: started.payload.skillDefinitions,
      }),
      toolsConfig: normalizeServerToolsConfig(started.payload.toolsConfig),
      intentMode: normalizeTurnIntentMode(started.payload.intentMode),
      resumeContext,
      emitter,
    })
    return {
      turn: this.getTurn({ userId, sessionId, turnId }),
      scheduled,
      locallyActive: scheduled || this.active.has(key),
      terminal: false,
    }
  }

  async cancelTurn({ userId, sessionId, turnId, authMode = null }) {
    if (!this.deps.readSession({ userId, sessionId }) && authMode === 'local') {
      this.#claimLegacySession({ userId, sessionId, authMode })
    }
    const key = activeKey(userId, sessionId, turnId)
    const running = this.active.get(key)
    const scope = { userId, sessionId, turnId }
    if (running) {
      try { this.deps.executionLeases.requestCancellation(scope) } catch { /* local abort still applies */ }
      running.controller.abort(abortError('TURN_CANCEL_REQUESTED', 'Cancelled by user'))
      releaseApprovalsForTurn({ userId, sessionId, turnId })
      return { ...this.getTurn({ userId, sessionId, turnId }), status: 'cancelling' }
    }
    const last = this.deps.lastEvent({ userId, sessionId, turnId })
    if (!last) throw new TurnEngineError('TURN_NOT_FOUND', 'turn not found', 404)
    if (TERMINAL_TYPES.has(last.type)) return this.getTurn({ userId, sessionId, turnId })
    let cancellationRequested = false
    try { cancellationRequested = this.deps.executionLeases.requestCancellation(scope) } catch { /* fall through */ }
    if (cancellationRequested) {
      releaseApprovalsForTurn({ userId, sessionId, turnId })
      return { ...this.getTurn({ userId, sessionId, turnId }), status: 'cancelling' }
    }
    const emit = this.#createEmitter({ userId, sessionId, turnId, sequence: last.sequence + 1 })
    await emit('turn.cancelled', {
      reason: 'Cancelled by user',
      verifiedLocalFiles: latestVerifiedLocalFiles(this.deps.replayEvents, scope),
    })
    releaseApprovalsForTurn({ userId, sessionId, turnId })
    return this.getTurn({ userId, sessionId, turnId })
  }

  waitForTurn({ userId, sessionId, turnId }) {
    return this.active.get(activeKey(userId, sessionId, turnId))?.promise || Promise.resolve()
  }

  #claimLegacySession({ userId, sessionId, authMode }) {
    try {
      return this.deps.claimSession({ userId, sessionId, authMode })
    } catch (error) {
      const wrapped = new TurnEngineError('SESSION_CLAIM_FAILED', 'failed to claim legacy session', 500)
      wrapped.cause = error
      throw wrapped
    }
  }

  #createEmitter({ userId, sessionId, turnId, sequence }) {
    let nextSequence = sequence
    let appendQueue = Promise.resolve()
    return (type, payload = {}, { beforeAppend, checkpointState = null } = {}) => {
      const pending = appendQueue.then(async () => {
        const event = createTurnEvent({
          id: this.deps.idFactory(), sessionId, turnId, sequence: nextSequence, type,
          payload, createdAt: this.deps.now(),
        })
        await beforeAppend?.(event)
        const stored = await this.deps.appendEvent({ userId, event, checkpointState })
        nextSequence += 1
        return stored
      })
      // A failed append must reject its own caller without permanently
      // poisoning the per-turn queue used by later failure/terminal events.
      appendQueue = pending.catch(() => {})
      return pending
    }
  }

  #schedule(context) {
    const key = activeKey(context.userId, context.sessionId, context.turnId)
    if (this.active.has(key)) return false
    const scope = { userId: context.userId, sessionId: context.sessionId, turnId: context.turnId }
    if (!this.deps.executionLeases.claim(scope)) return false
    const controller = new AbortController()
    const releaseLease = this.deps.executionLeases.hold(scope, controller)
    const entry = { controller, promise: null, releaseLease }
    this.active.set(key, entry)
    entry.promise = Promise.resolve()
      .then(() => this.#execute(context, controller.signal))
      .finally(() => {
        try { releaseLease?.() } finally {
          if (this.active.get(key) === entry) this.active.delete(key)
        }
      })
    entry.promise.catch(() => {})
    return true
  }

  async #execute({
    userId,
    sessionId,
    turnId,
    turnStartedAt,
    content,
    displayContent,
    modelName,
    agentId,
    skillIds,
    skillDefinitions,
    toolsConfig,
    intentMode,
    resumeContext,
    emitter,
  }, signal) {
    if (signal.aborted) {
      if (!lostTurnLease(signal)) {
        await emitter('turn.cancelled', {
          reason: signal.reason?.message || 'Cancelled by user',
          verifiedLocalFiles: [],
        })
      }
      return
    }
    const checkpointScope = { userId, sessionId, turnId }
    const effectiveTurnStartedAt = Number.isFinite(Number(turnStartedAt))
      ? Math.max(0, Number(turnStartedAt))
      : this.deps.now()
    const checkpoint = storedCheckpointEvent(this.deps.readCheckpoint(checkpointScope))
      || latestLegacyCheckpoint(this.deps.replayEvents, checkpointScope)
    const restoredCheckpointState = checkpointStateForResolution(checkpoint?.payload?.state, resumeContext)
    const steeringOwnerId = normalizeOptionalId(this.deps.executionLeases.ownerId)
    const steeringScope = { userId, sessionId, turnId, ownerId: steeringOwnerId }
    if (steeringOwnerId) {
      const appliedSteeringIds = Array.isArray(checkpoint?.payload?.state?.appliedSteeringIds)
        ? checkpoint.payload.state.appliedSteeringIds
        : []
      this.deps.acknowledgeAppliedSteering({
        ...steeringScope,
        steeringIds: appliedSteeringIds,
        now: this.deps.now(),
      })
      this.deps.releaseStaleSteering({ ...steeringScope, now: this.deps.now() })
    }
    let pendingRecoveryAttempt = recoveryAttemptAfterCheckpoint(
      this.deps.replayEvents,
      { userId, sessionId, turnId },
      checkpoint,
    )
    const storedMessages = this.deps.readMessages({ userId, sessionId, limit: 500, recent: true })
      .filter((message) => !isTemporaryTurnEvidence(message, turnId))
      .filter((message) => !(
        message?.id === `${turnId}:assistant`
          && message?.modelContext?.paused === true
      ))
      .filter((message) => !(
        message?.modelContext?.liveSteering === true
          && message?.modelContext?.turnId === turnId
      ))
      .map((message) => message.id === `${turnId}:user`
        ? { ...message, content }
        : message)
    const currentUserMessage = storedMessages.find((message) => message.id === `${turnId}:user`)
    const previousUserPrompt = this.deps.readPreviousUserMessage({
      userId,
      sessionId,
      messageId: `${turnId}:user`,
    })?.content || ''
    const managedAttachments = Array.isArray(currentUserMessage?.modelContext?.attachments)
      ? currentUserMessage.modelContext.attachments
      : []
    let promptContext = {
      messages: [],
      effectiveAgentId: agentId,
      skillIds,
      memoryIds: [],
      compactionArchiveId: null,
      compactionBoundary: null,
    }
    try {
      promptContext = await this.deps.preparePromptContext({
        userId,
        agentId,
        skillIds,
        skillDefinitions,
        sessionId,
        recentMessages: storedMessages,
        includeRecentTranscript: false,
        query: content,
        env: this.deps.env,
      }) || promptContext
    } catch {
      // Optional memory/agent/skill context must never prevent a turn from running.
    }
    const selectedStoredMessages = selectStoredMessagesAfterCompaction(
      storedMessages,
      promptContext.compactionBoundary,
    )
    const promptStoredMessages = currentUserMessage
      && !selectedStoredMessages.some((message) => message?.id === currentUserMessage.id)
      ? [...selectedStoredMessages, currentUserMessage]
      : selectedStoredMessages
    const historyMessages = expandStoredMessages(promptStoredMessages)
    const messages = [
      ...(Array.isArray(promptContext.messages) ? promptContext.messages : []),
      ...historyMessages,
    ]
    const attachmentIdsForFirstModelRequest = selectAttachmentIdsForModelRequest(messages, {
      currentAttachmentIds: managedAttachments.map((attachment) => attachment.id),
      prompt: content,
    })
    let shouldInlineManagedAttachments = attachmentIdsForFirstModelRequest.length > 0
    const effectiveToolsConfig = applyDirectoryAuthorizationToolsConfig(
      toolsConfig,
      resumeContext?.resolution,
    )
    const effectiveIntentMode = resumeContext?.resolution?.type === 'directory_authorization'
      && resumeContext.resolution.access_mode === 'read_write'
      ? 'execute'
      : normalizeTurnIntentMode(intentMode)
    const preparedSkillIds = normalizeIds(promptContext.skillIds)
    const effectiveSkillIds = preparedSkillIds.length ? preparedSkillIds : normalizeIds(skillIds)
    const effectiveApprovalMode = this.deps.readApprovalMode({ userId })
    let resolvedToolSpecs = this.deps.toolSpecs
    let toolResolutionDecision = null
    try {
      const authorizationAwareBaseSpecs = restoreDirectoryAuthorizationToolSpecs(
        this.deps.toolSpecs,
        resumeContext?.resolution,
        SERVER_TOOL_SPECS,
      )
      const resolved = await this.deps.resolveToolSpecs({
        userId,
        baseSpecs: authorizationAwareBaseSpecs,
        toolsConfig: effectiveToolsConfig,
        permissionMode: effectiveApprovalMode,
        prompt: content,
        messages,
        skillIds: effectiveSkillIds,
        onDecision: (decision) => { toolResolutionDecision = decision },
      })
      if (Array.isArray(resolved)) {
        resolvedToolSpecs = resolved
        if (!toolResolutionDecision) {
          toolResolutionDecision = {
            version: 1,
            eligibleToolNames: resolved
              .map((spec) => String(spec?.function?.name || '').trim())
              .filter(Boolean)
              .sort()
              .slice(0, 256),
            excludedTools: [],
            discoveryIssues: [],
          }
        }
      }
    } catch {
      // MCP/browser discovery is optional; retain the built-in tool set on failure.
      toolResolutionDecision = {
        version: 1,
        eligibleToolNames: resolvedToolSpecs
          .map((spec) => String(spec?.function?.name || '').trim())
          .filter(Boolean)
          .sort()
          .slice(0, 256),
        excludedTools: [],
        discoveryIssues: [{ source: 'tool_resolution', reason: 'discovery_failed' }],
      }
    }
    const activeSkillId = effectiveSkillIds.at(0) || null
    const baselineToolCallIds = collectToolCallIds(messages)
    let checkpointMessages = restoredCheckpointState?.messages || []
    let checkpointArtifactIds = normalizeArtifactIds(restoredCheckpointState?.artifactIds)
    let checkpointDeliveryArtifactIds = optionalDeliveryArtifactIds(restoredCheckpointState)
    let checkpointIterations = Math.max(0, Number(restoredCheckpointState?.iterations) || 0)
    let checkpointRecovery = restoredCheckpointState?.recovery || null
    let latestModelUsage = normalizeModelUsage(restoredCheckpointState?.latestModelUsage)
    let turnModelUsage = normalizeModelUsage(restoredCheckpointState?.turnModelUsage)
      || latestModelUsage
    let latestEstimatedPromptTokens = normalizePromptTokenEstimate(
      restoredCheckpointState?.latestEstimatedPromptTokens,
    )
    let streamedAssistantText = String(pendingRecoveryAttempt?.assistantText || '')
    const verifiedLocalFilesAt = (verifiedAt = this.deps.now()) => extractVerifiedLocalFiles(
      checkpointMessages,
      { userId, baselineToolCallIds, verifiedAt },
    )
    const persistTurnEvidence = ({
      state,
      text,
      artifactIds,
      deliveryArtifactIds,
      iterations,
      error = null,
      serverLastSequence = null,
      verifiedLocalFiles = null,
    }) => {
      const evidenceText = String(text || '').trim() || error?.message || 'Turn execution did not complete.'
      const evidenceArtifacts = normalizeArtifactIds(artifactIds)
      const evidenceIterations = Math.max(0, Number(iterations) || 0)
      const writtenAt = this.deps.now()
      const evidenceVerifiedLocalFiles = Array.isArray(verifiedLocalFiles)
        ? verifiedLocalFiles
        : verifiedLocalFilesAt(writtenAt)
      this.deps.writeMessage({
        id: `${turnId}:assistant`,
        userId,
        sessionId,
        role: 'assistant',
        content: evidenceText,
        modelContext: {
          ...buildAssistantModelContext({
            turnId,
            checkpointMessages,
            baselineToolCallIds,
            userId,
            verifiedLocalFiles: evidenceVerifiedLocalFiles,
            artifactIds: evidenceArtifacts,
            deliveryArtifactIds,
            iterations: evidenceIterations,
            compactionRecovery: checkpointRecovery,
            usage: latestModelUsage,
            turnModelUsage,
            estimatedPromptTokens: latestEstimatedPromptTokens,
            turnStartedAt: effectiveTurnStartedAt,
            turnCompletedAt: writtenAt,
          }),
          turnEvidence: true,
          evidenceState: state,
          ...(Number.isInteger(serverLastSequence) && serverLastSequence >= 0
            ? { serverLastSequence }
            : {}),
          ...(error ? { error } : {}),
        },
        createdAt: writtenAt,
        updatedAt: writtenAt,
      })
      return evidenceText
    }
    let contextWindow
    try {
      contextWindow = this.deps.getContextWindow({
        userId,
        modelName: modelName || undefined,
        env: this.deps.env,
      })
    } catch {
      // Endpoint metadata is advisory; model execution remains available if discovery fails.
    }
    try {
      const result = await this.deps.runLoop({
        job: {
          id: turnId,
          userId,
          sessionId,
          modelName: String(modelName || '').trim() || null,
          agentId: promptContext.effectiveAgentId || agentId || null,
          skillIds: effectiveSkillIds,
          skillDefinitions,
          origin: 'chat',
          prompt: content,
          userPrompt: displayContent || content,
          previousUserPrompt,
          title: content.slice(0, 120),
          managedAttachments,
          hasManagedAttachments: managedAttachments.length > 0,
        },
        step: { id: turnId, kind: 'chat' },
        messages,
        contextWindow,
        intentMode: effectiveIntentMode,
        signal,
        toolSpecs: resolvedToolSpecs,
        // The loop may progressively remount tools for an execution turn, but
        // its recovery catalog must remain the same user-configured catalog
        // resolved above. Never let it fall back to the global server catalog.
        fallbackToolSpecs: resolvedToolSpecs,
        toolResolutionDecision,
        skillId: activeSkillId,
        executeTool: this.deps.executeTool,
        approvalOrigin: 'chat',
        approvalSessionId: sessionId,
        approvalMode: effectiveApprovalMode,
        claimSteering: steeringOwnerId
          ? async () => this.deps.claimSteering({
              ...steeringScope,
              now: this.deps.now(),
            })
          : null,
        acknowledgeSteering: steeringOwnerId
          ? async (leaseId) => this.deps.acknowledgeSteering({
              ...steeringScope,
              leaseId,
              now: this.deps.now(),
            })
          : null,
        releaseSteering: steeringOwnerId
          ? async (leaseId) => this.deps.releaseSteering({
              ...steeringScope,
              leaseId,
              now: this.deps.now(),
            })
          : null,
        beforeFinalCompletion: steeringOwnerId
          ? async () => {
              const decision = this.deps.executionLeases.closeSteeringInbox({ userId, sessionId, turnId })
              if (!decision?.closed && decision?.reason !== 'pending') {
                throw abortError('TURN_LEASE_LOST', 'Turn execution lease was lost before completion')
              }
              return decision
            }
          : null,
        loadCheckpoint: async () => restoredCheckpointState || null,
        saveCheckpoint: async (state) => {
          const checkpointState = {
            ...state,
            ...(latestModelUsage ? { latestModelUsage } : {}),
            ...(turnModelUsage ? { turnModelUsage } : {}),
            ...(latestEstimatedPromptTokens !== null ? { latestEstimatedPromptTokens } : {}),
          }
          checkpointMessages = Array.isArray(checkpointState?.messages)
            ? checkpointState.messages
            : checkpointMessages
          const nextCheckpointArtifactIds = normalizeArtifactIds(
            checkpointState?.artifactIds ?? checkpointArtifactIds,
          )
          const artifactCollectionChanged = !sameArtifactIds(checkpointArtifactIds, nextCheckpointArtifactIds)
          checkpointArtifactIds = nextCheckpointArtifactIds
          checkpointDeliveryArtifactIds = optionalDeliveryArtifactIds(
            checkpointState,
            artifactCollectionChanged ? [] : checkpointDeliveryArtifactIds,
          )
          checkpointIterations = Math.max(0, Number(checkpointState?.iterations) || checkpointIterations)
          checkpointRecovery = checkpointState?.recovery || checkpointRecovery
          const checkpointEvent = await emitter('turn.checkpoint', {
            storage: 'turn_checkpoints',
            checkpointVersion: 1,
            iterations: checkpointIterations,
            toolCallCount: Array.isArray(checkpointState?.toolCalls) ? checkpointState.toolCalls.length : 0,
          }, { checkpointState })
          let saved = this.deps.readCheckpoint({ userId, sessionId, turnId })
          if (saved?.eventSequence !== checkpointEvent.sequence) {
            // Custom event-store adapters may not implement the atomic
            // checkpointState extension. Preserve dependency compatibility
            // with a post-append upsert fallback.
            saved = await this.deps.writeCheckpoint({
              userId,
              sessionId,
              turnId,
              eventSequence: checkpointEvent.sequence,
              state: checkpointState,
              now: checkpointEvent.createdAt,
            })
          }
          if (!saved?.state) throw new Error('Failed to persist turn checkpoint')
          return true
        },
        runModel: async (request) => {
          if (pendingRecoveryAttempt) {
            const attempt = pendingRecoveryAttempt
            pendingRecoveryAttempt = null
            streamedAssistantText = String(attempt.assistantText || '')
            await emitter('turn.attempt', attempt)
          }
          const inlineAttachmentIds = shouldInlineManagedAttachments
            ? attachmentIdsForFirstModelRequest
            : []
          shouldInlineManagedAttachments = false
          const materializationOptions = { userId, sessionId }
          let providerMessages
          if (inlineAttachmentIds.length > 0) {
            // Context compaction prices the lightweight stored surface. Build a
            // reference-only provider projection first so attachment bytes and
            // extracted text receive only the genuinely remaining request budget.
            const referenceMessages = await materializeManagedAttachmentMessages(request.messages, {
              ...materializationOptions,
              prepareAttachments: this.deps.prepareAttachments,
              inlineAttachmentIds: [],
            })
            const threshold = getAutoCompactionThreshold(
              contextWindow,
              this.deps.env?.MODEL_ACTIVE_CONTEXT_TOKENS,
            )
            const referenceTokens = estimateContextTokens(referenceMessages, request.tools)
            const maxAttachmentTokens = Math.max(
              0,
              threshold - referenceTokens - ATTACHMENT_CONTEXT_HEADROOM_TOKENS,
            )
            providerMessages = maxAttachmentTokens > 0
              ? await materializeManagedAttachmentMessages(request.messages, {
                  ...materializationOptions,
                  prepareAttachments: (attachmentRequest) => this.deps.prepareAttachments({
                    ...attachmentRequest,
                    maxAttachmentTokens,
                  }),
                  inlineAttachmentIds,
                })
              : referenceMessages

            // Re-price text/tool context after expansion and independently
            // enforce the raw inline-media budget. Visual models do not tokenize
            // base64 as text, but very large media still must not bypass the
            // attachment allocation merely because its visual token cost is low.
            if (
              inlineMediaProjectionTokens(providerMessages) > maxAttachmentTokens
              || estimateContextTokens(providerMessages, request.tools) >= threshold
            ) {
              providerMessages = referenceMessages
            }
            const finalTokens = estimateContextTokens(providerMessages, request.tools)
            if (finalTokens >= threshold) {
              const error = new Error(
                `附件展开后的请求仍超出上下文预算（估算 ${finalTokens} token，阈值 ${threshold} token）。`,
              )
              error.code = 'ATTACHMENT_CONTEXT_BUDGET_EXCEEDED'
              error.status = 413
              error.retryable = false
              throw error
            }
          } else {
            providerMessages = await materializeManagedAttachmentMessages(request.messages, {
              ...materializationOptions,
              prepareAttachments: this.deps.prepareAttachments,
              inlineAttachmentIds,
            })
          }
          latestEstimatedPromptTokens = estimateContextTokens(providerMessages, request.tools)
          const inheritedToolCallReady = request.onToolCallReady
          return this.deps.runModel({
            ...request,
            messages: providerMessages,
            userId,
            modelName: modelName || undefined,
            onToolCallReady: async (call, metadata = {}) => {
              if (typeof inheritedToolCallReady === 'function') {
                await inheritedToolCallReady(call, metadata)
              }
              const toolName = String(call?.function?.name || call?.name || '').trim()
              if (!toolName) return
              await this.deps.publishActivity({
                userId,
                activity: createTurnActivity({
                  sessionId,
                  turnId,
                  kind: 'tool_call_ready',
                  toolName,
                  modelName: metadata.modelName || null,
                  createdAt: this.deps.now(),
                }),
              })
            },
            onFailover: async (payload) => {
              await emitter('model.failover', payload)
            },
            onRetry: async (payload) => {
              await emitter('model.failover', payload)
            },
          })
        },
        onModelPhase: async ({ phase, iteration, usage, modelName: activeModel, error }) => {
          const normalizedUsage = phase === 'completed' ? normalizeModelUsage(usage) : null
          if (normalizedUsage) {
            latestModelUsage = normalizedUsage
            turnModelUsage = addModelUsage(turnModelUsage, normalizedUsage)
          }
          await emitter('model.phase', {
            phase,
            iteration,
            usage: normalizedUsage || usage,
            modelName: activeModel,
            error,
          })
        },
        onModelDelta: async ({ text: delta, iteration, modelName: activeModel }) => {
          streamedAssistantText += String(delta || '')
          await emitter('assistant.delta', { text: delta, iteration, modelName: activeModel })
        },
        onReasoningDelta: async ({ text: delta, iteration, modelName: activeModel }) => {
          await emitter('reasoning.delta', { text: delta, iteration, modelName: activeModel })
        },
        onProgress: async ({ completed, total, iteration, filesChanged, additions, deletions, phase } = {}) => {
          await emitter('turn.progress', {
            ...(completed !== undefined ? { completed } : {}),
            ...(total !== undefined ? { total } : {}),
            ...(iteration !== undefined ? { iteration } : {}),
            ...(filesChanged !== undefined ? { filesChanged } : {}),
            ...(additions !== undefined ? { additions } : {}),
            ...(deletions !== undefined ? { deletions } : {}),
            ...(phase !== undefined ? { phase } : {}),
          })
        },
        onToolCall: async (call) => emitter('tool.call', {
          toolCallId: call.id, name: call.name, args: call.args,
        }),
        onToolStarted: async (call) => emitter('tool.started', {
          toolCallId: call.id, name: call.name, args: call.args, outputReplay: 'live_only',
        }),
        onToolCompleted: async (outcome) => {
          const failure = outcome.result?.ok === false ? {
            code: String(outcome.result.code || 'tool_execution_failed'),
            message: String(outcome.result.error || 'Tool execution failed.'),
            retryable: outcome.result.retryable === true,
            ...(Number.isInteger(outcome.result.status) ? { status: outcome.result.status } : {}),
            ...(outcome.result.hint ? { hint: String(outcome.result.hint) } : {}),
            ...(Number.isInteger(outcome.result.attempts) ? { attempts: outcome.result.attempts } : {}),
          } : null
          return emitter('tool.completed', {
            toolCallId: outcome.call.id, name: outcome.call.name,
            args: outcome.executionArgs ?? outcome.call.args,
            result: outcome.result,
            error: failure,
            artifactId: outcome.artifactId || null,
            artifacts: Array.isArray(outcome.artifacts) ? outcome.artifacts : [],
          })
        },
        onApprovalPending: async (approval) => emitter('approval.required', {
          approvalId: approval.id, toolName: approval.toolName, args: approval.args,
          risk: approval.risk, reason: approval.reason, expiresAt: approval.expiresAt,
        }),
        onApprovalResolved: async (decision) => emitter('approval.resolved', {
          approvalId: decision.approvalId || null,
          proceed: !!decision.proceed,
          edited: !!decision.edited,
          args: decision.args ?? null,
          reason: decision.reason || null,
        }),
      })
      if (signal.aborted) {
        if (lostTurnLease(signal)) return
        const verifiedLocalFiles = verifiedLocalFilesAt()
        await emitter('turn.cancelled', {
          reason: 'Cancelled by user',
          artifactIds: normalizeArtifactIds(checkpointArtifactIds),
          deliveryArtifactIds: [],
          verifiedLocalFiles,
          iterations: checkpointIterations,
          ...(latestModelUsage ? { usage: latestModelUsage } : {}),
          ...(turnModelUsage ? { turnModelUsage } : {}),
          ...(latestEstimatedPromptTokens !== null ? { estimatedPromptTokens: latestEstimatedPromptTokens } : {}),
        })
        return
      }
      if (result?.interrupted) {
        const artifactIds = normalizeArtifactIds(result.artifactIds ?? checkpointArtifactIds)
        const deliveryArtifactIds = []
        const iterations = Math.max(0, Number(result.iterations) || checkpointIterations)
        const partialText = publicIncompleteText(
          result.text || streamedAssistantText,
          PUBLIC_TURN_INTERRUPTED,
        )
        const verifiedLocalFiles = verifiedLocalFilesAt()
        const failure = normalizeFailure({
          code: result.code,
          message: result.reason,
          retryable: true,
        }, { code: 'MODEL_CALL_INTERRUPTED', retryable: true })
        await emitter('turn.interrupted', {
          code: String(result.code || 'MODEL_CALL_INTERRUPTED'),
          message: failure.message,
          retryable: true,
          text: partialText,
          artifactIds,
          ...deliveryArtifactFields(deliveryArtifactIds),
          verifiedLocalFiles,
          iterations,
          ...(latestModelUsage ? { usage: latestModelUsage } : {}),
          ...(turnModelUsage ? { turnModelUsage } : {}),
          ...(latestEstimatedPromptTokens !== null ? { estimatedPromptTokens: latestEstimatedPromptTokens } : {}),
        }, {
          beforeAppend: (interruptedEvent) => persistTurnEvidence({
            state: 'interrupted',
            text: partialText,
            artifactIds,
            deliveryArtifactIds,
            iterations,
            error: failure,
            serverLastSequence: interruptedEvent.sequence,
            verifiedLocalFiles,
          }),
        })
        return
      }
      if (result?.incomplete) {
        const partialText = publicIncompleteText(result.text || streamedAssistantText)
        const nonRetryable = result.code === 'REASONING_RUNAWAY'
        const failure = normalizeFailure({
          code: nonRetryable ? result.code : 'TURN_INCOMPLETE',
          // Keep the wrap-up in partialText and the machine reason in the
          // hint. Reusing the wrap-up as the error message would make clients
          // append the same useful result a second time as an error banner.
          message: PUBLIC_TURN_INCOMPLETE,
          retryable: !nonRetryable,
          hint: '请重试本任务；系统会继续处理尚未完成的步骤。',
        }, { retryable: !nonRetryable })
        const artifactIds = normalizeArtifactIds(result.artifactIds ?? checkpointArtifactIds)
        const deliveryArtifactIds = []
        const iterations = Math.max(0, Number(result.iterations) || checkpointIterations)
        const verifiedLocalFiles = verifiedLocalFilesAt()
        persistTurnEvidence({
          state: 'failed',
          text: partialText,
          artifactIds,
          deliveryArtifactIds,
          iterations,
          error: failure,
          verifiedLocalFiles,
        })
        await emitter('turn.failed', {
          code: failure.code,
          message: failure.message,
          error: failure,
          partialText,
          artifactIds,
          ...deliveryArtifactFields(deliveryArtifactIds),
          verifiedLocalFiles,
          iterations,
          ...(latestModelUsage ? { usage: latestModelUsage } : {}),
          ...(turnModelUsage ? { turnModelUsage } : {}),
          ...(latestEstimatedPromptTokens !== null ? { estimatedPromptTokens: latestEstimatedPromptTokens } : {}),
        })
        return
      }
      if (result?.paused) {
        const text = finalClarificationText(result)
        const clarification = isRecord(result.clarification) || typeof result.clarification === 'string'
          ? result.clarification
          : { question: text, blocker_kind: 'missing_info' }
        const artifactIds = normalizeArtifactIds(result.artifactIds ?? checkpointArtifactIds)
        const deliveryArtifactIds = []
        const iterations = Math.max(0, Number(result.iterations) || checkpointIterations)
        const verifiedLocalFiles = verifiedLocalFilesAt()
        await emitter('turn.paused', {
          text,
          clarification,
          artifactIds,
          ...deliveryArtifactFields(deliveryArtifactIds),
          verifiedLocalFiles,
          iterations,
          ...(latestModelUsage ? { usage: latestModelUsage } : {}),
          ...(turnModelUsage ? { turnModelUsage } : {}),
          ...(latestEstimatedPromptTokens !== null ? { estimatedPromptTokens: latestEstimatedPromptTokens } : {}),
        }, {
          beforeAppend: (pausedEvent) => {
            const pausedAt = this.deps.now()
            this.deps.writeMessage({
              id: `${turnId}:assistant`,
              userId,
              sessionId,
              role: 'assistant',
              content: text,
              modelContext: {
                ...buildAssistantModelContext({
                  turnId,
                  checkpointMessages,
                  baselineToolCallIds,
                  userId,
                  verifiedLocalFiles,
                  artifactIds,
                  deliveryArtifactIds,
                  iterations,
                  paused: true,
                  compactionArchiveId: result?.recovery?.archiveId || null,
                  compactionRecovery: result?.recovery || checkpointRecovery,
                  usage: latestModelUsage,
                  turnModelUsage,
                  estimatedPromptTokens: latestEstimatedPromptTokens,
                  turnStartedAt: effectiveTurnStartedAt,
                  turnCompletedAt: pausedAt,
                }),
                clarification,
                pausedSequence: pausedEvent.sequence,
              },
              createdAt: pausedAt,
              updatedAt: pausedAt,
            })
          },
        })
        return
      }
      const text = String(result?.text || '(任务已结束，但模型没有返回文本。)')
      const artifactIds = normalizeArtifactIds(result?.artifactIds ?? checkpointArtifactIds)
      const deliveryArtifactIds = optionalDeliveryArtifactIds(result, checkpointDeliveryArtifactIds)
      const completedAt = this.deps.now()
      const verifiedLocalFiles = verifiedLocalFilesAt(completedAt)
      this.deps.writeMessage({
        id: `${turnId}:assistant`, userId, sessionId, role: 'assistant', content: text,
        modelContext: buildAssistantModelContext({
          turnId,
          checkpointMessages,
          baselineToolCallIds,
          userId,
          verifiedLocalFiles,
          artifactIds,
          deliveryArtifactIds,
          iterations: result?.iterations || 0,
          compactionArchiveId: result?.recovery?.archiveId || null,
          compactionRecovery: result?.recovery || checkpointRecovery,
          usage: latestModelUsage,
          turnModelUsage,
          estimatedPromptTokens: latestEstimatedPromptTokens,
          turnStartedAt: effectiveTurnStartedAt,
          turnCompletedAt: completedAt,
        }),
        createdAt: completedAt, updatedAt: completedAt,
      })
      await emitter('turn.completed', {
        text,
        artifactIds,
        ...deliveryArtifactFields(deliveryArtifactIds),
        verifiedLocalFiles,
        iterations: result?.iterations || 0,
        ...(latestModelUsage ? { usage: latestModelUsage } : {}),
        ...(turnModelUsage ? { turnModelUsage } : {}),
        ...(latestEstimatedPromptTokens !== null ? { estimatedPromptTokens: latestEstimatedPromptTokens } : {}),
      })
      // Best-effort async notification to external subscribers.
      void this.deps.dispatchHooks?.({
        userId,
        event: 'notification',
        tool: null,
        args: {
          text: String(text || '').slice(0, 4_000),
          artifactIds,
          ...deliveryArtifactFields(deliveryArtifactIds),
          iterations: result?.iterations || 0,
        },
        sessionId,
      }).catch(() => { /* notification hook is best-effort */ })
      try {
        this.deps.scheduleMemoryExtraction({
          userId,
          sessionId,
          agentId: promptContext.effectiveAgentId || agentId || null,
          messages: historyMessages,
          assistantText: text,
          callModel: ({ messages: memoryMessages }) => this.deps.runMemoryModel({
            messages: memoryMessages,
            userId,
          }),
        })
      } catch {
        // Automatic memory extraction is best-effort and must not change turn completion.
      }
    } catch (error) {
      if (lostTurnLease(signal, error)) return
      if (isExplicitTurnCancellation(signal, error)) {
        const verifiedLocalFiles = verifiedLocalFilesAt()
        await emitter('turn.cancelled', {
          reason: error?.message || 'Cancelled by user',
          artifactIds: normalizeArtifactIds(checkpointArtifactIds),
          deliveryArtifactIds: [],
          verifiedLocalFiles,
          iterations: checkpointIterations,
          ...(latestModelUsage ? { usage: latestModelUsage } : {}),
          ...(turnModelUsage ? { turnModelUsage } : {}),
          ...(latestEstimatedPromptTokens !== null ? { estimatedPromptTokens: latestEstimatedPromptTokens } : {}),
        })
        return
      }
      const failure = normalizeFailure(error)
      const partialText = publicIncompleteText(
        error?.partialText || error?.text || streamedAssistantText,
        failure.message,
      )
      const artifactIds = normalizeArtifactIds(error?.artifactIds ?? checkpointArtifactIds)
      const deliveryArtifactIds = []
      const iterations = Math.max(0, Number(error?.iterations) || checkpointIterations)
      const verifiedLocalFiles = verifiedLocalFilesAt()
      try {
        persistTurnEvidence({
          state: 'failed',
          text: partialText,
          artifactIds,
          deliveryArtifactIds,
          iterations,
          error: failure,
          verifiedLocalFiles,
        })
      } catch {
        // The durable event remains the source of truth if message persistence fails.
      }
      await emitter('turn.failed', {
        code: failure.code,
        message: failure.message,
        error: failure,
        partialText,
        artifactIds,
        ...deliveryArtifactFields(deliveryArtifactIds),
        verifiedLocalFiles,
        iterations,
        ...(latestModelUsage ? { usage: latestModelUsage } : {}),
        ...(turnModelUsage ? { turnModelUsage } : {}),
        ...(latestEstimatedPromptTokens !== null ? { estimatedPromptTokens: latestEstimatedPromptTokens } : {}),
      })
    }
  }
}

let singleton = null

export function getTurnEngine() {
  if (!singleton) singleton = new TurnEngine()
  return singleton
}

export function _resetTurnEngine() {
  singleton = null
}
