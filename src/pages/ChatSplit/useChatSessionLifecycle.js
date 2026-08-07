import { useEffect, useRef } from 'react'
import { writeContextUsageVisible, writeDesktopPetVisible, writeWorkbenchOpen } from '../../lib/chatUiPreferences.js'
import { deriveDesktopPetStatus } from './desktopPetState.js'

export default function useChatSessionLifecycle({
  abortCtrlRef,
  desktopPetVisible,
  dispatch,
  input,
  isGenerating,
  messages,
  setAttachments,
  setDesktopPetVisible,
  setInput,
  setWorkbenchMessage,
  showContextUsage,
  state,
  toolApproval,
  toolApprovalResolveRef,
  workbenchOpen,
}) {
  const abortSessionIdRef = useRef(state.activeSessionId)
  const newDraftVersionRef = useRef(state.newDraftVersion)
  const previousSessionIdRef = useRef(state.activeSessionId)
  const inputRef = useRef(input)
  useEffect(() => { inputRef.current = input }, [input])
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
    const timer = window.setTimeout(() => setInput(state.draftInput), 0)
    dispatch({ type: 'SET_DRAFT_INPUT', payload: '' })
    return () => window.clearTimeout(timer)
  }, [dispatch, setInput, state.draftInput])
  useEffect(() => {
    if (abortSessionIdRef.current !== state.activeSessionId) {
      abortSessionIdRef.current = state.activeSessionId
      toolApprovalResolveRef.current?.({ approved: false })
      abortCtrlRef.current?.abort()
    }
  }, [abortCtrlRef, state.activeSessionId, toolApprovalResolveRef])
  useEffect(() => () => abortCtrlRef.current?.abort(), [abortCtrlRef])
  useEffect(() => {
    const previousId = previousSessionIdRef.current
    const nextId = state.activeSessionId
    if (previousId === nextId) return
    if (previousId) dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId: previousId, text: inputRef.current } })
    setInput((state.sessionDrafts || {})[nextId] || '')
    previousSessionIdRef.current = nextId
  }, [dispatch, setInput, state.activeSessionId, state.sessionDrafts])
  useEffect(() => {
    if (!state.activeSessionId) return undefined
    const timer = window.setTimeout(() => dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId: state.activeSessionId, text: input } }), 250)
    return () => window.clearTimeout(timer)
  }, [dispatch, input, state.activeSessionId])
  return { abortSessionIdRef, inputRef }
}
