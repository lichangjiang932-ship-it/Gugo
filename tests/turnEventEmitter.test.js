import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTurnEventEmitter,
  findEventPersistenceFailure,
} from '../server/services/turnEventEmitter.js'
import { EventWriteBehindError } from '../server/services/eventWriteBehind.js'

function emitterScope(overrides = {}) {
  let nextId = 0
  return {
    userId: 'user-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    sequence: 3,
    idFactory: () => `event-${++nextId}`,
    now: () => 1_000,
    ...overrides,
  }
}

test('turn event emitter flushes deferred deltas before durable lifecycle events', async () => {
  const operations = []
  const durable = []
  const pending = []
  const writer = {
    enqueue(entry) {
      operations.push(`enqueue:${entry.event.type}`)
      pending.push(entry)
      return entry
    },
    async flush() {
      operations.push('flush')
      durable.push(...pending.splice(0))
    },
    async close() {
      operations.push('close')
      durable.push(...pending.splice(0))
    },
  }
  let opened = null
  let closed = null
  const emit = createTurnEventEmitter(emitterScope({
    createEventWriteBehind: () => writer,
    appendEvent: async (entry) => {
      operations.push(`append:${entry.event.type}`)
      durable.push(entry)
      return entry.event
    },
    onWriterOpen: (value) => { opened = value },
    onWriterClose: (value) => { closed = value },
  }))

  const delta = await emit('assistant.delta', { text: 'a' })
  const progress = await emit('turn.progress', { phase: 'working' })
  await emit.close()

  assert.equal(opened, writer)
  assert.equal(closed, writer)
  assert.equal(delta.sequence, 3)
  assert.equal(progress.sequence, 4)
  assert.deepEqual(durable.map((entry) => entry.event.type), [
    'assistant.delta',
    'turn.progress',
  ])
  assert.deepEqual(operations, [
    'enqueue:assistant.delta',
    'flush',
    'append:turn.progress',
    'close',
  ])
  await assert.rejects(
    emit('turn.progress', { phase: 'late' }),
    (error) => error?.code === 'TURN_EVENT_EMITTER_CLOSED',
  )
})

test('turn event emitter rejects legacy non-throwing durability failures and reuses the missing sequence', async () => {
  const durable = []
  const pending = []
  let failedEvents = 0
  const writer = {
    enqueue(entry) {
      pending.push(entry)
      return entry
    },
    async flush() {
      if (pending.length > 0) {
        failedEvents += pending.splice(0).length
      }
      return { failedEvents, failedBatches: failedEvents > 0 ? 1 : 0, lastError: 'legacy write failed' }
    },
    getStats() {
      return { failedEvents, failedBatches: failedEvents > 0 ? 1 : 0 }
    },
  }
  const emit = createTurnEventEmitter(emitterScope({
    createEventWriteBehind: () => writer,
    appendEvent: async (entry) => {
      durable.push(entry.event)
      return entry.event
    },
  }))

  await emit('assistant.delta', { text: 'not durable' })
  const failure = await emit('turn.completed', { text: 'must not complete' }).catch((error) => error)
  assert.equal(failure.code, 'TURN_EVENT_PERSISTENCE_FAILED')
  assert.equal(failure.firstFailedSequence, 3)
  assert.deepEqual(durable, [])

  const failed = await emit('turn.failed', {
    code: failure.code,
    message: failure.message,
  })
  assert.equal(failed.sequence, 3)
  assert.equal(failed.type, 'turn.failed')
  assert.deepEqual(durable.map((event) => event.type), ['turn.failed'])
})

test('turn event emitter reuses the missing sequence from a wrapped durability failure', async () => {
  const durable = []
  const pending = []
  let failNextFlush = true
  const writer = {
    enqueue(entry) {
      pending.push(entry)
      return entry
    },
    async flush() {
      if (!failNextFlush) return { failedEvents: 0, failedBatches: 0 }
      failNextFlush = false
      const failure = new EventWriteBehindError({
        batch: pending.splice(0),
        cause: new Error('wrapped storage failure'),
        attempts: 1,
        failedAt: 1_000,
      })
      throw new Error('adapter boundary failed', { cause: failure })
    },
  }
  const emit = createTurnEventEmitter(emitterScope({
    createEventWriteBehind: () => writer,
    appendEvent: async ({ event }) => {
      durable.push(event)
      return event
    },
  }))

  await emit('assistant.delta', { text: 'not durable' })
  const failure = await emit('turn.completed', { text: 'must not complete' }).catch((error) => error)
  assert.equal(findEventPersistenceFailure(failure)?.firstFailedSequence, 3)

  const failed = await emit('turn.failed', { code: failure.code, message: failure.message })
  assert.equal(failed.sequence, 3)
  assert.deepEqual(durable.map((event) => event.type), ['turn.failed'])
})

test('turn event emitter normalizes a custom writer rejection and keeps the log contiguous', async () => {
  const durable = []
  const pending = []
  let failNextFlush = true
  const writer = {
    enqueue(entry) {
      pending.push(entry)
      return entry
    },
    async flush() {
      if (!failNextFlush) return { ok: true }
      failNextFlush = false
      pending.splice(0)
      throw new Error('custom writer lost deferred batch')
    },
  }
  const emit = createTurnEventEmitter(emitterScope({
    createEventWriteBehind: () => writer,
    appendEvent: async ({ event }) => {
      durable.push(event)
      return event
    },
  }))

  await emit('assistant.delta', { text: 'not durable' })
  const failure = await emit('turn.completed', { text: 'must not complete' }).catch((error) => error)
  assert.equal(failure.code, 'TURN_EVENT_PERSISTENCE_FAILED')
  assert.equal(failure.firstFailedSequence, 3)

  const failed = await emit('turn.failed', { code: failure.code, message: failure.message })
  assert.equal(failed.sequence, 3)
  assert.deepEqual(durable.map((event) => event.type), ['turn.failed'])
})

