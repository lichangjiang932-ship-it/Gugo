import { fetchServerSessionSnapshot } from './sessionSnapshot.js'
import { cancelServerTurn, replayServerTurn, resumeServerTurnRequest, startServerTurn } from './turnRequests.js'
import {
  DEFAULT_RECONNECT_MAX_ATTEMPTS,
  DEFAULT_RECONNECT_MAX_DELAY_MS,
  TERMINAL_EVENTS,
  abortError,
  defaultWebSocketFactory,
  reconnectDelayForAttempt,
  reconnectExhaustedError,
  streamServerTurnEvents,
  streamServerTurnEventsWebSocket,
  waitForReconnect,
} from './turnTransport.js'
import { parseTurnEvent } from '../../../shared/turnEvents.js'

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
  webSocketFactory = defaultWebSocketFactory,
  webSocketConnectTimeoutMs,
  webSocketSubscribeTimeoutMs,
}) {
  const requestedTurnId = turnId || globalThis.crypto?.randomUUID?.() || `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let activeTurnId = requestedTurnId
  let after = Number.isInteger(afterSequence) ? afterSequence : -1
  let terminal = null
  let cancelling = false
  let reconnectAttempts = 0
  let webSocketDisabled = false
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
        const streamArgs = {
          sessionId,
          turnId: activeTurnId,
          after,
          signal,
          onEvent: async (event) => {
            const delivered = await deliverEvent(event)
            if (!delivered) return
            if (reconnectAttempts > 0) {
              reconnectAttempts = 0
              await onConnectionState?.({ status: 'connected', turnId: activeTurnId })
            }
          },
        }
        if (!webSocketDisabled) {
          try {
            terminal = await streamServerTurnEventsWebSocket({
              ...streamArgs,
              webSocketFactory,
              connectTimeoutMs: webSocketConnectTimeoutMs,
              subscribeTimeoutMs: webSocketSubscribeTimeoutMs,
            })
          } catch (webSocketError) {
            if (signal?.aborted || webSocketError?.name === 'AbortError') throw webSocketError
            webSocketDisabled = true
          }
        }
        if (!terminal) {
          terminal = await streamServerTurnEvents({ ...streamArgs, fetchImpl })
        }
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

