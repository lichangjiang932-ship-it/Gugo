import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'gugo-session-branches-tests', String(process.pid))

const { getDb } = await import('../server/db.js')
const { migrateToV59 } = await import('../server/migrations/v59SessionBranches.js')
const { handleSessionRequest } = await import('../server/routes/sessionRoutes.js')
const { SQLITE_TURN_PERSISTENCE_ADAPTER } = await import(
  '../server/adapters/sqliteTurnPersistenceAdapter.js'
)
const { createTurnPersistenceAdapterController } = await import(
  '../server/core/turnPersistenceAdapter.js'
)
const {
  deleteSession,
  forkSession,
  getSession,
  getSessionBranches,
  listMessages,
  SessionBranchDepthError,
  upsertMessage,
  upsertSession,
} = await import('../server/services/sessionStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { activateTestCompactionArchivePort } = await import('./helpers/testCompactionArchivePort.js')

const compactionArchiveController = activateTestCompactionArchivePort({ env: process.env })

migrateToV59(getDb())

function cleanDb() {
  const db = getDb()
  db.prepare('DELETE FROM messages').run()
  db.prepare('DELETE FROM sessions').run()
  db.prepare('DELETE FROM login_codes').run()
  db.prepare('DELETE FROM users').run()
  db.prepare('DELETE FROM rate_limits').run()
}

async function withRouteServer(engine, fn) {
  const server = createServer((req, res) => handleSessionRequest(req, res, engine))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test.beforeEach(cleanDb)
test.after(() => {
  compactionArchiveController.release()
  cleanDb()
})

test('v59 adds nullable lineage metadata and clears a deleted parent reference', () => {
  const db = getDb()
  migrateToV59(db)
  const columns = db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name)
  assert.ok(columns.includes('parent_session_id'))
  assert.ok(columns.includes('branch_label'))
  assert.ok(columns.includes('forked_at'))
  assert.ok(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_user_parent'",
  ).get())
  const parentForeignKey = db.prepare('PRAGMA foreign_key_list(sessions)').all()
    .find((row) => row.from === 'parent_session_id')
  assert.equal(parentForeignKey?.on_delete, 'SET NULL')
})

