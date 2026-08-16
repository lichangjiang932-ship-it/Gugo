import { useEffect } from 'react'
import { createBufferedTurnActivityDispatcher, dispatchTurnEvent, runServerTurn } from '../../lib/turnClient.js'
import { createTurnFailureError } from '../../lib/turnClient/turnEventDispatch.js'
import { TASK_STATUS } from '../../store/taskStatus.js'
import { buildChatFailureDisplayKey, buildChatFailureMessage, getVisibleModelErrorMessage } from '../../lib/chatFlowGuards.js'
import { isUserStopped, turnEventTimestamp } from './serverTurnFlow.js'
import { hasTurnRun, registerTurnRun, unregisterTurnRun } from './turnRunRegistry.js'
import { mergeAssistantText, missingAssistantTextSuffix } from '../../lib/assistantTextContinuity.js'

export function reduceResumedAssistantText(currentText, event) {
  if (event?.type === 'turn.attempt' && event.payload?.resetStreaming) {
    return String(event.payload?.assistantText || '')
  }
  if (event?.type === 'assistant.delta' && event.payload?.text) {
    return `${String(currentText || '')}${String(event.payload.text)}`
  }
  if (event?.type === 'turn.interrupted' || event?.type === 'turn.failed') {
    return mergeAssistantText(currentText, event.payload?.partialText ?? event.payload?.text ?? '')
  }
  return String(currentText || '')
}

export function terminalResumeText(currentText, terminal) {
  return missingAssistantTextSuffix(currentText, terminal?.payload?.text || '')
}

export function isRecoverableServerMessage(message) {
  const connectionState = message?.meta?.serverConnectionState
  return Boolean(message?.meta?.streaming)
    || ['interrupted', 'reconnecting', 'cancelling'].includes(connectionState)
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
}) {
  useEffect(() => {
    if (abortCtrlRef.current) return
    const current = stateRef.current
    const session = current.sessions.find((item) => item.id === current.activeSessionId)
    const message = [...(session?.messages || [])].reverse().find((item) => item.role === 'assistant')
    const turnId = message?.meta?.serverTurnId
    if (!session?.id || !turnId || !isRecoverableServerMessage(message) || resumingTurnIdsRef.current.has(turnId) || hasTurnRun(session.id, turnId)) return

    resumingTurnIdsRef.current.add(turnId)
    const controller = new AbortController()
    const owner = { sessionId: session.id, turnId }
    try {
      registerTurnRun({ sessionId: session.id, turnId, controller })
    } catch (error) {
      resumingTurnIdsRef.current.delete(turnId)
      if (error?.code !== 'SESSION_TURN_ALREADY_RUNNING') console.error('Failed to register resumed turn', error)
      return
    }
    abortCtrlRef.current = controller
    const taskId = `resume-${turnId}`
    const serverArtifacts = [...(message.meta?.serverArtifacts || [])]
    const resumeResolution = message.meta?.serverResumeResolution || null
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
    let currentAssistantText = String(message.content || '')
    let resumeAccepted = false
    dispatchMessage('UPDATE_LAST_MESSAGE_META', {
      turnStartedAt,
      turnCompletedAt: null,
      latency: null,
      streaming: true,
    })
    dispatch({
      type: 'ADD_TASK',
      payload: { id: taskId, name: t('chat.serverTurn.resumeTask'), detail: t('chat.serverTurn.resumeDetail'), status: TASK_STATUS.RUNNING, step: 1, stepLabel: t('chat.serverTurn.resuming'), perms: [] },
    })

    runServerTurn({
      sessionId: session.id,
      turnId,
      resume: true,
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
        if (event.type === 'turn.interrupted' || event.type === 'turn.failed') {
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
      turnActivityDispatcher.flush()
      if (terminal.type === 'turn.failed') {
        const error = createTurnFailureError(terminal.payload)
        error.turnCompletedAt = turnEventTimestamp(terminal)
        throw error
      }
      if (terminal.type === 'turn.cancelled') {
        const error = new Error('Generation stopped')
        error.name = 'AbortError'
        error.turnCompletedAt = turnEventTimestamp(terminal)
        throw error
      }
      const terminalText = terminalResumeText(currentAssistantText, terminal)
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
              stepLabel: terminal.payload?.clarification?.question || t('chat.serverTurn.resumeDetail'),
            },
          },
        })
        return
      }
      dispatchMessage('UPDATE_LAST_MESSAGE_META', {
        ...timingMeta,
        streaming: false,
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
      turnActivityDispatcher.flush()
      const stopped = isUserStopped(error)
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
          payload: buildChatFailureMessage(getVisibleModelErrorMessage(error, t)),
          meta: { serverFailureDisplayKey },
          ...messageTarget,
        })
        dispatchMessage('UPDATE_LAST_MESSAGE_META', {
          ...timingMeta,
          streaming: false,
          paused: false,
          failed: true,
          serverClarification: null,
          directoryAuthorizationPending: false,
          directoryAuthorizationError: null,
          serverResumeResolution: null,
          serverArtifacts,
          serverConnectionState: null,
          serverFailure: error.serverFailure || null,
          serverFailureDisplayKey,
          serverPartialText: error.partialText || '',
          serverArtifactIds: Array.isArray(error.artifactIds) ? error.artifactIds : [],
        })
      } else {
        dispatchMessage('UPDATE_LAST_MESSAGE_META', {
          ...timingMeta,
          streaming: false,
          paused: false,
          serverClarification: null,
          directoryAuthorizationPending: false,
          directoryAuthorizationError: null,
          serverResumeResolution: null,
          serverArtifacts,
          serverConnectionState: null,
        })
      }
      dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: stopped ? TASK_STATUS.CANCELLED : TASK_STATUS.FAILED, stepLabel: stopped ? t('chat.serverTurn.cancelled') : t('chat.serverTurn.resumeFailed') } } })
    }).finally(() => {
      turnActivityDispatcher.dispose()
      resumingTurnIdsRef.current.delete(turnId)
      clearToolApprovalForOwner(owner)
      unregisterTurnRun({ sessionId: session.id, turnId, controller })
      if (abortCtrlRef.current === controller) abortCtrlRef.current = null
      setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 5000)
    })
  }, [abortCtrlRef, clearToolApprovalForOwner, dispatch, requestServerToolApproval, resolveToolApprovalForOwner, resumingTurnIdsRef, stateActiveSessionId, stateRef, stateResumeSignal, stateTurnRunActive, t])
}
