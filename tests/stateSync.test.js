import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TOOLS_CONFIG_SCHEMA_VERSION,
  completeSnapshot,
  createInitialState,
} from '../src/store/appStateBootstrap.js'
import { reduceSyncState } from '../src/store/reducers/syncReducer.js'
import { createCrossTabClearReset } from '../src/store/useCrossTabStateSync.js'
import { selectSharedStateSyncPayload } from '../src/store/useStateSyncPublisher.js'
import {
  buildSyncMetadata,
  markConvergedMetadata,
  mergePersistedSnapshots,
  persistedSnapshotsEqual,
  readPersistedPayload,
} from '../src/store/stateSync.js'

function task(id, stepLabel, updatedAt) {
  return { id, stepLabel, updatedAt }
}

test('state sync merges concurrent task additions instead of replacing the whole snapshot', () => {
  const base = { tasks: [task('base', 'base', 1)], theme: 'system' }
  const baseMeta = buildSyncMetadata(base, {}, {}, { source: 'base', now: 1 })
  const left = { ...base, tasks: [...base.tasks, task('left', 'L', 2)] }
  const right = { ...base, tasks: [...base.tasks, task('right', 'R', 3)] }
  const leftMeta = buildSyncMetadata(left, base, baseMeta, { source: 'left', now: 2 })
  const rightMeta = buildSyncMetadata(right, base, baseMeta, { source: 'right', now: 3 })

  const merged = mergePersistedSnapshots(left, leftMeta, right, rightMeta)
  assert.deepEqual(new Set(merged.snapshot.tasks.map((item) => item.id)), new Set(['base', 'left', 'right']))
})

test('state sync keeps the newest entity edit and does not resurrect a deleted task', () => {
  const base = { tasks: [task('t1', 'old', 1), task('t2', 'remove me', 1)] }
  const baseMeta = buildSyncMetadata(base, {}, {}, { source: 'base', now: 10 })
  const edited = { tasks: [task('t1', 'new', 20), task('t2', 'remove me', 1)] }
  const deleted = { tasks: [task('t1', 'old', 1)] }
  const editedMeta = buildSyncMetadata(edited, base, baseMeta, { source: 'edit', now: 20 })
  const deletedMeta = buildSyncMetadata(deleted, base, baseMeta, { source: 'delete', now: 30 })

  const merged = mergePersistedSnapshots(edited, editedMeta, deleted, deletedMeta)
  assert.equal(merged.snapshot.tasks.find((item) => item.id === 't1').stepLabel, 'new')
  assert.equal(merged.snapshot.tasks.some((item) => item.id === 't2'), false)
})

test('state sync preserves tab-local selection and converges after one union write', () => {
  const left = { activeSessionId: 'left', tasks: [task('left', 'L', 1)] }
  const right = { activeSessionId: 'right', tasks: [task('right', 'R', 2)] }
  const leftMeta = buildSyncMetadata(left, {}, {}, { source: 'left', now: 10 })
  const rightMeta = buildSyncMetadata(right, {}, {}, { source: 'right', now: 20 })
  const first = mergePersistedSnapshots(left, leftMeta, right, rightMeta, { preserveLocalFields: ['activeSessionId'] })

  assert.equal(first.snapshot.activeSessionId, 'left')
  assert.equal(persistedSnapshotsEqual(right, first.snapshot, ['activeSessionId']), false)

  const convergenceMeta = markConvergedMetadata(first.meta, 'left', 30)
  const second = mergePersistedSnapshots(right, rightMeta, first.snapshot, convergenceMeta, { preserveLocalFields: ['activeSessionId'] })
  assert.equal(second.snapshot.activeSessionId, 'right')
  assert.equal(persistedSnapshotsEqual(first.snapshot, second.snapshot, ['activeSessionId']), true)
})

