import assert from 'node:assert/strict'
import test from 'node:test'

import { createEventWriteBehind } from '../server/services/eventWriteBehind.js'

test('event write-behind clones queued values and combines high-frequency writes', async () => {
  const batches = []
  const writer = createEventWriteBehind({
    writeBatch: (batch) => { batches.push(batch) },
    maxDelayMs: 10_000,
  })
  const first = { event: { id: 'e-1', payload: { text: 'original' } } }
  writer.enqueue(first)
  for (let index = 2; index <= 100; index += 1) {
    writer.enqueue({ event: { id: `e-${index}`, payload: { text: String(index) } } })
  }
  first.event.payload.text = 'mutated-after-enqueue'

  await writer.flush()

  assert.equal(batches.length, 1)
  assert.equal(batches[0].length, 100)
  assert.equal(batches[0][0].event.payload.text, 'original')
  assert.deepEqual(writer.getStats(), {
    enqueued: 100,
    written: 100,
    batches: 1,
    retries: 0,
    failedEvents: 0,
    failedBatches: 0,
    overflowFlushes: 0,
    lastFailureAt: null,
    lastError: null,
    pending: 0,
  })
})

test('event write-behind rejects the durability barrier with structured failure metadata', async () => {
  let attempts = 0
  let reported = null
  const errors = []
  const writer = createEventWriteBehind({
    writeBatch() {
      attempts += 1
      throw new Error('sqlite unavailable')
    },
    recordFailure(value) { reported = value },
    logger: { error: (...args) => errors.push(args) },
    maxDelayMs: 10_000,
  })

  writer.enqueue({
    userId: 'u-1',
    event: { id: 'e-failed', sequence: 7, type: 'assistant.delta' },
  })
  const failure = await writer.flush().catch((error) => error)

  assert.equal(failure.code, 'TURN_EVENT_PERSISTENCE_FAILED')
  assert.equal(failure.retryable, true)
  assert.equal(failure.failedEventCount, 1)
  assert.equal(failure.blockedEventCount, 0)
  assert.deepEqual(failure.failedEventTypes, ['assistant.delta'])
  assert.equal(failure.firstFailedSequence, 7)
  assert.equal(failure.lastFailedSequence, 7)
  assert.equal(attempts, 3)
  assert.equal(reported.batch[0].event.id, 'e-failed')
  assert.equal(reported.attempts, 3)
  assert.match(reported.errorMessage, /sqlite unavailable/)
  assert.equal(errors.length, 1)
  assert.equal(writer.getStats().failedEvents, 1)
  assert.equal(writer.getStats().retries, 2)
})

test('event write-behind keeps overflow batches ordered behind an in-flight batch', async () => {
  const batches = []
  let releaseFirst
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve })
  let calls = 0
  const writer = createEventWriteBehind({
    writeBatch: async (batch) => {
      calls += 1
      batches.push(batch.map((item) => item.id))
      if (calls === 1) await firstBlocked
    },
    writeBatchSync: async (batch) => {
      calls += 1
      batches.push(batch.map((item) => item.id))
      if (calls === 1) await firstBlocked
    },
    maxDelayMs: 10_000,
    maxQueueSize: 1,
  })

  writer.enqueue({ id: 'one' })
  writer.enqueue({ id: 'two' })
  writer.enqueue({ id: 'three' })
  writer.enqueue({ id: 'four' })

  await Promise.resolve()
  assert.deepEqual(batches, [['one', 'two']])
  const flushed = writer.flush()
  releaseFirst()
  await flushed

  assert.deepEqual(batches, [['one', 'two'], ['three', 'four']])
  assert.equal(writer.getStats().overflowFlushes, 2)
  assert.equal(writer.getStats().written, 4)
})

test('event write-behind blocks later batches after an ordered failure and starts a clean generation after rejection', async () => {
  let writeAttempts = 0
  const reports = []
  let available = false
  const writer = createEventWriteBehind({
    writeBatch(batch) {
      writeAttempts += 1
      if (!available) throw new Error('sqlite unavailable')
      return batch
    },
    recordFailure(value) { reports.push(value) },
    logger: { error() {} },
    maxDelayMs: 10_000,
    maxQueueSize: 1,
  })

  writer.enqueue({ event: { id: 'one', sequence: 1, type: 'assistant.delta' } })
  writer.enqueue({ event: { id: 'two', sequence: 2, type: 'assistant.delta' } })
  writer.enqueue({ event: { id: 'three', sequence: 3, type: 'reasoning.delta' } })
  writer.enqueue({ event: { id: 'four', sequence: 4, type: 'reasoning.delta' } })

  const failure = await writer.flush().catch((error) => error)
  assert.equal(writeAttempts, 3)
  assert.equal(failure.failedEventCount, 4)
  assert.equal(failure.blockedEventCount, 2)
  assert.deepEqual(failure.failedEventTypes, ['assistant.delta', 'reasoning.delta'])
  assert.equal(reports.length, 2)
  assert.equal(reports[1].blocked, true)

  available = true
  writer.enqueue({ event: { id: 'terminal', sequence: 5, type: 'turn.failed' } })
  await writer.flush()
  assert.equal(writer.getStats().written, 1)
})

test('concurrent flush callers observe the same failed durability boundary', async () => {
  const writer = createEventWriteBehind({
    writeBatch() { throw new Error('disk full') },
    logger: { error() {} },
    maxDelayMs: 10_000,
    maxAttempts: 1,
  })
  writer.enqueue({ event: { id: 'failed', sequence: 1, type: 'assistant.delta' } })

  const first = writer.flush()
  const second = writer.flush()
  assert.equal(first, second)
  const outcomes = await Promise.allSettled([first, second])
  assert.deepEqual(outcomes.map(({ status }) => status), ['rejected', 'rejected'])
  assert.equal(outcomes[0].reason, outcomes[1].reason)
})

test('close is an idempotent barrier and rejects enqueue as soon as closing starts', async () => {
  let releaseWrite
  const blocked = new Promise((resolve) => { releaseWrite = resolve })
  const writer = createEventWriteBehind({
    writeBatch: async () => blocked,
    maxDelayMs: 10_000,
  })
  writer.enqueue({ id: 'queued' })

  const first = writer.close()
  const second = writer.close()
  assert.equal(first, second)
  assert.throws(() => writer.enqueue({ id: 'too-late' }), /closed/)
  releaseWrite()
  const [firstStats, secondStats] = await Promise.all([first, second])
  assert.deepEqual(firstStats, secondStats)
  assert.equal(firstStats.written, 1)
})
