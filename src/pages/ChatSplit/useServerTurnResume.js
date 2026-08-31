import { useEffect } from 'react'
import { createBufferedTurnActivityDispatcher, dispatchTurnEvent, runServerTurn } from '../../lib/turnClient.js'
import {
  createTurnFailureError,
  isModelRequestOutcomeUnknownRecoveryKind,
  isSideEffectOutcomeUnknownRecoveryKind,
  MODEL_REQUEST_OUTCOME_UNKNOWN_RECOVERY_KIND,
  SIDE_EFFECT_OUTCOME_UNKNOWN_RECOVERY_KIND,
} from '../../lib/turnClient/turnEventDispatch.js'
import { TASK_STATUS } from '../../store/taskStatus.js'
import {
  buildChatFailureDisplayKey,
  buildChatFailureMessage,
  getVisibleModelErrorMessage,
  getVisibleTurnClarification,
  isPermanentFailedRetryRejectionFailure,
} from '../../lib/chatFlowGuards.js'
import { isUserStopped, terminalFailureEvidenceMeta, turnEventTimestamp } from './serverTurnFlow.js'
import { hasTurnRun, registerTurnRun, unregisterTurnRun } from './turnRunRegistry.js'
import { mergeAssistantText, missingAssistantTextSuffix } from '../../lib/assistantTextContinuity.js'

function nonEmptyTaskVerification(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
    ? value
    : null
}

export function reduceResumedAssistantText(currentText, event) {
  if (event?.type === 'turn.attempt' && event.payload?.resetStreaming) {
    return String(event.payload?.assistantText || '')
  }
  if (event?.type === 'assistant.delta' && event.payload?.text) {
    return `${String(currentText || '')}${String(event.payload.text)}`
  }
  if (event?.type === 'turn.interrupted'
    || event?.type === 'turn.blocked'
    || event?.type === 'turn.failed') {
    return mergeAssistantText(currentText, event.payload?.partialText ?? event.payload?.text ?? '')
  }
  return String(currentText || '')
}

export function terminalResumeText(currentText, terminal, t) {
  const terminalText = terminal?.payload?.text
    || (terminal?.type === 'turn.paused'
      ? getVisibleTurnClarification(terminal.payload?.clarification, t)
      : '')
  return missingAssistantTextSuffix(currentText, terminalText)
}