test('turn event emitter journals direct failures and distinguishes unknown terminal outcomes', async () => {
  const journal = []
  const createWriter = () => ({
    enqueue: (entry) => entry,
    flush: async () => {},
  })
  const storageError = new Error('storage unavailable')
  const emit = createTurnEventEmitter(emitterScope({
    createEventWriteBehind: createWriter,
    appendEvent: async () => { throw storageError },
    recordEventWriteFailure: async (entry) => { journal.push(entry) },
  }))

  const nonTerminalFailure = await emit('turn.progress', { phase: 'working' })
    .catch((error) => error)
  assert.equal(nonTerminalFailure.code, 'TURN_EVENT_PERSISTENCE_FAILED')
  assert.equal(findEventPersistenceFailure(nonTerminalFailure), nonTerminalFailure)
  assert.equal(nonTerminalFailure.firstFailedSequence, 3)
  assert.equal(journal.length, 1)
  assert.equal(journal[0].batch[0].event.type, 'turn.progress')

  const terminalFailure = await emit('turn.failed', {
    code: 'TURN_FAILED',
    message: 'failed',
  }).catch((error) => error)
  assert.equal(terminalFailure.code, 'TURN_TERMINAL_PERSISTENCE_FAILED')
  assert.equal(terminalFailure.terminalEventType, 'turn.failed')
  assert.equal(terminalFailure.eventSequence, 3)
  assert.equal(terminalFailure.cause, storageError)
  assert.equal(journal.length, 2)
})

test('turn event emitter rejects a terminal append that cannot produce a verified commit receipt', async () => {
  const createWriter = () => ({ enqueue: (entry) => entry, flush: async () => {} })
  const emit = createTurnEventEmitter(emitterScope({
    createEventWriteBehind: createWriter,
    appendEvent: async ({ event }) => event,
    verifyEventCommit: async () => ({ committed: false, receipt: null }),
    recordEventWriteFailure: async () => {},
  }))

  const failure = await emit('turn.completed', { text: 'not durable' }).catch((error) => error)
  assert.equal(failure.code, 'TURN_TERMINAL_PERSISTENCE_FAILED')
  assert.equal(failure.terminalEventType, 'turn.completed')
  assert.equal(failure.cause?.code, 'TURN_EVENT_COMMIT_UNVERIFIED')
})

test('turn event emitter treats a lost read-after-write response as an unknown terminal outcome', async () => {
  const createWriter = () => ({ enqueue: (entry) => entry, flush: async () => {} })
  const responseLost = Object.assign(new Error('verification connection reset'), { code: 'ECONNRESET' })
  const emergency = []
  const emit = createTurnEventEmitter(emitterScope({
    createEventWriteBehind: createWriter,
    appendEvent: async ({ event }) => event,
    verifyEventCommit: async () => { throw responseLost },
    recordEventWriteFailure: async () => { throw new Error('primary journal unavailable') },
    recordEmergencyFailure: async (input) => { emergency.push(input) },
    warn: () => {},
  }))

  const failure = await emit('turn.completed', { text: 'possibly durable' }).catch((error) => error)
  assert.equal(failure.code, 'TURN_TERMINAL_PERSISTENCE_FAILED')
  assert.equal(failure.cause, responseLost)
  assert.equal(emergency.length, 1)
  assert.equal(emergency[0].batch[0].event.type, 'turn.completed')
  assert.match(emergency[0].journalError.message, /primary journal unavailable/)
})

test('turn event emitter verifies every resumable durable boundary and preserves unknown outcomes', async () => {
  const boundaries = [
    ['turn.paused', { text: '', clarification: 'Need clarification' }],
    ['turn.interrupted', {
      code: 'MODEL_CALL_INTERRUPTED',
      message: 'Model call interrupted',
      retryable: true,
    }],
    ['turn.blocked', {
      code: 'SIDE_EFFECT_OUTCOME_UNKNOWN',
      message: 'Side-effect outcome requires verification',
      retryable: false,
      manualRetryable: true,
      recoveryStatus: 'dead_letter',
    }],
  ]
  for (const [type, payload] of boundaries) {
    const responseLost = Object.assign(new Error(`lost ${type} acknowledgement`), { code: 'ECONNRESET' })
    const emit = createTurnEventEmitter(emitterScope({
      createEventWriteBehind: () => ({ enqueue: (entry) => entry, flush: async () => {} }),
      appendEvent: async ({ event }) => event,
      verifyEventCommit: async () => { throw responseLost },
      recordEventWriteFailure: async () => {},
    }))

    const failure = await emit(type, payload).catch((error) => error)
    assert.equal(failure.code, 'TURN_TERMINAL_PERSISTENCE_FAILED')
    assert.equal(failure.boundaryEventType, type)
    assert.equal(failure.terminalEventType, type)
    assert.equal(failure.cause, responseLost)
    assert.equal(failure.eventSequence, 3)
  }
})
