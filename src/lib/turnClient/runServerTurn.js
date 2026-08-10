import { fetchServerSessionSnapshot } from './sessionSnapshot.js'
import {
  cancelServerTurn,
  getServerTurn,
  replayServerTurn,
  resumeServerTurnRequest,
  startServerTurn,
} from './turnRequests.js'
import {
  DEFAULT_RECONNECT_MAX_ATTEMPTS,
  DEFAULT_RECONNECT_MAX_DELAY_MS,
  TERMINAL_EVENTS,
  defaultWebSocketFactory,
  reconnectDelayForAttempt,
  streamServerTurnEvents,
  streamServerTurnEventsWebSocket,
  waitForReconnect,
} from './turnTransport.js'
import { parseTurnEvent } from '../../../shared/turnEvents.js'

const DEFAULT_RECOVERY_POLL_INTERVAL_MS = 15_000
const DEFAULT_CANCEL_RETRY_DELAY_MS = 750
const DEFAULT_CANCEL_RETRY_MAX_DELAY_MS = 5_000

function finiteDelay(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, numeric) : fallback
}

export async function runServerTurn({
  sessionId,
  content,
  displayContent,
  attachments,
  modelName,
  history,
  agentId,
  skillIds,
  toolsConfig,
  intentMode = 'auto',
  turnId,
  resume = false,
  resumeResolution = null,
  afterSequence = -1,
  signal,
  onStarted,
  onEvent,
  onActivity,
  reconnectDelayMs = 500,
  reconnectMaxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS,
  reconnectMaxAttempts = DEFAULT_RECONNECT_MAX_ATTEMPTS,
  recoveryPollIntervalMs = DEFAULT_RECOVERY_POLL_INTERVAL_MS,
  cancelRetryDelayMs = DEFAULT_CANCEL_RETRY_DELAY_MS,
  cancelRetryMaxDelayMs = DEFAULT_CANCEL_RETRY_MAX_DELAY_MS,
  onConnectionState,
  syncSessionSnapshot = false,
  fetchImpl = fetch,
  webSocketFactory = defaultWebSocketFactory,
  webSocketConnectTimeoutMs,
  webSocketSubscribeTimeoutMs,
}) {
  const requestedTurnId = turnId || globalThis.crypto?.randomUUID?.() || `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const maxAttempts = Math.max(1, Number(reconnectMaxAttempts) || DEFAULT_RECONNECT_MAX_ATTEMPTS)
  const recoveryDelay = finiteDelay(recoveryPollIntervalMs, DEFAULT_RECOVERY_POLL_INTERVAL_MS)
  let activeTurnId = requestedTurnId
  let after = Number.isInteger(afterSequence) ? afterSequence : -1
  let terminal = null
  let cancelRequested = false
  let cancelAcknowledged = false
  let cancelAttempts = 0
  let reconnectAttempts = 0
  let recoveryMode = false
  let webSocketDisabled = false
  let resumeWakeRequested = false
  let activeRequestController = null
  let activeWaitController = null

  const notifyConnectionState = async (state) => {
    await onConnectionState?.({ turnId: activeTurnId, ...state })
  }

  const deliverEvent = async (event) => {
    // SSE reconnects, WebSocket delivery, and replay may overlap. Advance the
    // durable cursor only after the consumer acknowledges an event.
    if (event.sequence <= after) return false
    await onEvent?.(event)
    after = Math.max(after, event.sequence)
    // Any newly acknowledged event proves that the previous wake made
    // progress. A later disconnect may therefore issue one fresh wake.
    resumeWakeRequested = false
    return true
  }

  const deliverActivity = async (activity) => {
    // Transient activity is best-effort UI state. It never advances the
    // durable replay cursor and is intentionally absent from reconnects.
    await onActivity?.(activity)
  }

  const acceptTerminalFromTurn = async (turn) => {
    if (!TERMINAL_EVENTS.has(turn?.lastEvent?.type)) return false
    const event = parseTurnEvent(turn.lastEvent)
    await deliverEvent(event)
    terminal = event
    return true
  }

  const withRequestSignal = async (request) => {
    const controller = new AbortController()
    activeRequestController = controller
    try {
      return await request(controller.signal)
    } finally {
      if (activeRequestController === controller) activeRequestController = null
    }
  }

  const waitForNextAttempt = async (delayMs) => {
    const controller = new AbortController()
    activeWaitController = controller
    try {
      await waitForReconnect(delayMs, controller.signal)
    } catch (error) {
      // A user stop wakes a reconnect delay so the cancellation POST can be
      // issued immediately. It does not terminate the observation lifecycle.
      if (!(cancelRequested && error?.name === 'AbortError')) throw error
    } finally {
      if (activeWaitController === controller) activeWaitController = null
    }
  }

  const requestCancel = () => {
    if (cancelRequested) return
    cancelRequested = true
    activeRequestController?.abort()
    activeWaitController?.abort()
    Promise.resolve(notifyConnectionState({
      status: 'cancelling',
      confirmed: false,
      attempt: 0,
    })).catch(() => {})
  }

  const observePersistedTurn = async (initialCause = null) => {
    let cause = initialCause
    let delivered = 0
    let turn = null
    try {
      const events = await withRequestSignal((requestSignal) => replayServerTurn({
        sessionId,
        turnId: activeTurnId,
        after,
        signal: requestSignal,
        fetchImpl,
      }))
      for (const event of events) {
        if (await deliverEvent(event)) delivered += 1
        if (TERMINAL_EVENTS.has(event.type) && event.sequence <= after) terminal = event
      }
    } catch (error) {
      if (!(cancelRequested && error?.name === 'AbortError')) cause = error
    }
    if (terminal) return { cause, delivered, turn }
    try {
      turn = await withRequestSignal((requestSignal) => getServerTurn({
        sessionId,
        turnId: activeTurnId,
        signal: requestSignal,
        fetchImpl,
      }))
      await acceptTerminalFromTurn(turn)
    } catch (error) {
      if (!(cancelRequested && error?.name === 'AbortError')) cause = error
    }
    return { cause, delivered, turn }
  }

  const tryAcknowledgeCancellation = async () => {
    cancelAttempts += 1
    try {
      const turn = await withRequestSignal((requestSignal) => cancelServerTurn({
        sessionId,
        turnId: activeTurnId,
        signal: requestSignal,
        fetchImpl,
      }))
      cancelAcknowledged = true
      reconnectAttempts = 0
      recoveryMode = false
      await notifyConnectionState({
        status: 'cancelling',
        confirmed: true,
        attempt: cancelAttempts,
      })
      await acceptTerminalFromTurn(turn)
      return null
    } catch (error) {
      await notifyConnectionState({
        status: 'cancelling',
        confirmed: false,
        attempt: cancelAttempts,
        error,
      })
      return error
    }
  }

  const tryWakeTurn = async (cause) => {
    if (cancelRequested || resumeWakeRequested) return cause
    try {
      const resumed = await withRequestSignal((requestSignal) => resumeServerTurnRequest({
        sessionId,
        turnId: activeTurnId,
        signal: requestSignal,
        fetchImpl,
      }))
      resumeWakeRequested = true
      await acceptTerminalFromTurn(resumed)
      return cause
    } catch (error) {
      if (cancelRequested && error?.name === 'AbortError') return cause
      return error
    }
  }

  signal?.addEventListener('abort', requestCancel, { once: true })
  if (signal?.aborted) requestCancel()
  try {
    // Do not bind the initial request to the user-stop signal. If the stop is
    // clicked while the POST is in flight, its outcome is ambiguous; waiting
    // for the turn idempotency key to be acknowledged lets us cancel safely.
    const turn = resume
      ? await resumeServerTurnRequest({
          sessionId,
          turnId: requestedTurnId,
          resolution: resumeResolution,
          fetchImpl,
        })
      : await startServerTurn({
          sessionId,
          content,
          displayContent,
          attachments,
          modelName,
          turnId: requestedTurnId,
          history,
          agentId,
          skillIds,
          toolsConfig,
          intentMode,
          fetchImpl,
        })
    activeTurnId = turn.turnId
    await onStarted?.(turn)
    await acceptTerminalFromTurn(turn)

    while (!terminal) {
      if (cancelRequested && !cancelAcknowledged) {
        let cancelCause = await tryAcknowledgeCancellation()
        if (terminal) continue
        if (!cancelAcknowledged) {
          const observed = await observePersistedTurn(cancelCause)
          if (terminal) continue
          cancelCause = observed.cause || cancelCause
          const delayMs = reconnectDelayForAttempt(
            cancelAttempts,
            cancelRetryDelayMs,
            cancelRetryMaxDelayMs,
          )
          await notifyConnectionState({
            status: 'cancelling',
            confirmed: false,
            attempt: cancelAttempts,
            delayMs,
            error: cancelCause,
          })
          await waitForNextAttempt(delayMs)
          continue
        }
      }

      if (recoveryMode) {
        const observed = await observePersistedTurn()
        if (terminal) continue
        if (!cancelRequested && observed.turn?.status === 'interrupted') {
          observed.cause = await tryWakeTurn(observed.cause)
          if (terminal) continue
        }
        await notifyConnectionState({
          status: cancelRequested ? 'cancelling' : 'reconnecting',
          confirmed: cancelRequested ? cancelAcknowledged : undefined,
          recoverable: true,
          recoveryMode: true,
          attempt: reconnectAttempts,
          maxAttempts,
          delayMs: recoveryDelay,
          error: observed.cause,
        })
        await waitForNextAttempt(recoveryDelay)
        continue
      }

      try {
        const streamArgs = {
          sessionId,
          turnId: activeTurnId,
          after,
          onEvent: async (event) => {
            const delivered = await deliverEvent(event)
            if (!delivered || event.type === 'turn.interrupted') return
            if (reconnectAttempts > 0) {
              reconnectAttempts = 0
              recoveryMode = false
              resumeWakeRequested = false
              await notifyConnectionState({ status: cancelRequested ? 'cancelling' : 'connected', confirmed: cancelAcknowledged })
            }
          },
          onActivity: deliverActivity,
        }
        if (!webSocketDisabled) {
          try {
            terminal = await withRequestSignal((requestSignal) => streamServerTurnEventsWebSocket({
              ...streamArgs,
              signal: requestSignal,
              webSocketFactory,
              connectTimeoutMs: webSocketConnectTimeoutMs,
              subscribeTimeoutMs: webSocketSubscribeTimeoutMs,
            }))
          } catch (webSocketError) {
            if (cancelRequested && webSocketError?.name === 'AbortError') throw webSocketError
            webSocketDisabled = true
          }
        }
        if (!terminal) {
          terminal = await withRequestSignal((requestSignal) => streamServerTurnEvents({
            ...streamArgs,
            signal: requestSignal,
            fetchImpl,
          }))
        }
      } catch (error) {
        if (cancelRequested && error?.name === 'AbortError') continue
        const observed = await observePersistedTurn(error)
        if (terminal) continue
        let reconnectCause = observed.cause || error
        reconnectCause = await tryWakeTurn(reconnectCause)
        if (terminal) continue
        reconnectAttempts += 1
        recoveryMode = reconnectAttempts >= maxAttempts
        const delayMs = recoveryMode
          ? recoveryDelay
          : reconnectDelayForAttempt(reconnectAttempts, reconnectDelayMs, reconnectMaxDelayMs)
        await notifyConnectionState({
          status: cancelRequested ? 'cancelling' : 'reconnecting',
          confirmed: cancelRequested ? cancelAcknowledged : undefined,
          recoverable: true,
          recoveryMode,
          attempt: reconnectAttempts,
          maxAttempts,
          delayMs,
          error: reconnectCause,
        })
        await waitForNextAttempt(delayMs)
      }
    }

    let sessionSnapshot = null
    if (syncSessionSnapshot && terminal?.type === 'turn.completed') {
      try {
        sessionSnapshot = await fetchServerSessionSnapshot({ sessionId, fetchImpl })
      } catch {
        // The terminal event remains authoritative and replayable even when
        // this best-effort browser convergence request is unavailable.
      }
    }
    return { turnId: activeTurnId, terminal, lastSequence: after, sessionSnapshot }
  } finally {
    activeRequestController?.abort()
    activeWaitController?.abort()
    signal?.removeEventListener('abort', requestCancel)
  }
}