export function failedRetryFailureFromError(error, previousFailure = null) {
  const previous = previousFailure && typeof previousFailure === 'object'
    ? previousFailure
    : {}
  const current = error?.serverFailure && typeof error.serverFailure === 'object'
    ? error.serverFailure
    : error || {}
  const code = String(error?.serverFailure?.code || error?.code || 'TURN_REQUEST_FAILED')
    .trim().toUpperCase() || 'TURN_REQUEST_FAILED'
  const status = Number(error?.serverFailure?.status ?? error?.status)
  const retryable = error?.serverFailure?.retryable ?? error?.retryable
  const manualRetryable = error?.serverFailure?.manualRetryable ?? error?.manualRetryable
  const incompleteReason = String(
    current.incompleteReason || error?.incompleteReason || previous.incompleteReason || '',
  ).trim()
  const currentMissingRequirements = Array.isArray(current.missingRequirements)
    ? current.missingRequirements
    : []
  const outerMissingRequirements = Array.isArray(error?.missingRequirements)
    ? error.missingRequirements
    : []
  const missingRequirements = [...new Set((currentMissingRequirements.length > 0
    ? currentMissingRequirements
    : outerMissingRequirements.length > 0
      ? outerMissingRequirements
      : Array.isArray(previous.missingRequirements) ? previous.missingRequirements : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))].slice(0, 16)
  const taskVerification = nonEmptyTaskVerification(current.taskVerification)
    || nonEmptyTaskVerification(error?.taskVerification)
    || nonEmptyTaskVerification(previous.taskVerification)
  const reason = String(current.reason || error?.reason || previous.reason || '').trim()
  const nextAction = String(current.nextAction || error?.nextAction || previous.nextAction || '').trim()
  return {
    code,
    retryable: retryable === true,
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(typeof manualRetryable === 'boolean' ? { manualRetryable } : {}),
    ...(incompleteReason ? { incompleteReason } : {}),
    ...(reason ? { reason } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(missingRequirements.length > 0 ? { missingRequirements } : {}),
    ...(taskVerification ? { taskVerification } : {}),
  }
}

function mergeFailureDiagnostics(currentFailure, previousFailure) {
  const current = currentFailure && typeof currentFailure === 'object' ? currentFailure : null
  const previous = previousFailure && typeof previousFailure === 'object' ? previousFailure : null
  if (!current) return previous
  if (!previous) return current
  const currentMissing = Array.isArray(current.missingRequirements)
    ? current.missingRequirements.filter(Boolean)
    : []
  const taskVerification = nonEmptyTaskVerification(current.taskVerification)
    || nonEmptyTaskVerification(previous.taskVerification)
  const reason = String(current.reason || previous.reason || '').trim()
  const nextAction = String(current.nextAction || previous.nextAction || '').trim()
  return {
    ...previous,
    ...current,
    ...(current.incompleteReason || previous.incompleteReason
      ? { incompleteReason: current.incompleteReason || previous.incompleteReason }
      : {}),
    ...(reason ? { reason } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(currentMissing.length > 0 || Array.isArray(previous.missingRequirements)
      ? { missingRequirements: currentMissing.length > 0 ? currentMissing : previous.missingRequirements }
      : {}),
    ...(taskVerification ? { taskVerification } : {}),
  }
}

export function isRecoverableServerMessage(message) {
  const connectionState = message?.meta?.serverConnectionState
  return Boolean(message?.meta?.streaming)
    || ['interrupted', 'reconnecting', 'cancelling'].includes(connectionState)
}

function sameNonEmptyId(left, right) {
  return typeof left === 'string'
    && left.length > 0
    && typeof right === 'string'
    && right.length > 0
    && left === right
}

export function matchesManualRecoveryResume(session, message, resume) {
  return resume?.kind === 'turn'
    && sameNonEmptyId(resume.sessionId, session?.id)
    && sameNonEmptyId(resume.turnId, message?.meta?.serverTurnId)
    && sameNonEmptyId(resume.toolCallId, message?.meta?.serverRecoveryToolCallId)
    && message?.meta?.serverRecoveryBlocked === true
    && isSideEffectOutcomeUnknownRecoveryKind(message?.meta?.serverRecoveryKind)
    && message?.meta?.serverConnectionState === 'blocked'
}

export function matchesFailedTurnRetryResume(session, message, retry) {
  const failure = message?.meta?.serverFailure
  const sameFailureCode = typeof retry?.code === 'string'
    && retry.code.length > 0
    && retry.code === failure?.code
  return sameNonEmptyId(retry?.sessionId, session?.id)
    && sameNonEmptyId(retry?.turnId, message?.meta?.serverTurnId)
    && message?.meta?.failed === true
    && sameFailureCode
    && (
      (retry.code === 'TURN_INCOMPLETE' && failure.retryable === true)
      || (retry.manualRetryable === true && failure.manualRetryable === true)
    )
}

function serverTurnResumeClaimKey(sessionId, turnId) {
  return `${String(sessionId || '')}\u0000${String(turnId || '')}`
}

export function claimServerTurnResume(
  claims,
  sessionId,
  turnId,
  hasActiveTurn = hasTurnRun,
) {
  if (!(claims instanceof Set) || !sameNonEmptyId(sessionId, sessionId) || !sameNonEmptyId(turnId, turnId)) {
    return false
  }
  const key = serverTurnResumeClaimKey(sessionId, turnId)
  if (claims.has(key) || hasActiveTurn(sessionId, turnId)) return false
  claims.add(key)
  return true
}

function releaseServerTurnResume(claims, sessionId, turnId) {
  claims.delete(serverTurnResumeClaimKey(sessionId, turnId))
}

export function shouldKeepResumePending({ resumeResolution, resumeAccepted, stopped }) {
  return Boolean(resumeResolution) && resumeAccepted !== true && stopped !== true
}

export function serverResumeAfterSequence(message) {
  const sequence = message?.meta?.serverLastSequence
  return Number.isInteger(sequence) && sequence >= -1 ? sequence : -1
}

export default function useServerTurnResume({
  abortCtrlRef,
  clearToolApprovalForOwner,
  dispatch,
  requestServerToolApproval,
  resolveToolApprovalForOwner,
  resumingTurnIdsRef,
  stateActiveSessionId,
  stateResumeSignal,
  stateTurnRunActive,
  stateRef,
  t,
  manualRecoveryResume = null,
  onManualRecoveryConsumed,
  failedTurnRetry = null,
  onFailedTurnRetryConsumed,
  onFailedTurnRetrySettled,
}) {
  useEffect(() => {
    if (abortCtrlRef.current) return
    const current = stateRef.current
    const session = current.sessions.find((item) => item.id === current.activeSessionId)
    const message = manualRecoveryResume?.kind === 'turn'
      ? [...(session?.messages || [])].reverse().find((item) => (
          item.role === 'assistant' && item.meta?.serverTurnId === manualRecoveryResume.turnId
          && item.meta?.serverRecoveryToolCallId === manualRecoveryResume.toolCallId
        ))
      : failedTurnRetry?.sessionId === session?.id
        ? [...(session?.messages || [])].reverse().find((item) => (
            item.role === 'assistant' && item.meta?.serverTurnId === failedTurnRetry.turnId
          ))
      : [...(session?.messages || [])].reverse().find((item) => item.role === 'assistant')
    const turnId = message?.meta?.serverTurnId
    const manualRecovery = matchesManualRecoveryResume(session, message, manualRecoveryResume)
    const failedRetry = matchesFailedTurnRetryResume(session, message, failedTurnRetry)
    if (
      !session?.id
      || !turnId
      || (!manualRecovery && !failedRetry && !isRecoverableServerMessage(message))
      || !claimServerTurnResume(resumingTurnIdsRef.current, session.id, turnId)
    ) return

    const controller = new AbortController()
    const owner = { sessionId: session.id, turnId }
    try {
      registerTurnRun({ sessionId: session.id, turnId, controller })
    } catch (error) {
      releaseServerTurnResume(resumingTurnIdsRef.current, session.id, turnId)
      if (error?.code !== 'SESSION_TURN_ALREADY_RUNNING') console.error('Failed to register resumed turn', error)
      return
    }
    abortCtrlRef.current = controller
    if (manualRecovery) onManualRecoveryConsumed?.()
    if (failedRetry) onFailedTurnRetryConsumed?.(failedTurnRetry)
    const taskId = `resume-${turnId}`
    const serverArtifacts = [...(message.meta?.serverArtifacts || [])]
    const failedRetryPartialText = failedRetry && typeof message.meta?.serverPartialText === 'string'
      ? message.meta.serverPartialText
      : ''
    const resumeResolution = failedRetry ? null : message.meta?.serverResumeResolution || null
    const messageTarget = { sessionId: session.id, messageId: message.id }
    const dispatchMessage = (type, payload) => dispatch({ type, payload, ...messageTarget })
    const storedStartedAt = message.meta?.turnStartedAt == null
      ? Number.NaN
      : Number(message.meta.turnStartedAt)
    const timestampStartedAt = message.timestamp == null ? Number.NaN : Number(message.timestamp)
    const turnStartedAt = Number.isFinite(storedStartedAt)
      ? storedStartedAt
      : Number.isFinite(timestampStartedAt) ? timestampStartedAt : Date.now()
    const turnActivityDispatcher = createBufferedTurnActivityDispatcher({ dispatch, taskId, messageTarget })
    controller.signal.addEventListener('abort', () => {
      turnActivityDispatcher.flush()
      resolveToolApprovalForOwner(owner, { approved: false })
    }, { once: true })
    const durablePartialText = !failedRetry && typeof message.meta?.serverPartialText === 'string'
      ? message.meta.serverPartialText
      : ''
    let currentAssistantText = mergeAssistantText(message.content, durablePartialText)
    let resumeAccepted = false
    let failedRetryResult = null
    const durablePartialSuffix = missingAssistantTextSuffix(message.content, durablePartialText)
    if (durablePartialSuffix) dispatchMessage('APPEND_TO_LAST_MESSAGE', durablePartialSuffix)
    dispatchMessage('UPDATE_LAST_MESSAGE_META', {
      turnStartedAt,
      turnCompletedAt: null,
      latency: null,
      streaming: true,
      serverConnectionState: 'reconnecting',
      serverRecoveryBlocked: false,
      serverRecoveryKind: null,
      serverRecoveryToolCallId: null,
      serverRecoveryModelRequestId: null,
      serverRecoveryActionPath: null,
      ...(failedRetry ? {
        failed: false,
        serverFailure: null,
        serverFailureDisplayKey: null,
        serverPartialText: null,
      } : {}),
    })
    dispatch({
      type: 'ADD_TASK',
      payload: { id: taskId, name: t('chat.serverTurn.resumeTask'), detail: t('chat.serverTurn.resumeDetail'), status: TASK_STATUS.RUNNING, step: 1, stepLabel: t('chat.serverTurn.resuming'), perms: [] },
    })

    runServerTurn({
      sessionId: session.id,
      turnId,
      resume: true,
      retryFailed: failedRetry,
      retryRecovery: manualRecovery,
      resumeResolution,
      afterSequence: serverResumeAfterSequence(message),
      signal: controller.signal,
      syncSessionSnapshot: true,
      onConnectionState: ({ status, attempt, maxAttempts }) => {
        if (status === 'reconnecting') {
          dispatchMessage('UPDATE_LAST_MESSAGE_META', { streaming: true, serverConnectionState: 'reconnecting', modelActivity: null })
          dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: t('chat.serverTurn.reconnecting', { attempt, max: maxAttempts }) } } })
        } else if (status === 'connected') {
          dispatchMessage('UPDATE_LAST_MESSAGE_META', { streaming: true, serverConnectionState: 'connected', modelActivity: null })
          dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: t('chat.serverTurn.reconnected') } } })
        } else if (status === 'cancelling') {
          dispatchMessage('UPDATE_LAST_MESSAGE_META', { streaming: true, serverConnectionState: 'cancelling', modelActivity: null })
          dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: t('taskCenter.statuses.cancel_requested') } } })
        }
      },
      onActivity: turnActivityDispatcher.onActivity,
      onEvent: async (event) => {
        if (event?.type === 'turn.resumed') resumeAccepted = true
        const previousAssistantText = currentAssistantText
        currentAssistantText = reduceResumedAssistantText(currentAssistantText, event)
        if (event.type === 'turn.interrupted'
          || event.type === 'turn.blocked'
          || event.type === 'turn.failed') {
          const suffix = currentAssistantText.startsWith(previousAssistantText)
            ? currentAssistantText.slice(previousAssistantText.length)
            : currentAssistantText
          if (suffix) dispatchMessage('APPEND_TO_LAST_MESSAGE', suffix)
        }
        const dispatchResult = await dispatchTurnEvent(event, {
          dispatch,
          taskId,
          messageTarget,
          flushToolOutput: turnActivityDispatcher.flush,
          onApproval: (request) => requestServerToolApproval(request, owner),
          onArtifact: (artifact) => {
            const filename = artifact.filename || 'artifact'
            const type = filename.includes('.') ? filename.split('.').pop().toLowerCase() : 'file'
            if (!serverArtifacts.some((item) => item.id === artifact.id)) {
              serverArtifacts.push({ ...artifact, filename, type })
              dispatchMessage('UPDATE_LAST_MESSAGE_META', { serverArtifacts: [...serverArtifacts] })
            }
          },
        })
        if (!dispatchResult?.cursorCommitted) {
          dispatchMessage('UPDATE_LAST_MESSAGE_META', { serverLastSequence: event.sequence })
        }
      },
    }).then(({ terminal, sessionSnapshot }) => {
      if (failedRetry) failedRetryResult = { terminal }
      turnActivityDispatcher.flush()
      if (terminal.type === 'turn.failed') {
        const error = createTurnFailureError(terminal.payload)
        error.turnCompletedAt = turnEventTimestamp(terminal)
        error.sessionSnapshot = sessionSnapshot
        throw error
      }
      if (terminal.type === 'turn.cancelled') {
        const error = new Error('Generation stopped')
        error.name = 'AbortError'
        error.turnCompletedAt = turnEventTimestamp(terminal)
        throw error
      }
      if (terminal.type === 'turn.blocked') {
        dispatchMessage('UPDATE_LAST_MESSAGE_META', {
          turnStartedAt,
          turnCompletedAt: null,
          latency: null,
          streaming: false,
          cancelled: false,
          interrupted: false,
          paused: false,
          failed: false,
          serverArtifacts,
          serverConnectionState: 'blocked',
          serverRecoveryBlocked: true,
          serverRecoveryKind: null,
          serverRecoveryToolCallId: null,
          serverRecoveryModelRequestId: null,
          serverRecoveryActionPath: null,
          ...(isSideEffectOutcomeUnknownRecoveryKind(terminal.payload?.recoveryKind) ? {
            serverRecoveryKind: SIDE_EFFECT_OUTCOME_UNKNOWN_RECOVERY_KIND,
            serverRecoveryToolCallId: terminal.payload?.toolCallId || null,
            serverRecoveryActionPath: '/settings?tab=recovery',
          } : {}),
          ...(isModelRequestOutcomeUnknownRecoveryKind(terminal.payload?.recoveryKind) ? {
            serverRecoveryKind: MODEL_REQUEST_OUTCOME_UNKNOWN_RECOVERY_KIND,
            serverRecoveryModelRequestId: terminal.payload?.modelRequestId || null,
            serverRecoveryActionPath: '/settings?tab=recovery',
          } : {}),
          serverClarification: null,
          directoryAuthorizationPending: false,
          serverResumeResolution: null,
        })
        dispatch({
          type: 'UPDATE_TASK',
          payload: {
            id: taskId,
            updates: {
              status: TASK_STATUS.PENDING,
              stepLabel: terminal.payload?.recoveryKind === MODEL_REQUEST_OUTCOME_UNKNOWN_RECOVERY_KIND
                ? t('chatMessages.modelRequestUnknownTitle')
                : terminal.payload?.recoveryKind === SIDE_EFFECT_OUTCOME_UNKNOWN_RECOVERY_KIND
                  ? t('chatMessages.sideEffectUnknownTitle')
                  : t('chat.serverTurn.resumeFailed'),
            },
          },
        })
        return
      }
      const terminalText = terminalResumeText(currentAssistantText, terminal, t)
      if (terminalText) dispatchMessage('APPEND_TO_LAST_MESSAGE', terminalText)
      const completedAt = turnEventTimestamp(terminal)
      const timingMeta = {
        turnStartedAt,
        turnCompletedAt: completedAt,
        latency: Math.max(0, completedAt - turnStartedAt),
      }
      if (terminal.type === 'turn.paused') {
        dispatchMessage('UPDATE_LAST_MESSAGE_META', {
          ...timingMeta,
          streaming: false,
          cancelled: false,
          failed: false,
          interrupted: false,
          paused: true,
          serverArtifacts,
          serverConnectionState: 'paused',
          serverClarification: terminal.payload?.clarification || null,
          directoryAuthorizationPending: false,
          serverResumeResolution: null,
        })
        dispatch({
          type: 'UPDATE_TASK',
          payload: {
            id: taskId,
            updates: {
              status: TASK_STATUS.PENDING,
              stepLabel: getVisibleTurnClarification(terminal.payload?.clarification, t),
            },
          },
        })
        return
      }
      dispatchMessage('UPDATE_LAST_MESSAGE_META', {
        ...timingMeta,
        streaming: false,
        cancelled: false,
        failed: false,
        interrupted: false,
        paused: false,
        serverClarification: null,
        directoryAuthorizationPending: false,
        directoryAuthorizationError: null,
        serverResumeResolution: null,
        serverArtifacts,
        serverConnectionState: null,
      })
      if (sessionSnapshot) {
        dispatch({
          type: 'APPLY_SERVER_SESSION_SNAPSHOT',
          payload: { sessionId: session.id, snapshot: sessionSnapshot },
        })
      }
      dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.COMPLETED, stepLabel: t('chat.serverTurn.resumed') } } })
    }).catch((error) => {
      if (failedRetry) failedRetryResult = { failed: true, error }
      turnActivityDispatcher.flush()
      const stopped = isUserStopped(error)
      const recoveryDeadLetter = error?.recovery?.status === 'dead_letter'
      const permanentFailedRetryRejection = failedRetry
        && isPermanentFailedRetryRejectionFailure(error)
      const recoveryFailure = recoveryDeadLetter
        ? {
            code: String(error?.code || 'TURN_RECOVERY_DEAD_LETTER'),
            retryable: false,
            manualRetryable: true,
            incompleteReason: 'recovery_attempts_exhausted',
            missingRequirements: ['execution_environment_repair', 'explicit_recovery_retry'],
          }
        : null
      const currentFailure = error?.serverFailure || recoveryFailure || createTurnFailureError(
        error,
        { fallbackCode: String(error?.code || 'TURN_REQUEST_FAILED') },
      ).serverFailure
      const durableFailure = permanentFailedRetryRejection
        ? failedRetryFailureFromError(error, message.meta?.serverFailure)
        : mergeFailureDiagnostics(
            currentFailure,
            message.meta?.serverFailure,
          )
      const failureEvidenceMeta = terminalFailureEvidenceMeta(error)
      if (!Object.hasOwn(failureEvidenceMeta, 'serverPartialText') && failedRetryPartialText) {
        failureEvidenceMeta.serverPartialText = failedRetryPartialText
      }
      const completedAt = turnEventTimestamp(error?.turnCompletedAt)
      const timingMeta = {
        turnStartedAt,
        turnCompletedAt: completedAt,
        latency: Math.max(0, completedAt - turnStartedAt),
      }
      if (shouldKeepResumePending({ resumeResolution, resumeAccepted, stopped })) {
        dispatchMessage('UPDATE_LAST_MESSAGE_META', {
          ...timingMeta,
          streaming: false,
          cancelled: false,
          failed: false,
          interrupted: false,
          paused: true,
          serverConnectionState: 'paused',
          directoryAuthorizationPending: false,
          directoryAuthorizationError: getVisibleModelErrorMessage(error, t),
          serverResumeResolution: null,
          serverArtifacts,
        })
        dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.PENDING, stepLabel: t('chat.serverTurn.resumeFailed') } } })
        return
      }
      if (!stopped) {
        const partialSuffix = missingAssistantTextSuffix(currentAssistantText, error.partialText || '')
        if (partialSuffix) {
          dispatchMessage('APPEND_TO_LAST_MESSAGE', partialSuffix)
          currentAssistantText = mergeAssistantText(currentAssistantText, error.partialText || '')
        }
        const serverFailureDisplayKey = buildChatFailureDisplayKey(turnId, error)
        dispatch({
          type: 'APPEND_TO_LAST_MESSAGE',
          payload: buildChatFailureMessage(error, t),
          meta: { serverFailureDisplayKey },
          ...messageTarget,
        })
        dispatchMessage('UPDATE_LAST_MESSAGE_META', {
          ...timingMeta,
          streaming: false,
          cancelled: false,
          paused: false,
          failed: true,
          interrupted: false,
          serverClarification: null,
          directoryAuthorizationPending: false,
          directoryAuthorizationError: null,
          serverResumeResolution: null,
          serverArtifacts,
          serverConnectionState: recoveryDeadLetter ? 'blocked' : null,
          serverRecoveryBlocked: recoveryDeadLetter,
          serverFailure: durableFailure,
          serverFailureDisplayKey,
          ...failureEvidenceMeta,
        })
      } else {
        dispatchMessage('UPDATE_LAST_MESSAGE_META', {
          ...timingMeta,
          streaming: false,
          cancelled: true,
          failed: false,
          interrupted: false,
          paused: false,
          serverClarification: null,
          directoryAuthorizationPending: false,
          directoryAuthorizationError: null,
          serverResumeResolution: null,
          serverArtifacts,
          serverConnectionState: 'cancelled',
        })
      }
      dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: stopped ? TASK_STATUS.CANCELLED : TASK_STATUS.FAILED, stepLabel: stopped ? t('chat.serverTurn.cancelled') : t('chat.serverTurn.resumeFailed') } } })
      if (!stopped && error.sessionSnapshot) {
        dispatch({
          type: 'APPLY_SERVER_SESSION_SNAPSHOT',
          payload: { sessionId: session.id, snapshot: error.sessionSnapshot },
        })
      }
    }).finally(() => {
      turnActivityDispatcher.dispose()
      releaseServerTurnResume(resumingTurnIdsRef.current, session.id, turnId)
      if (failedRetry) {
        onFailedTurnRetrySettled?.({
          sessionId: session.id,
          turnId,
          result: failedRetryResult,
        })
      }
      clearToolApprovalForOwner(owner)
      unregisterTurnRun({ sessionId: session.id, turnId, controller })
      if (abortCtrlRef.current === controller) abortCtrlRef.current = null
      setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 5000)
    })
  }, [abortCtrlRef, clearToolApprovalForOwner, dispatch, failedTurnRetry, manualRecoveryResume, onFailedTurnRetryConsumed, onFailedTurnRetrySettled, onManualRecoveryConsumed, requestServerToolApproval, resolveToolApprovalForOwner, resumingTurnIdsRef, stateActiveSessionId, stateRef, stateResumeSignal, stateTurnRunActive, t])
}
