import { canonicalizeSkillId } from '../../shared/artifactIntent.js'
import { normalizeTurnLocale } from '../../shared/turnLocale.js'
import { normalizeTurnIntentMode } from '../utils/executionIntent.js'
import { PERMISSION_MODES } from '../utils/approvalPolicy.js'
import { prepareInlineSkillsForPrompt } from './promptCompiler.js'
import { TurnEngineError } from './turnResolutionRuntime.js'
import { normalizeServerToolsConfig } from './turnToolSpecs.js'

const MODEL_MODES = new Set(['agent', 'chat_only'])

export function normalizeTurnModelMode(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return MODEL_MODES.has(normalized) ? normalized : 'agent'
}

export function normalizeTurnApprovalMode(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !PERMISSION_MODES.includes(value)) {
    throw new TurnEngineError(
      'TURN_APPROVAL_MODE_INVALID',
      `approvalMode must be one of ${PERMISSION_MODES.join(', ')}`,
      400,
    )
  }
  return value
}

export function normalizeTurnModelConfigRevision(value) {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TurnEngineError(
      'MODEL_CONFIG_REVISION_INVALID',
      'modelConfigRevision must be a positive safe integer',
      400,
    )
  }
  return value
}

export function normalizeTurnIds(values, limit = 32) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(canonicalizeSkillId)
    .filter(Boolean))]
    .slice(0, limit)
}

