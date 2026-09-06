import { useCallback, useEffect, useRef, useState } from 'react'
import { authorizeChatDirectoryRequest } from '../../lib/chatDirectoryRequest.js'
import {
  buildServerTurnResumeMeta,
  isResumeNudge,
  resolvePendingDirectorySend,
} from './pausedTurnResume.js'
import {
  buildStreamResumeState,
  buildStreamResumeStateFromMessages,
  getStreamResumeStateForSession,
  isStreamResumeStateForSession,
  latestStreamResumeMessage,
  streamResumeDismissalKey,
  updateStreamResumeStates,
} from './streamResumeState.js'
import { cancelTurnRun } from './turnRunRegistry.js'
import useManualRecoveryRouteResume from './useManualRecoveryRouteResume.js'
import useServerTurnResume from './useServerTurnResume.js'

export default function useChatTurnRecovery({
  abortCtrlRef,
  activeSessionId,
  approvals,
  dispatch,
  isGenerating,
  messages,
  resumingTurnIdsRef,
  setInput,
  setWorkbenchMessage,
  state,
  stateRef,
  t,
  toast,
}) {
  const [resumeStates, setResumeStates] = useState({})
  const [failedTurnRetry, setFailedTurnRetry] = useState(null)
  const dismissedResumeKeysRef = useRef(new Set())
  const resumeState = getStreamResumeStateForSession(resumeStates, activeSessionId)
  const latestServerAssistant = [...messages].reverse().find((message) => (
    message?.role === 'assistant' && message?.meta?.serverTurnId
  ))
  const serverResumeSignal = [
    activeSessionId || '',
    latestServerAssistant?.id || '',
    latestServerAssistant?.meta?.serverTurnId || '',
    latestServerAssistant?.meta?.streaming ? 'streaming' : 'idle',
    latestServerAssistant?.meta?.serverConnectionState || '',
    latestServerAssistant?.meta?.serverLastSequence ?? '',
    latestServerAssistant?.meta?.serverResumeResolution ? 'resolution' : '',
  ].join(':')

  const dismissSessionResume = useCallback((sessionId) => {
    const session = stateRef.current.sessions.find((item) => item.id === sessionId)
    const key = streamResumeDismissalKey(latestStreamResumeMessage(session?.messages), { sessionId })
    if (key) dismissedResumeKeysRef.current.add(key)
    setResumeStates((current) => updateStreamResumeStates(current, sessionId, null))
    setFailedTurnRetry((current) => current?.sessionId === sessionId ? null : current)
  }, [stateRef])
  const handleTurnStart = useCallback(({ sessionId }) => {
    dismissSessionResume(sessionId)
  }, [dismissSessionResume])
  const handleTurnResult = useCallback(({ sessionId, turnId, result }) => {
    const session = stateRef.current.sessions.find((item) => item.id === sessionId)
    const message = latestStreamResumeMessage(session?.messages)
    // A late completion from an earlier turn must not replace the current
    // turn's recovery state. Pending message updates will rebuild it below.
    if (message?.meta?.serverTurnId !== turnId) return
    const key = streamResumeDismissalKey(message, { sessionId })
    const nextResumeState = dismissedResumeKeysRef.current.has(key)
      ? null
      : buildStreamResumeState(result, { sessionId, turnId })
    setResumeStates((current) => updateStreamResumeStates(current, sessionId, nextResumeState))
  }, [stateRef])
  const showPendingDirectoryGuidance = useCallback((content = '') => {
    const current = stateRef.current
    const session = current.sessions.find((item) => item.id === current.activeSessionId)
    const pending = resolvePendingDirectorySend(session?.messages)
    if (!pending) return false
    setWorkbenchMessage(t(pending.state === 'resuming'
      ? 'chatSteering.directoryResumePending'
      : 'chatSteering.directoryAuthorizationRequired'))
    if (isResumeNudge(content)) {
      setInput('')
      dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId: current.activeSessionId, text: '' } })
    }
    window.requestAnimationFrame?.(() => {
      const row = document.getElementById(`message-${pending.message.id}`)
      row?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
      row?.querySelector?.('[data-testid="directory-request-card"] input')?.focus?.()
    })
    return true
  }, [dispatch, setInput, setWorkbenchMessage, stateRef, t])
  const handleAuthorizeDirectoryRequest = useCallback(async ({
    message,
    path,
    accessMode,
    authorizationScope,
  }) => {
    const sessionId = stateRef.current.activeSessionId
    const turnId = message?.meta?.serverTurnId
    const clarification = message?.meta?.serverClarification || {}
    const result = await authorizeChatDirectoryRequest({
      sessionId,
      turnId,
      pausedSequence: message?.meta?.serverLastSequence,
      path,
      accessMode,
      scope: authorizationScope,
      purpose: clarification.purpose || clarification.why || '',
    })
    dispatch({
      type: 'UPDATE_LAST_MESSAGE_META',
      sessionId,
      messageId: message.id,
      payload: buildServerTurnResumeMeta(result.resolution),
    })
    toast.success({ title: t('taskSteering.directoryGranted'), body: result.path })
    return result
  }, [dispatch, stateRef, t, toast])

  const { manualRecoveryResume, onManualRecoveryConsumed } = useManualRecoveryRouteResume()
  const onFailedTurnRetryConsumed = useCallback((consumed) => {
    setFailedTurnRetry((current) => (
      current?.sessionId === consumed?.sessionId && current?.turnId === consumed?.turnId
        ? null
        : current
    ))
  }, [])
  const onFailedTurnRetrySettled = handleTurnResult
  useServerTurnResume({
    abortCtrlRef,
    dispatch,
    requestServerToolApproval: approvals.requestServerToolApproval,
    resolveToolApprovalForOwner: approvals.resolveToolApprovalForOwner,
    resumingTurnIdsRef,
    clearToolApprovalForOwner: approvals.clearToolApprovalForOwner,
    stateActiveSessionId: state.activeSessionId,
    stateResumeSignal: serverResumeSignal,
    stateTurnRunActive: isGenerating,
    stateRef,
    t,
    manualRecoveryResume,
    onManualRecoveryConsumed,
    failedTurnRetry,
    onFailedTurnRetryConsumed,
    onFailedTurnRetrySettled,
  })
  useEffect(() => {
    if (!activeSessionId) return
    const rebuilt = buildStreamResumeStateFromMessages(messages, {
      sessionId: activeSessionId,
      dismissedKeys: dismissedResumeKeysRef.current,
    })
    const retryPending = rebuilt && (
      failedTurnRetry?.sessionId === rebuilt.sessionId
      && failedTurnRetry?.turnId === rebuilt.turnId
      || resumingTurnIdsRef.current.has(`${rebuilt.sessionId}\u0000${rebuilt.turnId}`)
    )
    setResumeStates((current) => updateStreamResumeStates(
      current,
      activeSessionId,
      retryPending ? null : rebuilt,
    ))
  }, [activeSessionId, failedTurnRetry, messages, resumingTurnIdsRef])

  const handleAbort = useCallback(() => {
    if (activeSessionId) {
      dismissSessionResume(activeSessionId)
    }
    if (!cancelTurnRun(activeSessionId)) abortCtrlRef.current?.abort()
  }, [abortCtrlRef, activeSessionId, dismissSessionResume])
  const handleDismissResume = useCallback(() => {
    if (activeSessionId) dismissSessionResume(activeSessionId)
  }, [activeSessionId, dismissSessionResume])
  const resumeAvailable = isStreamResumeStateForSession(resumeState, activeSessionId)
    && (resumeState.code === 'TURN_INCOMPLETE' || resumeState.manualRetryable === true)
  const manualRetryAvailable = resumeAvailable && resumeState.manualRetryable === true
  const handleResume = useCallback(() => {
    if (!isStreamResumeStateForSession(resumeState, activeSessionId)) return
    if (resumeState.code !== 'TURN_INCOMPLETE' && resumeState.manualRetryable !== true) return
    setResumeStates((current) => updateStreamResumeStates(current, activeSessionId, null))
    setFailedTurnRetry(resumeState)
  }, [activeSessionId, resumeState])

  return {
    handleAbort,
    handleAuthorizeDirectoryRequest,
    handleDismissResume,
    handleResume,
    handleTurnResult,
    handleTurnStart,
    manualRetryAvailable,
    resumeAvailable,
    showPendingDirectoryGuidance,
  }
}
