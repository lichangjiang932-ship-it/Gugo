import { useCallback } from 'react'
import { getLocalStorage } from './appStateBootstrap.js'
import { publishStateSyncSignal } from './appStatePersistence.js'

export default function useStateSyncPublisher({ channelRef, tabIdRef }) {
  return useCallback((type, payload, writtenAt = Date.now()) => {
    const message = { type, source: tabIdRef.current, writtenAt, payload }
    try { channelRef.current?.postMessage(message) } catch (error) { console.warn('[AppContext] BroadcastChannel publish failed:', error?.name || error) }
    const storage = getLocalStorage()
    if (!storage) return
    try { publishStateSyncSignal(storage, tabIdRef.current, writtenAt, type) } catch (error) { console.warn('[AppContext] storage sync signal failed:', error?.name || error) }
  }, [channelRef, tabIdRef])
}
