import assert from 'node:assert/strict'
import test from 'node:test'

import { createJobRuntimeEventHub } from '../server/services/jobRuntimeEventHub.js'

test('scoped listeners use the resolved owner and ignore event-supplied identities', () => {
  const owners = new Map([
    ['job-a', 'user-a'],
    ['job-b', 'user-b'],
  ])
  const hub = createJobRuntimeEventHub({
    resolveJobOwner: (jobId) => owners.get(jobId) || null,
  })
  const receivedByA = []
  const receivedByB = []
  const receivedGlobally = []
  hub.subscribe('user-a', (event) => receivedByA.push(event))
  hub.subscribe('user-b', (event) => receivedByB.push(event))
  hub.subscribe((event) => receivedGlobally.push(event))

  const eventA = { jobId: 'job-a', type: 'progress', userId: 'user-b' }
  const eventB = { jobId: 'job-b', type: 'progress', userId: 'user-a' }
  hub.emit(eventA)
  hub.emit(eventB)

  assert.deepEqual(receivedByA, [eventA])
  assert.deepEqual(receivedByB, [eventB])
  assert.deepEqual(receivedGlobally, [eventA, eventB])
})

test('snake-case job_id resolves through the same owner boundary', () => {
  const resolved = []
  const received = []
  const hub = createJobRuntimeEventHub({
    resolveJobOwner: (jobId) => {
      resolved.push(jobId)
      return jobId === 'legacy-job' ? 'user-a' : null
    },
  })
  hub.subscribe('user-a', (event) => received.push(event))
  const event = { job_id: 'legacy-job', type: 'progress', userId: 'user-b' }

  hub.emit(event)

  assert.deepEqual(resolved, ['legacy-job'])
  assert.deepEqual(received, [event])
})

test('unknown owners fail closed without creating a long-lived negative cache', () => {
  let owner = null
  let lookups = 0
  const scoped = []
  const global = []
  const hub = createJobRuntimeEventHub({
    resolveJobOwner: () => {
      lookups += 1
      return owner
    },
  })
  hub.subscribe('user-a', (event) => scoped.push(event))
  hub.subscribe((event) => global.push(event))
  const unknown = { jobId: 'late-job', type: 'created', userId: 'user-a' }

  hub.emit(unknown)
  assert.deepEqual(scoped, [])
  assert.deepEqual(global, [unknown])
  assert.equal(lookups, 1)

  owner = 'user-a'
  const resolved = { jobId: 'late-job', type: 'queued', userId: 'user-b' }
  hub.emit(resolved)

  assert.equal(lookups, 2)
  assert.deepEqual(scoped, [resolved])
  assert.deepEqual(global, [unknown, resolved])
})

test('owner lookup is cached after a successful resolution', () => {
  let lookups = 0
  const received = []
  const hub = createJobRuntimeEventHub({
    resolveJobOwner: () => {
      lookups += 1
      return 'user-a'
    },
  })
  hub.subscribe('user-a', (event) => received.push(event.type))

  hub.emit({ jobId: 'job-a', type: 'created' })
  hub.emit({ jobId: 'job-a', type: 'progress' })

  assert.equal(lookups, 1)
  assert.deepEqual(received, ['created', 'progress'])
})

test('explicit owner caching rejects empty identities instead of negative-caching them', () => {
  const hub = createJobRuntimeEventHub({ resolveJobOwner: () => 'user-a' })

  for (const args of [
    [null, 'user-a'],
    ['', 'user-a'],
    ['   ', 'user-a'],
    ['job-a', null],
    ['job-a', ''],
    ['job-a', '   '],
  ]) {
    assert.throws(
      () => hub.cacheJobOwner(...args),
      (error) => error instanceof TypeError,
    )
  }
})

test('unsubscribe is idempotent and prevents future delivery', () => {
  const received = []
  const hub = createJobRuntimeEventHub({ resolveJobOwner: () => 'user-a' })
  const unsubscribe = hub.subscribe('user-a', (event) => received.push(event))
  const before = { jobId: 'job-a', type: 'created' }
  const after = { jobId: 'job-a', type: 'progress' }

  hub.emit(before)
  assert.equal(unsubscribe(), true)
  assert.equal(unsubscribe(), false)
  hub.emit(after)

  assert.deepEqual(received, [before])
})

