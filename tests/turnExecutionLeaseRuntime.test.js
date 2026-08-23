import assert from 'node:assert/strict'
import test from 'node:test'

import { createTurnExecutionLeaseCoordinator } from '../server/services/turnExecutionLeaseRuntime.js'

const SCOPE = Object.freeze({
  userId: 'runtime-user',
  sessionId: 'runtime-session',
  turnId: 'runtime-turn',
})

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createFakeClock(start = 0) {
  let current = start
  let nextId = 1
  const scheduled = new Map()

  const setTimer = (callback, delayMs = 0) => {
    const handle = {
      id: nextId++,
      at: current + Math.max(0, Math.floor(Number(delayMs) || 0)),
      callback,
      unref() {},
    }
    scheduled.set(handle, handle)
    return handle
  }

  const clearTimer = (handle) => {
    scheduled.delete(handle)
  }

  const advance = (delayMs) => {
    const target = current + Math.max(0, Math.floor(Number(delayMs) || 0))
    while (true) {
      const due = [...scheduled.values()]
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0]
      if (!due) break
      current = due.at
      scheduled.delete(due)
      due.callback()
    }
    current = target
  }

  return {
    now: () => current,
    setTimer,
    clearTimer,
    advance,
    timerCount: () => scheduled.size,
  }
}

async function flushMicrotasks(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

function coordinatorOptions(clock, overrides = {}) {
  return {
    ownerId: 'runtime-owner',
    leaseMs: 1_000,
    renewalTimeoutMs: 100,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    claimLease: () => true,
    releaseLease: () => true,
    isLeaseActive: () => true,
    hasActiveSessionLease: () => true,
    requestCancellation: () => true,
    closeSteeringInbox: () => ({ closed: true }),
    ...overrides,
  }
}

test('a renewal that never settles aborts at its deadline and clears every timer', async () => {
  const clock = createFakeClock(1_000)
  const initialLease = {
    ...SCOPE,
    ownerId: 'runtime-owner',
    fencingToken: 7,
    expiresAt: 2_000,
  }
  let renewCalls = 0
  const coordinator = createTurnExecutionLeaseCoordinator(coordinatorOptions(clock, {
    readLease: () => initialLease,
    renewLease: () => {
      renewCalls += 1
      return new Promise(() => {})
    },
  }))

  assert.equal(await coordinator.claim(SCOPE), true)
  const controller = new AbortController()
  const release = coordinator.hold(SCOPE, controller)
  await flushMicrotasks()

  assert.equal(renewCalls, 1)
  clock.advance(99)
  await flushMicrotasks()
  assert.equal(controller.signal.aborted, false)

  clock.advance(1)
  await flushMicrotasks()
  assert.equal(controller.signal.aborted, true)
  assert.equal(controller.signal.reason?.code, 'TURN_LEASE_LOST')
  assert.equal(coordinator.proof(SCOPE), null)
  assert.equal(clock.timerCount(), 0)

  assert.equal(await release(), true)
  assert.equal(clock.timerCount(), 0)
})

test('a successful renewal replaces the cached proof with the authoritative expiry', async () => {
  const clock = createFakeClock(2_000)
  const leases = [
    {
      ...SCOPE,
      ownerId: 'runtime-owner',
      fencingToken: 11,
      expiresAt: 3_000,
    },
    {
      ...SCOPE,
      ownerId: 'runtime-owner',
      fencingToken: 11,
      expiresAt: 3_750,
    },
  ]
  let readIndex = 0
  const coordinator = createTurnExecutionLeaseCoordinator(coordinatorOptions(clock, {
    readLease: () => leases[Math.min(readIndex++, leases.length - 1)],
    renewLease: () => ({ renewed: true, cancelRequested: false }),
  }))

  assert.equal(await coordinator.claim(SCOPE), true)
  assert.equal(coordinator.proof(SCOPE)?.expiresAt, 3_000)
  const release = coordinator.hold(SCOPE, new AbortController())
  await flushMicrotasks()

  assert.deepEqual(coordinator.proof(SCOPE), {
    ownerId: 'runtime-owner',
    fencingToken: 11,
    expiresAt: 3_750,
  })
  assert.equal(readIndex, 2)

  assert.equal(await release(), true)
  assert.equal(coordinator.proof(SCOPE), null)
  assert.equal(clock.timerCount(), 0)
})

test('local expiry wins over a late renewal success and the stale result cannot restore proof', async () => {
  const clock = createFakeClock(5_000)
  const renewal = createDeferred()
  let readCalls = 0
  const initialLease = {
    ...SCOPE,
    ownerId: 'runtime-owner',
    fencingToken: 17,
    expiresAt: 5_050,
  }
  const coordinator = createTurnExecutionLeaseCoordinator(coordinatorOptions(clock, {
    renewalTimeoutMs: 900,
    readLease: () => {
      readCalls += 1
      return initialLease
    },
    renewLease: () => renewal.promise,
  }))

  assert.equal(await coordinator.claim(SCOPE), true)
  const controller = new AbortController()
  const release = coordinator.hold(SCOPE, controller)
  await flushMicrotasks()

  clock.advance(50)
  await flushMicrotasks()
  assert.equal(controller.signal.aborted, true)
  assert.equal(controller.signal.reason?.code, 'TURN_LEASE_LOST')
  assert.equal(coordinator.proof(SCOPE), null)
  assert.equal(clock.timerCount(), 0)

  renewal.resolve({ renewed: true, cancelRequested: false })
  await flushMicrotasks()
  assert.equal(readCalls, 1)
  assert.equal(coordinator.proof(SCOPE), null)
  assert.equal(clock.timerCount(), 0)

  assert.equal(await release(), true)
  assert.equal(clock.timerCount(), 0)
})

test('release does not await a hung renewal and absorbs its late rejection', async () => {
  const clock = createFakeClock(8_000)
  const renewal = createDeferred()
  const initialLease = {
    ...SCOPE,
    ownerId: 'runtime-owner',
    fencingToken: 23,
    expiresAt: 9_000,
  }
  let releaseCalls = 0
  const coordinator = createTurnExecutionLeaseCoordinator(coordinatorOptions(clock, {
    readLease: () => initialLease,
    renewLease: () => renewal.promise,
    releaseLease: () => {
      releaseCalls += 1
      return true
    },
  }))
  const unhandled = []
  const onUnhandledRejection = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandledRejection)

  try {
    assert.equal(await coordinator.claim(SCOPE), true)
    const controller = new AbortController()
    const release = coordinator.hold(SCOPE, controller)
    await flushMicrotasks()

    assert.equal(await release(), true)
    assert.equal(releaseCalls, 1)
    assert.equal(controller.signal.aborted, false)
    assert.equal(coordinator.proof(SCOPE), null)
    assert.equal(clock.timerCount(), 0)

    renewal.reject(new Error('late renewal failure'))
    await flushMicrotasks()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
    assert.equal(clock.timerCount(), 0)
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection)
  }
})

