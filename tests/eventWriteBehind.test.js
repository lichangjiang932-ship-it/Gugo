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

test('event write-behind retries three times and reports failures without rejecting flush', async () => {
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

  writer.enqueue({ userId: 'u-1', event: { id: 'e-failed' } })
  await assert.doesNotReject(writer.flush())

  assert.equal(attempts, 3)
  assert.equal(reported.batch[0].event.id, 'e-failed')
  assert.equal(reported.attempts, 3)
  assert.match(reported.errorMessage, /sqlite unavailable/)
  assert.equal(errors.length, 1)
  assert.equal(writer.getStats().failedEvents, 1)
  assert.equal(writer.getStats().retries, 2)
})

test('event write-behind drains synchronously when the bounded queue overflows', async () => {
  const batches = []
  const write = (batch) => { batches.push(batch.map((item) => item.id)) }
  const writer = createEventWriteBehind({
    writeBatch: write,
    writeBatchSync: write,
    maxDelayMs: 10_000,
    maxQueueSize: 2,
  })

  writer.enqueue({ id: 'one' })
  writer.enqueue({ id: 'two' })
  writer.enqueue({ id: 'three' })

  assert.deepEqual(batches, [['one', 'two', 'three']])
  await writer.flush()
  assert.equal(writer.getStats().overflowFlushes, 1)
  assert.equal(writer.getStats().written, 3)
})
