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
import { canAdvanceTurnEventCursor, parseTurnEvent } from '../../../shared/turnEvents.js'
import {
  DEFAULT_CANCEL_RETRY_DELAY_MS, DEFAULT_CANCEL_RETRY_MAX_DELAY_MS,
  DEFAULT_RECOVERY_POLL_INTERVAL_MS, DEFAULT_UNCONFIRMED_RECOVERY_MAX_ATTEMPTS,
  confirmsExistingTurn, finiteDelay, hasTurnIdentity, incompleteInitialTurnError,
  isAmbiguousInitialRequestError, isApprovalPresentationClosed, isRecoveryDeadLetterError,
  isTurnEventSequenceGapError, recoveryDeadLetterError, requiresRuntimeRestart,
  turnEventSequenceGapError, unconfirmedInitialTurnError,
} from './runServerTurnRecovery.js'

export async function runServerTurn({
  sessionId,
  content,
  displayContent,
  attachments,
  workspacePath,
  locale,
  modelConfigRevision,
  modelName,
  modelProviderId,
  modelMode = 'agent',
  history,
  agentId,
  skillIds,
  skillDefinitions,
  toolsConfig,
  intentMode = 'auto',
  turnId,
  resume = false,
  resumeResolution = null,
  retryFailed = false,
  retryRecovery = false,
  afterSequence = -1,
  signal,
  onStarted,
  onEvent,
  onActivity,
  reconnectDelayMs = 500,
  reconnectMaxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS,
  reconnectMaxAttempts = DEFAULT_RECONNECT_MAX_ATTEMPTS,
  recoveryPollIntervalMs = DEFAULT_RECOVERY_POLL_INTERVAL_MS,
  unconfirmedRecoveryMaxAttempts = DEFAULT_UNCONFIRMED_RECOVERY_MAX_ATTEMPTS,
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
  const maxUnconfirmedAttempts = Math.max(
    1,
    Number(unconfirmedRecoveryMaxAttempts) || DEFAULT_UNCONFIRMED_RECOVERY_MAX_ATTEMPTS,
  )
  let activeTurnId = requestedTurnId
  let after = Number.isInteger(afterSequence) ? afterSequence : -1
  let terminal = null
  let cancelRequested = false
  let cancelAcknowledged = false
  let cancelAttempts = 0
  let reconnectAttempts = 0
  let recoveryMode = false
  let webSocketDisabled = false
  let initialTurnConfirmed
  let unconfirmedAttempts = 0
  let startedNotified = false
  let resumeWakeRequested = false
  let activeRequestController = null
  let activeWaitController = null
  let initialRequestController = null
  let resolveCancellationStarted = () => {}
  const cancellationStarted = new Promise((resolve) => {
    resolveCancellationStarted = resolve
  })

  const notifyConnectionState = async (state) => {
    await onConnectionState?.({ turnId: activeTurnId, ...state })
  }

  const deliverEvent = async (event) => {
    // SSE reconnects, WebSocket delivery, and replay may overlap. Advance the
    // durable cursor only after the consumer acknowledges an event.
    if (event.sequence <= after) return false
    const expectedSequence = after + 1
    if (!canAdvanceTurnEventCursor(event, after)) {
      throw turnEventSequenceGapError({
        turnId: activeTurnId,
        expectedSequence,
        actualSequence: event.sequence,
      })
    }
    await onEvent?.(event)
    after = event.sequence
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

  const acknowledgeStartedTurn = async (turn = null) => {
    initialTurnConfirmed = true
    if (startedNotified) return false
    const acknowledgedTurn = hasTurnIdentity(turn)
      ? turn
      : {
          sessionId,
          turnId: activeTurnId,
          status: terminal ? 'completed' : 'running',
        }
    activeTurnId = String(acknowledgedTurn.turnId || activeTurnId)
    startedNotified = true
    await onStarted?.(acknowledgedTurn)
    return true
  }

  const acceptTerminalFromTurn = async (turn) => {
    if (TERMINAL_EVENTS.has(turn?.lastEvent?.type)) {
      const event = parseTurnEvent(turn.lastEvent)
      await deliverEvent(event)
      terminal = event
      return true
    }
    const recoveryError = recoveryDeadLetterError(turn)
    if (recoveryError) throw recoveryError
    return false
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
    resolveCancellationStarted()
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
      if (isRecoveryDeadLetterError(error)) throw error
      if (isApprovalPresentationClosed(error)) throw error
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
      if (isApprovalPresentationClosed(error)) throw error
      if (!(cancelRequested && error?.name === 'AbortError')) cause = error
    }
    return { cause, delivered, turn }
  }

  const acceptTerminalWithReplay = async (turn) => {
    try {
      return await acceptTerminalFromTurn(turn)
    } catch (error) {
      if (!isTurnEventSequenceGapError(error)) throw error
      let cause = error
      while (!terminal) {
        const observed = await observePersistedTurn(cause)
        if (terminal) return true
        if (observed.delivered === 0) throw observed.cause || cause
        cause = observed.cause || cause
      }
      return true
    }
  }

  const tryAcknowledgeCancellation = async ({ acceptTerminal = true } = {}) => {
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
      if (acceptTerminal) await acceptTerminalWithReplay(turn)
      return { turn, error: null }
    } catch (error) {
      await notifyConnectionState({
        status: 'cancelling',
        confirmed: false,
        attempt: cancelAttempts,
        error,
      })
      return { turn: null, error }
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
      await acceptTerminalWithReplay(resumed)
      return cause
    } catch (error) {
      if (cancelRequested && error?.name === 'AbortError') return cause
      return error
    }
  }

  signal?.addEventListener('abort', requestCancel, { once: true })
  if (signal?.aborted) requestCancel()
  try {
    const issueInitialRequest = (requestSignal) => (resume
      ? resumeServerTurnRequest({
          sessionId,
          turnId: requestedTurnId,
          resolution: resumeResolution,
          retryFailed,
          retryRecovery,
          signal: requestSignal,
          fetchImpl,
        })
      : startServerTurn({
          sessionId,
          content,
          displayContent,
          attachments,
          workspacePath,
          locale,
          modelConfigRevision,
          modelName,
          modelProviderId,
          modelMode,
          turnId: requestedTurnId,
          history,
          agentId,
          skillIds,
          skillDefinitions,
          toolsConfig,
          intentMode,
          signal: requestSignal,
          fetchImpl,
        }))

    // The client already owns the idempotent turn id. Race the initial POST
    // with a user stop so cancellation can be sent even when /run has not
    // returned yet. The initial request is only aborted after /cancel is
    // acknowledged, avoiding an ambiguous create-or-cancel outcome.
    initialRequestController = new AbortController()
    const initialRequest = issueInitialRequest(initialRequestController.signal)
      .then(
        (turn) => ({ kind: 'started', turn }),
        (error) => ({ kind: 'failed', error }),
      )
    let initialOutcome = cancelRequested
      ? { kind: 'cancel' }
      : await Promise.race([
          initialRequest,
          cancellationStarted.then(() => ({ kind: 'cancel' })),
        ])

    while (initialOutcome.kind === 'cancel') {
      const cancellation = await tryAcknowledgeCancellation({ acceptTerminal: false })
      if (cancellation.turn) {
        initialRequestController.abort()
        initialOutcome = { kind: 'started', turn: cancellation.turn }
        break
      }
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
        error: cancellation.error,
      })
      const retry = waitForNextAttempt(delayMs).then(() => ({ kind: 'cancel' }))
      initialOutcome = await Promise.race([initialRequest, retry])
      if (initialOutcome.kind !== 'cancel') activeWaitController?.abort()
    }

    if (initialOutcome.kind === 'started' && !hasTurnIdentity(initialOutcome.turn)) {
      initialOutcome = { kind: 'failed', error: incompleteInitialTurnError(requestedTurnId) }
    }

    let turn = initialOutcome.turn
    if (initialOutcome.kind === 'failed') {
      if (!isAmbiguousInitialRequestError(initialOutcome.error)) throw initialOutcome.error
      unconfirmedAttempts = 1

      // The POST may have reached the server even when its response body was
      // cut off. The client already knows the durable turn id, so first take
      // over through replay/query instead of creating a second logical turn.
      reconnectAttempts = 1
      const observed = await observePersistedTurn(initialOutcome.error)
      if (observed.delivered === 0 && isTurnEventSequenceGapError(observed.cause)) {
        throw observed.cause
      }
      initialTurnConfirmed = Boolean(
        terminal || observed.turn || observed.delivered > 0 || confirmsExistingTurn(initialOutcome.error),
      )
      recoveryMode = !initialTurnConfirmed
      if (recoveryMode && unconfirmedAttempts >= maxUnconfirmedAttempts) {
        throw unconfirmedInitialTurnError(requestedTurnId, unconfirmedAttempts, observed.cause || initialOutcome.error)
      }
      turn = observed.turn || {
        sessionId,
        turnId: requestedTurnId,
        status: terminal ? 'completed' : initialTurnConfirmed ? 'running' : 'recovering',
      }
      if (!terminal) {
        await notifyConnectionState({
          status: cancelRequested ? 'cancelling' : 'reconnecting',
          confirmed: cancelRequested ? cancelAcknowledged : undefined,
          recoverable: true,
          recoveryMode,
          attempt: reconnectAttempts,
          maxAttempts,
          delayMs: recoveryMode ? recoveryDelay : 0,
          error: observed.cause || initialOutcome.error,
        })
      }
    } else {
      initialTurnConfirmed = true
    }

    activeTurnId = String(turn?.turnId || requestedTurnId)
    if (initialTurnConfirmed) {
      await acknowledgeStartedTurn(turn)
      await acceptTerminalWithReplay(turn)
    }

    while (!terminal) {
      if (cancelRequested && !cancelAcknowledged) {
        const cancellation = await tryAcknowledgeCancellation()
        let cancelCause = cancellation.error
        if (cancellation.turn) await acknowledgeStartedTurn(cancellation.turn)
        if (terminal) continue
        if (!cancelAcknowledged) {
          const observed = await observePersistedTurn(cancelCause)
          if (terminal || observed.turn || observed.delivered > 0) {
            await acknowledgeStartedTurn(observed.turn)
          }
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
        if (terminal || observed.turn || observed.delivered > 0) {
          await acknowledgeStartedTurn(observed.turn)
        }
        if (terminal) continue
        if (observed.delivered === 0 && isTurnEventSequenceGapError(observed.cause)) {
          throw observed.cause
        }
        if (!cancelRequested && !initialTurnConfirmed) {
          try {
            const retriedTurn = await withRequestSignal(issueInitialRequest)
            if (!hasTurnIdentity(retriedTurn)) throw incompleteInitialTurnError(requestedTurnId)
            await acknowledgeStartedTurn(retriedTurn)
            await acceptTerminalWithReplay(retriedTurn)
          } catch (error) {
            if (cancelRequested && error?.name === 'AbortError') continue
            if (confirmsExistingTurn(error)) await acknowledgeStartedTurn()
            else if (!isAmbiguousInitialRequestError(error)) throw error
            else unconfirmedAttempts += 1
            observed.cause = error
          }
          if (terminal) continue
          if (!initialTurnConfirmed && unconfirmedAttempts >= maxUnconfirmedAttempts) {
            throw unconfirmedInitialTurnError(activeTurnId, unconfirmedAttempts, observed.cause)
          }
        }

        if (!cancelRequested && initialTurnConfirmed && observed.turn?.status === 'interrupted') {
          observed.cause = await tryWakeTurn(observed.cause)
          if (isRecoveryDeadLetterError(observed.cause)) throw observed.cause
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

        // Recovery polling keeps durable state visible, but it is not a live
        // transport. Periodically promote back to WebSocket/SSE so transient
        // tool activity and streaming deltas return as soon as the network
        // does. A fresh WebSocket attempt is allowed even if an earlier one
        // failed before recovery mode was entered.
        if (!cancelRequested && initialTurnConfirmed) {
          recoveryMode = false
          webSocketDisabled = false
          continue
        }
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
            if (isApprovalPresentationClosed(webSocketError)) throw webSocketError
            if (requiresRuntimeRestart(webSocketError)) throw webSocketError
            if (webSocketError?.serverFailure) throw webSocketError
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
        if (isApprovalPresentationClosed(error)) throw error
        if (requiresRuntimeRestart(error)) throw error
        const observed = await observePersistedTurn(error)
        if (terminal || observed.turn || observed.delivered > 0) {
          await acknowledgeStartedTurn(observed.turn)
        }
        if (terminal) continue
        if (observed.delivered === 0 && isTurnEventSequenceGapError(observed.cause)) {
          throw observed.cause
        }
        let reconnectCause = observed.cause || error
        reconnectCause = await tryWakeTurn(reconnectCause)
        if (isRecoveryDeadLetterError(reconnectCause)) throw reconnectCause
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
    if (syncSessionSnapshot && TERMINAL_EVENTS.has(terminal?.type)) {
      try {
        sessionSnapshot = await fetchServerSessionSnapshot({ sessionId, fetchImpl })
      } catch {
        // The terminal event remains authoritative even if browser convergence is unavailable.
      }
    }
    return { turnId: activeTurnId, terminal, lastSequence: after, sessionSnapshot }
  } finally {
    initialRequestController?.abort()
    activeRequestController?.abort()
    activeWaitController?.abort()
    signal?.removeEventListener('abort', requestCancel)
  }
}
