import assert from 'node:assert/strict'
import test from 'node:test'

import Database from 'better-sqlite3'

import { migrateToV113 } from '../server/migrations/v113AgentEventOutbox.js'
import {
  enqueueAgentEventOutboxInDb,
  readAgentEventOutboxPage,
} from '../server/services/agentEventOutboxStore.js'
import { createTurnEvent } from '../shared/turnEvents.js'

function createDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  migrateToV113(db)
  db.prepare('INSERT INTO users (id) VALUES (?), (?)').run('tenant-a', 'tenant-b')
  return db
}

function turnEvent(id, {
  sequence = 0,
  type = 'turn.started',
  payload = {},
  createdAt = 1_000 + sequence,
} = {}) {
  return createTurnEvent({
    id,
    sessionId: `session-${id}`,
    turnId: `turn-${id}`,
    sequence,
    type,
    payload,
    createdAt,
  })
}

function enqueue(db, userId, event) {
  return db.transaction(() => enqueueAgentEventOutboxInDb(db, { userId, event }))()
}

test('enqueue requires a caller-owned transaction and keeps tenant identity outside the envelope', () => {
  const db = createDb()
  try {
    const event = turnEvent('agent-event-transaction')
    assert.throws(
      () => enqueueAgentEventOutboxInDb(db, { userId: 'tenant-a', event }),
      (error) => error?.code === 'AGENT_EVENT_OUTBOX_TRANSACTION_REQUIRED',
    )

    const stored = enqueue(db, 'tenant-a', event)
    assert.equal(stored.userId, 'tenant-a')
    assert.equal(Object.hasOwn(stored.envelope, 'userId'), false)
    assert.equal(Object.hasOwn(stored.envelope.event, 'userId'), false)
    assert.equal(JSON.stringify(stored.envelope).includes('tenant-a'), false)
    assert.equal(stored.envelope.event.id, event.id)
    assert.equal(stored.inserted, true)
  } finally {
    db.close()
  }
})

test('enqueue retries are exact-idempotent and reject event identity reuse', () => {
  const db = createDb()
  try {
    const event = turnEvent('agent-event-idempotent')
    const first = enqueue(db, 'tenant-a', event)
    const retry = enqueue(db, 'tenant-a', event)
    assert.equal(retry.cursor, first.cursor)
    assert.equal(retry.eventFingerprint, first.eventFingerprint)
    assert.equal(retry.inserted, false)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_event_outbox').get().count, 1)

    assert.throws(
      () => enqueue(db, 'tenant-a', turnEvent(event.id, { createdAt: event.createdAt + 1 })),
      (error) => error?.code === 'AGENT_EVENT_OUTBOX_IDEMPOTENCY_CONFLICT',
    )
    assert.throws(
      () => enqueue(db, 'tenant-b', event),
      (error) => error?.code === 'AGENT_EVENT_OUTBOX_IDEMPOTENCY_CONFLICT',
    )
  } finally {
    db.close()
  }
})

test('cursor pages are global, bounded, ordered, and deeply frozen', () => {
  const db = createDb()
  try {
    const receipts = [
      enqueue(db, 'tenant-a', turnEvent('agent-event-page-1')),
      enqueue(db, 'tenant-b', turnEvent('agent-event-page-2')),
      enqueue(db, 'tenant-a', turnEvent('agent-event-page-3')),
    ]

    const first = readAgentEventOutboxPage({ db, afterCursor: 0, limit: 2 })
    assert.deepEqual(first.entries.map((entry) => entry.eventId), [
      'agent-event-page-1',
      'agent-event-page-2',
    ])
    assert.equal(first.nextCursor, receipts[1].cursor)
    assert.equal(first.hasMore, true)
    assert.deepEqual(first.stream, { epoch: 1, truncatedThrough: 0 })
    assert.equal(Object.isFrozen(first.stream), true)
    assert.equal(first.entries[0].userId, 'tenant-a')
    assert.equal(first.entries[1].userId, 'tenant-b')
    assert.equal(Object.hasOwn(first.entries[0].envelope, 'userId'), false)
    assert.equal(Object.hasOwn(first.entries[1].envelope, 'userId'), false)
    assert.equal(Object.isFrozen(first), true)
    assert.equal(Object.isFrozen(first.entries), true)
    assert.equal(Object.isFrozen(first.entries[0]), true)
    assert.equal(Object.isFrozen(first.entries[0].envelope), true)
    assert.equal(Object.isFrozen(first.entries[0].envelope.event), true)
    assert.equal(Object.isFrozen(first.entries[0].envelope.event.payload), true)

    const second = readAgentEventOutboxPage({
      db,
      afterCursor: first.nextCursor,
      limit: 100_000,
    })
    assert.equal(second.limit, 1_000)
    assert.deepEqual(second.entries.map((entry) => entry.eventId), ['agent-event-page-3'])
    assert.equal(second.nextCursor, receipts[2].cursor)
    assert.equal(second.hasMore, false)

    const empty = readAgentEventOutboxPage({ db, afterCursor: second.nextCursor, limit: 1 })
    assert.deepEqual(empty.entries, [])
    assert.equal(empty.nextCursor, second.nextCursor)
    assert.equal(empty.hasMore, false)
  } finally {
    db.close()
  }
})

test('cursor reads reject invalid bounds and fail closed on row corruption', () => {
  const db = createDb()
  try {
    const stored = enqueue(db, 'tenant-a', turnEvent('agent-event-corrupt'))
    assert.throws(
      () => readAgentEventOutboxPage({ db, afterCursor: -1 }),
      (error) => error?.code === 'AGENT_EVENT_OUTBOX_CURSOR_INVALID',
    )
    assert.throws(
      () => readAgentEventOutboxPage({ db, limit: 0 }),
      (error) => error?.code === 'AGENT_EVENT_OUTBOX_LIMIT_INVALID',
    )

    db.prepare(`
      UPDATE agent_event_outbox SET event_type = 'turn.progress' WHERE cursor = ?
    `).run(stored.cursor)
    assert.throws(
      () => readAgentEventOutboxPage({ db }),
      (error) => error?.code === 'AGENT_EVENT_OUTBOX_CORRUPT',
    )
  } finally {
    db.close()
  }
})

test('cursor reads expose stream metadata and fail closed behind the truncation watermark', () => {
  const db = createDb()
  try {
    const first = enqueue(db, 'tenant-a', turnEvent('agent-event-watermark-1'))
    const second = enqueue(db, 'tenant-a', turnEvent('agent-event-watermark-2'))
    db.prepare(`
      UPDATE agent_event_stream_metadata
      SET epoch = 2, truncated_through = ?
      WHERE stream_key = 'global'
    `).run(first.cursor)

    assert.throws(
      () => readAgentEventOutboxPage({ db, afterCursor: 0 }),
      (error) => error?.code === 'AGENT_EVENT_OUTBOX_CURSOR_TRUNCATED'
        && error.details?.epoch === 2
        && error.details?.afterCursor === 0
        && error.details?.truncatedThrough === first.cursor,
    )
    const page = readAgentEventOutboxPage({ db, afterCursor: first.cursor })
    assert.deepEqual(page.stream, { epoch: 2, truncatedThrough: first.cursor })
    assert.deepEqual(page.entries.map((entry) => entry.cursor), [second.cursor])

    db.prepare("DELETE FROM agent_event_stream_metadata WHERE stream_key = 'global'").run()
    assert.throws(
      () => readAgentEventOutboxPage({ db, afterCursor: first.cursor }),
      (error) => error?.code === 'AGENT_EVENT_OUTBOX_CORRUPT',
    )
  } finally {
    db.close()
  }
})
