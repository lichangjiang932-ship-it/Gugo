import { DEFAULT_STORAGE_KEY, sanitizeForPersist } from './persistDegradation.js'
import { readPersistedPayload } from './stateSync.js'

export const LEGACY_STATE_STORAGE_KEY = DEFAULT_STORAGE_KEY
export const SETTINGS_STORAGE_KEY = 'your-model-atelier:settings:v2'
export const STATE_SYNC_SIGNAL_KEY = 'your-model-atelier:state-sync:v2'
export const STATE_CLEAR_EPOCH_KEY = 'your-model-atelier:last-clear:v1'
export const STATE_SYNC_CHANNEL_NAME = 'your-model-atelier:state-sync'

export const PERSIST_KEYS = Object.freeze([
  'sessions',
  'activeSessionId',
  'tasks',
  'history',
  'permissions',
  'theme',
  'accentColor',
  'strongAccent',
  'fontSize',
  'density',
  'animationsEnabled',
  'skillConfigs',
  'toolsConfig',
  'agentMode',
  'sessionDrafts',
])

export const LIGHTWEIGHT_PERSIST_KEYS = Object.freeze([
  'activeSessionId',
  'permissions',
  'theme',
  'accentColor',
  'strongAccent',
  'fontSize',
  'density',
  'animationsEnabled',
  'skillConfigs',
  'toolsConfig',
  'agentMode',
])

function selectKeys(source, keys) {
  const selected = {}
  for (const key of keys) selected[key] = source?.[key]
  return selected
}

export function selectPersistedSnapshot(state) {
  const snapshot = selectKeys(state, PERSIST_KEYS)
  // The server is the sole durable source for migrated chat transcripts.
  // Keep legacy/local-only sessions intact, but do not duplicate complete
  // server-backed histories into IndexedDB and reconcile two sources later.
  snapshot.sessions = (Array.isArray(snapshot.sessions) ? snapshot.sessions : []).map((session) => (
    Number.isInteger(session?.serverRevision)
      ? { ...session, messages: [] }
      : session
  ))
  return snapshot
}

export function selectLightweightSnapshot(snapshot) {
  return selectKeys(snapshot, LIGHTWEIGHT_PERSIST_KEYS)
}

function parseStoredPayload(raw, fallbackTimestamp) {
  if (!raw) return null
  try {
    return readPersistedPayload(raw, fallbackTimestamp)
  } catch {
    return null
  }
}

export function readBootstrapPayloads(storage, fallbackTimestamp = Date.now()) {
  const safeGetItem = (key) => {
    try {
      return storage.getItem(key)
    } catch {
      return null
    }
  }
  return {
    settings: parseStoredPayload(safeGetItem(SETTINGS_STORAGE_KEY), fallbackTimestamp),
    legacy: parseStoredPayload(safeGetItem(LEGACY_STATE_STORAGE_KEY), fallbackTimestamp),
    clearedAt: readStateClearEpoch(storage),
  }
}

export function writeLightweightSnapshot(storage, snapshot) {
  const payload = {
    ...sanitizeForPersist(selectLightweightSnapshot(snapshot)),
    ...(snapshot?.__sync ? { __sync: sanitizeForPersist(snapshot.__sync) } : {}),
    __persistence: { version: 2, durableStore: 'indexeddb' },
  }
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload))
  return payload
}

export function removeLegacySnapshot(storage) {
  storage.removeItem(LEGACY_STATE_STORAGE_KEY)
}

export function publishStateSyncSignal(storage, source, writtenAt = Date.now(), type = 'updated') {
  if (type === 'cleared') writeStateClearEpoch(storage, writtenAt)
  const nonce = globalThis.crypto?.randomUUID?.() || `${writtenAt}-${Math.random().toString(36).slice(2)}`
  const signal = { source, writtenAt, type, nonce }
  storage.setItem(STATE_SYNC_SIGNAL_KEY, JSON.stringify(signal))
  return signal
}

export function readStateClearEpoch(storage) {
  try {
    const value = Number(storage?.getItem?.(STATE_CLEAR_EPOCH_KEY))
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

export function writeStateClearEpoch(storage, writtenAt = Date.now()) {
  const next = Number(writtenAt)
  if (!Number.isFinite(next) || next <= 0) return readStateClearEpoch(storage)
  const current = readStateClearEpoch(storage)
  const value = Math.max(current, next)
  storage.setItem(STATE_CLEAR_EPOCH_KEY, String(value))
  return value
}

export function readStateSyncSignal(raw) {
  if (!raw) return null
  try {
    const signal = JSON.parse(raw)
    if (!signal || typeof signal !== 'object') return null
    if (!['updated', 'cleared'].includes(signal.type)) return null
    return {
      source: typeof signal.source === 'string' ? signal.source : '',
      writtenAt: Number(signal.writtenAt) || 0,
      type: signal.type,
      nonce: typeof signal.nonce === 'string' ? signal.nonce : '',
    }
  } catch {
    return null
  }
}

export function clearLocalPersistence(storage, { preserveClearEpoch = false } = {}) {
  storage.removeItem(SETTINGS_STORAGE_KEY)
  storage.removeItem(LEGACY_STATE_STORAGE_KEY)
  storage.removeItem(STATE_SYNC_SIGNAL_KEY)
  if (!preserveClearEpoch) storage.removeItem(STATE_CLEAR_EPOCH_KEY)
}
