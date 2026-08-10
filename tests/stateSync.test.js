import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TOOLS_CONFIG_SCHEMA_VERSION,
  completeSnapshot,
} from '../src/store/appStateBootstrap.js'
import {
  buildSyncMetadata,
  markConvergedMetadata,
  mergePersistedSnapshots,
  persistedSnapshotsEqual,
} from '../src/store/stateSync.js'

function session(id, content, updatedAt) {
  return { id, title: id, updatedAt, messages: [{ id: `${id}-m`, role: 'user', content }] }
}

test('state sync merges concurrent session additions instead of replacing the whole snapshot', () => {
  const base = { sessions: [session('base', 'base', 1)], theme: 'system' }
  const baseMeta = buildSyncMetadata(base, {}, {}, { source: 'base', now: 1 })
  const left = { ...base, sessions: [...base.sessions, session('left', 'L', 2)] }
  const right = { ...base, sessions: [...base.sessions, session('right', 'R', 3)] }
  const leftMeta = buildSyncMetadata(left, base, baseMeta, { source: 'left', now: 2 })
  const rightMeta = buildSyncMetadata(right, base, baseMeta, { source: 'right', now: 3 })

  const merged = mergePersistedSnapshots(left, leftMeta, right, rightMeta)
  assert.deepEqual(new Set(merged.snapshot.sessions.map((item) => item.id)), new Set(['base', 'left', 'right']))
})

test('state sync keeps the newest entity edit and does not resurrect a deleted session', () => {
  const base = { sessions: [session('s1', 'old', 1), session('s2', 'remove me', 1)] }
  const baseMeta = buildSyncMetadata(base, {}, {}, { source: 'base', now: 10 })
  const edited = { sessions: [session('s1', 'new', 20), session('s2', 'remove me', 1)] }
  const deleted = { sessions: [session('s1', 'old', 1)] }
  const editedMeta = buildSyncMetadata(edited, base, baseMeta, { source: 'edit', now: 20 })
  const deletedMeta = buildSyncMetadata(deleted, base, baseMeta, { source: 'delete', now: 30 })

  const merged = mergePersistedSnapshots(edited, editedMeta, deleted, deletedMeta)
  assert.equal(merged.snapshot.sessions.find((item) => item.id === 's1').messages[0].content, 'new')
  assert.equal(merged.snapshot.sessions.some((item) => item.id === 's2'), false)
})

test('state sync preserves tab-local selection and converges after one union write', () => {
  const left = { activeSessionId: 'left', sessions: [session('left', 'L', 1)] }
  const right = { activeSessionId: 'right', sessions: [session('right', 'R', 2)] }
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
