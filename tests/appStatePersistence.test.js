import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LEGACY_STATE_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  STATE_CLEAR_EPOCH_KEY,
  STATE_SYNC_SIGNAL_KEY,
  clearLocalPersistence,
  publishStateSyncSignal,
  readBootstrapPayloads,
  readStateClearEpoch,
  readStateSyncSignal,
  selectLightweightSnapshot,
  selectPersistedSnapshot,
  writeLightweightSnapshot,
  writeStateClearEpoch,
} from '../src/store/appStatePersistence.js'

function createStorage(entries = []) {
  const values = new Map(entries)
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  }
}

test('lightweight local snapshot excludes sessions and other large state', () => {
  const snapshot = {
    user: { name: 'Ada' },
    sessions: [{ id: 's1', messages: [{ content: 'large' }] }],
    tasks: [{ id: 't1' }],
    history: [{ id: 'h1' }],
    sessionDrafts: { s1: 'draft' },
    theme: 'dark',
  }
  assert.deepEqual(selectPersistedSnapshot(snapshot).sessions, snapshot.sessions)
  assert.deepEqual(selectLightweightSnapshot(snapshot), {
    activeSessionId: undefined,
    permissions: undefined,
    theme: 'dark',
    accentColor: undefined,
    strongAccent: undefined,
    fontSize: undefined,
    density: undefined,
    animationsEnabled: undefined,
    skillConfigs: undefined,
    toolsConfig: undefined,
    agentMode: undefined,
  })
})

test('bootstrap reads new settings and a legacy full snapshot independently', () => {
  const storage = createStorage([
    [SETTINGS_STORAGE_KEY, JSON.stringify({ theme: 'dark' })],
    [LEGACY_STATE_STORAGE_KEY, JSON.stringify({ sessions: [{ id: 'legacy' }], theme: 'light' })],
  ])
  const result = readBootstrapPayloads(storage, 123)
  assert.equal(result.settings.snapshot.theme, 'dark')
  assert.equal(result.legacy.snapshot.sessions[0].id, 'legacy')
})

test('writing settings never places session content in localStorage', () => {
  const storage = createStorage()
  writeLightweightSnapshot(storage, {
    sessions: [{ id: 's1', messages: [{ content: 'must-not-be-local' }] }],
    theme: 'dark',
    __sync: { version: 1, source: 'tab-a', writtenAt: 321 },
  })
  const raw = storage.values.get(SETTINGS_STORAGE_KEY)
  assert.equal(raw.includes('must-not-be-local'), false)
  assert.equal(JSON.parse(raw).theme, 'dark')
  assert.equal(readBootstrapPayloads(storage, 0).settings.meta.writtenAt, 321)
})

test('lightweight settings are redacted and bootstrap tolerates blocked localStorage reads', () => {
  const storage = createStorage()
  writeLightweightSnapshot(storage, { toolsConfig: { apiKey: 'must-not-persist', enabled: true } })
  assert.equal(JSON.parse(storage.values.get(SETTINGS_STORAGE_KEY)).toolsConfig.apiKey, '[REDACTED]')
  const blocked = { getItem() { throw Object.assign(new Error('blocked'), { name: 'SecurityError' }) } }
  assert.deepEqual(readBootstrapPayloads(blocked), { settings: null, legacy: null, clearedAt: 0 })
})

test('sync signals are small, typed, and clearable with local persistence', () => {
  const storage = createStorage([[LEGACY_STATE_STORAGE_KEY, '{}'], [SETTINGS_STORAGE_KEY, '{}']])
  publishStateSyncSignal(storage, 'tab-a', 456, 'cleared')
  const signal = readStateSyncSignal(storage.values.get(STATE_SYNC_SIGNAL_KEY))
  assert.equal(signal.source, 'tab-a')
  assert.equal(signal.writtenAt, 456)
  assert.equal(signal.type, 'cleared')
  assert.equal(typeof signal.nonce, 'string')
  assert.ok(signal.nonce.length > 0)
  clearLocalPersistence(storage)
  assert.equal(storage.values.size, 0)
})

test('clear epoch is monotonic and can survive snapshot cleanup', () => {
  const storage = createStorage([
    [LEGACY_STATE_STORAGE_KEY, '{}'],
    [SETTINGS_STORAGE_KEY, '{}'],
  ])
  assert.equal(writeStateClearEpoch(storage, 500), 500)
  assert.equal(writeStateClearEpoch(storage, 400), 500)
  clearLocalPersistence(storage, { preserveClearEpoch: true })
  assert.equal(readStateClearEpoch(storage), 500)
  assert.equal(storage.values.get(STATE_CLEAR_EPOCH_KEY), '500')
  assert.equal(storage.values.size, 1)
})
