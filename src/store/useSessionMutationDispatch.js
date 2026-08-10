import { useCallback, useEffect, useRef } from 'react'
import { getAuthToken } from '../lib/accountClient.js'
import { deleteSessionRemote, getSessionMetadataRemote, replaceSessionMessagesRemote } from '../lib/sessionClient.js'
import { fetchServerSessionSnapshot } from '../lib/turnClient.js'
import { createSessionMutationDispatcher, needsServerTranscriptHydration } from './sessionServerSync.js'

export default function useSessionMutationDispatch({ dispatch, reducer, state, stateRef }) {
  const dispatcherRef = useRef(null)
  const getDispatcher = useCallback(() => {
    if (dispatcherRef.current != null) return dispatcherRef.current
    const dispatcher = createSessionMutationDispatcher({
      getState: () => stateRef.current,
      reduceState: reducer,
      dispatchImmediate: dispatch,
      applyServerAction: (action) => { stateRef.current = reducer(stateRef.current, action); dispatch(action) },
      replaceMessages: ({ sessionId, expectedRevision, messages }) => replaceSessionMessagesRemote(sessionId, { expectedRevision, messages }),
      deleteSession: ({ sessionId, expectedRevision }) => deleteSessionRemote(sessionId, { expectedRevision }),
      canFetchSessionSnapshot: () => !!getAuthToken(),
      fetchSessionSnapshot: ({ sessionId }) => fetchServerSessionSnapshot({ sessionId }),
      resolveSessionMetadata: ({ sessionId }) => getSessionMetadataRemote(sessionId),
      onError: (error, { action, sessionId }) => console.warn(`[AppContext] ${action.type} server session sync failed for ${sessionId}:`, error?.code || error?.message || error),
    })
    dispatcherRef.current = dispatcher
    return dispatcher
  }, [dispatch, reducer, stateRef])
  const dispatchWithSessionSync = useCallback((action) => getDispatcher()(action), [getDispatcher])
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId)
  const hydrationSessionId = state.authReady
    && state.isLoggedIn
    && needsServerTranscriptHydration(activeSession)
    ? activeSession.id
    : null
  const hydrationRevision = hydrationSessionId ? activeSession.serverRevision : null

  useEffect(() => {
    if (!hydrationSessionId) return
    void dispatchWithSessionSync({
      type: 'HYDRATE_SERVER_SESSION',
      payload: { sessionId: hydrationSessionId, revision: hydrationRevision },
    })
  }, [dispatchWithSessionSync, hydrationRevision, hydrationSessionId])

  return dispatchWithSessionSync
}
