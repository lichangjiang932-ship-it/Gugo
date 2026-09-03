import assert from 'node:assert/strict'
import test from 'node:test'

import { createDefaultJobRuntimeEventHub } from '../server/services/jobRuntimeDefaultEventHub.js'

test('default job runtime event hub resolves owners through the injected job reader', () => {
  const lookups = []
  const received = []
  const hub = createDefaultJobRuntimeEventHub({
    getJob: (jobId) => {
      lookups.push(jobId)
      return jobId === 'job-a' ? { userId: 'user-a' } : null
    },
  })
  hub.subscribe('user-a', (event) => received.push(event))
  const event = { jobId: 'job-a', type: 'progress' }

  hub.emit(event)

  assert.deepEqual(lookups, ['job-a'])
  assert.deepEqual(received, [event])
})

test('default job runtime event hubs keep owner caches and listeners instance-local', () => {
  const receivedByA = []
  const receivedByB = []
  const hubA = createDefaultJobRuntimeEventHub({
    getJob: () => ({ userId: 'user-a' }),
  })
  const hubB = createDefaultJobRuntimeEventHub({
    getJob: () => ({ userId: 'user-b' }),
  })
  hubA.subscribe('user-a', (event) => receivedByA.push(event))
  hubB.subscribe('user-b', (event) => receivedByB.push(event))
  const eventA = { jobId: 'shared-job', type: 'progress' }
  const eventB = { jobId: 'shared-job', type: 'queued' }

  hubA.emit(eventA)
  hubB.emit(eventB)

  assert.deepEqual(receivedByA, [eventA])
  assert.deepEqual(receivedByB, [eventB])
})

test('default job runtime event hub rejects an invalid job reader eagerly', () => {
  assert.throws(
    () => createDefaultJobRuntimeEventHub({ getJob: null }),
    /requires getJob to be a function/u,
  )
})
