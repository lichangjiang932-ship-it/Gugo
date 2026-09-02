import { useCallback, useEffect, useRef } from 'react'
import { bootstrapAuthWithRetry } from '../lib/accountClient.js'
import { getLocalFileAccessApi } from '../lib/localFileAccessClient.js'
import {
  importAllLegacySessionsRemote,
  listSessionCatalogRemote,
  sameSessionCatalogSource,
  selectLegacySessionImportCandidates,
} from '../lib/sessionClient.js'
import {
  attachSessionCatalogRefreshLifecycle,
  createSessionCatalogRefreshScheduler,
  isSessionCatalogRefreshVisible,
} from './sessionCatalogRefresh.js'

function catalogIdentity(state) {
  if (!state?.authReady || !state?.isLoggedIn) return ''
  return `${state.authMode || 'unknown'}:${state.user?.email || ''}`
}

function protectedLocalSessionIds(state) {
  const activeSessionId = String(state?.activeSessionId || '').trim()
  const draftSessionId = String(state?.draftSessionId || '').trim()
  return (Array.isArray(state?.sessions) ? state.sessions : [])
    .filter((session) => (
      !Number.isInteger(session?.serverRevision)
      && (
        session?.id === activeSessionId
        || session?.id === draftSessionId
        || session?.messages?.some((message) => (
          message?.meta?.pendingServerSync === true || message?.meta?.streaming === true
        ))
      )
    ))
    .map((session) => session.id)
}

export function defaultWorkspacePathForDraft(localFileAccess, state) {
  const workspacePath = String(localFileAccess?.defaultWorkspacePath || '').trim()
  if (!workspacePath || state?.activeSessionId || String(state?.draftWorkspacePath || '').trim()) {
    return ''
  }
  return workspacePath
}

export function hasSessionCatalogSourceChanged(previous, current) {
  return previous != null
    && current != null
    && !sameSessionCatalogSource(previous, current)
}