test('only the one-argument form can create a global subscription', () => {
  const hub = createJobRuntimeEventHub({ resolveJobOwner: () => 'user-a' })
  const listener = () => {}

  for (const args of [
    [],
    [undefined, listener],
    [null, listener],
    ['', listener],
    ['   ', listener],
    [42, listener],
    ['user-a', null],
    [listener, listener],
  ]) {
    assert.throws(
      () => hub.subscribe(...args),
      (error) => error instanceof TypeError,
    )
  }

  const unsubscribe = hub.subscribe(listener)
  assert.equal(hub.listenerCount(), 1)
  assert.equal(unsubscribe(), true)
})

test('a throwing listener cannot block sibling delivery', () => {
  const failure = new Error('listener failed')
  const errors = []
  const received = []
  const hub = createJobRuntimeEventHub({
    resolveJobOwner: () => 'user-a',
    onListenerError: (error) => errors.push(error),
  })
  hub.subscribe('user-a', () => {
    throw failure
  })
  hub.subscribe('user-a', (event) => received.push(event))
  const event = { jobId: 'job-a', type: 'progress' }

  hub.emit(event)

  assert.deepEqual(errors, [failure])
  assert.deepEqual(received, [event])
})

test('a throwing error reporter cannot block terminal delivery or eviction', () => {
  let lookups = 0
  const received = []
  const hub = createJobRuntimeEventHub({
    resolveJobOwner: () => {
      lookups += 1
      return 'user-a'
    },
    onListenerError: () => {
      throw new Error('diagnostics unavailable')
    },
  })
  hub.subscribe('user-a', () => {
    throw new Error('listener failed')
  })
  hub.subscribe('user-a', (event) => received.push(event.type))
  hub.cacheJobOwner('job-a', 'user-a')

  assert.doesNotThrow(() => hub.emit({ jobId: 'job-a', type: 'completed' }))
  assert.deepEqual(received, ['completed'])

  hub.emit({ jobId: 'job-a', type: 'after-terminal' })
  assert.equal(lookups, 1)
  assert.deepEqual(received, ['completed', 'after-terminal'])
})

test('an async listener rejection is reported without blocking siblings or eviction', async () => {
  const failure = new Error('async listener failed')
  const errors = []
  const received = []
  let lookups = 0
  const hub = createJobRuntimeEventHub({
    resolveJobOwner: () => {
      lookups += 1
      return 'user-a'
    },
    onListenerError: (error) => errors.push(error),
  })
  hub.subscribe('user-a', async () => {
    throw failure
  })
  hub.subscribe('user-a', (event) => received.push(event.type))
  hub.cacheJobOwner('job-a', 'user-a')

  hub.emit({ jobId: 'job-a', type: 'completed' })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(errors, [failure])
  assert.deepEqual(received, ['completed'])
  hub.emit({ jobId: 'job-a', type: 'after-terminal' })
  assert.equal(lookups, 1)
})

test('every terminal event is delivered before its owner cache entry is evicted', () => {
  const terminalTypes = ['completed', 'failed', 'cancelled', 'aborted']
  const lookups = new Map()
  const received = []
  const hub = createJobRuntimeEventHub({
    resolveJobOwner: (jobId) => {
      lookups.set(jobId, (lookups.get(jobId) || 0) + 1)
      return 'user-a'
    },
  })
  hub.subscribe('user-a', (event) => received.push(`${event.jobId}:${event.type}`))

  for (const type of terminalTypes) {
    const jobId = `job-${type}`
    hub.cacheJobOwner(jobId, 'user-a')
    hub.emit({ jobId, type })
    assert.equal(lookups.get(jobId), undefined)
    assert.equal(received.at(-1), `${jobId}:${type}`)

    hub.emit({ jobId, type: 'after-terminal' })
    assert.equal(lookups.get(jobId), 1)
    assert.equal(received.at(-1), `${jobId}:after-terminal`)
  }
})
