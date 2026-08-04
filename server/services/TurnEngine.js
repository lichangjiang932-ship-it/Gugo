import { randomUUID } from 'node:crypto'
import { callBackgroundModelWithTools } from '../adapters/modelProxy.js'
import { createTurnEvent } from '../../shared/turnEvents.js'
import { releaseApprovalsForTurn } from './approvalGate.js'
import { runToolsLoop, SERVER_TOOL_SPECS } from './jobTools.js'
import { getSession, listMessages, upsertMessage, upsertSession } from './sessionStore.js'
import { appendTurnEvent, getLastTurnEvent, listTurnEvents } from './turnEventStore.js'
import { resolveApprovalMode } from '../utils/approvalPolicy.js'

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

export class TurnEngine {
  constructor({
    runLoop = runToolsLoop,
    runModel = callBackgroundModelWithTools,
    executeTool,
    appendEvent = appendTurnEvent,
    lastEvent = getLastTurnEvent,
    replayEvents = listTurnEvents,
    readSession = getSession,
    writeSession = upsertSession,
    readMessages = listMessages,
    writeMessage = upsertMessage,
    idFactory = randomUUID,
    now = Date.now,
    toolSpecs = SERVER_TOOL_SPECS,
    readApprovalMode = resolveApprovalMode,
  } = {}) {
    this.deps = {
      runLoop, runModel, executeTool, appendEvent, lastEvent, replayEvents,
      readSession, writeSession, readMessages, writeMessage, idFactory, now, toolSpecs,
      readApprovalMode,
    }
    this.active = new Map()
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

  async startTurn({ userId, sessionId, turnId = this.deps.idFactory(), content, modelName = null, history = [] }) {
    const text = String(content || '').trim()
    if (!userId) throw new TurnEngineError('UNAUTHORIZED', 'Unauthorized', 401)
    if (!sessionId) throw new TurnEngineError('SESSION_REQUIRED', 'sessionId is required')
    if (!text) throw new TurnEngineError('CONTENT_REQUIRED', 'content is required')
    if (!this.deps.readSession({ userId, sessionId })) {
      try {
        this.deps.writeSession({
          id: sessionId,
          userId,
          title: text.slice(0, 80) || 'Untitled',
          createdAt: this.deps.now(),
        })
      } catch {
        throw new TurnEngineError('SESSION_NOT_FOUND', 'session not found', 404)
      }
    }
    const existing = this.deps.lastEvent({ userId, sessionId, turnId })
    if (existing) {
      throw new TurnEngineError('TURN_EXISTS', 'turn already exists; use resume', 409)
    }

    const createdAt = this.deps.now()
    const existingMessages = this.deps.readMessages({ userId, sessionId, limit: 1 })
    const safeHistory = existingMessages.length === 0 && Array.isArray(history) ? history.slice(-200) : []
    safeHistory.forEach((message, index) => {
      const sourceRole = ['user', 'assistant', 'system', 'tool'].includes(message?.role) ? message.role : null
      const role = sourceRole === 'tool' ? 'system' : sourceRole
      if (!role || typeof message?.content !== 'string') return
      this.deps.writeMessage({
        id: `${turnId}:history:${index}`,
        userId,
        sessionId,
        role,
        content: sourceRole === 'tool' ? `[历史工具结果]\n${message.content}` : message.content,
        createdAt: createdAt - safeHistory.length + index,
        updatedAt: createdAt,
      })
    })
    this.deps.writeMessage({
      id: `${turnId}:user`, userId, sessionId, role: 'user', content: text, createdAt, updatedAt: createdAt,
    })
    const emitter = this.#createEmitter({ userId, sessionId, turnId, sequence: 0 })
    await emitter('turn.started', {
      content: text,
      modelName: modelName || null,
      userMessageId: `${turnId}:user`,
      importedHistoryCount: safeHistory.length,
    })
    this.#schedule({ userId, sessionId, turnId, content: text, modelName, emitter })
    return this.getTurn({ userId, sessionId, turnId })
  }

  async resumeTurn({ userId, sessionId, turnId }) {
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
      modelName: started.payload.modelName || null,
      emitter,
    })
    return this.getTurn({ userId, sessionId, turnId })
  }

  async cancelTurn({ userId, sessionId, turnId }) {
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

  async #execute({ userId, sessionId, turnId, content, modelName, emitter }, signal) {
    const checkpoint = this.deps.lastEvent({ userId, sessionId, turnId, type: 'turn.checkpoint' })
    const messages = this.deps.readMessages({ userId, sessionId }).map(({ role, content: body }) => ({
      role,
      content: body,
    }))
    try {
      const result = await this.deps.runLoop({
        job: { id: turnId, userId, sessionId, origin: 'chat', prompt: content, title: content.slice(0, 120) },
        step: { id: turnId, kind: 'chat' },
        messages,
        signal,
        toolSpecs: this.deps.toolSpecs,
        executeTool: this.deps.executeTool,
        approvalOrigin: 'chat',
        approvalSessionId: sessionId,
        approvalMode: this.deps.readApprovalMode(),
        loadCheckpoint: async () => checkpoint?.payload?.state || null,
        saveCheckpoint: async (state) => {
          await emitter('turn.checkpoint', { state })
          return true
        },
        runModel: async (request) => this.deps.runModel({
          ...request, userId, modelName: modelName || undefined,
        }),
        onModelPhase: async ({ phase, iteration, content: delta, usage, modelName: activeModel, error }) => {
          await emitter('model.phase', { phase, iteration, usage, modelName: activeModel, error })
          if (delta) await emitter('assistant.delta', { text: delta, iteration })
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
