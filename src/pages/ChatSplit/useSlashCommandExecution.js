import { useCallback } from 'react'
import { recordLocalChatFeedback } from '../../lib/localChatFeedback.js'
import { createJob } from '../../lib/jobClient.js'
import { compressSession } from '../../lib/compactionClient.js'

export default function useSlashCommandExecution({
  changeApprovalMode,
  dispatch,
  modelName,
  navigate,
  setDesktopPetVisible,
  setInput,
  setSlashInlinePanel,
  setWorkbenchMessage,
  setWorkbenchOpen,
  setWorkbenchTab,
  slashRegistry,
  stateRef,
  triggerSendFlow,
}) {
  return useCallback(async (entry, args = '') => {
    if (!entry) return false
    slashRegistry.recordRecent(entry.name)
    if (entry.kind === 'skill') {
      setSlashInlinePanel(null)
      setInput(`/${entry.name} `)
      return true
    }
    try {
      setSlashInlinePanel(null)
      const result = await entry.handler(args, {
        dispatch,
        getState: () => stateRef.current,
        triggerSendFlow,
        navigate,
        openStatus: () => setSlashInlinePanel('status'),
        openMcp: () => setSlashInlinePanel('mcp'),
        openFeedback: () => setSlashInlinePanel('feedback'),
        openGoals: () => setSlashInlinePanel('goals'),
        openSideChat: () => { setWorkbenchTab('chat'); setWorkbenchOpen(true) },
        compactSession: (options) => compressSession({ ...options, modelName }),
        createGoalJob: (goal, options) => createJob(goal, { ...options, modelName }),
        togglePet: () => setDesktopPetVisible((visible) => !visible),
        setApprovalMode: changeApprovalMode,
        recordFeedback: (value) => recordLocalChatFeedback(value, stateRef.current.activeSessionId),
      })
      if (result && typeof result === 'object' && Object.hasOwn(result, 'input')) {
        const nextInput = String(result.input || '')
        setInput(nextInput)
        if (stateRef.current.activeSessionId) dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId: stateRef.current.activeSessionId, text: nextInput } })
        return true
      }
      if (entry.source === 'plugin') {
        setInput(result || `# ${entry.meta?.displayName || entry.name}\n`)
        return true
      }
      setInput('')
      if (stateRef.current.activeSessionId) dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId: stateRef.current.activeSessionId, text: '' } })
      if (typeof result === 'string' && result) setWorkbenchMessage(result)
      return true
    } catch (error) {
      setWorkbenchMessage(error?.message || 'Slash command failed.')
      return true
    }
  }, [
    changeApprovalMode, dispatch, modelName, navigate, setDesktopPetVisible, setInput, setSlashInlinePanel, setWorkbenchMessage,
    setWorkbenchOpen, setWorkbenchTab, slashRegistry, stateRef, triggerSendFlow,
  ])
}
