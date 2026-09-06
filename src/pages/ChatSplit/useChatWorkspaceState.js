import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  activateChatWorkspace,
  deriveRecentChatWorkspaces,
  normalizeChatWorkspacePath,
} from '../../lib/chatWorkspaceSelection.js'
import { setSessionWorkspaceRemote } from '../../lib/sessionClient.js'

function useWorkspaceRequests(scope, t) {
  const currentScopeRef = useRef(null)
  const latestRequestsRef = useRef(new Map())
  const sessionWritesRef = useRef(new Map())
  const [requestState, setRequestState] = useState(null)

  useLayoutEffect(() => {
    const requests = latestRequestsRef.current
    currentScopeRef.current = scope
    return () => {
      currentScopeRef.current = null
      // Drafts have no durable session identity. Leaving the draft revokes its
      // outstanding selection even if navigation later returns to that version.
      if (!scope.sessionId) requests.delete(scope.key)
    }
  }, [scope])
  useLayoutEffect(() => {
    const requests = latestRequestsRef.current
    return () => requests.clear()
  }, [])

  const isCurrent = useCallback((request) => Boolean(request
    && latestRequestsRef.current.get(request.scope.key) === request
    && (request.scope.sessionId || currentScopeRef.current === request.scope)), [])

  const finish = useCallback((request, message) => {
    if (!request.authorizationOnly) {
      if (latestRequestsRef.current.get(request.scope.key) !== request) return
      latestRequestsRef.current.delete(request.scope.key)
    }
    if (currentScopeRef.current !== request.scope) return
    setRequestState((current) => current?.request === request
      ? { request, busy: false, message }
      : current)
  }, [])

  const run = useCallback(async (operation, { authorizationOnly = false } = {}) => {
    if (currentScopeRef.current !== scope) return authorizationOnly ? operation(null) : undefined
    const request = { scope, authorizationOnly }
    if (!authorizationOnly) latestRequestsRef.current.set(scope.key, request)
    // Authorizing an already captured Turn path is not a new directory
    // selection. It cannot revoke a select/clear token or replace that
    // scope's manual picker feedback; its result still reaches the send flow.
    setRequestState((current) => authorizationOnly
      && current?.request.scope === scope
      && !current.request.authorizationOnly
      ? current
      : { request, busy: true, message: '' })
    let message = ''
    try {
      return await operation(request)
    } catch (error) {
      message = String(error?.message || t('chatMessages.workspaceSelectionFailed'))
      throw error
    } finally {
      finish(request, message)
    }
  }, [finish, scope, t])

  const writeSession = useCallback(async (request, write) => {
    const key = request.scope.key
    const previous = sessionWritesRef.current.get(key)
    // A later clear/select must be the last server write too, not merely the
    // last response shown locally. A failed earlier write cannot block it.
    const pending = (previous ? previous.catch(() => null) : Promise.resolve())
      .then(() => isCurrent(request) ? write() : null)
    sessionWritesRef.current.set(key, pending)
    try {
      return await pending
    } finally {
      if (sessionWritesRef.current.get(key) === pending) sessionWritesRef.current.delete(key)
    }
  }, [isCurrent])

  const visible = requestState?.request.scope === scope
  return {
    isCurrent,
    run,
    writeSession,
    busy: visible && requestState.busy,
    error: visible ? requestState.message : '',
  }
}

export default function useChatWorkspaceState({
  activeSession,
  activeSessionId,
  dispatch,
  state,
  t,
}) {
  const scope = useMemo(() => ({
    key: JSON.stringify(activeSessionId ? ['session', activeSessionId] : ['draft', state.newDraftVersion]),
    sessionId: activeSessionId || null,
    draftVersion: state.newDraftVersion,
  }), [activeSessionId, state.newDraftVersion])
  const { run, isCurrent, writeSession, busy: workspaceBusy, error: workspaceError } = useWorkspaceRequests(scope, t)
  const draftWorkspacePath = normalizeChatWorkspacePath(state.draftWorkspacePath)
  const selectedWorkspacePath = normalizeChatWorkspacePath(
    activeSession?.workspacePath || (!activeSessionId ? draftWorkspacePath : ''),
  )
  const activeSessionServerRevision = activeSession?.serverRevision
  const recentWorkspaces = useMemo(
    () => deriveRecentChatWorkspaces(state.sessions),
    [state.sessions],
  )

  const applyWorkspacePath = useCallback(async (request, workspacePath) => {
    if (!isCurrent(request)) return
    const sessionId = request.scope.sessionId
    if (sessionId && Number.isInteger(activeSessionServerRevision)) {
      const result = await writeSession(request, () => setSessionWorkspaceRemote(sessionId, workspacePath || null))
      if (result && isCurrent(request)) {
        dispatch({
          type: 'APPLY_SERVER_SESSION_METADATA',
          payload: { sessionId, session: result.session },
        })
      }
    } else if (sessionId) {
      dispatch({ type: 'SET_SESSION_WORKSPACE', payload: { sessionId, workspacePath } })
    } else {
      dispatch({
        type: 'SET_DRAFT_WORKSPACE',
        payload: { workspacePath, expectedDraftVersion: request.scope.draftVersion },
      })
    }
  }, [activeSessionServerRevision, dispatch, isCurrent, writeSession])

  // A send may already have captured its workspace before async preflight.
  // Navigation detaches its UI, but must not skip the required grant/trust.
  const activateWorkspaceForTurn = useCallback((path) => run(
    () => activateChatWorkspace(path),
    { authorizationOnly: true },
  ), [run])

  const handleWorkspaceSelect = useCallback((path) => run(async (request) => {
    const activated = await activateChatWorkspace(path)
    await applyWorkspacePath(request, activated.path)
    return activated
  }), [applyWorkspacePath, run])

  const handleWorkspaceClear = useCallback(() => run(
    (request) => applyWorkspacePath(request, ''),
  ), [applyWorkspacePath, run])

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
