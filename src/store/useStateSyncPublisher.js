import { useCallback } from 'react'
import { getLocalStorage } from './appStateBootstrap.js'
import { publishStateSyncSignal } from './appStatePersistence.js'
import { sanitizeRetiredBrowserAccountFields } from './browserSnapshotSanitizer.js'

export function selectSharedStateSyncPayload(type, payload) {
  return type === 'updated'
    ? sanitizeRetiredBrowserAccountFields(payload).payload
    : payload
}

export default function useStateSyncPublisher({ channelRef, tabIdRef }) {
  return useCallback((type, payload, writtenAt = Date.now()) => {
    const sharedPayload = selectSharedStateSyncPayload(type, payload)
    const message = { type, source: tabIdRef.current, writtenAt, payload: sharedPayload }
    try { channelRef.current?.postMessage(message) } catch (error) { console.warn('[AppContext] BroadcastChannel publish failed:', error?.name || error) }
    const storage = getLocalStorage()
    if (!storage) return
    try { publishStateSyncSignal(storage, tabIdRef.current, writtenAt, type) } catch (error) { console.warn('[AppContext] storage sync signal failed:', error?.name || error) }
  }, [channelRef, tabIdRef])
}