test('cross-tab payload parsing reports retired account fields while preserving current data', () => {
  const parsed = readPersistedPayload({
    user: { plan: 'legacy' },
    isLoggedIn: true,
    sessions: [{ id: 'stale-browser-session', messages: [{ content: 'stale' }] }],
    pendingLegacySessions: [{ id: 'local-migration', messages: [{ content: 'private' }] }],
    toolsConfig: { fetch_url: false },
    __sync: {
      writtenAt: 20,
      fields: { user: 20, isLoggedIn: 20, pendingLegacySessions: 20 },
      entities: { sessions: { 'stale-browser-session': 20 } },
    },
  })

  assert.deepEqual(parsed.retiredAccountFieldsRemoved.sort(), ['isLoggedIn', 'pendingLegacySessions', 'sessions', 'user'])
  assert.equal(Object.hasOwn(parsed.snapshot, 'user'), false)
  assert.equal(Object.hasOwn(parsed.snapshot, 'isLoggedIn'), false)
  assert.equal(Object.hasOwn(parsed.meta.fields, 'user'), false)
  assert.equal(Object.hasOwn(parsed.meta.fields, 'isLoggedIn'), false)
  assert.equal(Object.hasOwn(parsed.snapshot, 'sessions'), false)
  assert.equal(Object.hasOwn(parsed.snapshot, 'pendingLegacySessions'), false)
  assert.equal(Object.hasOwn(parsed.meta.fields, 'pendingLegacySessions'), false)
  assert.deepEqual(parsed.snapshot.toolsConfig, { fetch_url: false })
  assert.equal(Object.hasOwn(completeSnapshot(parsed.snapshot), 'sessions'), false)
})

test('browser snapshot A or B cannot replace the authoritative server sessions', () => {
  const state = {
    ...createInitialState(),
    sessions: [{ id: 'server', serverRevision: 9, messages: [{ content: 'authoritative' }] }],
  }
  const fromBrowserA = reduceSyncState(state, {
    type: 'MERGE_EXTERNAL_STATE',
    payload: {
      sessions: [{ id: 'browser-a' }],
      pendingLegacySessions: [{ id: 'browser-a-private' }],
      theme: 'dark',
    },
  })
  const fromBrowserB = reduceSyncState(fromBrowserA, {
    type: 'MERGE_EXTERNAL_STATE',
    payload: { sessions: [{ id: 'browser-b' }], density: 'compact' },
  })

  assert.strictEqual(fromBrowserA.sessions, state.sessions)
  assert.strictEqual(fromBrowserB.sessions, state.sessions)
  assert.strictEqual(fromBrowserA.pendingLegacySessions, state.pendingLegacySessions)
  assert.equal(fromBrowserA.theme, 'dark')
  assert.equal(fromBrowserB.density, 'compact')
})

test('local hydration restores the migration queue but shared sync payloads never expose it', () => {
  const pendingLegacySessions = [{
    id: 'local-only',
    messages: [{ id: 'private-message', content: 'private legacy history' }],
  }]
  const hydrated = reduceSyncState(createInitialState(), {
    type: 'HYDRATE_LOCAL_PERSISTED_STATE',
    payload: { pendingLegacySessions, theme: 'dark' },
  })
  assert.deepEqual(hydrated.pendingLegacySessions, pendingLegacySessions)

  const shared = selectSharedStateSyncPayload('updated', {
    pendingLegacySessions,
    theme: 'dark',
    __sync: {
      fields: { pendingLegacySessions: 10, theme: 10 },
      entities: { pendingLegacySessions: { 'local-only': 10 } },
    },
  })
  assert.equal(Object.hasOwn(shared, 'pendingLegacySessions'), false)
  assert.equal(Object.hasOwn(shared.__sync.fields, 'pendingLegacySessions'), false)
  assert.equal(Object.hasOwn(shared.__sync.entities, 'pendingLegacySessions'), false)
  assert.equal(shared.theme, 'dark')
})

test('cross-tab clear resets the local migration queue without widening shared-state sync', () => {
  const pendingLegacySessions = [{
    id: 'private-legacy-history',
    messages: [{ id: 'private-message', content: 'must stay local until cleared' }],
  }]
  const state = {
    ...createInitialState(),
    pendingLegacySessions,
    theme: 'dark',
  }
  const { persistedSnapshot, localState } = createCrossTabClearReset()

  assert.equal(Object.hasOwn(persistedSnapshot, 'pendingLegacySessions'), false)
  assert.deepEqual(localState.pendingLegacySessions, [])

  const sharedMerge = reduceSyncState(state, {
    type: 'MERGE_EXTERNAL_STATE',
    payload: localState,
  })
  assert.strictEqual(sharedMerge.pendingLegacySessions, pendingLegacySessions)

  const cleared = reduceSyncState(state, {
    type: 'HYDRATE_LOCAL_PERSISTED_STATE',
    payload: localState,
  })
  assert.deepEqual(cleared.pendingLegacySessions, [])
  assert.equal(cleared.theme, 'white')
})

