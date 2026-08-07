import { useEffect } from 'react'
import { TOKEN_KEY, syncAuthTokenFromStorage } from '../lib/accountClient.js'
import { completeSnapshot, createInitialState, getLocalStorage } from './appStateBootstrap.js'
import { ACTIVE_PERSISTENCE_CONTROLLERS } from './appPersistenceClear.js'
import {
  LEGACY_STATE_STORAGE_KEY, STATE_SYNC_CHANNEL_NAME, STATE_SYNC_SIGNAL_KEY,
  clearLocalPersistence, readStateSyncSignal, selectPersistedSnapshot, writeStateClearEpoch,
} from './appStatePersistence.js'
import { clearPersistedSnapshot, readPersistedSnapshot } from './indexedDbPersistence.js'
import { reportPersistenceResult } from './persistenceNotice.js'
import {
  buildSyncMetadata, markConvergedMetadata, mergePersistedSnapshots,
  persistedSnapshotsEqual, readPersistedPayload,
} from './stateSync.js'

export default function useCrossTabStateSync(options) {
  const {
    backendRef, channelRef, clearGenerationRef, dispatch, enqueueIndexedDbWrite, hydrated,
    lastClearedAtRef, lastSnapshotRef, mountedRef, pendingWriteRef, persistToLegacy,
    publishChange, refreshAuth, skipPersistSnapshotRef, stateRef, syncMetaRef, tabIdRef, writeLoopRef,
  } = options

  function applyRemotePayload(payload, fallbackTimestamp = Date.now()) {
    let remote
    try { remote = readPersistedPayload(payload, fallbackTimestamp) } catch { return }
    if (remote.meta.source && remote.meta.source === tabIdRef.current) return
    const remoteWrittenAt = Number(remote.meta.writtenAt) || Number(fallbackTimestamp) || 0
    if (lastClearedAtRef.current > 0 && remoteWrittenAt <= lastClearedAtRef.current) return
    const currentSnapshot = selectPersistedSnapshot(stateRef.current)
    const normalizedRemote = completeSnapshot(remote.snapshot)
    const merged = mergePersistedSnapshots(currentSnapshot, syncMetaRef.current, normalizedRemote, remote.meta, { preserveLocalFields: ['activeSessionId'] })
    const stateChanged = !persistedSnapshotsEqual(currentSnapshot, merged.snapshot)
    const needsConvergenceWrite = !persistedSnapshotsEqual(normalizedRemote, merged.snapshot, ['activeSessionId'])
    lastSnapshotRef.current = merged.snapshot
    syncMetaRef.current = merged.meta
    if (stateChanged) {
      skipPersistSnapshotRef.current = merged.snapshot
      stateRef.current = { ...stateRef.current, ...merged.snapshot }
      dispatch({ type: 'MERGE_EXTERNAL_STATE', payload: merged.snapshot })
    }
    if (needsConvergenceWrite) {
      const convergenceMeta = markConvergedMetadata(merged.meta, tabIdRef.current)
      if (backendRef.current === 'indexeddb') enqueueIndexedDbWrite(merged.snapshot, convergenceMeta)
      else persistToLegacy(merged.snapshot, convergenceMeta)
    }
  }

  async function applyExternalClear(writtenAt = Date.now()) {
    const requestedClearAt = Number(writtenAt) || Date.now()
    lastClearedAtRef.current = Math.max(lastClearedAtRef.current, requestedClearAt)
    clearGenerationRef.current += 1
    pendingWriteRef.current = null
    while (writeLoopRef.current) await writeLoopRef.current
    const durableResult = await clearPersistedSnapshot()
    if (!durableResult.ok && durableResult.status !== 'unavailable') {
      console.warn('[AppContext] external IndexedDB clear failed:', durableResult.error?.name || durableResult.status)
      if (mountedRef.current) reportPersistenceResult(dispatch, { ok: false, level: 'error', error: durableResult.error })
    }
    const storage = getLocalStorage()
    if (storage) {
      try { clearLocalPersistence(storage, { preserveClearEpoch: true }) } catch (error) { console.warn('[AppContext] local clear failed:', error?.name || error) }
    }
    const previousSnapshot = selectPersistedSnapshot(stateRef.current)
    const resetSnapshot = selectPersistedSnapshot(createInitialState())
    const clearMeta = buildSyncMetadata(resetSnapshot, previousSnapshot, syncMetaRef.current, { source: tabIdRef.current, now: lastClearedAtRef.current })
    lastClearedAtRef.current = Math.max(lastClearedAtRef.current, clearMeta.writtenAt)
    if (storage) {
      try { writeStateClearEpoch(storage, lastClearedAtRef.current) } catch (error) { console.warn('[AppContext] clear epoch write failed:', error?.name || error) }
    }
    lastSnapshotRef.current = resetSnapshot
    syncMetaRef.current = clearMeta
    skipPersistSnapshotRef.current = resetSnapshot
    stateRef.current = { ...stateRef.current, ...resetSnapshot }
    dispatch({ type: 'MERGE_EXTERNAL_STATE', payload: resetSnapshot })
  }

  useEffect(() => {
    const controller = {
      async prepareClear() { clearGenerationRef.current += 1; pendingWriteRef.current = null; while (writeLoopRef.current) await writeLoopRef.current },
      publishClear(writtenAt) {
        const resetSnapshot = selectPersistedSnapshot(createInitialState())
        const clearMeta = buildSyncMetadata(resetSnapshot, selectPersistedSnapshot(stateRef.current), syncMetaRef.current, { source: tabIdRef.current, now: writtenAt })
        lastClearedAtRef.current = Math.max(lastClearedAtRef.current, clearMeta.writtenAt)
        lastSnapshotRef.current = resetSnapshot
        syncMetaRef.current = clearMeta
        skipPersistSnapshotRef.current = resetSnapshot
        publishChange('cleared', null, lastClearedAtRef.current)
      },
    }
    ACTIVE_PERSISTENCE_CONTROLLERS.add(controller)
    return () => ACTIVE_PERSISTENCE_CONTROLLERS.delete(controller)
  }, [clearGenerationRef, lastClearedAtRef, lastSnapshotRef, pendingWriteRef, publishChange, skipPersistSnapshotRef, stateRef, syncMetaRef, tabIdRef, writeLoopRef])

  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return undefined
    let channel = null
    if (typeof BroadcastChannel === 'function') {
      try {
        channel = new BroadcastChannel(STATE_SYNC_CHANNEL_NAME)
        channelRef.current = channel
        channel.onmessage = (event) => {
          const message = event.data
          if (!message || message.source === tabIdRef.current) return
          if (message.type === 'cleared') void applyExternalClear(message.writtenAt)
          else if (message.type === 'updated' && message.payload) applyRemotePayload(message.payload, message.writtenAt)
        }
      } catch (error) { console.warn('[AppContext] BroadcastChannel unavailable:', error?.name || error) }
    }
    const onStorage = (event) => {
      if (event.storageArea && event.storageArea !== getLocalStorage()) return
      if (event.key === TOKEN_KEY) { syncAuthTokenFromStorage(event.newValue); void refreshAuth({ retryDelays: [0, 250, 750] }); return }
      if (event.key === LEGACY_STATE_STORAGE_KEY) { if (event.newValue) applyRemotePayload(event.newValue, Date.now()); return }
      if (event.key !== STATE_SYNC_SIGNAL_KEY || !event.newValue) return
      const signal = readStateSyncSignal(event.newValue)
      if (!signal || signal.source === tabIdRef.current) return
      if (signal.type === 'cleared') { void applyExternalClear(signal.writtenAt); return }
      void readPersistedSnapshot().then((remote) => { if (remote.ok && remote.payload) applyRemotePayload(remote.payload, remote.updatedAt || signal.writtenAt) })
    }
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener('storage', onStorage); channel?.close(); if (channelRef.current === channel) channelRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, refreshAuth])
}
