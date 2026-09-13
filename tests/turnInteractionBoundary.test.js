import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { readTurnInteractionBoundary, runWithTurnInteractionBoundary } from '../server/services/turnInteractionBoundary.js'

function fixture(t, kind = 'directory') {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec(`CREATE TABLE turn_events (
    id TEXT, user_id TEXT, session_id TEXT, turn_id TEXT, sequence INTEGER, type TEXT, payload_json TEXT
  ); CREATE TABLE confirmations (value TEXT);`)
  const scope = { userId: 'owner', sessionId: 'session', turnId: 'turn' }
  const payload = kind === 'directory'
    ? { clarification: { request_type: 'directory', access_mode: 'read_only', path: 'C:/fixture' } }
    : { code: 'SIDE_EFFECT_OUTCOME_UNKNOWN', requiresUserVerification: true,
      recoveryKind: 'side_effect_outcome_unknown', toolCallId: 'call' }
  const boundary = { id: 'boundary', sequence: 2, type: kind === 'directory' ? 'turn.paused' : 'turn.blocked' }
  const append = (event, body = {}, owner = scope) => db.prepare('INSERT INTO turn_events VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(event.id, owner.userId, owner.sessionId, owner.turnId, event.sequence, event.type, JSON.stringify(body))
  append(boundary, payload)
  const input = { ...scope, boundary, ...(kind === 'side_effect' ? { toolCallId: 'call' } : {}), db }
  return { db, scope, boundary, payload, append, input,
    count: () => db.prepare('SELECT COUNT(*) AS total FROM confirmations').get().total }
}

for (const kind of ['directory', 'side_effect']) {
  test(`a ${kind} confirmation checks and writes under one SQLite transaction`, t => {
    const f = fixture(t, kind)
    assert.deepEqual(readTurnInteractionBoundary(f.input), f.boundary)
    const result = runWithTurnInteractionBoundary(f.input, ({ db, payload }) => {
      assert.equal(db.inTransaction, true)
      assert.deepEqual(payload, f.payload)
      db.prepare('INSERT INTO confirmations VALUES (?)').run('confirmed')
      return { confirmed: true }
    })
    assert.deepEqual(result, { confirmed: true })
    assert.equal(f.count(), 1)
  })
}

test('confirmation refuses mismatched owners, scopes and boundary identity before calling a writer', t => {
  const f = fixture(t, 'side_effect')
  const mismatches = [
    { userId: 'other' }, { sessionId: 'other' }, { turnId: 'other' }, { toolCallId: 'other' },
    { boundary: { ...f.boundary, id: 'other' } }, { boundary: { ...f.boundary, sequence: 1 } },
    { boundary: { ...f.boundary, type: 'turn.paused' } }, { boundary: null },
  ]
  for (const mismatch of mismatches) {
    assert.throws(() => runWithTurnInteractionBoundary({ ...f.input, ...mismatch }, () => assert.fail('must not write')),
      error => error.code === 'TURN_INTERACTION_STALE' && error.statusCode === 409)
  }
  assert.equal(f.count(), 0)
})

test('a cancelled or resumed task invalidates an earlier confirmation even while its old record exists', t => {
  const f = fixture(t)
  const snapshot = readTurnInteractionBoundary(f.input)
  f.append({ id: 'cancelled', sequence: 3, type: 'turn.cancelled' })
  assert.throws(() => runWithTurnInteractionBoundary({ ...f.input, boundary: snapshot }, () => assert.fail('late write')),
    error => error.code === 'TURN_INTERACTION_STALE')
  assert.equal(f.count(), 0)
})

test('a different user event cannot replace this user current boundary', t => {
  const f = fixture(t)
  f.append({ id: 'foreign-cancel', sequence: 99, type: 'turn.cancelled' }, {}, { ...f.scope, userId: 'other' })
  assert.deepEqual(readTurnInteractionBoundary(f.input), f.boundary)
})

test('directory and unknown-operation confirmations cannot be substituted for each other', t => {
  const directory = fixture(t)
  assert.throws(() => readTurnInteractionBoundary({ ...directory.input, toolCallId: 'call' }),
    error => error.code === 'TURN_INTERACTION_STALE')
  const unknown = fixture(t, 'side_effect')
  assert.throws(() => readTurnInteractionBoundary({ ...unknown.input, toolCallId: undefined }),
    error => error.code === 'TURN_INTERACTION_STALE')
})

test('the transaction helper rejects async functions before invocation and rolls back a returned promise', t => {
  const f = fixture(t)
  let entered = false
  assert.throws(() => runWithTurnInteractionBoundary(f.input, async () => { entered = true }), /synchronous/u)
  assert.equal(entered, false)
  assert.throws(() => runWithTurnInteractionBoundary(f.input, ({ db }) => {
    db.prepare('INSERT INTO confirmations VALUES (?)').run('must roll back')
    return Promise.resolve()
  }), /synchronously/u)
  assert.equal(f.count(), 0)
})

test('malformed identities cannot open the supplied database', () => {
  const db = { prepare: () => assert.fail('read'), transaction: () => assert.fail('write') }
  assert.throws(() => readTurnInteractionBoundary({ userId: ' ', sessionId: 's', turnId: 't', db }),
    error => error.code === 'TURN_INTERACTION_STALE')
})
