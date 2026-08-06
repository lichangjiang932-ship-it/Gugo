import { randomUUID } from 'node:crypto'
import { callBackgroundModel, callStreamingModelWithTools, getModelContextWindow } from '../adapters/modelProxy.js'
import { createTurnEvent } from '../../shared/turnEvents.js'
import { canonicalizeSkillId } from '../../shared/artifactIntent.js'
import { releaseApprovalsForTurn } from './approvalGate.js'
import { runToolLoop, SERVER_TOOL_SPECS } from './toolLoopRuntime.js'
import {
  claimLocalChatSession,
  getSession,
  listMessages,
  SessionOwnershipError,
  upsertMessage,
  upsertSession,
} from './sessionStore.js'
import { appendTurnEvent, getLastTurnEvent, listTurnEvents } from './turnEventStore.js'
import { resolveApprovalMode } from '../utils/approvalPolicy.js'
import {
  buildAssistantModelContext,
  collectToolCallIds,
  expandStoredMessages,
} from './turnMessageContext.js'
import { prepareTurnPromptContext } from './turnPromptContext.js'
import { normalizeServerToolsConfig, resolveTurnToolSpecs } from './turnToolSpecs.js'
import { scheduleAutoMemoryExtraction } from './autoMemoryService.js'

const TERMINAL_TYPES = new Set(['turn.completed', 'turn.cancelled', 'turn.failed'])

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

