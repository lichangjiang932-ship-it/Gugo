import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-session-sync-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, getDb } = await import('../server/db.js')
const { handleSessionRequest } = await import('../server/routes/sessionRoutes.js')
const {
  deleteSession,
  getSession,
  getSessionSnapshot,
  listMessages,
  replaceSessionMessages,
  SessionRevisionConflictError,
  upsertMessage,
  upsertSession,
} = await import('../server/services/sessionStore.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function makeRequest({ method = 'GET', url, token, body = null }) {
  const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = token ? { authorization: `Bearer ${token}` } : {}
  if (body !== null) req.headers['content-type'] = 'application/json'
  return req
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode
      this.headers = headers
    },
    end(chunk = '') {
      if (chunk) this.chunks.push(Buffer.from(String(chunk)))
    },
    json() {
      return JSON.parse(Buffer.concat(this.chunks).toString('utf8'))
    },
  }
}

async function invokeRoute(options, engine = { hasActiveSession: () => false }) {
  const res = makeResponse()
  await handleSessionRequest(makeRequest(options), res, engine)
  return res
}

test('session snapshots paginate complete histories without changing revision', { concurrency: false }, async () => {
  const { token, userId } = issueTestSession({ email: 'session-pages@example.com' })
  const sessionId = 'session-pages'
  upsertSession({ id: sessionId, userId, title: 'Paged history', createdAt: 1, updatedAt: 1 })
  const db = getDb()
  const insert = db.prepare(`
    INSERT INTO messages
      (id, session_id, user_id, role, content, session_title, model_context_json, created_at, updated_at)
    VALUES (?, ?, ?, 'user', ?, 'Paged history', '{}', ?, ?)
  `)
  db.transaction(() => {
    for (let index = 0; index < 2005; index += 1) {
      insert.run(`page-message-${index}`, sessionId, userId, `message ${index}`, index + 1, index + 1)
    }
  })()

  const first = await invokeRoute({
    url: `/api/sessions/${sessionId}/snapshot?limit=2000&offset=0`,
    token,
  })
  assert.equal(first.statusCode, 200)
  const firstSnapshot = first.json().snapshot
  assert.equal(firstSnapshot.messages.length, 2000)
  assert.equal(firstSnapshot.totalMessages, 2005)
  assert.equal(firstSnapshot.complete, false)
  assert.equal(firstSnapshot.nextOffset, 2000)

  const second = await invokeRoute({
    url: `/api/sessions/${sessionId}/snapshot?limit=2000&offset=${firstSnapshot.nextOffset}`,
    token,
  })
  assert.equal(second.statusCode, 200)
  const secondSnapshot = second.json().snapshot
  assert.equal(secondSnapshot.messages.length, 5)
  assert.equal(secondSnapshot.messages[0].id, 'page-message-2000')
  assert.equal(secondSnapshot.complete, true)
  assert.equal(secondSnapshot.nextOffset, null)
  assert.equal(secondSnapshot.revision, firstSnapshot.revision)
})

test('CAS replacement preserves stored model context and rejects a stale revision', { concurrency: false }, () => {
  const { userId } = issueTestSession({ email: 'session-cas@example.com' })
  const sessionId = 'session-cas'
  upsertSession({ id: sessionId, userId, title: 'CAS history', createdAt: 1, updatedAt: 1 })
  upsertMessage({
    id: 'cas-assistant',
    userId,
    sessionId,
    role: 'assistant',
    content: 'old',
    modelContext: {
      version: 1,
      toolTrace: [{ role: 'tool', tool_call_id: 'call-1', name: 'grep', content: 'result' }],
    },
    createdAt: 2,
    updatedAt: 2,
  })
  const before = getSessionSnapshot({ userId, sessionId })
  const result = replaceSessionMessages({
    userId,
    sessionId,
    expectedRevision: before.revision,
    now: 10,
    messages: [
      { id: 'cas-assistant', role: 'assistant', content: 'updated', createdAt: 2, updatedAt: 10 },
      { id: 'cas-user', role: 'user', content: 'next', createdAt: 3, updatedAt: 10 },
    ],
  })
  assert.ok(result.revision > before.revision)
  const stored = listMessages({ userId, sessionId })
  assert.equal(stored[0].content, 'updated')
  assert.equal(stored[0].modelContext.toolTrace[0].tool_call_id, 'call-1')
  assert.throws(
    () => replaceSessionMessages({
      userId,
      sessionId,
      expectedRevision: before.revision,
      messages: [],
    }),
    (error) => error instanceof SessionRevisionConflictError && error.currentRevision === result.revision,
  )
})

