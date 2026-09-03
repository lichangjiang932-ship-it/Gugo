import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-agent-event-outbox-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, createUser, getDb } = await import('../server/db.js')
const { migrateToV113 } = await import('../server/migrations/v113AgentEventOutbox.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const {
  appendTurnEvent,
  pruneTurnEvents,
} = await import('../server/services/turnEventStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function createScope(label) {
  const userId = `agent-outbox-user-${label}`
  const sessionId = `agent-outbox-session-${label}`
  createUser({ id: userId, email: `${userId}@example.test` })
  upsertSession({ id: sessionId, userId, title: `Agent outbox ${label}` })
  return { userId, sessionId, turnId: `agent-outbox-turn-${label}` }
}

function event(scope, {
  id,
  sequence = 0,
  type = 'turn.started',
  payload = {},
  createdAt = 1_000,
} = {}) {
  return createTurnEvent({
    id: id || `${scope.turnId}-event-${sequence}`,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    sequence,
    type,
    payload,
    createdAt,
  })
}

function outboxRows(where = '', ...params) {
  return getDb().prepare(`
    SELECT * FROM agent_event_outbox ${where} ORDER BY cursor ASC
  `).all(...params)
}

test('v113 Agent Event outbox schema is idempotent and fail-closed', () => {
  const db = getDb()
  migrateToV113(db)
  migrateToV113(db)

  const columns = new Set(db.prepare('PRAGMA table_info(agent_event_outbox)').all()
    .map((row) => row.name))
  assert.deepEqual(columns, new Set([
    'cursor',
    'event_id',
    'user_id',
    'event_type',
    'envelope_json',
    'event_fingerprint',
    'created_at',
  ]))
  assert.deepEqual(
    db.prepare('PRAGMA foreign_key_list(agent_event_outbox)').all()
      .map(({ table, from, to, on_delete: onDelete }) => ({ table, from, to, onDelete })),
    [{ table: 'users', from: 'user_id', to: 'id', onDelete: 'CASCADE' }],
  )
  const indexes = new Set(db.prepare('PRAGMA index_list(agent_event_outbox)').all()
    .map((row) => row.name))
  assert.ok(indexes.has('idx_agent_event_outbox_user_cursor'))
  assert.ok(indexes.has('idx_agent_event_outbox_type_cursor'))
  assert.match(
    db.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_event_outbox'
    `).get().sql,
    /\bcursor\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/iu,
  )

  const metadataColumns = new Set(
    db.prepare('PRAGMA table_info(agent_event_stream_metadata)').all().map((row) => row.name),
  )
  assert.deepEqual(metadataColumns, new Set(['stream_key', 'epoch', 'truncated_through']))
  assert.deepEqual(
    db.prepare(`
      SELECT stream_key, epoch, truncated_through FROM agent_event_stream_metadata
    `).all(),
    [{ stream_key: 'global', epoch: 1, truncated_through: 0 }],
  )

  db.prepare(`
    UPDATE agent_event_stream_metadata SET epoch = 2, truncated_through = 7
    WHERE stream_key = 'global'
  `).run()
  migrateToV113(db)
  assert.deepEqual(
    db.prepare(`
      SELECT stream_key, epoch, truncated_through FROM agent_event_stream_metadata
    `).all(),
    [{ stream_key: 'global', epoch: 2, truncated_through: 7 }],
  )
  db.prepare(`
    UPDATE agent_event_stream_metadata SET epoch = 1, truncated_through = 0
    WHERE stream_key = 'global'
  `).run()
  assert.throws(
    () => db.prepare(`
      UPDATE agent_event_stream_metadata SET epoch = 1.5 WHERE stream_key = 'global'
    `).run(),
    /CHECK constraint failed/u,
  )
  assert.throws(
    () => db.prepare(`
      UPDATE agent_event_stream_metadata SET truncated_through = -1 WHERE stream_key = 'global'
    `).run(),
    /CHECK constraint failed/u,
  )

  const scope = createScope('schema')
  const insert = db.prepare(`
    INSERT INTO agent_event_outbox (
      event_id, user_id, event_type, envelope_json, event_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `)
  assert.throws(
    () => insert.run('bad-json', scope.userId, 'turn.started', '[]', 'a'.repeat(64), 1),
    /CHECK constraint failed/u,
  )
  assert.throws(
    () => insert.run('bad-digest', scope.userId, 'turn.started', '{}', 'z'.repeat(64), 1),
    /CHECK constraint failed/u,
  )
  assert.throws(
    () => insert.run('bad-time', scope.userId, 'turn.started', '{}', 'a'.repeat(64), -1),
    /CHECK constraint failed/u,
  )
  assert.throws(
    () => insert.run(
      'bad-time-storage-class',
      scope.userId,
      'turn.started',
      '{}',
      'a'.repeat(64),
      'not-an-integer',
    ),
    /CHECK constraint failed/u,
  )

  const firstCursor = Number(insert.run(
    'autoincrement-first',
    scope.userId,
    'turn.started',
    '{}',
    'a'.repeat(64),
    2,
  ).lastInsertRowid)
  db.prepare('DELETE FROM agent_event_outbox WHERE cursor = ?').run(firstCursor)
  const secondCursor = Number(insert.run(
    'autoincrement-second',
    scope.userId,
    'turn.started',
    '{}',
    'b'.repeat(64),
    3,
  ).lastInsertRowid)
  assert.ok(secondCursor > firstCursor)
  db.prepare('DELETE FROM agent_event_outbox WHERE cursor = ?').run(secondCursor)
})

test('Turn persistence rolls back when durable Agent Event capture fails', () => {
  const scope = createScope('rollback')
  const value = event(scope, { id: 'agent-outbox-rollback-event' })
  const db = getDb()
  db.exec(`
    CREATE TRIGGER reject_agent_event_capture
    BEFORE INSERT ON agent_event_outbox
    BEGIN
      SELECT RAISE(ABORT, 'reject Agent Event capture');
    END;
  `)
  try {
    assert.throws(
      () => appendTurnEvent({ userId: scope.userId, event: value }),
      /reject Agent Event capture/u,
    )
  } finally {
    db.exec('DROP TRIGGER reject_agent_event_capture')
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM turn_events WHERE id = ?')
    .get(value.id).count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_event_outbox WHERE event_id = ?')
    .get(value.id).count, 0)

  appendTurnEvent({ userId: scope.userId, event: value })
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM turn_events WHERE id = ?')
    .get(value.id).count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_event_outbox WHERE event_id = ?')
    .get(value.id).count, 1)
})

test('Agent Event capture is idempotent and globally ordered across tenants and Turns', () => {
  const left = createScope('ordered-left')
  const right = createScope('ordered-right')
  const leftStarted = event(left, { id: 'agent-outbox-left-started', createdAt: 2_000 })
  const rightStarted = event(right, { id: 'agent-outbox-right-started', createdAt: 2_001 })
  const leftProgress = event(left, {
    id: 'agent-outbox-left-progress',
    sequence: 1,
    type: 'turn.progress',
    payload: { phase: 'working' },
    createdAt: 2_002,
  })

  appendTurnEvent({ userId: left.userId, event: leftStarted })
  appendTurnEvent({ userId: left.userId, event: leftStarted })
  appendTurnEvent({ userId: right.userId, event: rightStarted })
  appendTurnEvent({ userId: left.userId, event: leftProgress })

  const rows = outboxRows(
    'WHERE event_id IN (?, ?, ?)',
    leftStarted.id,
    rightStarted.id,
    leftProgress.id,
  )
  assert.deepEqual(rows.map((row) => row.event_id), [
    leftStarted.id,
    rightStarted.id,
    leftProgress.id,
  ])
  assert.equal(rows.length, 3)
  assert.ok(rows[0].cursor < rows[1].cursor && rows[1].cursor < rows[2].cursor)

  for (const row of rows) {
    const envelope = JSON.parse(row.envelope_json)
    assert.equal(Object.hasOwn(envelope, 'userId'), false)
    assert.equal(Object.hasOwn(envelope.event, 'userId'), false)
    assert.equal(envelope.event.id, row.event_id)
    assert.equal(envelope.event.type, row.event_type)
    assert.equal(row.event_fingerprint, createHash('sha256')
      .update(JSON.stringify({ userId: row.user_id, envelope }))
      .digest('hex'))
  }
})

test('Turn event retention does not erase durable Agent Event capture', () => {
  const scope = createScope('retention')
  const started = event(scope, { id: 'agent-outbox-retained-started', createdAt: 100 })
  const failed = event(scope, {
    id: 'agent-outbox-retained-failed',
    sequence: 1,
    type: 'turn.failed',
    payload: { code: 'TEST_FAILURE' },
    createdAt: 101,
  })
  appendTurnEvent({ userId: scope.userId, event: started })
  appendTurnEvent({ userId: scope.userId, event: failed })

  const result = pruneTurnEvents({
    userId: scope.userId,
    now: 10_000,
    retentionMs: 1,
    maxTerminalTurnsPerUser: 100,
  })
  assert.deepEqual(result, { turnsDeleted: 1, eventsDeleted: 2 })
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM turn_events WHERE user_id = ?')
    .get(scope.userId).count, 0)
  assert.deepEqual(
    outboxRows('WHERE user_id = ?', scope.userId).map((row) => row.event_id),
    [started.id, failed.id],
  )
})

test('deleting a user clears only that tenant durable Agent Event capture', () => {
  const removed = createScope('clear-removed')
  const retained = createScope('clear-retained')
  appendTurnEvent({ userId: removed.userId, event: event(removed) })
  appendTurnEvent({ userId: retained.userId, event: event(retained) })

  getDb().prepare('DELETE FROM users WHERE id = ?').run(removed.userId)
  assert.equal(outboxRows('WHERE user_id = ?', removed.userId).length, 0)
  assert.equal(outboxRows('WHERE user_id = ?', retained.userId).length, 1)
})
