import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TOOLS_CONFIG_SCHEMA_VERSION,
  completeSnapshot,
  createInitialState,
  needsToolsConfigSchemaMigration,
  normalizePersistedFields,
} from '../src/store/appStateBootstrap.js'
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
import { reduceTaskSettingsState } from '../src/store/reducers/taskSettingsReducer.js'

function createStorage(entries = []) {
  const values = new Map(entries)
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  }
}

test('new installs enable every app permission and tool toggle by default', () => {
  const state = createInitialState()
  assert.ok(state.permissions.length > 0)
  assert.equal(state.permissions.every((permission) => permission.enabled === true), true)
  assert.equal(Object.values(state.toolsConfig).every((enabled) => enabled === true), true)
  assert.equal(state.inputHistoryNavigationEnabled, true)
})

test('legacy account and subscription fields never re-enter persisted app state', () => {
  const legacy = {
    user: { email: 'legacy@example.test', plan: 'pro' },
    isLoggedIn: true,
    theme: 'dark',
  }
  const normalized = normalizePersistedFields(legacy)
  assert.equal(Object.hasOwn(normalized, 'user'), false)
  assert.equal(Object.hasOwn(normalized, 'isLoggedIn'), false)

  const selected = selectPersistedSnapshot(legacy)
  assert.equal(Object.hasOwn(selected, 'user'), false)
  assert.equal(Object.hasOwn(selected, 'isLoggedIn'), false)

  const completed = completeSnapshot(legacy)
  assert.equal(Object.hasOwn(completed, 'user'), false)
  assert.equal(Object.hasOwn(completed, 'isLoggedIn'), false)
})

test('input history navigation opt-out persists while invalid values use the enabled default', () => {
  const disabled = reduceTaskSettingsState(createInitialState(), {
    type: 'SET_INPUT_HISTORY_NAVIGATION',
    payload: false,
  })
  assert.equal(disabled.inputHistoryNavigationEnabled, false)
  assert.equal(selectPersistedSnapshot(disabled).inputHistoryNavigationEnabled, false)
  assert.equal(normalizePersistedFields({ inputHistoryNavigationEnabled: false }).inputHistoryNavigationEnabled, false)
  assert.equal(normalizePersistedFields({ inputHistoryNavigationEnabled: 'false' }).inputHistoryNavigationEnabled, undefined)
  assert.equal(selectPersistedSnapshot(createInitialState()).inputHistoryNavigationEnabled, true)
})

test('current persisted permission opt-outs remain explicit', () => {
  const normalized = normalizePersistedFields({
    permissions: [
      { id: 'mic', enabled: false },
      { id: 'notify', enabled: true },
    ],
  })
  assert.equal(normalized.permissions.find((permission) => permission.id === 'mic')?.enabled, false)
  assert.equal(normalized.permissions.find((permission) => permission.id === 'notify')?.enabled, true)
})

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
    inputHistoryNavigationEnabled: undefined,
    skillConfigs: undefined,
    toolsConfigSchemaVersion: undefined,
    toolsConfig: undefined,
    agentMode: undefined,
  })
})

test('server-backed sessions persist metadata without duplicating transcript messages', () => {
  const snapshot = selectPersistedSnapshot({
    sessions: [
      { id: 'server', serverRevision: 7, messages: [{ id: 'm1', content: 'server copy' }] },
      { id: 'legacy', messages: [{ id: 'm2', content: 'local only' }] },
    ],
  })
  assert.deepEqual(snapshot.sessions[0].messages, [])
  assert.equal(snapshot.sessions[0].serverRevision, 7)
  assert.equal(snapshot.sessions[1].messages[0].content, 'local only')
})

