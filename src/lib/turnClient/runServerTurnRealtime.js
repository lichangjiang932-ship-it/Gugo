import {
  TERMINAL_EVENTS,
  streamServerTurnEvents,
  streamServerTurnEventsWebSocket,
} from './turnTransport.js'
import { fetchServerSessionSnapshot } from './sessionSnapshot.js'
import {
  isApprovalPresentationClosed,
  requiresRuntimeRestart,
} from './runServerTurnRecovery.js'

export async function streamServerTurnRealtimeAttempt({
  sessionId,
  turnId,
  after,
  deliverEvent,
  deliverActivity,
  getReconnectState,
  resetReconnectState,
  notifyConnectionState,
  withRequestSignal,
  shouldAttemptWebSocket,
  markWebSocketDisabled,
  isCancellationRequested,
  webSocketFactory,
  webSocketConnectTimeoutMs,
  webSocketSubscribeTimeoutMs,
  fetchImpl,
}) {
  const streamArgs = {
    sessionId,
    turnId,
    after,
    onEvent: async (event) => {
      const delivered = await deliverEvent(event)
      if (!delivered || event.type === 'turn.interrupted') return
      const reconnectState = getReconnectState()
      if (reconnectState.attempts > 0) {
        resetReconnectState()
        await notifyConnectionState({
          status: reconnectState.cancelRequested ? 'cancelling' : 'connected',
          confirmed: reconnectState.cancelAcknowledged,
        })
      }
    },
    onActivity: deliverActivity,
  }
  let terminal = null
  if (shouldAttemptWebSocket) {
    try {
      terminal = await withRequestSignal((requestSignal) => streamServerTurnEventsWebSocket({
        ...streamArgs,
        signal: requestSignal,
        webSocketFactory,
        connectTimeoutMs: webSocketConnectTimeoutMs,
        subscribeTimeoutMs: webSocketSubscribeTimeoutMs,
      }))
    } catch (webSocketError) {
      if (isCancellationRequested() && webSocketError?.name === 'AbortError') throw webSocketError
      if (isApprovalPresentationClosed(webSocketError)) throw webSocketError
      if (requiresRuntimeRestart(webSocketError)) throw webSocketError
      if (webSocketError?.serverFailure) throw webSocketError
      markWebSocketDisabled()
    }
  }
  if (!terminal) {
    terminal = await withRequestSignal((requestSignal) => streamServerTurnEvents({
      ...streamArgs,
      signal: requestSignal,
      fetchImpl,
    }))
  }
  return terminal
}

export async function fetchTerminalServerSessionSnapshot({
  syncSessionSnapshot,
  terminal,
  sessionId,
  fetchImpl,
}) {
  if (!syncSessionSnapshot || !TERMINAL_EVENTS.has(terminal?.type)) return null
  try {
    return await fetchServerSessionSnapshot({ sessionId, fetchImpl })
  } catch {
    // The terminal event remains authoritative even if browser convergence is unavailable.
    return null
  }
}
