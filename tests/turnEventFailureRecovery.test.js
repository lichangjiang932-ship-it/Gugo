import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-event-recovery-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, createUser } = await import('../server/db.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const {
  appendTurnEvent,
  listTurnEventWriteFailures,
  recordTurnEventWriteFailure,
  replayTurnEventWriteFailure,
} = await import('../server/services/turnEventStore.js')
const { getTurnCheckpoint } = await import('../server/services/turnCheckpointStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('checkpoint write failures preserve state and can be replayed atomically', () => {
  const userId = 'checkpoint-replay-user'
  const sessionId = 'checkpoint-replay-session'
  const turnId = 'checkpoint-replay-turn'
  createUser({ id: userId, email: 'checkpoint-replay@example.com' })
  upsertSession({ id: sessionId, userId, title: 'Checkpoint recovery' })
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: 'checkpoint-started-event',
      sessionId,
      turnId,
      sequence: 0,
      type: 'turn.started',
      payload: {},
      createdAt: 999,
    }),
  })
  const event = createTurnEvent({
    id: 'checkpoint-event-1',
    sessionId,
    turnId,
    sequence: 1,
    type: 'turn.checkpoint',
    payload: { storage: 'turn_checkpoints', checkpointVersion: 1, iterations: 1 },
    createdAt: 1_000,
  })
  const checkpointState = {
    version: 1,
    nextIteration: 2,
    messages: [{ role: 'assistant', content: 'durable state' }],
  }

  assert.equal(recordTurnEventWriteFailure({
    batch: [{ userId, event, checkpointState }],
    errorMessage: 'disk full',
    attempts: 3,
    failedAt: Date.now(),
  }), 1)
  const [failure] = listTurnEventWriteFailures({ userId })
  assert.deepEqual(failure.checkpointState, checkpointState)

  const replayed = replayTurnEventWriteFailure({ userId, id: failure.id })
  assert.equal(replayed.event.type, 'turn.checkpoint')
  assert.deepEqual(getTurnCheckpoint({ userId, sessionId, turnId })?.state, {
    ...checkpointState,
    checkpointVersion: 1,
  })
  assert.deepEqual(listTurnEventWriteFailures({ userId }), [])
})