test('tool defaults migrate to the complete execution loop while current explicit disables are preserved', () => {
  assert.equal(needsToolsConfigSchemaMigration({ toolsConfig: { bash_exec: false, run_project_check: false } }), true)
  const legacy = normalizePersistedFields({ toolsConfig: { bash_exec: false, run_project_check: false } })
  assert.equal(legacy.toolsConfig.bash_exec, true)
  assert.equal(legacy.toolsConfig.run_project_check, true)
  for (const id of ['image_info', 'image_transform', 'media_probe', 'media_transform', 'pdf_info', 'pdf_text', 'pdf_transform', 'archive_list', 'archive_create', 'archive_extract', 'batch_rename', 'file_hash_manifest']) {
    assert.equal(legacy.toolsConfig[id], true)
  }
  assert.equal(legacy.toolsConfig.create_pdf, true)
  assert.equal(legacy.toolsConfigSchemaVersion, TOOLS_CONFIG_SCHEMA_VERSION)

  const v1 = normalizePersistedFields({
    toolsConfigSchemaVersion: 1,
    toolsConfig: { bash_exec: false, run_project_check: false },
  })
  assert.equal(needsToolsConfigSchemaMigration({
    toolsConfigSchemaVersion: 1,
    toolsConfig: { bash_exec: false, run_project_check: false },
  }), true)
  assert.equal(v1.toolsConfig.bash_exec, true)
  assert.equal(v1.toolsConfig.run_project_check, true)

  const v2 = normalizePersistedFields({
    toolsConfigSchemaVersion: 2,
    toolsConfig: { image_info: false, pdf_transform: false, archive_create: false },
  })
  assert.equal(v2.toolsConfig.image_info, true)
  assert.equal(v2.toolsConfig.pdf_transform, true)
  assert.equal(v2.toolsConfig.archive_create, true)

  const v3Saved = {
    toolsConfigSchemaVersion: 3,
    toolsConfig: {
      image_info: false,
      archive_create: false,
      archive_extract: false,
      batch_rename: false,
      file_hash_manifest: false,
    },
  }
  assert.equal(needsToolsConfigSchemaMigration(v3Saved), true)
  const v3 = normalizePersistedFields(v3Saved)
  assert.equal(v3.toolsConfig.image_info, true)
  for (const id of ['archive_create', 'archive_extract', 'batch_rename', 'file_hash_manifest']) {
    assert.equal(v3.toolsConfig[id], true)
  }

  const v4 = normalizePersistedFields({
    toolsConfigSchemaVersion: 4,
    toolsConfig: { pdf_transform: false, archive_extract: false },
  })
  assert.equal(v4.toolsConfig.pdf_text, true)
  assert.equal(v4.toolsConfig.archive_list, true)
  assert.equal(v4.toolsConfig.pdf_transform, true)
  assert.equal(v4.toolsConfig.archive_extract, true)

  const v5 = normalizePersistedFields({
    toolsConfigSchemaVersion: 5,
    toolsConfig: {
      list_directory: false,
      read_file: false,
      write_file: false,
      edit_file: false,
      apply_patch: false,
      bash_exec: false,
      git_status: false,
      git_diff: false,
      git_commit: false,
      git_push: false,
      git_rollback: false,
      run_project_check: false,
    },
  })
  for (const id of [
    'list_directory', 'read_file', 'write_file', 'edit_file', 'apply_patch', 'bash_exec',
    'git_status', 'git_diff', 'git_commit', 'git_push', 'git_rollback', 'run_project_check',
  ]) assert.equal(v5.toolsConfig[id], true, id)

  const v6 = normalizePersistedFields({
    toolsConfigSchemaVersion: 6,
    toolsConfig: { run_test: false, docker_exec: false, file_download: false },
  })
  for (const id of ['run_test', 'docker_exec', 'file_download']) {
    assert.equal(v6.toolsConfig[id], true, id)
  }

  const v7 = normalizePersistedFields({
    toolsConfigSchemaVersion: 7,
    toolsConfig: { patch_file: false, run_command: false, git_write: false },
  })
  for (const id of ['patch_file', 'run_command', 'git_write']) {
    assert.equal(v7.toolsConfig[id], true, id)
  }

  const v8 = normalizePersistedFields({
    toolsConfigSchemaVersion: 8,
    toolsConfig: { create_pdf: false },
  })
  assert.equal(v8.toolsConfig.create_pdf, true)

  const explicit = normalizePersistedFields({
    toolsConfigSchemaVersion: TOOLS_CONFIG_SCHEMA_VERSION,
    toolsConfig: {
      bash_exec: false,
      list_directory: false,
      read_file: false,
      write_file: false,
      edit_file: false,
      apply_patch: false,
      patch_file: false,
      run_command: false,
      run_test: false,
      docker_exec: false,
      file_download: false,
      git_status: false,
      git_diff: false,
      git_commit: false,
      git_push: false,
      git_rollback: false,
      git_write: false,
      run_project_check: false,
      archive_create: false,
      archive_extract: false,
      batch_rename: false,
      file_hash_manifest: false,
      pdf_text: false,
      archive_list: false,
      create_pdf: false,
    },
  })
  assert.equal(needsToolsConfigSchemaMigration(explicit), false)
  assert.equal(explicit.toolsConfig.bash_exec, false)
  assert.equal(explicit.toolsConfig.run_project_check, false)
  for (const id of [
    'list_directory', 'read_file', 'write_file', 'edit_file', 'apply_patch', 'patch_file', 'run_command',
    'run_test', 'docker_exec', 'file_download',
    'git_status', 'git_diff', 'git_commit', 'git_push', 'git_rollback', 'git_write',
  ]) assert.equal(explicit.toolsConfig[id], false, id)
  for (const id of ['archive_create', 'archive_extract', 'batch_rename', 'file_hash_manifest']) {
    assert.equal(explicit.toolsConfig[id], false)
  }
  assert.equal(explicit.toolsConfig.pdf_text, false)
  assert.equal(explicit.toolsConfig.archive_list, false)
  assert.equal(explicit.toolsConfig.create_pdf, false)
  assert.equal(explicit.toolsConfigSchemaVersion, TOOLS_CONFIG_SCHEMA_VERSION)
})

