import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-turn-checkpoint-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, createUser, getDb } = await import('../server/db.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnEvent, listTurnEvents } = await import('../server/services/turnEventStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const {
  deleteTurnCheckpoint,
  getTurnCheckpoint,
  saveTurnCheckpoint,
} = await import('../server/services/turnCheckpointStore.js')

createUser({ id: 'checkpoint-user', email: 'turn-checkpoint@example.com' })
createUser({ id: 'checkpoint-other', email: 'turn-checkpoint-other@example.com' })
upsertSession({ id: 'checkpoint-session', userId: 'checkpoint-user', title: 'Checkpoint' })

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('turn checkpoint upserts one latest user-isolated row', () => {
  const first = saveTurnCheckpoint({
    userId: 'checkpoint-user',
    sessionId: 'checkpoint-session',
    turnId: 'turn-1',
    eventSequence: 3,
    state: { messages: [{ role: 'user', content: 'first' }], iterations: 1 },
    now: 100,
  })
  assert.equal(first.eventSequence, 3)
  assert.equal(first.state.checkpointVersion, 1)

  const second = saveTurnCheckpoint({
    userId: 'checkpoint-user',
    sessionId: 'checkpoint-session',
    turnId: 'turn-1',
    eventSequence: 7,
    state: { messages: [{ role: 'user', content: 'latest' }], iterations: 4 },
    now: 200,
  })
  assert.equal(second.eventSequence, 7)
  assert.equal(second.createdAt, 100)
  assert.equal(second.updatedAt, 200)
  assert.equal(second.state.messages[0].content, 'latest')
  assert.equal(
    getDb().prepare(`
      SELECT COUNT(*) AS count FROM turn_checkpoints
       WHERE user_id = ? AND session_id = ? AND turn_id = ?
    `).get('checkpoint-user', 'checkpoint-session', 'turn-1').count,
    1,
  )
  assert.equal(getTurnCheckpoint({
    userId: 'checkpoint-other',
    sessionId: 'checkpoint-session',
    turnId: 'turn-1',
  }), null)
})

test('a stale writer cannot replace a newer checkpoint', () => {
  saveTurnCheckpoint({
    userId: 'checkpoint-user',
    sessionId: 'checkpoint-session',
    turnId: 'turn-stale',
    eventSequence: 9,
    state: { marker: 'newer' },
    now: 300,
  })
  const checkpoint = saveTurnCheckpoint({
    userId: 'checkpoint-user',
    sessionId: 'checkpoint-session',
    turnId: 'turn-stale',
    eventSequence: 8,
    state: { marker: 'stale' },
    now: 400,
  })
  assert.equal(checkpoint.eventSequence, 9)
  assert.equal(checkpoint.state.marker, 'newer')
  assert.equal(checkpoint.updatedAt, 300)
})

test('checkpoint deletion is scoped to the owning user and turn', () => {
  saveTurnCheckpoint({
    userId: 'checkpoint-user',
    sessionId: 'checkpoint-session',
    turnId: 'turn-delete',
    eventSequence: 1,
    state: { marker: true },
  })
  assert.equal(deleteTurnCheckpoint({
    userId: 'checkpoint-other',
    sessionId: 'checkpoint-session',
    turnId: 'turn-delete',
  }), 0)
  assert.equal(deleteTurnCheckpoint({
    userId: 'checkpoint-user',
    sessionId: 'checkpoint-session',
    turnId: 'turn-delete',
  }), 1)
})

test('checkpoint event and mutable state commit atomically', () => {
  const event = createTurnEvent({
    id: 'atomic-checkpoint-event',
    sessionId: 'checkpoint-session',
    turnId: 'turn-atomic',
    sequence: 0,
    type: 'turn.checkpoint',
    payload: {
      storage: 'turn_checkpoints',
      checkpointVersion: 1,
      iterations: 1,
      toolCallCount: 0,
    },
    createdAt: 500,
  })
  assert.throws(() => appendTurnEvent({
    userId: 'checkpoint-user',
    event,
    checkpointState: { unserializable: 1n },
  }))
  assert.deepEqual(listTurnEvents({
    userId: 'checkpoint-user',
    sessionId: 'checkpoint-session',
    turnId: 'turn-atomic',
  }), [])
  assert.equal(getTurnCheckpoint({
    userId: 'checkpoint-user',
    sessionId: 'checkpoint-session',
    turnId: 'turn-atomic',
  }), null)

  appendTurnEvent({
    userId: 'checkpoint-user',
    event,
    checkpointState: { messages: [], iterations: 1 },
  })
  assert.equal(listTurnEvents({
    userId: 'checkpoint-user',
    sessionId: 'checkpoint-session',
    turnId: 'turn-atomic',
  }).length, 1)
  assert.equal(getTurnCheckpoint({
    userId: 'checkpoint-user',
    sessionId: 'checkpoint-session',
    turnId: 'turn-atomic',
  }).state.iterations, 1)
})