test('a cancellation renewal aborts work but preserves proof until release', async () => {
  const clock = createFakeClock(10_000)
  const initialLease = {
    ...SCOPE,
    ownerId: 'runtime-owner',
    fencingToken: 29,
    expiresAt: 11_000,
  }
  const coordinator = createTurnExecutionLeaseCoordinator(coordinatorOptions(clock, {
    readLease: () => initialLease,
    renewLease: () => ({ renewed: true, cancelRequested: true }),
  }))

  assert.equal(await coordinator.claim(SCOPE), true)
  const controller = new AbortController()
  const release = coordinator.hold(SCOPE, controller)
  await flushMicrotasks()

  assert.equal(controller.signal.aborted, true)
  assert.equal(controller.signal.reason?.code, 'TURN_CANCEL_REQUESTED')
  assert.deepEqual(coordinator.proof(SCOPE), {
    ownerId: 'runtime-owner',
    fencingToken: 29,
    expiresAt: 11_000,
  })
  assert.equal(clock.timerCount(), 0)

  assert.equal(await release(), true)
  assert.equal(coordinator.proof(SCOPE), null)
  assert.equal(clock.timerCount(), 0)
})

test('a failed release preserves proof and can be retried without duplicate concurrent calls', async () => {
  const clock = createFakeClock(10_000)
  const releaseFailure = new Error('lease release failed')
  const initialLease = {
    ...SCOPE,
    ownerId: 'runtime-owner',
    fencingToken: 31,
    expiresAt: 11_000,
  }
  let releaseCalls = 0
  const coordinator = createTurnExecutionLeaseCoordinator(coordinatorOptions(clock, {
    readLease: () => initialLease,
    releaseLease: async () => {
      releaseCalls += 1
      if (releaseCalls === 1) throw releaseFailure
      return true
    },
  }))
  assert.equal(await coordinator.claim(SCOPE), true)
  const controller = new AbortController()
  const release = coordinator.hold(SCOPE, controller)
  const proof = coordinator.proof(SCOPE)

  const firstRelease = release()
  const concurrentRelease = release()
  await assert.rejects(
    Promise.all([firstRelease, concurrentRelease]),
    (error) => error === releaseFailure,
  )
  assert.equal(releaseCalls, 1)
  assert.deepEqual(coordinator.proof(SCOPE), proof)
  assert.equal(await release(), true)
  assert.equal(releaseCalls, 2)
  assert.equal(coordinator.proof(SCOPE), null)
  assert.equal(await release(), false)
  assert.equal(releaseCalls, 2)
})
