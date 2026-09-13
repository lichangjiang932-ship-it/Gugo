import { useCallback, useEffect } from 'react'
import { decideChatDirectory } from './chatDirectoryDecisions.js'
import {
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
import { cancelTurnRun, hasTurnRun } from './turnRunRegistry.js'
import useManualRecoveryRouteResume from './useManualRecoveryRouteResume.js'
import useServerTurnResume from './useServerTurnResume.js'
import { streamResumeOwnerScope } from '../../lib/streamResumeDismissals.js'
import useStreamResumeDismissals from './useStreamResumeDismissals.js'
import useScopedChatRecoveryState from './useScopedChatRecoveryState.js'
import { safeSideEffectResumeDescriptor } from '../../lib/sideEffectRecoveryClient.js'
import { matchesManualRecoveryResume } from './serverTurnResumePolicy.js'

export function inlineSideEffectResumeForCurrentMessage({
  state, ownerScope, submittedOwnerScope, message, record, resume, running = false,
}) {
  if (!ownerScope || ownerScope !== streamResumeOwnerScope(state)
    || submittedOwnerScope !== ownerScope || running
    || !['committed', 'failed'].includes(record?.status)
    || record.scopeKey !== JSON.stringify(['turn', record.sessionId, record.turnId])
    || !/^[a-f0-9]{64}$/u.test(record.argsDigest || '')
    || typeof message?.id !== 'string' || !message.id) return null
  const descriptor = safeSideEffectResumeDescriptor(record, resume)
  if (!descriptor || descriptor.kind !== 'turn' || state?.activeSessionId !== descriptor.sessionId) return null
  const session = state.sessions?.find((item) => item.id === descriptor.sessionId)
  const currentMessage = session?.messages?.find((item) => item.id === message?.id && item.role === 'assistant')
  if (!currentMessage || currentMessage.meta?.cancelled === true || currentMessage.meta?.streaming === true
    || !Number.isSafeInteger(currentMessage.meta?.serverLastSequence) || currentMessage.meta.serverLastSequence < 0
    || currentMessage.meta?.serverLastSequence !== message?.meta?.serverLastSequence
    || !matchesManualRecoveryResume(session, currentMessage, descriptor)) return null
  return { ...descriptor, inlineGuard: {
    ownerScope, messageId: currentMessage.id, sequence: currentMessage.meta.serverLastSequence,
  } }
}

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
  const ownerScope = streamResumeOwnerScope(state)
  const { resumeStates, setResumeStates, failedTurnRetry, setFailedTurnRetry } = useScopedChatRecoveryState(ownerScope)
  const { readKeys: readDismissedKeys, remember: rememberDismissal, revision: dismissalRevision } = useStreamResumeDismissals(ownerScope)
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
    if (streamResumeOwnerScope(stateRef.current) !== ownerScope) return
    const session = stateRef.current.sessions.find((item) => item.id === sessionId)
    const key = streamResumeDismissalKey(latestStreamResumeMessage(session?.messages), { sessionId })
    if (key) rememberDismissal(key)
    setResumeStates((current) => updateStreamResumeStates(current, sessionId, null))
    setFailedTurnRetry((current) => current?.sessionId === sessionId ? null : current)
  }, [ownerScope, rememberDismissal, setFailedTurnRetry, setResumeStates, stateRef])
  const handleTurnStart = useCallback(({ sessionId }) => {
    dismissSessionResume(sessionId)
  }, [dismissSessionResume])
  const handleTurnResult = useCallback(({ sessionId, turnId, result }) => {
    if (streamResumeOwnerScope(stateRef.current) !== ownerScope) return
    const session = stateRef.current.sessions.find((item) => item.id === sessionId)
    const message = latestStreamResumeMessage(session?.messages)
    // A late completion from an earlier turn must not replace the current
    // turn's recovery state. Pending message updates will rebuild it below.
    if (message?.meta?.serverTurnId !== turnId) return
    const key = streamResumeDismissalKey(message, { sessionId })
    const nextResumeState = readDismissedKeys().has(key)
      ? null
      : buildStreamResumeState(result, { sessionId, turnId })
    setResumeStates((current) => updateStreamResumeStates(current, sessionId, nextResumeState))
  }, [ownerScope, readDismissedKeys, setResumeStates, stateRef])
  const showPendingDirectoryGuidance = useCallback((content = '') => {
    const current = stateRef.current
    const session = current.sessions.find((item) => item.id === current.activeSessionId)
    const pending = resolvePendingDirectorySend(session?.messages)
    if (!pending) return false
    if (pending.message.meta?.cancelled === true) return false
    setWorkbenchMessage(t(pending.state === 'resuming'
      ? 'chatSteering.directoryResumePending'
      : 'taskSteering.directoryDecisionRequired'))
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
  const handleAuthorizeDirectoryRequest = useCallback((input) => decideChatDirectory({
    kind: 'grant', input, stateRef, ownerScope, dispatch, toast, t,
  }), [dispatch, ownerScope, stateRef, t, toast])
  const handleRejectDirectoryRequest = useCallback((input) => decideChatDirectory({
    kind: 'reject', input, stateRef, ownerScope, dispatch, toast, t,
  }), [dispatch, ownerScope, stateRef, t, toast])

  const { manualRecoveryResume, onManualRecoveryConsumed, requestManualRecoveryResume } = useManualRecoveryRouteResume()
  const handleSideEffectResolved = useCallback((input) => {
    const descriptor = inlineSideEffectResumeForCurrentMessage({
      ...input, state: stateRef.current, ownerScope, submittedOwnerScope: input?.ownerScope,
      running: Boolean(abortCtrlRef.current) || hasTurnRun(input?.record?.sessionId)
        || resumingTurnIdsRef.current.has(`${input?.record?.sessionId}\u0000${input?.record?.turnId}`),
    })
    return descriptor ? requestManualRecoveryResume(descriptor) : false
  }, [abortCtrlRef, ownerScope, requestManualRecoveryResume, resumingTurnIdsRef, stateRef])
  const onFailedTurnRetryConsumed = useCallback((consumed) => {
    if (streamResumeOwnerScope(stateRef.current) !== ownerScope) return
    setFailedTurnRetry((current) => (
      current?.sessionId === consumed?.sessionId && current?.turnId === consumed?.turnId
        ? null
        : current
    ))
  }, [ownerScope, setFailedTurnRetry, stateRef])
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
      dismissedKeys: readDismissedKeys(),
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
  }, [activeSessionId, dismissalRevision, failedTurnRetry, messages, readDismissedKeys, resumingTurnIdsRef, setResumeStates])

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
    if (streamResumeOwnerScope(stateRef.current) !== ownerScope) return
    if (!isStreamResumeStateForSession(resumeState, activeSessionId)) return
    if (resumeState.code !== 'TURN_INCOMPLETE' && resumeState.manualRetryable !== true) return
    setResumeStates((current) => updateStreamResumeStates(current, activeSessionId, null))
    setFailedTurnRetry(resumeState)
  }, [activeSessionId, ownerScope, resumeState, setFailedTurnRetry, setResumeStates, stateRef])

  return {
    handleAbort,
    handleAuthorizeDirectoryRequest,
    handleRejectDirectoryRequest,
    handleSideEffectResolved,
    recoveryOwnerScope: ownerScope,
    handleDismissResume,
    handleResume,
    handleTurnResult,
    handleTurnStart,
    manualRetryAvailable,
    resumeAvailable,
    showPendingDirectoryGuidance,
  }
}
