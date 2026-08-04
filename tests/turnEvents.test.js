import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTurnEvent, parseTurnEvent } from '../shared/turnEvents.js'

test('turn event protocol accepts known events and rejects protocol drift', () => {
  const event = createTurnEvent({ id: 'e1', sessionId: 's1', turnId: 't1', sequence: 0, type: 'turn.started', payload: { model: 'test' }, createdAt: 1 })
  assert.equal(event.type, 'turn.started')
  assert.throws(() => parseTurnEvent({ ...event, type: 'text' }))
  assert.throws(() => parseTurnEvent({ ...event, sequence: -1 }))
})

test('turn event store is append-only, idempotent, ordered, and user isolated', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yma-turn-events-'))
  const oldPath = process.env.APP_DB_PATH
  process.env.APP_DB_PATH = path.join(dir, 'test.db')
  const { closeDb, createUser, getDb } = await import('../server/db.js')
  const { upsertSession } = await import('../server/services/sessionStore.js')
  const {
    appendTurnEvent,
    listTurnEvents,
    pruneTurnEvents,
    resolveTurnEventRetentionConfig,
  } = await import('../server/services/turnEventStore.js')
  try {
    createUser({ id: 'u1', email: 'turn-u1@example.com' }); createUser({ id: 'u2', email: 'turn-u2@example.com' })
    upsertSession({ id: 's1', userId: 'u1', title: 'Turn' })
    const event = createTurnEvent({ id: 'e1', sessionId: 's1', turnId: 't1', sequence: 0, type: 'turn.started', createdAt: 1 })
    appendTurnEvent({ userId: 'u1', event }); appendTurnEvent({ userId: 'u1', event })
    appendTurnEvent({ userId: 'u1', event: createTurnEvent({ id: 'e2', sessionId: 's1', turnId: 't1', sequence: 1, type: 'turn.completed', createdAt: 2 }) })
    assert.deepEqual(listTurnEvents({ userId: 'u1', sessionId: 's1', turnId: 't1' }).map((item) => item.id), ['e1', 'e2'])
    assert.deepEqual(listTurnEvents({ userId: 'u2', sessionId: 's1', turnId: 't1' }), [])
    assert.throws(() => appendTurnEvent({ userId: 'u1', event: { ...event, id: 'other', type: 'turn.failed' } }), /conflict/)

    assert.deepEqual(resolveTurnEventRetentionConfig({
      TURN_EVENT_RETENTION_DAYS: '7',
      TURN_EVENT_MAX_TERMINAL_TURNS_PER_USER: '25',
      TURN_EVENT_CLEANUP_INTERVAL_MS: '2000',
    }), {
      retentionMs: 7 * 86_400_000,
      maxTerminalTurnsPerUser: 25,
      cleanupIntervalMs: 2_000,
    })
    assert.equal(
      getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_turn_events_retention'").get()?.name,
      'idx_turn_events_retention',
    )

    // Sessions created by bridge/mobile flows may not have a display title yet.
    // Ownership, not presentation metadata, is the authorization boundary.
    getDb().prepare(`
      INSERT INTO sessions (token, id, user_id, title, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?)
    `).run('untitled-session', 'untitled-session', 'u1', Number.MAX_SAFE_INTEGER, 1, 1)
    const untitledEvent = createTurnEvent({
      id: 'untitled-event', sessionId: 'untitled-session', turnId: 'untitled-turn',
      sequence: 0, type: 'turn.started', createdAt: 1,
    })
    assert.equal(appendTurnEvent({ userId: 'u1', event: untitledEvent }).id, 'untitled-event')
    assert.throws(() => appendTurnEvent({
      userId: 'u2',
      event: { ...untitledEvent, id: 'untitled-cross-user', turnId: 'cross-user-turn' },
    }), /session not found/)

    upsertSession({ id: 'retention-session', userId: 'u2', title: 'Retention' })
    const add = (turnId, sequence, type, createdAt) => appendTurnEvent({
      userId: 'u2',
      event: createTurnEvent({
        id: `${turnId}-${sequence}`,
        sessionId: 'retention-session',
        turnId,
        sequence,
        type,
        createdAt,
      }),
    })
    add('stale-active', 0, 'turn.started', 100)
    add('stale-terminal', 0, 'turn.started', 200)
    add('stale-terminal', 1, 'turn.completed', 201)
    for (const [turnId, createdAt] of [['recent-1', 850], ['recent-2', 900], ['recent-3', 950]]) {
      add(turnId, 0, 'turn.started', createdAt)
      add(turnId, 1, 'turn.completed', createdAt + 1)
    }
    add('recent-active', 0, 'turn.started', 975)

    const pruned = pruneTurnEvents({
      userId: 'u2',
      now: 1_000,
      retentionMs: 500,
      maxTerminalTurnsPerUser: 2,
    })
    assert.deepEqual(pruned, { turnsDeleted: 3, eventsDeleted: 5 })
    assert.deepEqual(listTurnEvents({ userId: 'u2', sessionId: 'retention-session', turnId: 'stale-active' }), [])
    assert.deepEqual(listTurnEvents({ userId: 'u2', sessionId: 'retention-session', turnId: 'stale-terminal' }), [])
    assert.deepEqual(listTurnEvents({ userId: 'u2', sessionId: 'retention-session', turnId: 'recent-1' }), [])
    assert.equal(listTurnEvents({ userId: 'u2', sessionId: 'retention-session', turnId: 'recent-2' }).length, 2)
    assert.equal(listTurnEvents({ userId: 'u2', sessionId: 'retention-session', turnId: 'recent-3' }).length, 2)
    assert.equal(listTurnEvents({ userId: 'u2', sessionId: 'retention-session', turnId: 'recent-active' }).length, 1)
  } finally { closeDb(); process.env.APP_DB_PATH = oldPath; rmSync(dir, { recursive: true, force: true }) }
})
