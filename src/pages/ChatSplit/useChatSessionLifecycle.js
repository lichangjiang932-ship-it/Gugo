import { useEffect, useRef } from 'react'
import { writeContextUsageVisible, writeDesktopPetVisible, writeWorkbenchOpen } from '../../lib/chatUiPreferences.js'
import { deriveDesktopPetStatus } from './desktopPetState.js'
import { getTurnRun, subscribeTurnRuns } from './turnRunRegistry.js'
import { normalizeDraftAttachments, readSessionDraft } from '../../lib/chatDrafts.js'

export default function useChatSessionLifecycle({
  abortCtrlRef,
  attachments,
  desktopPetVisible,
  dispatch,
  input,
  isGenerating,
  messages,
  preserveAttachmentsForSessionRef,
  setAttachments,
  setDesktopPetVisible,
  setIsGenerating,
  setInput,
  setWorkbenchMessage,
  showContextUsage,
  state,
  toolApproval,
  workbenchOpen,
}) {
  const abortSessionIdRef = useRef(state.activeSessionId)
  const newDraftVersionRef = useRef(state.newDraftVersion)
  const previousSessionIdRef = useRef(state.activeSessionId)
  const activeSessionIdRef = useRef(state.activeSessionId)
  const inputRef = useRef(input)
  const attachmentsRef = useRef(attachments)
  useEffect(() => { inputRef.current = input }, [input])
  useEffect(() => { attachmentsRef.current = attachments }, [attachments])
  useEffect(() => { activeSessionIdRef.current = state.activeSessionId }, [state.activeSessionId])
  useEffect(() => () => {
    const sessionId = activeSessionIdRef.current
    const action = sessionId
      ? { type: 'SET_SESSION_DRAFT', payload: {
          sessionId,
          text: inputRef.current,
          attachments: normalizeDraftAttachments(attachmentsRef.current),
        } }
      : { type: 'SET_DRAFT_INPUT', payload: inputRef.current }
    dispatch(action)
  }, [dispatch])
  useEffect(() => writeContextUsageVisible(showContextUsage), [showContextUsage])
  useEffect(() => writeWorkbenchOpen(workbenchOpen), [workbenchOpen])
  useEffect(() => writeDesktopPetVisible(desktopPetVisible), [desktopPetVisible])
  useEffect(() => { window.gugoDesktop?.setPetVisible(desktopPetVisible).catch(() => {}) }, [desktopPetVisible])
  useEffect(() => window.gugoDesktop?.onPetVisibility((visible) => setDesktopPetVisible(visible)), [setDesktopPetVisible])
  useEffect(() => {
    window.gugoDesktop?.updatePetStatus(deriveDesktopPetStatus({ isGenerating, messages, tasks: state.tasks, toolApproval })).catch(() => {})
  }, [isGenerating, messages, state.tasks, toolApproval])
  useEffect(() => {
    if (newDraftVersionRef.current === state.newDraftVersion) return
    newDraftVersionRef.current = state.newDraftVersion
    setInput('')
    setAttachments([])
    setWorkbenchMessage('')
  }, [setAttachments, setInput, setWorkbenchMessage, state.newDraftVersion])
  useEffect(() => {
    if (!state.draftInput) return undefined
    const draftInput = state.draftInput
    const timer = window.setTimeout(() => {
      setInput(draftInput)
      dispatch({ type: 'SET_DRAFT_INPUT', payload: '' })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [dispatch, setInput, state.draftInput])
  useEffect(() => {
    abortSessionIdRef.current = state.activeSessionId
    const syncActiveTurn = () => {
      const run = getTurnRun(state.activeSessionId)
      abortCtrlRef.current = run?.controller || null
      setIsGenerating(Boolean(run))
    }
    syncActiveTurn()
    return subscribeTurnRuns(syncActiveTurn)
  }, [abortCtrlRef, setIsGenerating, state.activeSessionId])
  useEffect(() => {
    const previousId = previousSessionIdRef.current
    const nextId = state.activeSessionId
    if (previousId === nextId) return
    const preserveAttachments = previousId == null
      && preserveAttachmentsForSessionRef?.current === nextId
    if (preserveAttachmentsForSessionRef?.current === nextId) {
      preserveAttachmentsForSessionRef.current = null
    }
    if (previousId) dispatch({ type: 'SET_SESSION_DRAFT', payload: {
      sessionId: previousId,
      text: inputRef.current,
      attachments: normalizeDraftAttachments(attachmentsRef.current),
    } })
    const nextDraft = readSessionDraft((state.sessionDrafts || {})[nextId])
    setInput(nextDraft.text)
    if (!preserveAttachments) setAttachments(nextDraft.attachments)
    previousSessionIdRef.current = nextId
  }, [dispatch, preserveAttachmentsForSessionRef, setAttachments, setInput, state.activeSessionId, state.sessionDrafts])
  useEffect(() => {
    if (!state.activeSessionId) return undefined
    const timer = window.setTimeout(() => dispatch({
      type: 'SET_SESSION_DRAFT',
      payload: {
        sessionId: state.activeSessionId,
        text: input,
        attachments: normalizeDraftAttachments(attachments),
      },
    }), 250)
    return () => window.clearTimeout(timer)
  }, [attachments, dispatch, input, state.activeSessionId])
  return { abortSessionIdRef, inputRef }
}
