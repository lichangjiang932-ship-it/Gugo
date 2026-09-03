import { DEFAULT_STORAGE_KEY, sanitizeForPersist } from './persistDegradation.js'
import { readPersistedPayload } from './stateSync.js'
import { sanitizeRetiredBrowserAccountFields } from './browserSnapshotSanitizer.js'

export const LEGACY_STATE_STORAGE_KEY = DEFAULT_STORAGE_KEY
export const SETTINGS_STORAGE_KEY = 'your-model-atelier:settings:v2'
export const STATE_SYNC_SIGNAL_KEY = 'your-model-atelier:state-sync:v2'
export const STATE_CLEAR_EPOCH_KEY = 'your-model-atelier:last-clear:v1'
export const STATE_SYNC_CHANNEL_NAME = 'your-model-atelier:state-sync'

export const PERSIST_KEYS = Object.freeze([
  'activeSessionId',
  'sessionCatalogSource',
  'tasks',
  'history',
  'permissions',
  'theme',
  'fontSize',
  'density',
  'animationsEnabled',
  'inputHistoryNavigationEnabled',
  'skillConfigs',
  'toolsConfigSchemaVersion',
  'toolsConfig',
  'agentMode',
  'sessionDrafts',
])

export const LOCAL_ONLY_PERSIST_KEYS = Object.freeze(['pendingLegacySessions'])

export const LIGHTWEIGHT_PERSIST_KEYS = Object.freeze([
  'activeSessionId',
  'sessionCatalogSource',
  'permissions',
  'theme',
  'fontSize',
  'density',
  'animationsEnabled',
  'inputHistoryNavigationEnabled',
  'skillConfigs',
  'toolsConfigSchemaVersion',
  'toolsConfig',
  'agentMode',
])

function selectKeys(source, keys) {
  const selected = {}
  for (const key of keys) selected[key] = source?.[key]
  return selected
}

export function selectPersistedSnapshot(state) {
  // The server catalog is the only durable session history. Browser storage
  // retains settings and drafts. The one local-only exception is an upgrade
  // queue, which exists only until the server confirms the legacy import.
  const selected = selectKeys(state, PERSIST_KEYS)
  if (Array.isArray(state?.pendingLegacySessions) && state.pendingLegacySessions.length) {
    selected.pendingLegacySessions = state.pendingLegacySessions
  }
  return selected
}

export function selectLightweightSnapshot(snapshot) {
  const selected = selectKeys(snapshot, LIGHTWEIGHT_PERSIST_KEYS)
  if (snapshot?.sessionCatalogSource == null) delete selected.sessionCatalogSource
  return selected
}

function parseStoredPayload(raw, fallbackTimestamp) {
  if (!raw) return null
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    const sanitized = sanitizeRetiredBrowserAccountFields(parsed, {
      preservePendingLegacySessions: true,
      stageLegacySessions: true,
    })
    const payload = readPersistedPayload(sanitized.payload, fallbackTimestamp, {
      preservePendingLegacySessions: true,
    })
    return {
      payload,
      sanitizedPayload: sanitized.changed ? sanitized.payload : null,
      removedFields: sanitized.removedFields,
    }
  } catch {
    return null
  }
}

export function readBootstrapPayloads(storage, fallbackTimestamp = Date.now()) {
  const readAndClean = (key) => {
    let raw
    try {
      raw = storage.getItem(key)
    } catch {
      return null
    }
    const parsed = parseStoredPayload(raw, fallbackTimestamp)
    if (!parsed) return null
    if (!parsed.sanitizedPayload) return parsed.payload
    let cleanupNeeded = false
    try {
      storage.setItem(key, JSON.stringify(parsed.sanitizedPayload))
    } catch {
      cleanupNeeded = true
    }
    return {
      ...parsed.payload,
      retiredAccountFieldsRemoved: parsed.removedFields,
      ...(cleanupNeeded ? { cleanupNeeded: true } : {}),
    }
  }
  return {
    settings: readAndClean(SETTINGS_STORAGE_KEY),
    legacy: readAndClean(LEGACY_STATE_STORAGE_KEY),
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