export default function useAuthBootstrap({ dispatch, hydrated, mountedRef, stateRef }) {
  const requestRef = useRef(null)
  const generationRef = useRef(0)
  const catalogGenerationRef = useRef(0)

  const refreshSessionCatalog = useCallback(async ({ signal } = {}) => {
    const initialState = stateRef.current
    const identity = catalogIdentity(initialState)
    if (!identity) return null
    const catalogGeneration = ++catalogGenerationRef.current
    let serverAuthoritativeIds = []
    let importedSessionIds = []
    let preserveLocalOnly = false
    let catalog = await listSessionCatalogRemote({ signal })
    const sourceChanged = hasSessionCatalogSourceChanged(
      initialState.sessionCatalogSource,
      catalog.source,
    )
    if (initialState.authMode === 'local' && !sourceChanged) {
      const candidates = selectLegacySessionImportCandidates(initialState.sessions)
      if (candidates.length) {
        try {
          const imported = await importAllLegacySessionsRemote(candidates, { signal })
          serverAuthoritativeIds = imported.results
            .filter((entry) => entry?.status === 'server_authoritative')
            .map((entry) => entry.id)
          importedSessionIds = imported.results
            .filter((entry) => entry?.status === 'imported')
            .map((entry) => entry.id)
          const refreshed = await listSessionCatalogRemote({ signal })
          if (!sameSessionCatalogSource(catalog.source, refreshed.source)) {
            const error = new Error('Session catalog source changed during legacy import')
            error.code = 'SESSION_CATALOG_SOURCE_CHANGED'
            throw error
          }
          catalog = refreshed
        } catch (error) {
          if (signal?.aborted) return null
          preserveLocalOnly = true
          console.warn('[AppContext] legacy Session retry failed:', error?.code || error?.message || error)
        }
      }
    }
    const currentState = stateRef.current
    if (
      signal?.aborted
      || !mountedRef.current
      || catalogGeneration !== catalogGenerationRef.current
      || catalogIdentity(currentState) !== identity
    ) return null
    dispatch({
      type: 'RECONCILE_SERVER_SESSION_CATALOG',
      payload: {
        sessions: catalog.sessions,
        source: catalog.source,
        preserveLocalOnly,
        serverAuthoritativeIds,
        importedSessionIds,
        preserveSessionIds: protectedLocalSessionIds(currentState),
      },
    })
    return catalog.sessions
  }, [dispatch, mountedRef, stateRef])

  const refreshAuth = useCallback(async ({ signal, retryDelays } = {}) => {
    const generation = ++generationRef.current
    const request = bootstrapAuthWithRetry({ signal, retryDelays })
    requestRef.current = request
    try {
      const result = await request
      let serverSessions = null
      let serverAuthoritativeIds = []
      let importedSessionIds = []
      let defaultWorkspacePath = ''
      let preserveLocalOnly = false
      let sessionCatalogSource
      if (result?.authenticated === true) {
        if (result.mode === 'local') {
          try {
            const localFileAccess = await getLocalFileAccessApi({ signal })
            defaultWorkspacePath = String(localFileAccess?.defaultWorkspacePath || '').trim()
          } catch (error) {
            if (signal?.aborted) return null
            console.warn('[AppContext] default workspace bootstrap failed:', error?.code || error?.message || error)
          }
        }
        const catalogGeneration = ++catalogGenerationRef.current
        try {
          let catalog = await listSessionCatalogRemote({ signal })
          const sourceChanged = hasSessionCatalogSourceChanged(
            stateRef.current?.sessionCatalogSource,
            catalog.source,
          )
          if (result.mode === 'local' && !sourceChanged) {
            const candidates = selectLegacySessionImportCandidates(stateRef.current?.sessions)
            if (candidates.length) {
              try {
                const imported = await importAllLegacySessionsRemote(candidates, { signal })
                serverAuthoritativeIds = imported.results
                  .filter((entry) => entry?.status === 'server_authoritative')
                  .map((entry) => entry.id)
                importedSessionIds = imported.results
                  .filter((entry) => entry?.status === 'imported')
                  .map((entry) => entry.id)
                const refreshed = await listSessionCatalogRemote({ signal })
                if (!sameSessionCatalogSource(catalog.source, refreshed.source)) {
                  const error = new Error('Session catalog source changed during legacy import')
                  error.code = 'SESSION_CATALOG_SOURCE_CHANGED'
                  throw error
                }
                catalog = refreshed
              } catch (error) {
                if (signal?.aborted) return null
                preserveLocalOnly = true
                console.warn('[AppContext] legacy Session import failed:', error?.code || error?.message || error)
              }
            }
          }
          serverSessions = catalog.sessions
          sessionCatalogSource = catalog.source
          if (catalogGeneration !== catalogGenerationRef.current) serverSessions = null
        } catch (error) {
          if (signal?.aborted) return null
          console.warn('[AppContext] session catalog bootstrap failed:', error?.code || error?.message || error)
        }
      }
      if (mountedRef.current && generation === generationRef.current) {
        dispatch({ type: 'AUTH_BOOTSTRAP', payload: result })
        if (serverSessions) {
          dispatch({
            type: 'RECONCILE_SERVER_SESSION_CATALOG',
            payload: {
              sessions: serverSessions,
              source: sessionCatalogSource,
              preserveLocalOnly,
              serverAuthoritativeIds,
              importedSessionIds,
              preserveSessionIds: protectedLocalSessionIds(stateRef.current),
            },
          })
        }
        if (defaultWorkspacePath) {
          dispatch({
            type: 'SET_DEFAULT_WORKSPACE',
            payload: { workspacePath: defaultWorkspacePath },
          })
        }
        const draftDefaultWorkspacePath = defaultWorkspacePathForDraft(
          { defaultWorkspacePath },
          stateRef.current,
        )
        if (draftDefaultWorkspacePath) {
          dispatch({
            type: 'SET_DRAFT_WORKSPACE',
            payload: { workspacePath: draftDefaultWorkspacePath },
          })
        }
      }
      return result
    } catch (error) {
      if (signal?.aborted) return null
      if (mountedRef.current && generation === generationRef.current) {
        console.warn('[AppContext] auth bootstrap failed:', error?.message || error)
        dispatch({ type: 'AUTH_BOOTSTRAP_FAILED' })
      }
      return null
    } finally {
      if (requestRef.current === request) requestRef.current = null
    }
  }, [dispatch, mountedRef, stateRef])

  useEffect(() => {
    if (!hydrated) return undefined
    const controller = new AbortController()
    void refreshAuth({ signal: controller.signal })
    const retryWhenOnline = () => void refreshAuth({ retryDelays: [0, 250, 750] })
    window.addEventListener('online', retryWhenOnline)
    return () => { controller.abort(); window.removeEventListener('online', retryWhenOnline) }
  }, [hydrated, refreshAuth])

  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return undefined
    const controller = new AbortController()
    const scheduler = createSessionCatalogRefreshScheduler({
      task: () => refreshSessionCatalog({ signal: controller.signal }),
      canRun: () => (
        !controller.signal.aborted
        && !!catalogIdentity(stateRef.current)
        && isSessionCatalogRefreshVisible()
      ),
    })
    const detach = attachSessionCatalogRefreshLifecycle({ scheduler })
    return () => {
      controller.abort()
      detach()
    }
  }, [hydrated, refreshSessionCatalog, stateRef])

  return refreshAuth
}
