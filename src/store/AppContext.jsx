import { createContext, useCallback, useContext, useReducer, useEffect, useRef, useState } from 'react'
import { persistWithDegradation, sanitizeForPersist } from './persistDegradation.js'
import { getLocalStorage, indexedDbNoticeResult, readBootstrapState } from './appStateBootstrap.js'
import { reducer } from './appReducer.js'
import {
  buildSyncMetadata,
  persistedSnapshotsEqual,
  withSyncMetadata,
} from './stateSync.js'
import {
  removeLegacySnapshot,
  selectPersistedSnapshot,
  writeLightweightSnapshot,
} from './appStatePersistence.js'
import { writePersistedSnapshot } from './indexedDbPersistence.js'
import useAuthBootstrap from './useAuthBootstrap.js'
import useSessionMutationDispatch from './useSessionMutationDispatch.js'
import useStateSyncPublisher from './useStateSyncPublisher.js'
import { clearPersistedState, TAB_INSTANCE_ID } from './appPersistenceClear.js'
import useCrossTabStateSync from './useCrossTabStateSync.js'
import { reportPersistenceResult } from './persistenceNotice.js'
import usePersistenceHydration from './usePersistenceHydration.js'

// eslint-disable-next-line react-refresh/only-export-components
export { clearPersistedState }