test('forkSession copies only persisted transcript with fresh message ids and safe terminal context', () => {
  const owner = issueTestSession({ email: `branch-owner-${process.pid}@example.com` })
  const other = issueTestSession({ email: `branch-other-${process.pid}@example.com` })
  upsertSession({ id: 'branch-source', userId: owner.userId, title: 'Source', createdAt: 10, updatedAt: 20 })
  getDb().prepare(`
    UPDATE sessions SET pinned_at = 30, archived_at = 40
    WHERE user_id = ? AND token = ?
  `).run(owner.userId, 'branch-source')
  upsertMessage({
    id: 'source-user',
    userId: owner.userId,
    sessionId: 'branch-source',
    role: 'user',
    content: 'try another route',
    modelContext: { version: 1, turnId: 'turn-source', modelContent: 'try another route' },
    createdAt: 100,
    updatedAt: 100,
  })
  upsertMessage({
    id: 'source-assistant',
    userId: owner.userId,
    sessionId: 'branch-source',
    role: 'assistant',
    content: 'persisted answer',
    modelContext: {
      version: 1,
      turnId: 'turn-source',
      paused: true,
      clarification: { kind: 'directory' },
      pausedSequence: 8,
      serverConnectionState: 'paused',
      toolTrace: [{ role: 'assistant', content: 'kept trace' }],
    },
    createdAt: 200,
    updatedAt: 200,
  })
  getDb().prepare(`
    INSERT INTO turn_checkpoints
      (user_id, session_id, turn_id, event_sequence, state_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(owner.userId, 'branch-source', 'turn-source', 8, '{"messages":[]}', 200, 200)

  const ids = ['branch-copy', 'branch-user-copy', 'branch-assistant-copy']
  const result = forkSession({
    userId: owner.userId,
    sessionId: 'branch-source',
    label: 'Alternative',
    now: 500,
    idFactory: () => ids.shift(),
  })

  assert.equal(result.totalMessages, 2)
  assert.deepEqual(result.session, {
    id: 'branch-copy',
    title: 'Source',
    workspacePath: null,
    createdAt: 500,
    updatedAt: 500,
    lastViewedAt: null,
    archivedAt: null,
    pinnedAt: null,
    parentSessionId: 'branch-source',
    branchLabel: 'Alternative',
    forkedAt: 500,
    revision: 2,
    turnEventRevision: 0,
  })
  const copied = listMessages({ userId: owner.userId, sessionId: 'branch-copy' })
  assert.deepEqual(copied.map(({ id }) => id), ['branch-user-copy', 'branch-assistant-copy'])
  assert.deepEqual(copied.map(({ content }) => content), ['try another route', 'persisted answer'])
  assert.equal(copied[1].modelContext.turnId, undefined)
  assert.equal(copied[1].modelContext.forkSource.turnId, 'turn-source')
  assert.equal(copied[1].modelContext.forkSource.sessionId, 'branch-source')
  assert.deepEqual(copied[1].modelContext.toolTrace, [{ role: 'assistant', content: 'kept trace' }])
  for (const key of ['paused', 'clarification', 'pausedSequence', 'serverConnectionState']) {
    assert.equal(Object.hasOwn(copied[1].modelContext, key), false)
  }
  assert.equal(getDb().prepare(
    'SELECT COUNT(*) AS count FROM turn_checkpoints WHERE user_id = ? AND session_id = ?',
  ).get(owner.userId, 'branch-copy').count, 0)

  upsertMessage({
    id: 'branch-only-message',
    userId: owner.userId,
    sessionId: 'branch-copy',
    role: 'user',
    content: 'independent edit',
  })
  assert.equal(listMessages({ userId: owner.userId, sessionId: 'branch-source' }).length, 2)
  assert.equal(listMessages({ userId: owner.userId, sessionId: 'branch-copy' }).length, 3)
  assert.equal(getSession({ userId: other.userId, sessionId: 'branch-copy' }), null)
})

test('forkSession can branch through an owned user or assistant message without copying the abandoned suffix', () => {
  const owner = issueTestSession({ email: `branch-node-owner-${process.pid}@example.com` })
  upsertSession({ id: 'branch-node-source', userId: owner.userId, title: 'Node source' })
  for (const [id, role, content, createdAt] of [
    ['node-user-1', 'user', 'first prompt', 10],
    ['node-assistant-1', 'assistant', 'first answer', 20],
    ['node-user-2', 'user', 'second prompt', 30],
    ['node-assistant-2', 'assistant', 'abandoned answer', 40],
  ]) {
    upsertMessage({ id, userId: owner.userId, sessionId: 'branch-node-source', role, content, createdAt })
  }
  const ids = ['branch-node-copy', 'copy-user-1', 'copy-assistant-1', 'copy-user-2']
  const result = forkSession({
    userId: owner.userId,
    sessionId: 'branch-node-source',
    throughMessageId: 'node-user-2',
    label: 'Retry second prompt',
    idFactory: () => ids.shift(),
  })
  assert.equal(result.totalMessages, 3)
  assert.deepEqual(
    listMessages({ userId: owner.userId, sessionId: result.session.id }).map(({ role, content }) => [role, content]),
    [['user', 'first prompt'], ['assistant', 'first answer'], ['user', 'second prompt']],
  )
  const assistantIds = ['branch-assistant-copy', 'copy-user-before-assistant', 'copy-assistant-boundary']
  const assistantResult = forkSession({
    userId: owner.userId,
    sessionId: 'branch-node-source',
    throughMessageId: 'node-assistant-1',
    label: 'Continue after first answer',
    idFactory: () => assistantIds.shift(),
  })
  assert.equal(assistantResult.totalMessages, 2)
  assert.deepEqual(
    listMessages({ userId: owner.userId, sessionId: assistantResult.session.id })
      .map(({ role, content }) => [role, content]),
    [['user', 'first prompt'], ['assistant', 'first answer']],
  )
  const branchSummaries = getSessionBranches({
    userId: owner.userId,
    sessionId: assistantResult.session.id,
  }).branches.map(({ branchLabel, branchSummary, branchTipRole, messageCount }) => ({
    branchLabel, branchSummary, branchTipRole, messageCount,
  }))
  assert.deepEqual(branchSummaries, [
    { branchLabel: null, branchSummary: 'abandoned answer', branchTipRole: 'assistant', messageCount: 4 },
    { branchLabel: 'Retry second prompt', branchSummary: 'second prompt', branchTipRole: 'user', messageCount: 3 },
    { branchLabel: 'Continue after first answer', branchSummary: 'first answer', branchTipRole: 'assistant', messageCount: 2 },
  ])

  assert.throws(
    () => forkSession({
      userId: owner.userId,
      sessionId: 'branch-node-source',
      throughMessageId: 'missing-message',
      idFactory: () => 'invalid-missing-message',
    }),
    (error) => error?.code === 'INVALID_SESSION_MUTATION'
      && /user or assistant message in the source Session/.test(error.message),
  )
  assert.equal(getSession({ userId: owner.userId, sessionId: 'invalid-missing-message' }), null)
})

test('branch file-operation summaries use successful durable evidence and exclude copied history', () => {
  const owner = issueTestSession({ email: `branch-files-owner-${process.pid}@example.com` })
  upsertSession({ id: 'branch-files-root', userId: owner.userId, title: 'File evidence' })
  upsertMessage({
    id: 'branch-files-root-answer',
    userId: owner.userId,
    sessionId: 'branch-files-root',
    role: 'assistant',
    content: 'root operation',
    modelContext: {
      toolTrace: [
        { role: 'assistant', tool_calls: [{
          id: 'root-write', type: 'function',
          function: { name: 'write_file', arguments: '{"path":"workspace/root.txt"}' },
        }] },
        { role: 'tool', tool_call_id: 'root-write', name: 'write_file', content: JSON.stringify({
          ok: true,
          changedPaths: ['workspace/root.txt'],
          verifiedOutputs: [{ path: 'workspace/root.txt', status: 'modified', type: 'file' }],
        }) },
      ],
    },
  })
  const ids = ['branch-files-child', 'branch-files-copied-answer']
  forkSession({
    userId: owner.userId,
    sessionId: 'branch-files-root',
    label: 'Different implementation',
    idFactory: () => ids.shift(),
  })
  upsertMessage({
    id: 'branch-files-child-answer',
    userId: owner.userId,
    sessionId: 'branch-files-child',
    role: 'assistant',
    content: 'child operation; prose says workspace/fake.txt changed',
    modelContext: {
      toolTrace: [
        { role: 'assistant', tool_calls: [
          { id: 'child-download', type: 'function', function: { name: 'browser_download', arguments: '{}' } },
          { id: 'root-write', type: 'function', function: { name: 'write_file', arguments: '{}' } },
          { id: 'failed-write', type: 'function', function: { name: 'write_file', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'child-download', name: 'browser_download', content: JSON.stringify({
          ok: true,
          changedPaths: ['workspace/child.txt'],
          verifiedOutputs: [{ path: 'workspace/child.txt', status: 'created', type: 'file' }],
        }) },
        { role: 'tool', tool_call_id: 'root-write', name: 'write_file', content: JSON.stringify({
          ok: true,
          changedPaths: ['workspace/root.txt'],
          verifiedOutputs: [{ path: 'workspace/root.txt', status: 'modified', type: 'file' }],
        }) },
        { role: 'tool', tool_call_id: 'failed-write', name: 'write_file', content: JSON.stringify({
          ok: false,
          changedPaths: ['workspace/failed.txt'],
        }) },
      ],
    },
  })

  const branches = getSessionBranches({
    userId: owner.userId,
    sessionId: 'branch-files-child',
  }).branches
  assert.deepEqual(branches.map((branch) => ({
    id: branch.id,
    fileOperations: branch.fileOperations,
    fileOperationsTruncated: branch.fileOperationsTruncated,
  })), [
    {
      id: 'branch-files-root',
      fileOperations: [{ path: 'workspace/root.txt', action: 'modified', toolName: 'write_file' }],
      fileOperationsTruncated: false,
    },
    {
      id: 'branch-files-child',
      fileOperations: [
        { path: 'workspace/child.txt', action: 'created', toolName: 'browser_download' },
        { path: 'workspace/root.txt', action: 'modified', toolName: 'write_file' },
      ],
      fileOperationsTruncated: false,
    },
  ])

  const nestedIds = [
    'branch-files-grandchild',
    'branch-files-grandchild-root-copy',
    'branch-files-grandchild-child-copy',
  ]
  forkSession({
    userId: owner.userId,
    sessionId: 'branch-files-child',
    label: 'Nested alternative',
    idFactory: () => nestedIds.shift(),
  })
  const grandchild = getSessionBranches({
    userId: owner.userId,
    sessionId: 'branch-files-grandchild',
  }).branches.find((branch) => branch.id === 'branch-files-grandchild')
  assert.deepEqual(grandchild.fileOperations, [])
  assert.equal(grandchild.fileOperationsTruncated, false)
})

test('branch lineage enforces depth five, stays user scoped, and survives parent deletion', () => {
  const owner = issueTestSession({ email: `depth-owner-${process.pid}@example.com` })
  const other = issueTestSession({ email: `depth-other-${process.pid}@example.com` })
  upsertSession({ id: 'depth-root', userId: owner.userId, title: 'Root', createdAt: 1, updatedAt: 1 })

  let parentId = 'depth-root'
  for (let depth = 1; depth <= 5; depth += 1) {
    const nextId = `depth-${depth}`
    const result = forkSession({
      userId: owner.userId,
      sessionId: parentId,
      label: `Depth ${depth}`,
      now: depth + 1,
      idFactory: () => nextId,
    })
    assert.equal(result.session.parentSessionId, parentId)
    parentId = nextId
  }
  assert.throws(
    () => forkSession({
      userId: owner.userId,
      sessionId: parentId,
      label: 'Too deep',
      idFactory: () => 'depth-6',
    }),
    (error) => error instanceof SessionBranchDepthError && error.code === 'SESSION_BRANCH_DEPTH_LIMIT',
  )

  const tree = getSessionBranches({ userId: owner.userId, sessionId: 'depth-3' })
  assert.equal(tree.rootSessionId, 'depth-root')
  assert.deepEqual(tree.branches.map(({ id, depth }) => [id, depth]), [
    ['depth-root', 0],
    ['depth-1', 1],
    ['depth-2', 2],
    ['depth-3', 3],
    ['depth-4', 4],
    ['depth-5', 5],
  ])
  assert.equal(tree.truncated, false)
  assert.equal(getSessionBranches({ userId: other.userId, sessionId: 'depth-3' }), null)

  const root = getSession({ userId: owner.userId, sessionId: 'depth-root' })
  assert.deepEqual(deleteSession({
    userId: owner.userId,
    sessionId: 'depth-root',
    expectedRevision: root.revision,
  }), { deleted: true, previousRevision: root.revision })
  assert.equal(getSession({ userId: owner.userId, sessionId: 'depth-1' }).parentSessionId, null)
})

test('fork and branch routes isolate users and reject an active source with 409', async () => {
  const owner = issueTestSession({ email: `route-branch-owner-${process.pid}@example.com` })
  const other = issueTestSession({ email: `route-branch-other-${process.pid}@example.com` })
  upsertSession({ id: 'route-branch-source', userId: owner.userId, title: 'Route source' })
  upsertMessage({
    id: 'route-source-message',
    userId: owner.userId,
    sessionId: 'route-branch-source',
    role: 'user',
    content: 'persist me',
  })
  upsertMessage({
    id: 'route-source-answer',
    userId: owner.userId,
    sessionId: 'route-branch-source',
    role: 'assistant',
    content: 'do not copy this suffix',
  })
  let active = false
  const engine = { hasActiveSession: () => active }
  const persistence = createTurnPersistenceAdapterController(SQLITE_TURN_PERSISTENCE_ADAPTER, {
    source: 'test.session-branches',
  })
  persistence.activate()

  try {
    await withRouteServer(engine, async (baseUrl) => {
      const ownerHeaders = {
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/json',
      }
      const otherHeaders = { Authorization: `Bearer ${other.token}` }
      const forked = await fetch(`${baseUrl}/api/sessions/route-branch-source/fork`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          label: 'Route alternative',
          throughMessageId: 'route-source-message',
        }),
      })
      assert.equal(forked.status, 201)
      const forkedBody = await forked.json()
      assert.equal(forkedBody.ok, true)
      assert.equal(forkedBody.session.parentSessionId, 'route-branch-source')
      assert.equal(forkedBody.totalMessages, 1)

      const branches = await fetch(`${baseUrl}/api/sessions/route-branch-source/branches`, {
        headers: ownerHeaders,
      })
      assert.equal(branches.status, 200)
      assert.equal((await branches.json()).branches.length, 2)

      const hidden = await fetch(`${baseUrl}/api/sessions/route-branch-source/branches`, {
        headers: otherHeaders,
      })
      assert.equal(hidden.status, 404)

      active = true
      const blocked = await fetch(`${baseUrl}/api/sessions/route-branch-source/fork`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ label: 'Blocked' }),
      })
      assert.equal(blocked.status, 409)
      assert.deepEqual((await blocked.json()).error, {
        code: 'SESSION_ACTIVE',
        message: 'session has an active turn',
      })

      const unauthorized = await fetch(`${baseUrl}/api/sessions/route-branch-source/branches`)
      assert.equal(unauthorized.status, 401)
    })
  } finally {
    persistence.release()
  }
})