function publicStatus(lastEvent, running = false) {
  if (running) return 'running'
  if (!lastEvent) return 'not_found'
  if (lastEvent.type === 'turn.completed') return 'completed'
  if (lastEvent.type === 'turn.cancelled') return 'cancelled'
  if (lastEvent.type === 'turn.failed') return 'failed'
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
    lastEvent = getLastTurnEvent,
    replayEvents = listTurnEvents,
    readSession = getSession,
    claimSession = claimLocalChatSession,
    writeSession = upsertSession,
    readMessages = listMessages,
    writeMessage = upsertMessage,
    idFactory = randomUUID,
    now = Date.now,
    toolSpecs = SERVER_TOOL_SPECS,
    readApprovalMode = resolveApprovalMode,
    preparePromptContext = prepareTurnPromptContext,
    resolveToolSpecs = resolveTurnToolSpecs,
    scheduleMemoryExtraction = scheduleAutoMemoryExtraction,
    runMemoryModel = callBackgroundModel,
    getContextWindow = getModelContextWindow,
    env = process.env,
  } = {}) {
    this.deps = {
      runLoop, runModel, executeTool, appendEvent, lastEvent, replayEvents,
      readSession, claimSession, writeSession, readMessages, writeMessage, idFactory, now, toolSpecs,
      readApprovalMode, preparePromptContext, resolveToolSpecs, scheduleMemoryExtraction, runMemoryModel, env,
      getContextWindow,
    }
    this.active = new Map()
    this.startingSessions = new Map()
  }

  getTurn({ userId, sessionId, turnId }) {
    const key = activeKey(userId, sessionId, turnId)
    const last = this.deps.lastEvent({ userId, sessionId, turnId })
    return last ? {
      sessionId,
      turnId,
      status: publicStatus(last, this.active.has(key)),
      lastEvent: last,
    } : null
  }

  hasActiveSession({ userId, sessionId } = {}) {
    if (!userId || !sessionId) return false
    if (this.startingSessions.has(sessionKey(userId, sessionId))) return true
    const prefix = `${userId}\u0000${sessionId}\u0000`
    return [...this.active.keys()].some((key) => key.startsWith(prefix))
  }

  async startTurn({
    userId,
    sessionId,
    turnId = this.deps.idFactory(),
    content,
    displayContent = null,
    modelName = null,
    history = [],
    agentId = null,
    skillIds = [],
    toolsConfig = null,
    authMode = null,
  }) {
    const rawText = String(content || '').trim()
    // I1：调用方未显式传 skillIds 时，服务端解析 `/技能前缀`（对齐 job 链路）。
    // 模型上下文使用剥离前缀后的正文，展示层保留用户原话。
    const resolvedSkill = resolveSkillPrefixFromContent(rawText, skillIds)
    const text = resolvedSkill.content
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
      const normalizedToolsConfig = normalizeServerToolsConfig(toolsConfig)
      const existingMessages = this.deps.readMessages({ userId, sessionId, limit: 1 })
      const safeHistory = existingMessages.length === 0 && Array.isArray(history) ? history.slice() : []
      safeHistory.forEach((message, index) => {
        const sourceRole = ['user', 'assistant', 'system', 'tool'].includes(message?.role) ? message.role : null
        const role = sourceRole === 'tool' && !message?.tool_call_id ? 'system' : sourceRole
        if (!role || typeof message?.content !== 'string') return
        this.deps.writeMessage({
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
      this.deps.writeMessage({
        id: `${turnId}:user`, userId, sessionId, role: 'user', content: displayText,
        modelContext: { version: 1, turnId },
        createdAt, updatedAt: createdAt,
      })
      const emitter = this.#createEmitter({ userId, sessionId, turnId, sequence: 0 })
      await emitter('turn.started', {
        content: text,
        displayContent: displayText,
        modelName: modelName || null,
        agentId: normalizedAgentId,
        skillIds: normalizedSkillIds,
        toolsConfig: normalizedToolsConfig,
        userMessageId: `${turnId}:user`,
        importedHistoryCount: safeHistory.length,
      })
      this.#schedule({
        userId,
        sessionId,
        turnId,
        content: text,
        displayContent: displayText,
        modelName,
        agentId: normalizedAgentId,
        skillIds: normalizedSkillIds,
        toolsConfig: normalizedToolsConfig,
        emitter,
      })
      return this.getTurn({ userId, sessionId, turnId })
    } finally {
      const remainingStarts = (this.startingSessions.get(startingKey) || 1) - 1
      if (remainingStarts > 0) this.startingSessions.set(startingKey, remainingStarts)
      else this.startingSessions.delete(startingKey)
    }
  }

  async resumeTurn({ userId, sessionId, turnId, authMode = null }) {
    if (!this.deps.readSession({ userId, sessionId }) && authMode === 'local') {
      this.#claimLegacySession({ userId, sessionId, authMode })
    }
    const key = activeKey(userId, sessionId, turnId)
    if (this.active.has(key)) return this.getTurn({ userId, sessionId, turnId })
    const started = this.deps.lastEvent({ userId, sessionId, turnId, type: 'turn.started' })
    if (!started) throw new TurnEngineError('TURN_NOT_FOUND', 'turn not found', 404)
    const last = this.deps.lastEvent({ userId, sessionId, turnId })
    if (TERMINAL_TYPES.has(last?.type)) return this.getTurn({ userId, sessionId, turnId })
    const emitter = this.#createEmitter({ userId, sessionId, turnId, sequence: last.sequence + 1 })
    this.#schedule({
      userId,
      sessionId,
      turnId,
      content: String(started.payload.content || ''),
      displayContent: String(started.payload.displayContent || started.payload.content || ''),
      modelName: started.payload.modelName || null,
      agentId: normalizeOptionalId(started.payload.agentId),
      skillIds: normalizeIds(started.payload.skillIds),
      toolsConfig: normalizeServerToolsConfig(started.payload.toolsConfig),
      emitter,
    })
    return this.getTurn({ userId, sessionId, turnId })
  }

  async cancelTurn({ userId, sessionId, turnId, authMode = null }) {
    if (!this.deps.readSession({ userId, sessionId }) && authMode === 'local') {
      this.#claimLegacySession({ userId, sessionId, authMode })
    }
    const key = activeKey(userId, sessionId, turnId)
    const running = this.active.get(key)
    if (running) {
      running.controller.abort()
      releaseApprovalsForTurn({ userId, sessionId, turnId })
      return { ...this.getTurn({ userId, sessionId, turnId }), status: 'cancelling' }
    }
    const last = this.deps.lastEvent({ userId, sessionId, turnId })
    if (!last) throw new TurnEngineError('TURN_NOT_FOUND', 'turn not found', 404)
    if (TERMINAL_TYPES.has(last.type)) return this.getTurn({ userId, sessionId, turnId })
    const emit = this.#createEmitter({ userId, sessionId, turnId, sequence: last.sequence + 1 })
    await emit('turn.cancelled', { reason: 'Cancelled by user' })
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
    return async (type, payload = {}) => {
      const event = createTurnEvent({
        id: this.deps.idFactory(), sessionId, turnId, sequence: nextSequence, type,
        payload, createdAt: this.deps.now(),
      })
      nextSequence += 1
      return this.deps.appendEvent({ userId, event })
    }
  }

  #schedule(context) {
    const key = activeKey(context.userId, context.sessionId, context.turnId)
    const controller = new AbortController()
    const entry = { controller, promise: null }
    this.active.set(key, entry)
    entry.promise = Promise.resolve()
      .then(() => this.#execute(context, controller.signal))
      .finally(() => this.active.delete(key))
    entry.promise.catch(() => {})
  }

  async #execute({
    userId,
    sessionId,
    turnId,
    content,
    displayContent,
    modelName,
    agentId,
    skillIds,
    toolsConfig,
    emitter,
  }, signal) {
    const checkpoint = this.deps.lastEvent({ userId, sessionId, turnId, type: 'turn.checkpoint' })
    const storedMessages = this.deps.readMessages({ userId, sessionId, limit: 500, recent: true })
      .map((message) => message.id === `${turnId}:user`
        ? { ...message, content }
        : message)
    const historyMessages = expandStoredMessages(storedMessages)
    let promptContext = { messages: [], effectiveAgentId: agentId, skillIds, memoryIds: [] }
    try {
      promptContext = await this.deps.preparePromptContext({
        userId,
        agentId,
        skillIds,
        sessionId,
        recentMessages: storedMessages,
        includeRecentTranscript: false,
        query: content,
        env: this.deps.env,
      }) || promptContext
    } catch {
      // Optional memory/agent/skill context must never prevent a turn from running.
    }
    const messages = [
      ...(Array.isArray(promptContext.messages) ? promptContext.messages : []),
      ...historyMessages,
    ]
    let resolvedToolSpecs = this.deps.toolSpecs
    try {
      const resolved = await this.deps.resolveToolSpecs({
        userId,
        baseSpecs: this.deps.toolSpecs,
        toolsConfig,
      })
      if (Array.isArray(resolved)) resolvedToolSpecs = resolved
    } catch {
      // MCP/browser discovery is optional; retain the built-in tool set on failure.
    }
    const activeSkillId = normalizeIds(promptContext.skillIds).at(0) || normalizeIds(skillIds).at(0) || null
    const baselineToolCallIds = collectToolCallIds(messages)
    let checkpointMessages = checkpoint?.payload?.state?.messages || []
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
          agentId: promptContext.effectiveAgentId || agentId || null,
          origin: 'chat',
          prompt: content,
          userPrompt: displayContent || content,
          title: content.slice(0, 120),
        },
        step: { id: turnId, kind: 'chat' },
        messages,
        contextWindow,
        signal,
        toolSpecs: resolvedToolSpecs,
        skillId: activeSkillId,
        executeTool: this.deps.executeTool,
        approvalOrigin: 'chat',
        approvalSessionId: sessionId,
        approvalMode: this.deps.readApprovalMode(),
        loadCheckpoint: async () => checkpoint?.payload?.state || null,
        saveCheckpoint: async (state) => {
          checkpointMessages = Array.isArray(state?.messages) ? state.messages : checkpointMessages
          await emitter('turn.checkpoint', { state })
          return true
        },
        runModel: async (request) => this.deps.runModel({
          ...request, userId, modelName: modelName || undefined,
        }),
        onModelPhase: async ({ phase, iteration, usage, modelName: activeModel, error }) => {
          await emitter('model.phase', { phase, iteration, usage, modelName: activeModel, error })
        },
        onModelDelta: async ({ text: delta, iteration, modelName: activeModel }) => {
          await emitter('assistant.delta', { text: delta, iteration, modelName: activeModel })
        },
        onReasoningDelta: async ({ text: delta, iteration, modelName: activeModel }) => {
          await emitter('reasoning.delta', { text: delta, iteration, modelName: activeModel })
        },
        onToolCall: async (call) => emitter('tool.call', {
          toolCallId: call.id, name: call.name, args: call.args,
        }),
        onToolStarted: async (call) => emitter('tool.started', {
          toolCallId: call.id, name: call.name,
        }),
        onToolCompleted: async (outcome) => emitter('tool.completed', {
          toolCallId: outcome.call.id, name: outcome.call.name, result: outcome.result,
          artifactId: outcome.artifactId || null,
        }),
        onApprovalPending: async (approval) => emitter('approval.required', {
          approvalId: approval.id, toolName: approval.toolName, args: approval.args,
          risk: approval.risk, reason: approval.reason, expiresAt: approval.expiresAt,
        }),
        onApprovalResolved: async (decision) => emitter('approval.resolved', {
          approvalId: decision.approvalId || null,
          proceed: !!decision.proceed,
          edited: !!decision.edited,
          reason: decision.reason || null,
        }),
      })
      if (signal.aborted) {
        await emitter('turn.cancelled', { reason: 'Cancelled by user' })
        return
      }
      const text = result?.paused
        ? finalClarificationText(result)
        : String(result?.text || '(任务已结束，但模型没有返回文本。)')
      const completedAt = this.deps.now()
      this.deps.writeMessage({
        id: `${turnId}:assistant`, userId, sessionId, role: 'assistant', content: text,
        modelContext: buildAssistantModelContext({
          turnId,
          checkpointMessages,
          baselineToolCallIds,
          artifactIds: result?.artifactIds || [],
          iterations: result?.iterations || 0,
          paused: !!result?.paused,
          compactionArchiveId: result?.recovery?.archiveId || null,
        }),
        createdAt: completedAt, updatedAt: completedAt,
      })
      await emitter('turn.completed', {
        text,
        artifactIds: result?.artifactIds || [],
        iterations: result?.iterations || 0,
        paused: !!result?.paused,
        clarification: result?.clarification || null,
        interrupted: !!result?.interrupted,
      })
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
      if (signal.aborted || error?.name === 'AbortError') {
        await emitter('turn.cancelled', { reason: error?.message || 'Cancelled by user' })
        return
      }
      await emitter('turn.failed', {
        code: error?.code || 'TURN_FAILED',
        message: error?.message || String(error),
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
