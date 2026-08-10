import { useCallback, useEffect } from 'react'
import { sanitizeForPersist } from './persistDegradation.js'
import { completeSnapshot, getLocalStorage, needsToolsConfigSchemaMigration } from './appStateBootstrap.js'
import { readBootstrapPayloads } from './appStatePersistence.js'
import { clearPersistedSnapshot, readPersistedSnapshot, writePersistedSnapshot } from './indexedDbPersistence.js'
import {
  buildSyncMetadata, mergePersistedSnapshots, persistedSnapshotsEqual,
  readPersistedPayload, withSyncMetadata,
} from './stateSync.js'

export default function usePersistenceHydration(options) {
  const {
    backendRef, dispatch, hydrationPromiseRef, lastClearedAtRef, lastSnapshotRef,
    mountedRef, persistToLegacy, setHydrated, skipPersistSnapshotRef, stateRef,
    syncMetaRef, tabIdRef, updateLocalMirrorAfterIndexedDbCommit,
  } = options

  const load = useCallback(async () => {
    const storage = getLocalStorage()
    let bootstrap = { settings: null, legacy: null, clearedAt: 0 }
    if (storage) {
      try { bootstrap = readBootstrapPayloads(storage, 0) } catch (error) { console.warn('[AppContext] bootstrap payload read failed:', error?.name || error) }
    }
    const clearedAt = Number(bootstrap.clearedAt) || 0
    lastClearedAtRef.current = Math.max(lastClearedAtRef.current, clearedAt)
    if (clearedAt > 0) {
      const writtenBeforeClear = (entry) => entry && (Number(entry.meta?.writtenAt) || 0) <= clearedAt
      if (writtenBeforeClear(bootstrap.settings)) bootstrap.settings = null
      if (writtenBeforeClear(bootstrap.legacy)) bootstrap.legacy = null
    }
    let durable = await readPersistedSnapshot()
    let migrationFailed = false
    if (durable.ok && durable.payload && clearedAt > 0) {
      try {
        const candidate = readPersistedPayload(durable.payload, durable.updatedAt || 0)
        if ((Number(candidate.meta?.writtenAt) || 0) <= clearedAt) {
          const staleClear = await clearPersistedSnapshot()
          if (!staleClear.ok && staleClear.status !== 'unavailable') console.warn('[AppContext] stale IndexedDB snapshot cleanup failed:', staleClear.error?.name || staleClear.status)
          durable = { ...durable, payload: null, updatedAt: null }
        }
      } catch { /* malformed snapshots are handled by the normal parsing path */ }
    }
    const hasMigrationMarker = bootstrap.settings?.snapshot?.__persistence?.durableStore === 'indexeddb'
    if (durable.ok && !durable.payload && !bootstrap.legacy && hasMigrationMarker) durable = await readPersistedSnapshot()
    if (durable.ok && durable.payload) {
      try {
        const parsed = readPersistedPayload(durable.payload, durable.updatedAt || 0)
        const durableSource = { ...(bootstrap.settings?.snapshot || {}), ...parsed.snapshot }
        const durableNeedsToolsConfigMigration = needsToolsConfigSchemaMigration(durableSource)
        const durableSnapshot = completeSnapshot(durableSource)
        if (bootstrap.legacy) {
          const legacySnapshot = completeSnapshot({ ...bootstrap.legacy.snapshot, ...(bootstrap.settings?.snapshot || {}) })
          const reconciled = mergePersistedSnapshots(durableSnapshot, parsed.meta, legacySnapshot, bootstrap.legacy.meta)
          const previousSnapshot = reconciled.snapshot
          const snapshot = completeSnapshot(previousSnapshot, { cancelRunningTasks: true })
          const meta = persistedSnapshotsEqual(snapshot, previousSnapshot) ? reconciled.meta : buildSyncMetadata(snapshot, previousSnapshot, reconciled.meta, { source: tabIdRef.current })
          const payload = sanitizeForPersist(withSyncMetadata(snapshot, meta))
          const committed = await writePersistedSnapshot(payload)
          if (committed.ok) {
            updateLocalMirrorAfterIndexedDbCommit(payload)
            return { backend: 'indexeddb', snapshot, previousSnapshot: snapshot, meta, skipInitialWrite: true }
          }
          persistToLegacy(snapshot, meta, { broadcast: false })
          return { backend: 'localstorage', snapshot, previousSnapshot: snapshot, meta, skipInitialWrite: true }
        }
        const previousSnapshot = durableSnapshot
        const snapshot = completeSnapshot(durableSnapshot, { cancelRunningTasks: true })
        return {
          backend: 'indexeddb',
          snapshot,
          previousSnapshot,
          meta: parsed.meta,
          skipInitialWrite: !durableNeedsToolsConfigMigration && persistedSnapshotsEqual(snapshot, previousSnapshot),
        }
      } catch (error) { console.warn('[AppContext] invalid IndexedDB snapshot; trying legacy data:', error) }
    }
    if (durable.ok && bootstrap.legacy) {
      const combined = { ...bootstrap.legacy.snapshot, ...(bootstrap.settings?.snapshot || {}) }
      const previousSnapshot = completeSnapshot(combined)
      const snapshot = completeSnapshot(combined, { cancelRunningTasks: true })
      const meta = buildSyncMetadata(snapshot, previousSnapshot, bootstrap.legacy.meta, { source: tabIdRef.current })
      const payload = sanitizeForPersist(withSyncMetadata(snapshot, meta))
      const migrated = await writePersistedSnapshot(payload)
      if (migrated.ok) {
        updateLocalMirrorAfterIndexedDbCommit(payload)
        return { backend: 'indexeddb', snapshot, previousSnapshot: snapshot, meta, skipInitialWrite: true }
      }
      console.warn('[AppContext] IndexedDB migration failed; preserving legacy snapshot:', migrated.error?.name || migrated.status)
      migrationFailed = true
    }
    const fallback = bootstrap.legacy || bootstrap.settings
    const combined = fallback?.snapshot || {}
    const needsToolsConfigMigration = needsToolsConfigSchemaMigration(combined)
    const previousSnapshot = completeSnapshot(combined)
    const snapshot = completeSnapshot(combined, { cancelRunningTasks: true })
    return {
      backend: durable.ok && !migrationFailed ? 'indexeddb' : 'localstorage',
      snapshot,
      previousSnapshot,
      meta: fallback?.meta || {},
      skipInitialWrite: !needsToolsConfigMigration && persistedSnapshotsEqual(snapshot, previousSnapshot),
      unavailable: !durable.ok && !storage,
    }
  }, [lastClearedAtRef, persistToLegacy, tabIdRef, updateLocalMirrorAfterIndexedDbCommit])

  useEffect(() => {
    mountedRef.current = true
    let active = true
    if (!hydrationPromiseRef.current) hydrationPromiseRef.current = load()
    hydrationPromiseRef.current.then((result) => {
      if (!active) return
      backendRef.current = result.backend
      lastSnapshotRef.current = result.previousSnapshot
      syncMetaRef.current = result.meta
      skipPersistSnapshotRef.current = result.skipInitialWrite ? result.snapshot : null
      stateRef.current = { ...stateRef.current, ...result.snapshot }
      dispatch({ type: 'MERGE_EXTERNAL_STATE', payload: result.snapshot })
      if (result.unavailable) dispatch({ type: 'SET_PERSISTENCE_NOTICE', payload: { level: 'unavailable' } })
      setHydrated(true)
    }).catch((error) => {
      if (!active) return
      console.error('[AppContext] persistence hydration failed:', error)
      backendRef.current = 'localstorage'
      dispatch({ type: 'SET_PERSISTENCE_NOTICE', payload: { level: 'unavailable' } })
      setHydrated(true)
    })
    return () => { active = false; mountedRef.current = false }
  }, [backendRef, dispatch, hydrationPromiseRef, lastSnapshotRef, load, mountedRef, setHydrated, skipPersistSnapshotRef, stateRef, syncMetaRef])
}