test('IndexedDB and legacy localStorage migration queues are unioned instead of using field LWW', () => {
  const indexedDb = {
    pendingLegacySessions: [{
      id: 'indexed-db-history',
      messages: [{ id: 'indexed-db-message', role: 'user', content: 'history A' }],
    }],
  }
  const localStorage = {
    pendingLegacySessions: [{
      id: 'local-storage-history',
      messages: [{ id: 'local-storage-message', role: 'user', content: 'history B' }],
    }],
  }

  const merged = mergePersistedSnapshots(
    indexedDb,
    { writtenAt: 100, fields: {} },
    localStorage,
    { writtenAt: 200, fields: {} },
  )

  assert.deepEqual(
    new Set(merged.snapshot.pendingLegacySessions.map((session) => session.id)),
    new Set(['indexed-db-history', 'local-storage-history']),
  )
  assert.match(JSON.stringify(merged.snapshot.pendingLegacySessions), /history A/)
  assert.match(JSON.stringify(merged.snapshot.pendingLegacySessions), /history B/)
})

test('same-id legacy migration conflicts preserve both transcripts with import-safe message ids', () => {
  const indexedDb = {
    pendingLegacySessions: [{
      id: 'same-session',
      title: 'IndexedDB copy',
      messages: [
        { id: 'shared-message', role: 'user', content: 'IndexedDB body' },
        { id: 'indexed-db-tail', role: 'assistant', content: 'history A' },
      ],
    }],
  }
  const localStorage = {
    pendingLegacySessions: [{
      id: 'same-session',
      title: 'Newer localStorage copy',
      messages: [
        { id: 'shared-message', role: 'user', content: 'localStorage body' },
        { id: 'local-storage-tail', role: 'assistant', content: 'history B' },
      ],
    }],
  }
  const indexedDbMeta = { writtenAt: 100, fields: {} }
  const localStorageMeta = { writtenAt: 200, fields: {} }

  const merged = mergePersistedSnapshots(
    indexedDb,
    indexedDbMeta,
    localStorage,
    localStorageMeta,
  )
  const [session] = merged.snapshot.pendingLegacySessions
  const messageIds = session.messages.map((message) => message.id)
  assert.equal(merged.snapshot.pendingLegacySessions.length, 1)
  assert.equal(session.title, 'Newer localStorage copy')
  assert.equal(new Set(messageIds).size, messageIds.length)
  assert.match(JSON.stringify(session.messages), /IndexedDB body/)
  assert.match(JSON.stringify(session.messages), /localStorage body/)
  assert.match(JSON.stringify(session.messages), /history A/)
  assert.match(JSON.stringify(session.messages), /history B/)

  const repeated = mergePersistedSnapshots(
    merged.snapshot,
    merged.meta,
    localStorage,
    localStorageMeta,
  )
  assert.equal(repeated.snapshot.pendingLegacySessions[0].messages.length, 4)
  assert.deepEqual(indexedDb.pendingLegacySessions[0].messages.map(({ id }) => id), [
    'shared-message',
    'indexed-db-tail',
  ])
})

test('cross-tab normalization migrates legacy execution defaults without overriding newer explicit disables', () => {
  const migratedRemote = completeSnapshot({ toolsConfig: { bash_exec: false, run_project_check: false } })
  assert.equal(migratedRemote.toolsConfig.bash_exec, true)
  assert.equal(migratedRemote.toolsConfig.run_project_check, true)
  assert.equal(migratedRemote.toolsConfigSchemaVersion, TOOLS_CONFIG_SCHEMA_VERSION)

  const explicitLocal = completeSnapshot({
    toolsConfigSchemaVersion: TOOLS_CONFIG_SCHEMA_VERSION,
    toolsConfig: { bash_exec: false, run_project_check: false },
  })
  const remoteMeta = buildSyncMetadata(migratedRemote, {}, {}, { source: 'legacy-tab', now: 10 })
  const localMeta = buildSyncMetadata(explicitLocal, {}, {}, { source: 'current-tab', now: 20 })
  const merged = mergePersistedSnapshots(explicitLocal, localMeta, migratedRemote, remoteMeta)

  assert.equal(merged.snapshot.toolsConfig.bash_exec, false)
  assert.equal(merged.snapshot.toolsConfig.run_project_check, false)
  assert.equal(merged.snapshot.toolsConfigSchemaVersion, TOOLS_CONFIG_SCHEMA_VERSION)
})