const AppContext = createContext(null)

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, readBootstrapState)
  const [hydrated, setHydrated] = useState(typeof window === 'undefined')
  const stateRef = useRef(state)
  const tabIdRef = useRef(TAB_INSTANCE_ID)
  const lastSnapshotRef = useRef(selectPersistedSnapshot(state))
  const syncMetaRef = useRef({})
  const skipPersistSnapshotRef = useRef(null)
  const backendRef = useRef('hydrating')
  const hydrationPromiseRef = useRef(null)
  const pendingWriteRef = useRef(null)
  const writeLoopRef = useRef(null)
  const clearGenerationRef = useRef(0)
  const lastClearedAtRef = useRef(0)
  const channelRef = useRef(null)
  const mountedRef = useRef(true)
  const contextDispatch = useSessionMutationDispatch({ dispatch, reducer, state, stateRef })

  const publishChange = useStateSyncPublisher({ channelRef, tabIdRef })

  const refreshAuth = useAuthBootstrap({ dispatch, hydrated, mountedRef })

  const persistToLegacy = useCallback((snapshot, meta, { broadcast = true } = {}) => {
    const storage = getLocalStorage()
    if (!storage) {
      const result = { ok: false, level: 'error', error: new Error('localStorage unavailable') }
      if (mountedRef.current) reportPersistenceResult(dispatch, result)
      return result
    }
    const payload = sanitizeForPersist(withSyncMetadata(snapshot, meta))
    const result = persistWithDegradation(payload, (key, value) => storage.setItem(key, value))
    if (mountedRef.current) reportPersistenceResult(dispatch, result)
    if (result.ok) {
      lastSnapshotRef.current = snapshot
      syncMetaRef.current = meta
      if (broadcast) publishChange('updated', payload, meta.writtenAt)
    }
    return result
  }, [publishChange])

  const updateLocalMirrorAfterIndexedDbCommit = useCallback((payload) => {
    const storage = getLocalStorage()
    if (!storage) return
    try {
      // Free the legacy full snapshot first so the small settings mirror cannot fail just
      // because the old value already consumes the localStorage quota.
      removeLegacySnapshot(storage)
    } catch (error) {
      console.warn('[AppContext] legacy snapshot cleanup failed:', error?.name || error)
    }
    try {
      writeLightweightSnapshot(storage, payload)
    } catch (error) {
      console.warn('[AppContext] lightweight settings write failed:', error?.name || error)
    }
  }, [])

  function enqueueIndexedDbWrite(snapshot, meta) {
    pendingWriteRef.current = {
      snapshot,
      meta,
      generation: clearGenerationRef.current,
    }
    if (writeLoopRef.current) return writeLoopRef.current

    const loop = (async () => {
      while (pendingWriteRef.current) {
        const item = pendingWriteRef.current
        pendingWriteRef.current = null
        if (item.generation !== clearGenerationRef.current) continue

        const payload = sanitizeForPersist(withSyncMetadata(item.snapshot, item.meta))
        const result = await writePersistedSnapshot(payload)
        if (item.generation !== clearGenerationRef.current) continue

        if (!result.ok) {
          console.warn('[AppContext] IndexedDB write failed; falling back to localStorage:', result.error?.name || result.status)
          backendRef.current = 'localstorage'
          persistToLegacy(item.snapshot, item.meta)
          continue
        }

        lastSnapshotRef.current = item.snapshot
        syncMetaRef.current = item.meta
        updateLocalMirrorAfterIndexedDbCommit(payload)
        if (mountedRef.current) reportPersistenceResult(dispatch, indexedDbNoticeResult(result))
        publishChange('updated', payload, item.meta.writtenAt)
      }
    })().catch((error) => {
      console.error('[AppContext] persistence queue failed:', error)
    }).finally(() => {
      writeLoopRef.current = null
      if (pendingWriteRef.current) enqueueIndexedDbWrite(
        pendingWriteRef.current.snapshot,
        pendingWriteRef.current.meta,
      )
    })
    writeLoopRef.current = loop
    return loop
  }

  usePersistenceHydration({
    backendRef, dispatch, hydrationPromiseRef, lastClearedAtRef, lastSnapshotRef, mountedRef,
    persistToLegacy, setHydrated, skipPersistSnapshotRef, stateRef, syncMetaRef, tabIdRef,
    updateLocalMirrorAfterIndexedDbCommit,
  })

  useCrossTabStateSync({
    backendRef, channelRef, clearGenerationRef, dispatch, enqueueIndexedDbWrite, hydrated,
    lastClearedAtRef, lastSnapshotRef, mountedRef, pendingWriteRef, persistToLegacy,
    publishChange, refreshAuth, skipPersistSnapshotRef, stateRef, syncMetaRef, tabIdRef, writeLoopRef,
  })

  useEffect(() => {
    stateRef.current = state
  }, [state])

  // 持久化：state 变化时把白名单字段写回 localStorage
  // 防容量炸弹:抓到 QuotaExceededError 走逐步降级策略,见 persistWithDegradation.
  //
  // ★ debounce 250ms。原来每次 state 变化都同步全量 JSON 序列化 ——
  // 流式生成时每个 token 都会 dispatch 一次 APPEND_TO_LAST_MESSAGE,
  // 于是一条长回复要把整个 state(所有会话 + 所有消息)序列化几千次。
  // 本地模型吐字慢反而掩盖了这个问题,云端快模型上会明显掉帧。
  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return undefined
    const timer = setTimeout(() => {
      const snapshot = selectPersistedSnapshot(stateRef.current)
      if (skipPersistSnapshotRef.current && persistedSnapshotsEqual(snapshot, skipPersistSnapshotRef.current)) {
        skipPersistSnapshotRef.current = null
        return
      }
      skipPersistSnapshotRef.current = null
      const syncMeta = buildSyncMetadata(snapshot, lastSnapshotRef.current, syncMetaRef.current, {
        source: tabIdRef.current,
        now: Math.max(Date.now(), lastClearedAtRef.current + 1),
      })
      if (backendRef.current === 'indexeddb') {
        enqueueIndexedDbWrite(snapshot, syncMeta)
        return
      }
      const result = persistWithDegradation(withSyncMetadata(snapshot, syncMeta), (key, value) => window.localStorage.setItem(key, value))
      reportPersistenceResult(dispatch, result)
      if (!result.ok) {
        console.error('[AppContext] localStorage 完全不可写:', result.error)
      } else {
        lastSnapshotRef.current = snapshot
        syncMetaRef.current = syncMeta
      }
    }, 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, state.user, state.isLoggedIn, state.sessions, state.activeSessionId, state.tasks, state.history, state.permissions, state.theme, state.accentColor, state.strongAccent, state.fontSize, state.density, state.animationsEnabled, state.inputHistoryNavigationEnabled, state.skillConfigs, state.toolsConfigSchemaVersion, state.toolsConfig, state.agentMode, state.sessionDrafts])

  return (
    <AppContext.Provider value={{ state, dispatch: contextDispatch }}>
      {hydrated && state.authReady ? children : null}
    </AppContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAppContext() {
  const ctx = useContext(AppContext)
  if (!ctx) {
    throw new Error('useAppContext must be used within <AppProvider>')
  }
  return ctx
}
