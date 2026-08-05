import { getAuthToken } from './accountClient.js'
import { parseTurnEvent } from '../../shared/turnEvents.js'
import { TOOL_CALL_STATUS } from '../store/taskStatus.js'

const TERMINAL_EVENTS = new Set(['turn.completed', 'turn.cancelled', 'turn.failed'])
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 8
const DEFAULT_RECONNECT_MAX_DELAY_MS = 10_000

function headers(json = false) {
  const token = getAuthToken()
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function parseResponse(response) {
  let body
  try { body = await response.json() } catch { body = null }
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Turn request failed: HTTP ${response.status}`)
    error.code = body?.error?.code || 'TURN_REQUEST_FAILED'
    error.status = response.status
    throw error
  }
  return body || {}
}

function abortError() {
  const error = new Error('Generation stopped')
  error.name = 'AbortError'
  error.code = 'USER_STOPPED'
  return error
}

function waitForReconnect(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let timer = null
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const finish = () => {
      cleanup()
      resolve()
    }
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(finish, ms)
  })
}

export function reconnectDelayForAttempt(attempt, baseMs = 500, maxMs = DEFAULT_RECONNECT_MAX_DELAY_MS) {
  const safeAttempt = Math.max(1, Number(attempt) || 1)
  const safeBase = Math.max(0, Number(baseMs) || 0)
  const safeMax = Math.max(safeBase, Number(maxMs) || DEFAULT_RECONNECT_MAX_DELAY_MS)
  return Math.min(safeMax, safeBase * (2 ** (safeAttempt - 1)))
}

function reconnectExhaustedError(attempts, cause) {
  const error = new Error(`Turn connection could not be restored after ${attempts} attempts`)
  error.code = 'TURN_RECONNECT_EXHAUSTED'
  error.cause = cause
  return error
}

function streamTruncatedError() {
  const error = new Error('Turn event stream ended before a terminal event')
  error.code = 'TURN_STREAM_TRUNCATED'
  return error
}

function normalizeToolNames(names) {
  if (!Array.isArray(names)) return []
  return [...new Set(names
    .filter((name) => typeof name === 'string')
    .map((name) => name.trim())
    .filter(Boolean))]
    .sort()
}

export function normalizeToolsConfig(toolsConfig) {
  const disabled = normalizeToolNames(toolsConfig?.disabled)
  const disabledSet = new Set(disabled)
  const enabled = normalizeToolNames(toolsConfig?.enabled)
    .filter((name) => !disabledSet.has(name))
  return { enabled, disabled }
}

function normalizeContextIds(values, limit = 32) {
  if (!Array.isArray(values)) return []
  return [...new Set(values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))]
    .slice(0, limit)
}

function parseSseFrame(frame) {
  let eventType = 'message'
  const data = []
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) eventType = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (!data.length) return null
  return { eventType, data: data.join('\n') }
}

export async function streamServerTurnEvents({ sessionId, turnId, after = -1, signal, onEvent, fetchImpl = fetch }) {
  const query = new URLSearchParams({ sessionId, turnId, after: String(after) })
  const response = await fetchImpl(`/api/turns/stream?${query}`, { headers: headers(), signal })
  if (!response.ok) await parseResponse(response)
  const reader = response.body?.getReader?.()
  if (!reader) throw streamTruncatedError()
  const decoder = new TextDecoder()
  let buffer = ''
  let terminal = null
  while (!terminal) {
    const chunk = await reader.read()
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done })
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() || ''
    for (const rawFrame of frames) {
      const frame = parseSseFrame(rawFrame)
      if (frame?.eventType !== 'turn_event') continue
      const event = parseTurnEvent(JSON.parse(frame.data))
      await onEvent?.(event)
      if (TERMINAL_EVENTS.has(event.type)) terminal = event
    }
    if (chunk.done) break
  }
  if (!terminal) throw streamTruncatedError()
  return terminal
}

export async function startServerTurn({
  sessionId,
  content,
  displayContent,
  modelName,
  turnId,
  history,
  agentId,
  skillIds,
  toolsConfig,
  signal,
  fetchImpl = fetch,
}) {
  const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() || null : null
  const response = await fetchImpl('/api/turns/run', {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({
      sessionId,
      content,
      displayContent,
      modelName,
      turnId,
      history,
      agentId: normalizedAgentId,
      skillIds: normalizeContextIds(skillIds),
      toolsConfig: normalizeToolsConfig(toolsConfig),
    }),
    signal,
  })
  return (await parseResponse(response)).turn
}

function parseToolResult(content) {
  try { return JSON.parse(content) } catch { return null }
}

function toolCallsFromContext(context) {
  const calls = []
  const byId = new Map()
  for (const message of Array.isArray(context?.toolTrace) ? context.toolTrace : []) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const entry = {
          id: call?.id,
          name: call?.function?.name || '',
          arguments: call?.function?.arguments || '{}',
          status: TOOL_CALL_STATUS.RUNNING,
        }
        if (!entry.id) continue
        calls.push(entry)
        byId.set(entry.id, entry)
      }
    } else if (message?.role === 'tool') {
      const entry = byId.get(message.tool_call_id)
      if (!entry) continue
      const parsed = parseToolResult(message.content)
      entry.status = parsed?.ok === false ? TOOL_CALL_STATUS.ERROR : TOOL_CALL_STATUS.SUCCESS
      entry.result = String(message.content || '')
      entry.error = parsed?.ok === false ? parsed?.error || 'Tool call failed' : undefined
      entry.approvalAuthorization = parsed?.approvalAuthorization || null
    }
  }
  return calls
}

export function normalizeServerSessionSnapshot(snapshot) {
  if (!snapshot || snapshot.complete !== true) return null
  return {
    ...snapshot,
    messages: (snapshot.messages || [])
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => {
        const toolCalls = message.role === 'assistant'
          ? toolCallsFromContext(message.modelContext)
          : []
        return {
          id: message.id,
          role: message.role,
          content: message.content,
          timestamp: message.createdAt,
          ...(message.role === 'assistant' ? {
            meta: {
              serverTurnId: message.modelContext?.turnId || null,
              streaming: false,
              serverAuthoritative: true,
              toolCalls,
            },
          } : {}),
        }
      }),
  }
}

export async function fetchServerSessionSnapshot({ sessionId, signal, fetchImpl = fetch }) {
  const response = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot`, {
    headers: headers(),
    signal,
  })
  const body = await parseResponse(response)
  return normalizeServerSessionSnapshot(body.snapshot)
}

