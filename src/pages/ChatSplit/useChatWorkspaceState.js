import { useCallback, useMemo, useState } from 'react'
import {
  activateChatWorkspace,
  deriveRecentChatWorkspaces,
  normalizeChatWorkspacePath,
} from '../../lib/chatWorkspaceSelection.js'

export default function useChatWorkspaceState({
  activeSession,
  activeSessionId,
  dispatch,
  state,
  t,
}) {
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [workspaceErrorState, setWorkspaceErrorState] = useState(() => ({
    draftVersion: state.newDraftVersion,
    message: '',
  }))
  const draftWorkspacePath = normalizeChatWorkspacePath(state.draftWorkspacePath)
  const selectedWorkspacePath = normalizeChatWorkspacePath(
    activeSession?.workspacePath || (!activeSessionId ? draftWorkspacePath : ''),
  )
  const recentWorkspaces = useMemo(
    () => deriveRecentChatWorkspaces(state.sessions),
    [state.sessions],
  )
  const workspaceError = workspaceErrorState.draftVersion === state.newDraftVersion
    ? workspaceErrorState.message
    : ''

  const activateWorkspaceForTurn = useCallback(async (path) => {
    setWorkspaceBusy(true)
    setWorkspaceErrorState({ draftVersion: state.newDraftVersion, message: '' })
    try {
      return await activateChatWorkspace(path)
    } catch (error) {
      setWorkspaceErrorState({
        draftVersion: state.newDraftVersion,
        message: String(error?.message || t('chatMessages.workspaceSelectionFailed')),
      })
      throw error
    } finally {
      setWorkspaceBusy(false)
    }
  }, [state.newDraftVersion, t])

  const handleWorkspaceSelect = useCallback(async (path) => {
    const activated = await activateWorkspaceForTurn(path)
    if (activeSessionId) {
      dispatch({
        type: 'SET_SESSION_WORKSPACE',
        payload: { sessionId: activeSessionId, workspacePath: activated.path },
      })
    } else {
      dispatch({ type: 'SET_DRAFT_WORKSPACE', payload: { workspacePath: activated.path } })
    }
    return activated
  }, [activeSessionId, activateWorkspaceForTurn, dispatch])

  const handleWorkspaceClear = useCallback(() => {
    setWorkspaceErrorState({ draftVersion: state.newDraftVersion, message: '' })
    if (activeSessionId) {
      dispatch({ type: 'SET_SESSION_WORKSPACE', payload: { sessionId: activeSessionId, workspacePath: '' } })
    } else {
      dispatch({ type: 'SET_DRAFT_WORKSPACE', payload: { workspacePath: '' } })
    }
  }, [activeSessionId, dispatch, state.newDraftVersion])

  return {
    activateWorkspaceForTurn,
    draftWorkspacePath,
    handleWorkspaceClear,
    handleWorkspaceSelect,
    recentWorkspaces,
    selectedWorkspacePath,
    workspaceBusy,
    workspaceError,
  }
}
