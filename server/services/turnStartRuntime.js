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

/**
 * Resolve a server-side `/skill` prefix when the caller did not provide an
 * explicit skill list. Display content remains unchanged; only model content
 * has the prefix removed.
 */
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

/**
 * Persist the durable beginning of a Turn.
 *
 * This runtime ends after `turn.started` is committed and before an execution
 * lease is acquired. Storage is available only through the injected narrow
 * ports; the runtime has no knowledge of SQLite or the active adapter.
 */
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

  return Object.freeze({
    async initialize({
      userId,
      sessionId,
      turnId,
      content,
      displayContent = null,
      workspacePath = '',
      locale = null,
      modelName = null,
      modelProviderId = null,
      modelConfigRevision = null,
      modelMode = 'agent',
      history = [],
      agentId = null,
      skillIds = [],
      skillDefinitions = [],
      toolsConfig = null,
      intentMode = 'auto',
      approvalMode = null,
      attachments = [],
      authMode = null,
    } = {}) {
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
      const normalizedApprovalMode = normalizeTurnApprovalMode(approvalMode)
      const normalizedModelConfigRevision = normalizeTurnModelConfigRevision(modelConfigRevision)

      let session = await ports.readSession({ userId, sessionId })
      const occupied = !session && await ports.sessionIdOccupied({ sessionId })
      if (!session && occupied && authMode !== 'local') {
        throw new TurnEngineError('SESSION_NOT_FOUND', 'session not found', 404)
      }
      if (!occupied) {
        const existing = await ports.lastEvent({ userId, sessionId, turnId })
        if (existing) {
          throw new TurnEngineError('TURN_EXISTS', 'turn already exists; use resume', 409)
        }
      }

      // Readiness is resolved before any durable session/message/event state is
      // created so rejected configuration never leaves an empty conversation.
      const normalizedAgentId = normalizeTurnOptionalId(agentId)
      const normalizedModelProviderId = normalizeTurnOptionalId(modelProviderId)
      const normalizedModelMode = normalizeTurnModelMode(modelMode)
      const modelBinding = await ports.resolveModelBinding({
        userId,
        modelName,
        modelProviderId: normalizedModelProviderId,
        modelConfigRevision: normalizedModelConfigRevision,
        modelMode: normalizedModelMode,
        requirePersistedBinding: false,
      })
      const turnDirectory = await ports.resolveProjectDirectory({ userId, workspacePath }) || {}
      const normalizedWorkspacePath = String(turnDirectory.workspacePath || '').trim() || null
      const projectDirectory = String(turnDirectory.projectDirectory || '').trim() || null
      const defaultOutputDirectory = String(
        turnDirectory.defaultOutputDirectory || projectDirectory || '',
      ).trim() || null
      // A local-auth caller may still own a chat created under its legacy user
      // identity. Claiming it rewrites ownership and enqueues content outbox
      // events, so it must happen only after the model binding preflight has
      // accepted this Turn. The earlier occupancy read remains side-effect free.
      if (!session && occupied) {
        session = await ports.claimLegacySession({ userId, sessionId, authMode })
        if (!session) {
          throw new TurnEngineError('SESSION_NOT_FOUND', 'session not found', 404)
        }
        const existing = await ports.lastEvent({ userId, sessionId, turnId })
        if (existing) {
          throw new TurnEngineError('TURN_EXISTS', 'turn already exists; use resume', 409)
        }
      }
      const createdAt = ports.now()
      const pendingSession = !session ? {
        id: sessionId,
        userId,
        title: displayText.slice(0, 80) || 'Untitled',
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

      const normalizedSkillIds = normalizeTurnIds(resolvedSkill.skillIds)
      const normalizedSkillDefinitions = prepareInlineSkillsForPrompt({
        skillIds: normalizedSkillIds,
        skillDefinitions,
      })
      const normalizedToolsConfig = normalizeServerToolsConfig(toolsConfig)
      const normalizedIntentMode = normalizeTurnIntentMode(intentMode)
      let managedAttachments
      try {
        managedAttachments = await ports.validateAttachments({
          userId,
          sessionId,
          attachmentIds: normalizedAttachmentIds,
        })
      } catch (error) {
        throw attachmentTurnError(error)
      }
      const existingMessages = await ports.readMessages({ userId, sessionId, limit: 1 })
      const safeHistory = existingMessages.length === 0 && Array.isArray(history) ? history.slice() : []
      const stagedMessages = []
      safeHistory.forEach((message, index) => {
        const sourceRole = ['user', 'assistant', 'system', 'tool'].includes(message?.role) ? message.role : null
        const role = sourceRole === 'tool' && !message?.tool_call_id ? 'system' : sourceRole
        if (!role || typeof message?.content !== 'string') return
        stagedMessages.push({
          id: `${turnId}:history:${index}`,
          userId,
          sessionId,
          role,
          modelContext: importedMessageContext(message, sourceRole),
          content: sourceRole === 'tool' ? `[历史工具结果]\n${message.content}` : message.content,
          createdAt: createdAt - safeHistory.length + index,
          updatedAt: createdAt,
        })
      })
      const userMessageId = `${turnId}:user`
      stagedMessages.push({
        id: userMessageId,
        userId,
        sessionId,
        role: 'user',
        content: displayText,
        modelContext: { version: 1, turnId, modelContent: text, attachments: managedAttachments },
        createdAt,
        updatedAt: createdAt,
      })

      const stagedMessageIds = []
      const rollbackStagedMessages = async () => {
        for (const messageId of stagedMessageIds.reverse()) {
          try { await ports.removeMessage({ userId, messageId }) } catch { /* best-effort compensation */ }
        }
      }
      if (!atomicTurnStart) {
        for (const message of stagedMessages) {
          await ports.writeMessage(message)
          stagedMessageIds.push(message.id)
        }
        try {
          await ports.bindAttachments({
            userId,
            sessionId,
            messageId: userMessageId,
            attachmentIds: normalizedAttachmentIds,
            now: createdAt,
          })
        } catch (error) {
          await rollbackStagedMessages()
          throw attachmentTurnError(error)
        }
      }

      const emitter = ports.createEmitter({ userId, sessionId, turnId, sequence: 0 })
      try {
        await emitter('turn.started', {
          content: text,
          displayContent: displayText,
          modelName: modelBinding.modelName,
          modelProviderId: modelBinding.modelProviderId,
          modelConfigRevision: modelBinding.modelConfigRevision,
          modelMode: normalizedModelMode,
          agentId: normalizedAgentId,
          skillIds: normalizedSkillIds,
          skillDefinitions: normalizedSkillDefinitions,
          toolsConfig: normalizedToolsConfig,
          intentMode: normalizedIntentMode,
          ...(normalizedLocale ? { locale: normalizedLocale } : {}),
          ...(normalizedApprovalMode ? { approvalMode: normalizedApprovalMode } : {}),
          ...(projectDirectory ? {
            workspacePath: normalizedWorkspacePath,
            projectDirectory,
          } : {}),
          userMessageId,
          attachments: managedAttachments,
          importedHistoryCount: safeHistory.length,
        }, {
          commitEvent: atomicTurnStart
            ? ({ event }) => ports.commitTurnStart({
                userId,
                session: pendingSession,
                messages: stagedMessages,
                attachmentBinding: normalizedAttachmentIds.length > 0 ? {
                  userId,
                  sessionId,
                  messageId: userMessageId,
                  attachmentIds: normalizedAttachmentIds,
                  now: createdAt,
                } : null,
                event,
              })
            : null,
        })
      } catch (error) {
        try { await emitter.close() } catch { /* preserve the authoritative start failure */ }
        if (!atomicTurnStart) await rollbackStagedMessages()
        throw error
      }
      if (atomicTurnStart) {
        session = await ports.readSession({ userId, sessionId })
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
        scope: { userId, sessionId, turnId },
        emitter,
        execution: {
          userId,
          sessionId,
          turnId,
          turnStartedAt: createdAt,
          content: text,
          displayContent: displayText,
          modelName: modelBinding.modelName,
          modelProviderId: modelBinding.modelProviderId,
          modelConfigRevision: modelBinding.modelConfigRevision,
          modelRuntimeEnv: modelBinding.env,
          modelMode: normalizedModelMode,
          agentId: normalizedAgentId,
          skillIds: normalizedSkillIds,
          skillDefinitions: normalizedSkillDefinitions,
          toolsConfig: normalizedToolsConfig,
          intentMode: normalizedIntentMode,
          ...(normalizedLocale ? { locale: normalizedLocale } : {}),
          approvalMode: normalizedApprovalMode,
          projectDirectory,
          defaultOutputDirectory,
        },
      }
    },
  })
}