export async function replayServerTurn({ sessionId, turnId, after = -1, limit = 500, signal, fetchImpl = fetch }) {
  const query = new URLSearchParams({
    sessionId,
    turnId,
    after: String(after),
    limit: String(limit),
  })
  const response = await fetchImpl(`/api/turns/events?${query}`, { headers: headers(), signal })
  const body = await parseResponse(response)
  return (body.events || []).map(parseTurnEvent)
}

export async function cancelServerTurn({ sessionId, turnId, fetchImpl = fetch }) {
  const response = await fetchImpl(`/api/turns/${encodeURIComponent(turnId)}/cancel`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ sessionId }),
  })
  return (await parseResponse(response)).turn
}

export async function resumeServerTurnRequest({ sessionId, turnId, signal, fetchImpl = fetch }) {
  const response = await fetchImpl(`/api/turns/${encodeURIComponent(turnId)}/resume`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ sessionId }),
    signal,
  })
  return (await parseResponse(response)).turn
}

export async function runServerTurn({
  sessionId,
  content,
  displayContent,
  modelName,
  history,
  agentId,
  skillIds,
  toolsConfig,
  turnId,
  resume = false,
  afterSequence = -1,
  signal,
  onStarted,
  onEvent,
  reconnectDelayMs = 500,
  reconnectMaxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS,
  reconnectMaxAttempts = DEFAULT_RECONNECT_MAX_ATTEMPTS,
  onConnectionState,
  syncSessionSnapshot = false,
  fetchImpl = fetch,
}) {
  const requestedTurnId = turnId || globalThis.crypto?.randomUUID?.() || `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let activeTurnId = requestedTurnId
  let after = Number.isInteger(afterSequence) ? afterSequence : -1
  let terminal = null
  let cancelling = false
  let reconnectAttempts = 0
  const deliverEvent = async (event) => {
    // SSE reconnects and the replay endpoint may overlap. Only events that the
    // consumer has acknowledged can advance the durable cursor, and an event
    // at or behind that cursor must never be applied twice (notably deltas).
    if (event.sequence <= after) return false
    await onEvent?.(event)
    after = Math.max(after, event.sequence)
    return true
  }
  const requestCancel = () => {
    if (cancelling) return
    cancelling = true
    cancelServerTurn({ sessionId, turnId: activeTurnId, fetchImpl }).catch(() => {})
  }
  signal?.addEventListener('abort', requestCancel, { once: true })
  try {
    const turn = resume
      ? await resumeServerTurnRequest({ sessionId, turnId: requestedTurnId, signal, fetchImpl })
      : await startServerTurn({
          sessionId,
          content,
          displayContent,
          modelName,
          turnId: requestedTurnId,
          history,
          agentId,
          skillIds,
          toolsConfig,
          signal,
          fetchImpl,
        })
    activeTurnId = turn.turnId
    await onStarted?.(turn)
    if (TERMINAL_EVENTS.has(turn.lastEvent?.type) && turn.lastEvent.sequence <= after) {
      terminal = parseTurnEvent(turn.lastEvent)
    }
    while (!terminal) {
      if (signal?.aborted) throw abortError()
      try {
        terminal = await streamServerTurnEvents({
          sessionId,
          turnId: activeTurnId,
          after,
          signal,
          fetchImpl,
          onEvent: async (event) => {
            const delivered = await deliverEvent(event)
            if (!delivered) return
            if (reconnectAttempts > 0) {
              reconnectAttempts = 0
              await onConnectionState?.({ status: 'connected', turnId: activeTurnId })
            }
          },
        })
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw abortError()
        let reconnectCause = error
        let events = []
        try {
          events = await replayServerTurn({ sessionId, turnId: activeTurnId, after, signal, fetchImpl })
        } catch (replayError) {
          if (signal?.aborted || replayError?.name === 'AbortError') throw abortError()
          reconnectCause = replayError
        }
        for (const event of events) {
          await deliverEvent(event)
          // A replay endpoint may include its boundary event. If that boundary
          // is terminal it was already acknowledged, so the loop may finish
          // without applying it a second time.
          if (TERMINAL_EVENTS.has(event.type) && event.sequence <= after) terminal = event
        }
        if (terminal) continue
        reconnectAttempts += 1
        const maxAttempts = Math.max(1, Number(reconnectMaxAttempts) || DEFAULT_RECONNECT_MAX_ATTEMPTS)
        if (reconnectAttempts >= maxAttempts) {
          const exhausted = reconnectExhaustedError(reconnectAttempts, reconnectCause)
          await onConnectionState?.({ status: 'failed', turnId: activeTurnId, attempt: reconnectAttempts, maxAttempts, error: exhausted })
          throw exhausted
        }
        const delayMs = reconnectDelayForAttempt(reconnectAttempts, reconnectDelayMs, reconnectMaxDelayMs)
        await onConnectionState?.({ status: 'reconnecting', turnId: activeTurnId, attempt: reconnectAttempts, maxAttempts, delayMs, error: reconnectCause })
        await waitForReconnect(delayMs, signal)
      }
    }
    let sessionSnapshot = null
    if (syncSessionSnapshot && terminal?.type === 'turn.completed') {
      try {
        sessionSnapshot = await fetchServerSessionSnapshot({ sessionId, signal, fetchImpl })
      } catch {
        // The completed server turn remains authoritative and replayable even
        // when this best-effort browser convergence request is unavailable.
      }
    }
    return { turnId: activeTurnId, terminal, lastSequence: after, sessionSnapshot }
  } finally {
    signal?.removeEventListener('abort', requestCancel)
  }
}

function resultText(result) {
  if (typeof result === 'string') return result
  try { return JSON.stringify(result ?? {}) } catch { return String(result ?? '') }
}

export async function dispatchTurnEvent(event, { dispatch, taskId, onApproval, onArtifact, messageTarget } = {}) {
  const payload = event.payload || {}
  const dispatchMessage = (action) => dispatch?.({ ...action, ...(messageTarget || {}) })
  if (event.type === 'model.phase') {
    const label = payload.phase === 'started' ? 'Calling model'
      : payload.phase === 'failed' ? 'Model call failed'
        : 'Model response completed'
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: label } } })
  } else if (event.type === 'assistant.delta') {
    dispatchMessage({ type: 'APPEND_TO_LAST_MESSAGE', payload: payload.text || '' })
  } else if (event.type === 'reasoning.delta') {
    dispatchMessage({ type: 'APPEND_REASONING_TO_LAST_MESSAGE', payload: payload.text || '' })
  } else if (event.type === 'tool.call' || event.type === 'tool.started') {
    dispatchMessage({
      type: 'APPEND_TOOL_CALL_TO_LAST_MESSAGE',
      payload: {
        id: payload.toolCallId,
        name: payload.name,
        arguments: JSON.stringify(payload.args || {}),
        status: TOOL_CALL_STATUS.RUNNING,
      },
    })
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: `Calling ${payload.name || 'tool'}` } } })
  } else if (event.type === 'tool.completed') {
    const failed = payload.result?.ok === false
    dispatchMessage({
      type: 'APPEND_TOOL_CALL_TO_LAST_MESSAGE',
      payload: {
        id: payload.toolCallId,
        name: payload.name,
        status: failed ? TOOL_CALL_STATUS.ERROR : TOOL_CALL_STATUS.SUCCESS,
        result: resultText(payload.result),
        error: failed ? payload.result?.error || 'Tool call failed' : undefined,
        approvalAuthorization: payload.result?.approvalAuthorization || null,
      },
    })
    if (payload.artifactId || payload.result?.artifactId) onArtifact?.({
      id: payload.artifactId || payload.result.artifactId,
      name: payload.name,
      filename: payload.result?.filename || '',
      url: payload.result?.url || '',
    })
  } else if (event.type === 'approval.required') {
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: 'Waiting for approval' } } })
    await onApproval?.({
      id: payload.approvalId,
      name: payload.toolName,
      args: payload.args || {},
      risk: payload.risk,
      reason: payload.reason,
    })
  } else if (event.type === 'approval.resolved') {
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: 'Approval resolved, continuing' } } })
  }
}