test('server-backed persistence keeps one redacted active-turn stub for crash recovery', () => {
  const snapshot = selectPersistedSnapshot({
    sessions: [{
      id: 'server',
      serverRevision: 8,
      messages: [
        { id: 'history', role: 'assistant', content: 'durable server history' },
        { id: 'orphan', role: 'assistant', content: 'orphan', meta: { streaming: true } },
        {
          id: 'active-1',
          role: 'assistant',
          content: 'SECRET partial answer',
          timestamp: 10,
          meta: { streaming: true, serverTurnId: 'turn-1', serverLastSequence: 40, reasoning: 'SECRET reasoning' },
        },
        {
          id: 'active-2',
          role: 'assistant',
          content: 'LATEST secret',
          timestamp: 20,
          meta: {
            streaming: true,
            serverTurnId: 'turn-2',
            serverLastSequence: 99,
            toolCalls: [{ result: 'SECRET tool result' }],
            serverArtifacts: [{ filename: 'SECRET.docx' }],
          },
        },
      ],
    }],
  })

  assert.deepEqual(snapshot.sessions[0].messages, [{
    id: 'active-2',
    role: 'assistant',
    content: '',
    timestamp: 20,
    meta: { streaming: true, serverTurnId: 'turn-2', serverLastSequence: -1 },
  }])
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|\.docx/)
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

test('bootstrap physically removes retired account fields without changing local sessions or settings', () => {
  const settingsPayload = {
    user: { email: 'old@example.test', plan: 'pro' },
    isLoggedIn: true,
    theme: 'dark',
    toolsConfig: { fetch_url: false },
    customSetting: { keep: true },
    __sync: {
      version: 1,
      source: 'old-tab',
      writtenAt: 50,
      fields: { user: 50, isLoggedIn: 50, theme: 50 },
      entities: { user: { old: 50 }, toolsConfig: { fetch_url: 50 } },
      tombstones: { isLoggedIn: { old: 40 } },
    },
  }
  const legacyPayload = {
    user: { plan: 'legacy' },
    isLoggedIn: false,
    sessions: [{ id: 'keep-session', messages: [{ id: 'm1', content: 'keep-message' }] }],
    modelConfig: { baseUrl: 'http://localhost:11434', model: 'local-model' },
  }
  const storage = createStorage([
    [SETTINGS_STORAGE_KEY, JSON.stringify(settingsPayload)],
    [LEGACY_STATE_STORAGE_KEY, JSON.stringify(legacyPayload)],
  ])

  const result = readBootstrapPayloads(storage, 50)
  assert.deepEqual(result.settings.retiredAccountFieldsRemoved.sort(), ['isLoggedIn', 'user'])
  assert.equal(Object.hasOwn(result.settings.snapshot, 'user'), false)
  assert.equal(Object.hasOwn(result.settings.snapshot, 'isLoggedIn'), false)
  assert.equal(Object.hasOwn(result.settings.meta.fields, 'user'), false)
  assert.equal(Object.hasOwn(result.settings.meta.fields, 'isLoggedIn'), false)
  assert.deepEqual(result.settings.snapshot.toolsConfig, { fetch_url: false })
  assert.deepEqual(result.settings.snapshot.customSetting, { keep: true })
  assert.equal(result.legacy.snapshot.sessions[0].messages[0].content, 'keep-message')
  assert.equal(result.legacy.snapshot.modelConfig.model, 'local-model')

  const cleanedSettings = JSON.parse(storage.values.get(SETTINGS_STORAGE_KEY))
  const cleanedLegacy = JSON.parse(storage.values.get(LEGACY_STATE_STORAGE_KEY))
  for (const cleaned of [cleanedSettings, cleanedLegacy]) {
    assert.equal(Object.hasOwn(cleaned, 'user'), false)
    assert.equal(Object.hasOwn(cleaned, 'isLoggedIn'), false)
  }
  assert.equal(Object.hasOwn(cleanedSettings.__sync.fields, 'user'), false)
  assert.equal(Object.hasOwn(cleanedSettings.__sync.fields, 'isLoggedIn'), false)
  assert.equal(cleanedLegacy.sessions[0].messages[0].content, 'keep-message')
  assert.equal(cleanedLegacy.modelConfig.baseUrl, 'http://localhost:11434')
})

test('blocked localStorage rewrites still expose a clean snapshot and request a later cleanup write', () => {
  const raw = JSON.stringify({
    user: { plan: 'legacy' },
    isLoggedIn: true,
    sessions: [{ id: 'safe' }],
    theme: 'dark',
  })
  const storage = {
    getItem(key) { return key === LEGACY_STATE_STORAGE_KEY ? raw : null },
    setItem() { throw Object.assign(new Error('blocked'), { name: 'SecurityError' }) },
  }

  const result = readBootstrapPayloads(storage, 10)
  assert.equal(result.legacy.cleanupNeeded, true)
  assert.equal(Object.hasOwn(result.legacy.snapshot, 'user'), false)
  assert.equal(Object.hasOwn(result.legacy.snapshot, 'isLoggedIn'), false)
  assert.deepEqual(result.legacy.snapshot.sessions, [{ id: 'safe' }])
  assert.equal(result.legacy.snapshot.theme, 'dark')
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
  writeLightweightSnapshot(storage, {
    toolsConfigSchemaVersion: TOOLS_CONFIG_SCHEMA_VERSION,
    toolsConfig: { apiKey: 'must-not-persist', enabled: true },
  })
  const stored = JSON.parse(storage.values.get(SETTINGS_STORAGE_KEY))
  assert.equal(stored.toolsConfig.apiKey, '[REDACTED]')
  assert.equal(stored.toolsConfigSchemaVersion, TOOLS_CONFIG_SCHEMA_VERSION)
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
