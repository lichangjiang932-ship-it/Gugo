import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'gugo-session-branches-tests', String(process.pid))

const { getDb } = await import('../server/db.js')
const { migrateToV59 } = await import('../server/migrations/v59SessionBranches.js')
const { handleSessionRequest } = await import('../server/routes/sessionRoutes.js')
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
test.after(cleanDb)

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
    createdAt: 500,
    updatedAt: 500,
    lastViewedAt: null,
    archivedAt: null,
    pinnedAt: null,
    parentSessionId: 'branch-source',
    branchLabel: 'Alternative',
    forkedAt: 500,
    revision: 2,
  })
  const copied = listMessages({ userId: owner.userId, sessionId: 'branch-copy' })
  assert.deepEqual(copied.map(({ id }) => id), ['branch-user-copy', 'branch-assistant-copy'])
  assert.deepEqual(copied.map(({ content }) => content), ['try another route', 'persisted answer'])
  assert.equal(copied[1].modelContext.turnId, 'turn-source')
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
  let active = false
  const engine = { hasActiveSession: () => active }

  await withRouteServer(engine, async (baseUrl) => {
    const ownerHeaders = {
      Authorization: `Bearer ${owner.token}`,
      'Content-Type': 'application/json',
    }
    const otherHeaders = { Authorization: `Bearer ${other.token}` }
    const forked = await fetch(`${baseUrl}/api/sessions/route-branch-source/fork`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ label: 'Route alternative' }),
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
})
