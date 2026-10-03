import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-transcript-fences-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')

const { closeDb, createUser, getDb } = await import('../server/db.js')
const {
  claimLocalChatSession,
  deleteMessage,
  getSession,
  getSessionSnapshot,
  listMessages,
  replaceSessionMessages,
  upsertMessage,
  upsertSession,
} = await import('../server/services/sessionStore.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { normalizeServerSessionSnapshot } = await import('../src/lib/turnClient/sessionSnapshot.js')
const { fetchServerSessionSnapshot } = await import('../src/lib/turnClient/sessionSnapshot.js')
const { handleSessionRequest } = await import('../server/routes/sessionRoutes.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { createTurnPersistenceAdapterController } = await import('../server/core/turnPersistenceAdapter.js')
const { SQLITE_TURN_PERSISTENCE_ADAPTER } = await import('../server/adapters/sqliteTurnPersistenceAdapter.js')
const { normalizeSessionMessagesForServer } = await import('../src/lib/sessionClient.js')
const { migrateToV116 } = await import('../server/migrations/v116SessionTranscriptRecoveryFences.js')
const { fenceSessionTranscriptRecovery } = await import('../server/services/sessionTranscriptRecoveryFenceStore.js')
const { collectSessionTranscriptRecoverySchemaProblems } = await import(
  '../server/sessionTranscriptRecoverySchemaContract.js'
)

test.after(() => {
  closeDb()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

let fixtureSequence = 0
function fixture(label) {
  fixtureSequence += 1
  const userId = `fence-user-${fixtureSequence}`
  const sessionId = `fence-session-${fixtureSequence}`
  createUser({ id: userId, email: `${userId}@example.test`, now: 1_000 })
  upsertSession({ id: sessionId, userId, title: label, createdAt: 1_000, updatedAt: 1_000 })
  return { userId, sessionId }
}

function event(scope, turnId, type, sequence, payload, createdAt = 2_000 + sequence) {
  return appendTurnEvent({
    userId: scope.userId,
    event: createTurnEvent({
      id: `${scope.sessionId}:${turnId}:${sequence}`,
      sessionId: scope.sessionId,
      turnId,
      type,
      sequence,
      payload,
      createdAt,
    }),
  })
}

function completedTurn(scope, suffix, { persisted = true, canonicalId = true, createdAt = 2_000 } = {}) {
  const turnId = `${scope.sessionId}:turn-${suffix}`
  const userMessage = upsertMessage({
    ...scope,
    id: `${turnId}:user`,
    role: 'user',
    content: `request ${suffix}`,
    modelContext: { version: 1, turnId },
    createdAt,
  })
  event(scope, turnId, 'turn.started', 0, {}, createdAt)
  event(scope, turnId, 'turn.completed', 1, { text: `answer ${suffix}`, iterations: 1 }, createdAt + 1)
  const assistant = persisted ? upsertMessage({
    ...scope,
    id: canonicalId ? `${turnId}:assistant` : `imported-answer-${suffix}-${scope.sessionId}`,
    role: 'assistant',
    content: `answer ${suffix}`,
    modelContext: { version: 1, turnId, turnEvidence: true, evidenceState: 'completed' },
    createdAt: createdAt + 1,
  }) : null
  return { turnId, userMessage, assistant }
}

function replace(scope, messages) {
  return replaceSessionMessages({
    ...scope,
    expectedRevision: getSession(scope).revision,
    messages,
    // The fence is causal, not based on wall-clock timestamps.
    now: 100,
  })
}

test('static recovery-fence SQL keeps empty, scoped, and all-turn selection distinct', () => {
  const scope = fixture('scope-selection')
  const first = completedTurn(scope, 'first')
  const second = completedTurn(scope, 'second')
  const db = getDb()
  const recordedTurns = () => db.prepare(`
    SELECT turn_id FROM session_transcript_recovery_fences
    WHERE user_id = ? AND session_id = ? ORDER BY turn_id
  `).all(scope.userId, scope.sessionId).map((row) => row.turn_id)
  db.transaction(() => fenceSessionTranscriptRecovery(db, { ...scope, turnIds: [] }))()
  assert.deepEqual(recordedTurns(), [])
  db.transaction(() => fenceSessionTranscriptRecovery(db, {
    ...scope, turnIds: [first.turnId, ` ${first.turnId} `, '', "unmatched') OR 1=1 --"],
  }))()
  assert.deepEqual(recordedTurns(), [first.turnId])
  db.transaction(() => fenceSessionTranscriptRecovery(db, scope))()
  assert.deepEqual(recordedTurns(), [first.turnId, second.turnId].sort())
})

test('explicit clear suppresses all old evidence without deleting terminal audit events', () => {
  const scope = fixture('clear')
  completedTurn(scope, 'first')
  completedTurn(scope, 'missing', { persisted: false })
  assert.equal(getSessionSnapshot(scope).totalMessages, 4)
  replace(scope, [])
  const snapshot = getSessionSnapshot(scope)
  assert.deepEqual(snapshot.messages, [])
  assert.equal(snapshot.totalMessages, 0)
  assert.equal(snapshot.complete, true)
  assert.equal(snapshot.nextOffset, null)
  assert.equal(normalizeServerSessionSnapshot(snapshot).messages.length, 0)
  assert.equal(getDb().prepare(
    'SELECT COUNT(*) AS count FROM turn_events WHERE user_id = ? AND session_id = ?',
  ).get(scope.userId, scope.sessionId).count, 4)
  closeDb()
  assert.deepEqual(getSessionSnapshot(scope).messages, [])
})

for (const canonicalId of [true, false]) {
  test(`replacement edits remain authoritative for ${canonicalId ? 'canonical' : 'imported'} assistant ids`, () => {
    const scope = fixture('edit')
    const { assistant } = completedTurn(scope, 'edit', { canonicalId })
    const edited = listMessages(scope).map((message) => ({
      ...message,
      content: message.role === 'assistant' ? 'user-edited answer' : message.content,
      updatedAt: 10,
    }))
    replace(scope, edited)
    assert.equal(getSessionSnapshot(scope).messages.find((row) => row.id === assistant.id)?.content,
      'user-edited answer')
    assert.equal(listMessages(scope).find((row) => row.id === assistant.id)?.content, 'user-edited answer')
  })
}

test('browser-style answer edits retain recovered terminal metadata and verified file receipts', () => {
  const scope = fixture('partial-ui-context')
  const { assistant, turnId } = completedTurn(scope, 'edited')
  const receipt = { id: 'edited-file-receipt', path: 'D:/output/result.txt', filename: 'result.txt', verifiedAt: 2_001 }
  upsertMessage({
    ...assistant,
    modelContext: {
      turnId, turnEvidence: true, evidenceState: 'failed',
      error: { code: 'TURN_FAILED', retryable: false },
      verifiedLocalFiles: [receipt],
    },
  })
  const browserSnapshot = normalizeServerSessionSnapshot(getSessionSnapshot(scope))
  const request = normalizeSessionMessagesForServer(browserSnapshot.messages
    .map((message) => message.role === 'assistant' ? { ...message, content: '' } : message))
  assert.equal(request[1].modelContext.verifiedLocalFiles, undefined)
  replace(scope, request)
  const edited = getSessionSnapshot(scope).messages.find((row) => row.id === assistant.id)
  assert.equal(edited.content, '')
  assert.equal(edited.modelContext.evidenceState, 'completed')
  assert.equal(edited.modelContext.error, undefined)
  assert.deepEqual(edited.modelContext.verifiedLocalFiles, [receipt])
})

test('single assistant delete suppresses only its own turn and no client recovery stub returns', () => {
  const scope = fixture('single-delete')
  const older = completedTurn(scope, 'older', { persisted: false, createdAt: 2_000 })
  const deleted = completedTurn(scope, 'deleted', { canonicalId: false, createdAt: 3_000 })
  assert.equal(deleteMessage({ userId: scope.userId, messageId: deleted.assistant.id }), true)
  const snapshot = getSessionSnapshot(scope)
  assert.deepEqual(snapshot.messages.map((row) => row.id), [
    older.userMessage.id, `${older.turnId}:assistant`, deleted.userMessage.id,
  ])
  assert.equal(snapshot.totalMessages, 3)
  const normalized = normalizeServerSessionSnapshot(snapshot)
  assert.equal(normalized.messages.some((row) => row.meta?.serverRecoveryStub), false)
  assert.equal(normalized.messages.some((row) => row.meta?.serverTurnId === deleted.turnId), false)
  assert.equal(deleteMessage({ userId: scope.userId, messageId: deleted.assistant.id }), false)
})

test('replacement truncation prevents a deleted answer from reappearing as a recovery stub', () => {
  const scope = fixture('truncate')
  const { userMessage } = completedTurn(scope, 'truncated')
  replace(scope, [userMessage])
  const snapshot = getSessionSnapshot(scope)
  assert.equal(snapshot.messages.length, 1)
  assert.equal(snapshot.messages[0].modelContext.turnRecoverySuppressed, true)
  assert.equal(normalizeServerSessionSnapshot(snapshot).messages.length, 1)
})

test('fences preserve real missing-evidence recovery and virtual pagination offsets', () => {
  const scope = fixture('paging')
  const deleted = completedTurn(scope, 'deleted', { createdAt: 2_000 })
  completedTurn(scope, 'recovered-one', { persisted: false, createdAt: 3_000 })
  completedTurn(scope, 'recovered-two', { persisted: false, createdAt: 4_000 })
  deleteMessage({ userId: scope.userId, messageId: deleted.assistant.id })
  const first = getSessionSnapshot({ ...scope, limit: 1, offset: 0 })
  const second = getSessionSnapshot({ ...scope, limit: 1, offset: first.nextOffset })
  const third = getSessionSnapshot({ ...scope, limit: 1, offset: second.nextOffset })
  assert.deepEqual([first.messages.length, second.messages.length, third.messages.length], [1, 2, 2])
  assert.deepEqual([first.nextOffset, second.nextOffset, third.nextOffset], [1, 2, null])
  assert.deepEqual([first.totalMessages, second.totalMessages, third.totalMessages], [5, 5, 5])
  assert.deepEqual([first.complete, second.complete, third.complete], [false, false, true])
  const combined = [...first.messages, ...second.messages, ...third.messages]
  assert.equal(new Set(combined.map((row) => row.id)).size, 5)
  assert.equal(normalizeServerSessionSnapshot({ ...third, messages: combined }).messages.length, 5)
  assert.equal(listMessages(scope).length, 3, 'recovery is a read projection, not a database mutation')
})

test('real HTTP snapshot pages pass the admin DTO and aggregate recovered rows without gaps or duplicates', async () => {
  const owner = issueTestSession({ email: `fence-http-${process.pid}@example.test` })
  const scope = { userId: owner.userId, sessionId: 'fence-http-session' }
  upsertSession({ id: scope.sessionId, userId: scope.userId, title: 'HTTP recovery' })
  const deleted = completedTurn(scope, 'deleted', { createdAt: 2_000 })
  completedTurn(scope, 'recovered-one', { persisted: false, createdAt: 3_000 })
  completedTurn(scope, 'recovered-two', { persisted: false, createdAt: 4_000 })
  deleteMessage({ userId: scope.userId, messageId: deleted.assistant.id })
  const persistence = createTurnPersistenceAdapterController(SQLITE_TURN_PERSISTENCE_ADAPTER, {
    source: 'test.transcript-recovery-pages',
  })
  persistence.activate()
  const server = createServer((req, res) => handleSessionRequest(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const requestedOffsets = []
    const snapshot = await fetchServerSessionSnapshot({
      sessionId: scope.sessionId,
      pageSize: 1,
      fetchImpl: (url, options) => {
        requestedOffsets.push(Number(new URL(url, baseUrl).searchParams.get('offset')))
        return fetch(`${baseUrl}${url}`, {
          ...options,
          headers: { ...options.headers, Authorization: `Bearer ${owner.token}` },
        })
      },
    })
    assert.deepEqual(requestedOffsets, [0, 1, 2])
    assert.equal(snapshot.messages.length, 5)
    assert.equal(snapshot.totalMessages, 5)
    assert.equal(snapshot.durableTotalMessages, 3)
    assert.equal(snapshot.durableMessageCount, 3)
    assert.equal(new Set(snapshot.messages.map((row) => row.id)).size, 5)
    assert.equal(snapshot.messages.some((row) => row.id === deleted.assistant.id), false)
    assert.equal(snapshot.messages.some((row) => row.meta?.serverRecoveryStub), false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    persistence.release()
  }
})

test('explicit replacement also fences a missing initial event and a new event re-enables recovery', () => {
  const scope = fixture('missing-start')
  const turnId = `${scope.sessionId}:turn-no-event`
  const userMessage = upsertMessage({
    ...scope, id: `${turnId}:user`, role: 'user', content: 'request',
    modelContext: { turnId }, createdAt: 2_000,
  })
  replace(scope, [userMessage])
  assert.equal(normalizeServerSessionSnapshot(getSessionSnapshot(scope)).messages.length, 1)
  event(scope, turnId, 'turn.started', 0, {})
  const recovered = normalizeServerSessionSnapshot(getSessionSnapshot(scope))
  assert.equal(recovered.messages.length, 2)
  assert.equal(recovered.messages[1].meta.serverRecoveryStub, true)
})

test('a genuinely newer recovery boundary re-enables projection despite a persisted old suppression flag', () => {
  const scope = fixture('new-boundary')
  const turnId = `${scope.sessionId}:resumable`
  const userMessage = upsertMessage({
    ...scope,
    id: `${turnId}:user`,
    role: 'user',
    content: 'finish this',
    modelContext: { turnId },
    createdAt: 2_000,
  })
  event(scope, turnId, 'turn.started', 0, {})
  event(scope, turnId, 'turn.interrupted', 1, { code: 'TURN_INTERRUPTED', retryable: true })
  replace(scope, [userMessage])
  const suppressed = getSessionSnapshot(scope)
  assert.equal(suppressed.messages.length, 1)
  replace(scope, suppressed.messages)
  event(scope, turnId, 'turn.completed', 2, { text: 'new recovered answer', iterations: 1 }, 50)
  const recovered = getSessionSnapshot(scope)
  assert.equal(recovered.messages.length, 2)
  assert.equal(recovered.messages[1].content, 'new recovered answer')
  assert.equal(recovered.messages[0].modelContext.turnRecoverySuppressed, undefined)
  assert.equal(recovered.messages[1].modelContext.serverLastSequence, 2)
  assert.equal(recovered.totalMessages, 2)
})

test('new turns after a cleared transcript retain normal missing-evidence recovery', () => {
  const scope = fixture('new-turn')
  completedTurn(scope, 'before')
  replace(scope, [])
  completedTurn(scope, 'after', { persisted: false, createdAt: 3_000 })
  const snapshot = getSessionSnapshot(scope)
  assert.deepEqual(snapshot.messages.map((row) => row.content), ['request after', 'answer after'])
  assert.equal(snapshot.totalMessages, 2)
})

test('failed CAS and failed outbox writes roll back transcript recovery fences', () => {
  const scope = fixture('atomic-fence')
  completedTurn(scope, 'atomic')
  assert.throws(() => replaceSessionMessages({
    ...scope, expectedRevision: getSession(scope).revision - 1, messages: [],
  }), (error) => error.code === 'SESSION_REVISION_CONFLICT')
  const db = getDb()
  db.exec(`
    CREATE TRIGGER reject_fence_outbox BEFORE INSERT ON session_content_outbox
    WHEN NEW.event_type = 'session.replace'
    BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END;
  `)
  try {
    assert.throws(() => replace(scope, []), /injected outbox failure/u)
  } finally {
    db.exec('DROP TRIGGER reject_fence_outbox')
  }
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM session_transcript_recovery_fences WHERE user_id = ? AND session_id = ?',
  ).get(scope.userId, scope.sessionId).count, 0)
  assert.equal(getSessionSnapshot(scope).messages.length, 2)
})

test('legacy owner transfer preserves fences and deletion cascades clean them up', () => {
  const scope = fixture('owner-transfer')
  completedTurn(scope, 'hidden')
  replace(scope, [])
  const nextOwner = `${scope.userId}:next`
  createUser({ id: nextOwner, email: `${nextOwner}@example.test`, now: 4_000 })
  getDb().prepare(`
    INSERT INTO meta (key, value) VALUES ('local_auth_owner_user_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(nextOwner)
  const moved = claimLocalChatSession({ userId: nextOwner, sessionId: scope.sessionId, authMode: 'local' })
  assert.equal(moved.id, scope.sessionId)
  assert.deepEqual(getSessionSnapshot({ userId: nextOwner, sessionId: scope.sessionId }).messages, [])
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(scope.sessionId)
  assert.equal(getDb().prepare(
    'SELECT COUNT(*) AS count FROM session_transcript_recovery_fences WHERE session_id = ?',
  ).get(scope.sessionId).count, 0)
})

test('v116 migration is additive, repeatable, constrained and refuses a malformed claimed table', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (token TEXT PRIMARY KEY);
    INSERT INTO users VALUES ('owner');
    INSERT INTO sessions VALUES ('session');
  `)
  try {
    migrateToV116(db)
    migrateToV116(db)
    assert.deepEqual(collectSessionTranscriptRecoverySchemaProblems(db), [])
    const insert = db.prepare('INSERT INTO session_transcript_recovery_fences VALUES (?, ?, ?, ?)')
    insert.run('owner', 'session', 'turn', 4)
    assert.throws(() => insert.run('owner', 'session', 'turn', 5), /UNIQUE/u)
    assert.throws(() => insert.run('owner', 'session', 'bad-sequence', -2), /CHECK/u)
    assert.throws(() => insert.run('missing-owner', 'session', 'other', 1), /FOREIGN KEY/u)
    db.prepare('DELETE FROM users WHERE id = ?').run('owner')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM session_transcript_recovery_fences').get().count, 0)
    db.exec('DROP TABLE session_transcript_recovery_fences')
    db.exec('CREATE TABLE session_transcript_recovery_fences (turn_id TEXT)')
    assert.throws(() => migrateToV116(db), (error) => error.code === 'DB_SCHEMA_INCOMPLETE')
  } finally {
    db.close()
  }
})