export function normalizeTurnOptionalId(value, maxLength = 256) {
  const normalized = String(value || '').trim()
  return normalized ? normalized.slice(0, maxLength) : null
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

function attachmentOnlyPrompt(locale) {
  return normalizeTurnLocale(locale) === 'zh'
    ? '请分析附件内容。'
    : 'Please analyze the attached content.'
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

function resolveSkillPrefixFromContent(content, skillIds) {
  const normalized = normalizeTurnIds(skillIds)
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

function requirePort(name, value) {
  if (typeof value !== 'function') throw new TypeError(`${name} is required`)
  return value
}

function normalizeTurnStartRequest(input = {}) {
  const {
    userId, sessionId, turnId, content, displayContent = null, workspacePath = '',
    locale = null, modelName = null, modelProviderId = null, modelConfigRevision = null,
    modelMode = 'agent', history = [], agentId = null, skillIds = [],
    skillDefinitions = [], toolsConfig = null, intentMode = 'auto', approvalMode = null,
    attachments = [], authMode = null,
  } = input
  const rawText = String(content || '').trim()
  const normalizedAttachmentIds = normalizeAttachmentIds(attachments)
  const resolvedSkill = resolveSkillPrefixFromContent(rawText, skillIds)
  const normalizedLocale = locale === null || locale === undefined || locale === ''
    ? null
    : normalizeTurnLocale(locale)
  const text = resolvedSkill.content
    || (normalizedAttachmentIds.length ? attachmentOnlyPrompt(normalizedLocale) : '')
  const displayText = String(displayContent ?? rawText ?? '').trim() || text
  if (!userId) throw new TurnEngineError('UNAUTHORIZED', 'Unauthorized', 401)
  if (!sessionId) throw new TurnEngineError('SESSION_REQUIRED', 'sessionId is required')
  if (!text) throw new TurnEngineError('CONTENT_REQUIRED', 'content is required')
  return {
    userId, sessionId, turnId, text, displayText, workspacePath, modelName,
    authMode, history, normalizedAttachmentIds, normalizedLocale,
    normalizedApprovalMode: normalizeTurnApprovalMode(approvalMode),
    normalizedModelConfigRevision: normalizeTurnModelConfigRevision(modelConfigRevision),
    normalizedModelProviderId: normalizeTurnOptionalId(modelProviderId),
    normalizedModelMode: normalizeTurnModelMode(modelMode),
    normalizedAgentId: normalizeTurnOptionalId(agentId),
    normalizedSkillIds: normalizeTurnIds(resolvedSkill.skillIds),
    skillDefinitions,
    normalizedToolsConfig: normalizeServerToolsConfig(toolsConfig),
    normalizedIntentMode: normalizeTurnIntentMode(intentMode),
  }
}

async function prepareTurnStartSession(ports, request) {
  const { userId, sessionId, turnId, authMode } = request
  let session = await ports.readSession({ userId, sessionId })
  const occupied = !session && await ports.sessionIdOccupied({ sessionId })
  if (!session && occupied && authMode !== 'local') {
    throw new TurnEngineError('SESSION_NOT_FOUND', 'session not found', 404)
  }
  if (!occupied) {
    const existing = await ports.lastEvent({ userId, sessionId, turnId })
    if (existing) throw new TurnEngineError('TURN_EXISTS', 'turn already exists; use resume', 409)
  }
  const modelBinding = await ports.resolveModelBinding({
    userId,
    modelName: request.modelName,
    modelProviderId: request.normalizedModelProviderId,
    modelConfigRevision: request.normalizedModelConfigRevision,
    modelMode: request.normalizedModelMode,
    requirePersistedBinding: false,
  })
  const turnDirectory = await ports.resolveProjectDirectory({
    userId,
    workspacePath: request.workspacePath,
  }) || {}
  const normalizedWorkspacePath = String(turnDirectory.workspacePath || '').trim() || null
  const projectDirectory = String(turnDirectory.projectDirectory || '').trim() || null
  const defaultOutputDirectory = String(
    turnDirectory.defaultOutputDirectory || projectDirectory || '',
  ).trim() || null
  if (!session && occupied) {
    session = await ports.claimLegacySession({ userId, sessionId, authMode })
    if (!session) throw new TurnEngineError('SESSION_NOT_FOUND', 'session not found', 404)
    const existing = await ports.lastEvent({ userId, sessionId, turnId })
    if (existing) throw new TurnEngineError('TURN_EXISTS', 'turn already exists; use resume', 409)
  }
  const createdAt = ports.now()
  const pendingSession = !session ? {
    id: sessionId,
    userId,
    title: request.displayText.slice(0, 80) || 'Untitled',
    createdAt,
    ...(projectDirectory ? { workspacePath: normalizedWorkspacePath } : {}),
  } : null
  const atomicTurnStart = !!ports.commitTurnStart
  if (pendingSession && !atomicTurnStart) {
    try {
      session = await ports.writeSession(pendingSession)
    } catch (error) {
      if (error?.code === 'SESSION_OWNERSHIP_CONFLICT') {
        throw new TurnEngineError('SESSION_NOT_FOUND', 'session not found', 404)
      }
      const wrapped = new TurnEngineError('SESSION_CREATE_FAILED', 'failed to create session', 500)
      wrapped.cause = error
      throw wrapped
    }
  }
  return {
    session, modelBinding, normalizedWorkspacePath, projectDirectory,
    defaultOutputDirectory, createdAt, pendingSession, atomicTurnStart,
  }
}

async function prepareTurnStartMessages(ports, request, prepared) {
  const { userId, sessionId, turnId } = request
  let managedAttachments
  try {
    managedAttachments = await ports.validateAttachments({
      userId,
      sessionId,
      attachmentIds: request.normalizedAttachmentIds,
    })
  } catch (error) {
    throw attachmentTurnError(error)
  }
  const existingMessages = await ports.readMessages({ userId, sessionId, limit: 1 })
  const safeHistory = existingMessages.length === 0 && Array.isArray(request.history)
    ? request.history.slice()
    : []
  const stagedMessages = []
  safeHistory.forEach((message, index) => {
    const sourceRole = ['user', 'assistant', 'system', 'tool'].includes(message?.role)
      ? message.role
      : null
    const role = sourceRole === 'tool' && !message?.tool_call_id ? 'system' : sourceRole
    if (!role || typeof message?.content !== 'string') return
    stagedMessages.push({
      id: `${turnId}:history:${index}`,
      userId,
      sessionId,
      role,
      modelContext: importedMessageContext(message, sourceRole),
      content: sourceRole === 'tool' ? `[历史工具结果]\n${message.content}` : message.content,
      createdAt: prepared.createdAt - safeHistory.length + index,
      updatedAt: prepared.createdAt,
    })
  })
  const userMessageId = `${turnId}:user`
  stagedMessages.push({
    id: userMessageId,
    userId,
    sessionId,
    role: 'user',
    content: request.displayText,
    modelContext: {
      version: 1,
      turnId,
      modelContent: request.text,
      attachments: managedAttachments,
    },
    createdAt: prepared.createdAt,
    updatedAt: prepared.createdAt,
  })
  return { managedAttachments, safeHistory, stagedMessages, userMessageId }
}

async function persistNonAtomicTurnMessages(ports, request, prepared, messages) {
  const stagedMessageIds = []
  const rollback = async () => {
    for (const messageId of stagedMessageIds.reverse()) {
      try { await ports.removeMessage({ userId: request.userId, messageId }) }
      catch { /* best-effort compensation */ }
    }
  }
  if (prepared.atomicTurnStart) return rollback
  for (const message of messages.stagedMessages) {
    await ports.writeMessage(message)
    stagedMessageIds.push(message.id)
  }
  try {
    await ports.bindAttachments({
      userId: request.userId,
      sessionId: request.sessionId,
      messageId: messages.userMessageId,
      attachmentIds: request.normalizedAttachmentIds,
      now: prepared.createdAt,
    })
  } catch (error) {
    await rollback()
    throw attachmentTurnError(error)
  }
  return rollback
}

function turnStartedPayload(request, prepared, messages) {
  const normalizedSkillDefinitions = prepareInlineSkillsForPrompt({
    skillIds: request.normalizedSkillIds,
    skillDefinitions: request.skillDefinitions,
  })
  const payload = {
    content: request.text,
    displayContent: request.displayText,
    modelName: prepared.modelBinding.modelName,
    modelProviderId: prepared.modelBinding.modelProviderId,
    modelConfigRevision: prepared.modelBinding.modelConfigRevision,
    modelMode: request.normalizedModelMode,
    agentId: request.normalizedAgentId,
    skillIds: request.normalizedSkillIds,
    skillDefinitions: normalizedSkillDefinitions,
    toolsConfig: request.normalizedToolsConfig,
    intentMode: request.normalizedIntentMode,
    ...(request.normalizedLocale ? { locale: request.normalizedLocale } : {}),
    ...(request.normalizedApprovalMode ? { approvalMode: request.normalizedApprovalMode } : {}),
    ...(prepared.projectDirectory ? {
      workspacePath: prepared.normalizedWorkspacePath,
      projectDirectory: prepared.projectDirectory,
    } : {}),
    userMessageId: messages.userMessageId,
    attachments: messages.managedAttachments,
    importedHistoryCount: messages.safeHistory.length,
  }
  return { payload, normalizedSkillDefinitions }
}

async function initializeTurnStart(ports, input) {
  const request = normalizeTurnStartRequest(input)
  const prepared = await prepareTurnStartSession(ports, request)
  const messages = await prepareTurnStartMessages(ports, request, prepared)
  const rollbackStagedMessages = await persistNonAtomicTurnMessages(ports, request, prepared, messages)
  const emitter = ports.createEmitter({
    userId: request.userId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    sequence: 0,
  })
  const { payload, normalizedSkillDefinitions } = turnStartedPayload(request, prepared, messages)
  try {
    await emitter('turn.started', payload, {
      commitEvent: prepared.atomicTurnStart
        ? ({ event }) => ports.commitTurnStart({
            userId: request.userId,
            session: prepared.pendingSession,
            messages: messages.stagedMessages,
            attachmentBinding: request.normalizedAttachmentIds.length > 0 ? {
              userId: request.userId,
              sessionId: request.sessionId,
              messageId: messages.userMessageId,
              attachmentIds: request.normalizedAttachmentIds,
              now: prepared.createdAt,
            } : null,
            event,
          })
        : null,
    })
  } catch (error) {
    try { await emitter.close() } catch { /* preserve the authoritative start failure */ }
    if (!prepared.atomicTurnStart) await rollbackStagedMessages()
    throw error
  }
  if (prepared.atomicTurnStart) {
    const session = await ports.readSession({ userId: request.userId, sessionId: request.sessionId })
    if (!session) {
      try { await emitter.close() } catch { /* preserve the authoritative read failure */ }
      throw new TurnEngineError(
        'TURN_START_COMMIT_UNVERIFIED',
        'turn start commit completed without a readable session',
        503,
      )
    }
  }
  return {
    scope: { userId: request.userId, sessionId: request.sessionId, turnId: request.turnId },
    emitter,
    execution: {
      userId: request.userId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      turnStartedAt: prepared.createdAt,
      content: request.text,
      displayContent: request.displayText,
      modelName: prepared.modelBinding.modelName,
      modelProviderId: prepared.modelBinding.modelProviderId,
      modelConfigRevision: prepared.modelBinding.modelConfigRevision,
      modelRuntimeEnv: prepared.modelBinding.env,
      modelMode: request.normalizedModelMode,
      agentId: request.normalizedAgentId,
      skillIds: request.normalizedSkillIds,
      skillDefinitions: normalizedSkillDefinitions,
      toolsConfig: request.normalizedToolsConfig,
      intentMode: request.normalizedIntentMode,
      ...(request.normalizedLocale ? { locale: request.normalizedLocale } : {}),
      approvalMode: request.normalizedApprovalMode,
      projectDirectory: prepared.projectDirectory,
      defaultOutputDirectory: prepared.defaultOutputDirectory,
    },
  }
}

/** Persist the durable beginning of a Turn before an execution lease is acquired. */
export function createTurnStartRuntime({
  readSession,
  sessionIdOccupied,
  claimLegacySession,
  lastEvent,
  resolveModelBinding,
  resolveProjectDirectory = null,
  now,
  writeSession,
  readMessages,
  writeMessage,
  removeMessage,
  validateAttachments,
  bindAttachments,
  createEmitter,
  commitTurnStart = null,
} = {}) {
  const ports = {
    readSession: requirePort('readSession', readSession),
    sessionIdOccupied: requirePort('sessionIdOccupied', sessionIdOccupied),
    claimLegacySession: requirePort('claimLegacySession', claimLegacySession),
    lastEvent: requirePort('lastEvent', lastEvent),
    resolveModelBinding: requirePort('resolveModelBinding', resolveModelBinding),
    resolveProjectDirectory: typeof resolveProjectDirectory === 'function'
      ? resolveProjectDirectory
      : () => ({ workspacePath: null, projectDirectory: null, defaultOutputDirectory: null }),
    now: requirePort('now', now),
    writeSession: requirePort('writeSession', writeSession),
    readMessages: requirePort('readMessages', readMessages),
    writeMessage: requirePort('writeMessage', writeMessage),
    removeMessage: requirePort('removeMessage', removeMessage),
    validateAttachments: requirePort('validateAttachments', validateAttachments),
    bindAttachments: requirePort('bindAttachments', bindAttachments),
    createEmitter: requirePort('createEmitter', createEmitter),
    commitTurnStart: typeof commitTurnStart === 'function' ? commitTurnStart : null,
  }
  return Object.freeze({ initialize: (input) => initializeTurnStart(ports, input) })
}
