import { useCallback, useMemo, useState } from 'react'
import {
  activateChatWorkspace,
  deriveRecentChatWorkspaces,
  normalizeChatWorkspacePath,
} from '../../lib/chatWorkspaceSelection.js'
import { setSessionWorkspaceRemote } from '../../lib/sessionClient.js'

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
  const activeSessionServerRevision = activeSession?.serverRevision
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
    setWorkspaceBusy(true)
    setWorkspaceErrorState({ draftVersion: state.newDraftVersion, message: '' })
    try {
      const activated = await activateChatWorkspace(path)
      if (activeSessionId && Number.isInteger(activeSessionServerRevision)) {
        const result = await setSessionWorkspaceRemote(activeSessionId, activated.path)
        dispatch({
          type: 'APPLY_SERVER_SESSION_METADATA',
          payload: { sessionId: activeSessionId, session: result.session },
        })
      } else if (activeSessionId) {
        dispatch({
          type: 'SET_SESSION_WORKSPACE',
          payload: { sessionId: activeSessionId, workspacePath: activated.path },
        })
      } else {
        dispatch({ type: 'SET_DRAFT_WORKSPACE', payload: { workspacePath: activated.path } })
      }
      return activated
    } catch (error) {
      setWorkspaceErrorState({
        draftVersion: state.newDraftVersion,
        message: String(error?.message || t('chatMessages.workspaceSelectionFailed')),
      })
      throw error
    } finally {
      setWorkspaceBusy(false)
    }
  }, [activeSessionId, activeSessionServerRevision, dispatch, state.newDraftVersion, t])

  const handleWorkspaceClear = useCallback(async () => {
    setWorkspaceErrorState({ draftVersion: state.newDraftVersion, message: '' })
    if (activeSessionId && Number.isInteger(activeSessionServerRevision)) {
      setWorkspaceBusy(true)
      try {
        const result = await setSessionWorkspaceRemote(activeSessionId, null)
        dispatch({
          type: 'APPLY_SERVER_SESSION_METADATA',
          payload: { sessionId: activeSessionId, session: result.session },
        })
      } catch (error) {
        setWorkspaceErrorState({
          draftVersion: state.newDraftVersion,
          message: String(error?.message || t('chatMessages.workspaceSelectionFailed')),
        })
        throw error
      } finally {
        setWorkspaceBusy(false)
      }
    } else if (activeSessionId) {
      dispatch({ type: 'SET_SESSION_WORKSPACE', payload: { sessionId: activeSessionId, workspacePath: '' } })
    } else {
      dispatch({ type: 'SET_DRAFT_WORKSPACE', payload: { workspacePath: '' } })
    }
  }, [activeSessionId, activeSessionServerRevision, dispatch, state.newDraftVersion, t])

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