test('session mutation routes return 409 for stale revisions and active turns', { concurrency: false }, async () => {
  const { token, userId } = issueTestSession({ email: 'session-route-conflict@example.com' })
  const sessionId = 'session-route-conflict'
  upsertSession({ id: sessionId, userId, title: 'Route conflict' })
  upsertMessage({ id: 'route-message', userId, sessionId, role: 'user', content: 'hello' })
  const current = getSessionSnapshot({ userId, sessionId })

  const stale = await invokeRoute({
    method: 'PUT',
    url: `/api/sessions/${sessionId}/messages`,
    token,
    body: { expectedRevision: current.revision - 1, messages: [] },
  })
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.json().error.code, 'SESSION_REVISION_CONFLICT')
  assert.equal(stale.json().error.currentRevision, current.revision)

  const activeEngine = { hasActiveSession: ({ userId: candidate, sessionId: candidateSession }) => (
    candidate === userId && candidateSession === sessionId
  ) }
  for (const [method, suffix, body] of [
    ['PUT', '/messages', { expectedRevision: current.revision, messages: [] }],
    ['DELETE', '', { expectedRevision: current.revision }],
  ]) {
    const response = await invokeRoute({
      method,
      url: `/api/sessions/${sessionId}${suffix}`,
      token,
      body,
    }, activeEngine)
    assert.equal(response.statusCode, 409)
    assert.equal(response.json().error.code, 'SESSION_ACTIVE')
  }
  assert.ok(getSession({ userId, sessionId }))
  assert.equal(listMessages({ userId, sessionId }).length, 1)
})

test('cross-user session mutations return 404 without changing the owner history', { concurrency: false }, async () => {
  const owner = issueTestSession({ email: 'session-owner@example.com' })
  const intruder = issueTestSession({ email: 'session-intruder@example.com' })
  const sessionId = 'session-owned'
  upsertSession({ id: sessionId, userId: owner.userId, title: 'Owned' })
  upsertMessage({ id: 'owned-message', userId: owner.userId, sessionId, role: 'user', content: 'private' })
  for (const [method, suffix, body] of [
    ['PUT', '/messages', { expectedRevision: 0, messages: [] }],
    ['DELETE', '', { expectedRevision: 0 }],
  ]) {
    const response = await invokeRoute({
      method,
      url: `/api/sessions/${sessionId}${suffix}`,
      token: intruder.token,
      body,
    })
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error.code, 'SESSION_NOT_FOUND')
  }
  assert.equal(listMessages({ userId: owner.userId, sessionId })[0].content, 'private')
})

test('CAS session deletion cascades strong references and clears weak references', { concurrency: false }, () => {
  const { userId } = issueTestSession({ email: 'session-delete@example.com' })
  const sessionId = 'session-delete'
  const db = getDb()
  upsertSession({ id: sessionId, userId, title: 'Delete me' })
  upsertMessage({ id: 'delete-message', userId, sessionId, role: 'user', content: 'bye' })
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: 'delete-event',
      sessionId,
      turnId: 'delete-turn',
      sequence: 0,
      type: 'turn.completed',
      payload: {},
      createdAt: 2,
    }),
  })
  db.prepare(`
    INSERT INTO turn_artifacts
      (id, user_id, session_id, turn_id, type, title, url, filename, created_at)
    VALUES ('delete-artifact', ?, ?, 'delete-turn', 'file', 'Delete', '/delete', 'session-delete.txt', 2)
  `).run(userId, sessionId)
  db.prepare(`
    INSERT INTO pending_approvals
      (id, user_id, origin, session_id, tool_name, args_json, risk, status, created_at, updated_at)
    VALUES ('delete-approval', ?, 'chat', ?, 'write_file', '{}', 'medium', 'pending', 2, 2)
  `).run(userId, sessionId)
  db.prepare('INSERT INTO session_meters (session_id, user_id, updated_at) VALUES (?, ?, 2)')
    .run(sessionId, userId)
  db.prepare(`
    INSERT INTO compaction_archive
      (id, user_id, session_id, replaced_message_count, archived_messages_json, summary_text, created_at)
    VALUES ('delete-archive', ?, ?, 1, '[]', 'summary', 2)
  `).run(userId, sessionId)
  db.prepare(`
    INSERT INTO memories
      (id, user_id, type, title, slug, body, frontmatter_json, pinned,
       source_session_id, source_message_id, created_at, updated_at)
    VALUES ('delete-memory', ?, 'project', 'Delete memory', 'delete-memory', 'body', '{}', 0, ?, 'delete-message', 2, 2)
  `).run(userId, sessionId)
  db.prepare(`
    INSERT INTO subagent_runs
      (id, user_id, parent_session_id, parent_message_id, agent_type, prompt, status, created_at)
    VALUES ('delete-subagent', ?, ?, 'delete-message', 'general', 'prompt', 'completed', 2)
  `).run(userId, sessionId)

  const revision = getSessionSnapshot({ userId, sessionId }).revision
  assert.deepEqual(deleteSession({ userId, sessionId, expectedRevision: revision }), {
    deleted: true,
    previousRevision: revision,
  })
  assert.equal(getSession({ userId, sessionId }), null)
  for (const [table, column, value] of [
    ['messages', 'id', 'delete-message'],
    ['turn_events', 'id', 'delete-event'],
    ['turn_artifacts', 'id', 'delete-artifact'],
    ['pending_approvals', 'id', 'delete-approval'],
    ['compaction_archive', 'id', 'delete-archive'],
    ['session_meters', 'session_id', sessionId],
  ]) {
    assert.equal(db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(value), undefined, table)
  }
  assert.deepEqual(
    db.prepare('SELECT source_session_id, source_message_id FROM memories WHERE id = ?').get('delete-memory'),
    { source_session_id: null, source_message_id: null },
  )
  assert.deepEqual(
    db.prepare('SELECT parent_session_id, parent_message_id FROM subagent_runs WHERE id = ?').get('delete-subagent'),
    { parent_session_id: null, parent_message_id: null },
  )
})
