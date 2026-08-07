import { getLocalStorage } from './appStateBootstrap.js'
import { clearLocalPersistence, publishStateSyncSignal, STATE_SYNC_CHANNEL_NAME } from './appStatePersistence.js'
import { clearPersistedSnapshot } from './indexedDbPersistence.js'

export const TAB_INSTANCE_ID = globalThis.crypto?.randomUUID?.() || `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`
export const ACTIVE_PERSISTENCE_CONTROLLERS = new Set()

export async function clearPersistedState() {
  if (typeof window === 'undefined') return { ok: true }
  try {
    const controllers = [...ACTIVE_PERSISTENCE_CONTROLLERS]
    await Promise.all(controllers.map((controller) => controller.prepareClear()))
    const durableResult = await clearPersistedSnapshot()
    const storage = getLocalStorage()
    if (!durableResult.ok && durableResult.status !== 'unavailable') return { ok: false, reason: durableResult.error?.message || durableResult.status }
    if (!durableResult.ok && !storage) return { ok: false, reason: durableResult.error?.message || durableResult.status }
    if (storage) clearLocalPersistence(storage)
    const writtenAt = Date.now()
    if (controllers.length) {
      for (const controller of controllers) controller.publishClear(writtenAt)
    } else {
      if (storage) publishStateSyncSignal(storage, TAB_INSTANCE_ID, writtenAt, 'cleared')
      if (typeof BroadcastChannel === 'function') {
        const channel = new BroadcastChannel(STATE_SYNC_CHANNEL_NAME)
        channel.postMessage({ type: 'cleared', source: TAB_INSTANCE_ID, writtenAt, payload: null })
        channel.close()
      }
    }
    return { ok: true }
  } catch (error) {
    console.warn('[AppContext] storage clear failed:', error?.name || error)
    return { ok: false, reason: error?.name === 'SecurityError' ? 'storage-disabled' : (error?.message || 'unknown') }
  }
}
