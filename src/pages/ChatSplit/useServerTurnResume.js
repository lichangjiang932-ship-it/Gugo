import { useEffect } from 'react'
import { dispatchTurnActivity, dispatchTurnEvent, runServerTurn } from '../../lib/turnClient.js'
import { createTurnFailureError } from '../../lib/turnClient/turnEventDispatch.js'
import { TASK_STATUS } from '../../store/taskStatus.js'
import { buildChatFailureMessage, getVisibleModelErrorMessage } from '../../lib/chatFlowGuards.js'
import { isUserStopped } from './serverTurnFlow.js'
import { hasTurnRun, registerTurnRun, unregisterTurnRun } from './turnRunRegistry.js'

export function reduceResumedAssistantText(currentText, event) {
  if (event?.type === 'turn.attempt' && event.payload?.resetStreaming) {
    return String(event.payload?.assistantText || '')
  }
  if (event?.type === 'assistant.delta' && event.payload?.text) {
    return `${String(currentText || '')}${String(event.payload.text)}`
  }
  if ((event?.type === 'turn.interrupted' || event?.type === 'turn.failed') && !String(currentText || '')) {
    return String(event.payload?.partialText ?? event.payload?.text ?? '')
  }
  return String(currentText || '')
}

export function terminalResumeText(currentText, terminal) {
  return String(currentText || '').length === 0 ? String(terminal?.payload?.text || '') : ''
}

export function isRecoverableServerMessage(message) {
  const connectionState = message?.meta?.serverConnectionState
  return Boolean(message?.meta?.streaming)
    || ['interrupted', 'reconnecting', 'cancelling'].includes(connectionState)
}

export function shouldKeepResumePending({ resumeResolution, resumeAccepted, stopped }) {
  return Boolean(resumeResolution) && resumeAccepted !== true && stopped !== true
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
    controller.signal.addEventListener('abort', () => {
      resolveToolApprovalForOwner(owner, { approved: false })
    }, { once: true })
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
    let currentAssistantText = String(message.content || '')
    let resumeAccepted = false
    dispatch({
      type: 'ADD_TASK',
      payload: { id: taskId, name: t('chat.serverTurn.resumeTask'), detail: t('chat.serverTurn.resumeDetail'), status: TASK_STATUS.RUNNING, step: 1, stepLabel: t('chat.serverTurn.resuming'), perms: [] },
    })

    runServerTurn({
      sessionId: session.id,
      turnId,
      resume: true,
      resumeResolution,
      afterSequence: Number.isInteger(message.meta?.serverLastSequence) ? message.meta.serverLastSequence : -1,
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
      onActivity: (activity) => dispatchTurnActivity(activity, { dispatch, taskId, messageTarget }),
      onEvent: async (event) => {
        if (event?.type === 'turn.resumed') resumeAccepted = true
        const previousAssistantText = currentAssistantText
        currentAssistantText = reduceResumedAssistantText(currentAssistantText, event)
        if (!previousAssistantText && currentAssistantText
          && (event.type === 'turn.interrupted' || event.type === 'turn.failed')) {
          dispatchMessage('APPEND_TO_LAST_MESSAGE', currentAssistantText)
        }
        const dispatchResult = await dispatchTurnEvent(event, {
          dispatch,
          taskId,
          messageTarget,
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
      if (terminal.type === 'turn.failed') throw createTurnFailureError(terminal.payload)
      if (terminal.type === 'turn.cancelled') {
        const error = new Error('Generation stopped')
        error.name = 'AbortError'
        throw error
      }
      const terminalText = terminalResumeText(currentAssistantText, terminal)
      if (terminalText) dispatchMessage('APPEND_TO_LAST_MESSAGE', terminalText)
      if (terminal.type === 'turn.paused') {
        dispatchMessage('UPDATE_LAST_MESSAGE_META', {
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
      const stopped = isUserStopped(error)
      if (shouldKeepResumePending({ resumeResolution, resumeAccepted, stopped })) {
        dispatchMessage('UPDATE_LAST_MESSAGE_META', {
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
        dispatchMessage('APPEND_TO_LAST_MESSAGE', buildChatFailureMessage(getVisibleModelErrorMessage(error, t)))
        dispatchMessage('UPDATE_LAST_MESSAGE_META', {
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
          serverPartialText: error.partialText || '',
          serverArtifactIds: Array.isArray(error.artifactIds) ? error.artifactIds : [],
        })
      } else {
        dispatchMessage('UPDATE_LAST_MESSAGE_META', {
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
      resumingTurnIdsRef.current.delete(turnId)
      clearToolApprovalForOwner(owner)
      unregisterTurnRun({ sessionId: session.id, turnId, controller })
      if (abortCtrlRef.current === controller) abortCtrlRef.current = null
      setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 5000)
    })
  }, [abortCtrlRef, clearToolApprovalForOwner, dispatch, requestServerToolApproval, resolveToolApprovalForOwner, resumingTurnIdsRef, stateActiveSessionId, stateRef, stateResumeSignal, stateTurnRunActive, t])
}
