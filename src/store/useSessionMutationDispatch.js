import { useCallback, useRef } from 'react'
import { deleteSessionRemote, getSessionMetadataRemote, replaceSessionMessagesRemote } from '../lib/sessionClient.js'
import { createSessionMutationDispatcher } from './sessionServerSync.js'

export default function useSessionMutationDispatch({ dispatch, reducer, stateRef }) {
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
      resolveSessionMetadata: ({ sessionId }) => getSessionMetadataRemote(sessionId),
      onError: (error, { action, sessionId }) => console.warn(`[AppContext] ${action.type} server session sync failed for ${sessionId}:`, error?.code || error?.message || error),
    })
    dispatcherRef.current = dispatcher
    return dispatcher
  }, [dispatch, reducer, stateRef])
  return useCallback((action) => getDispatcher()(action), [getDispatcher])
}
