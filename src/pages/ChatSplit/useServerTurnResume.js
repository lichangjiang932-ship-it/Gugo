import { useEffect } from 'react'
import { dispatchTurnEvent, runServerTurn } from '../../lib/turnClient.js'
import { TASK_STATUS } from '../../store/taskStatus.js'
import { buildChatFailureMessage, getVisibleModelErrorMessage } from '../../lib/chatFlowGuards.js'
import { isUserStopped } from './serverTurnFlow.js'
import { hasTurnRun, registerTurnRun, unregisterTurnRun } from './turnRunRegistry.js'

export default function useServerTurnResume({
  abortCtrlRef,
  clearToolApprovalForOwner,
  dispatch,
  requestServerToolApproval,
  resolveToolApprovalForOwner,
  resumingTurnIdsRef,
  stateActiveSessionId,
  stateRef,
  t,
}) {
  useEffect(() => {
    if (abortCtrlRef.current) return
    const current = stateRef.current
    const session = current.sessions.find((item) => item.id === current.activeSessionId)
    const message = [...(session?.messages || [])].reverse().find((item) => item.role === 'assistant')
    const turnId = message?.meta?.serverTurnId
    if (!session?.id || !turnId || !message.meta?.streaming || resumingTurnIdsRef.current.has(turnId) || hasTurnRun(session.id, turnId)) return

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
    const messageTarget = { sessionId: session.id, messageId: message.id }
    const dispatchMessage = (type, payload) => dispatch({ type, payload, ...messageTarget })
    let sawAssistantText = false
    dispatch({
      type: 'ADD_TASK',
      payload: { id: taskId, name: t('chat.serverTurn.resumeTask'), detail: t('chat.serverTurn.resumeDetail'), status: TASK_STATUS.RUNNING, step: 1, stepLabel: t('chat.serverTurn.resuming'), perms: [] },
    })

    runServerTurn({
      sessionId: session.id,
      turnId,
      resume: true,
      afterSequence: Number.isInteger(message.meta?.serverLastSequence) ? message.meta.serverLastSequence : -1,
      signal: controller.signal,
      syncSessionSnapshot: true,
      onConnectionState: ({ status, attempt, maxAttempts }) => {
        if (status === 'reconnecting') {
          dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: t('chat.serverTurn.reconnecting', { attempt, max: maxAttempts }) } } })
        } else if (status === 'connected') {
          dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: t('chat.serverTurn.reconnected') } } })
        }
      },
      onEvent: async (event) => {
        if (event.type === 'assistant.delta' && event.payload?.text) sawAssistantText = true
        await dispatchTurnEvent(event, {
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
        dispatchMessage('UPDATE_LAST_MESSAGE_META', { serverLastSequence: event.sequence })
      },
    }).then(({ terminal, sessionSnapshot }) => {
      if (terminal.type === 'turn.failed') throw new Error(terminal.payload?.message || 'Server turn failed')
      if (terminal.type === 'turn.cancelled') {
        const error = new Error('Generation stopped')
        error.name = 'AbortError'
        throw error
      }
      if (!sawAssistantText && !message.content && terminal.payload?.text) dispatchMessage('APPEND_TO_LAST_MESSAGE', terminal.payload.text)
      dispatchMessage('UPDATE_LAST_MESSAGE_META', { streaming: false, serverArtifacts })
      if (sessionSnapshot) {
        dispatch({
          type: 'APPLY_SERVER_SESSION_SNAPSHOT',
          payload: { sessionId: session.id, snapshot: sessionSnapshot },
        })
      }
      dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.COMPLETED, stepLabel: t('chat.serverTurn.resumed') } } })
    }).catch((error) => {
      const stopped = isUserStopped(error)
      if (!stopped) {
        dispatchMessage('APPEND_TO_LAST_MESSAGE', buildChatFailureMessage(getVisibleModelErrorMessage(error, t)))
        dispatchMessage('UPDATE_LAST_MESSAGE_META', { streaming: false, failed: true, serverArtifacts })
      } else {
        dispatchMessage('UPDATE_LAST_MESSAGE_META', { streaming: false, serverArtifacts })
      }
      dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: stopped ? TASK_STATUS.CANCELLED : TASK_STATUS.FAILED, stepLabel: stopped ? t('chat.serverTurn.cancelled') : t('chat.serverTurn.resumeFailed') } } })
    }).finally(() => {
      resumingTurnIdsRef.current.delete(turnId)
      clearToolApprovalForOwner(owner)
      unregisterTurnRun({ sessionId: session.id, turnId, controller })
      if (abortCtrlRef.current === controller) abortCtrlRef.current = null
      setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 5000)
    })
  }, [abortCtrlRef, clearToolApprovalForOwner, dispatch, requestServerToolApproval, resolveToolApprovalForOwner, resumingTurnIdsRef, stateActiveSessionId, stateRef, t])
}
