import { useCallback, useLayoutEffect, useRef } from 'react'
import { getAuthToken } from '../../lib/accountClient.js'
import { getSessionMetadataRemote, renameSessionRemote } from '../../lib/sessionClient.js'
import { createSessionRenameCoordinator } from '../../lib/sessionRenameCoordinator.js'

export default function useSessionRename({ state, dispatch, toast, t }) {
  const parameters = useRef({ state, dispatch, toast, t })
  const coordinator = useRef(null)
  useLayoutEffect(() => { parameters.current = { state, dispatch, toast, t } }, [state, dispatch, toast, t])
  return useCallback((session, title) => {
    if (!coordinator.current) coordinator.current = createSessionRenameCoordinator({
      getScope: () => { const current = parameters.current.state; return JSON.stringify([current.user?.id ?? null, current.authMode, current.sessionCatalogSource ?? null]) },
      canWrite: () => !!getAuthToken(), read: getSessionMetadataRemote, write: renameSessionRemote,
      optimistic: (target, next) => parameters.current.dispatch({ type: 'UPDATE_SESSION_TITLE_FOR', payload: { sessionId: target.id, title: next, onlyIfMatches: target.title } }),
      commit: (sessionId, value) => parameters.current.dispatch({ type: 'APPLY_SERVER_SESSION_METADATA', payload: { sessionId, session: value } }),
      failed: (target, next, failure, canonical) => {
        const current = parameters.current
        current.dispatch({ type: 'UPDATE_SESSION_TITLE_FOR', payload: { sessionId: target.id, title: canonical?.title || target.title, onlyIfMatches: next } })
        const key = failure.code === 'SESSION_REVISION_CONFLICT' ? 'nav.renameChangedHint'
          : failure.code === 'SESSION_ACCESS_UNAVAILABLE' ? 'nav.localServiceReconnect' : 'nav.renameUnconfirmedHint'
        current.toast.error({ title: current.t('nav.renameFailed'), body: current.t(key) })
      },
    })
    return coordinator.current(session, title)
  }, [])
}
