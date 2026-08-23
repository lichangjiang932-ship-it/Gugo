import assert from 'node:assert/strict'
import test from 'node:test'

import { holdEvolutionOperationLease } from '../server/services/evolutionOperationLeaseRuntime.js'
import { MAX_EVOLUTION_OPERATION_LEASE_MS } from '../server/services/evolutionOperationService.js'

function createClock(startAt) {
  let current = startAt
  let nextId = 1
  const timers = new Map()

  const setTimeoutFn = (callback, delay) => {
    const id = nextId
    nextId += 1
    timers.set(id, { callback, dueAt: current + delay })
    return {
      id,
      unref() {},
    }
  }
  const clearTimeoutFn = (timer) => timers.delete(timer?.id)
  const advanceTo = (target) => {
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0]
      if (!next) break
      const [id, timer] = next
      timers.delete(id)
      current = timer.dueAt
      timer.callback()
    }
    current = target
  }
  const runNext = () => {
    const next = [...timers.entries()]
      .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0]
    if (!next) return false
    const [id, timer] = next
    timers.delete(id)
    timer.callback()
    return true
  }

  return {
    now: () => current,
    setTimeoutFn,
    clearTimeoutFn,
    advanceTo,
    runNext,
    setNow: (value) => { current = value },
  }
}

test('evolution lease holder rejects non-finite, unsafe, and out-of-range durations', () => {
  for (const leaseMs of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    MAX_EVOLUTION_OPERATION_LEASE_MS + 1,
    999,
    1_000.5,
  ]) {
    assert.throws(() => holdEvolutionOperationLease({
      userId: 'heartbeat-user',
      id: 'heartbeat-operation',
      workerToken: 'worker-token',
      leaseOwnerId: 'lease-owner',
      leaseExpiresAt: 2_000,
      leaseMs,
      now: () => 1_000,
    }), {
      code: 'EVOLUTION_OPERATION_LEASE_DURATION_INVALID',
      statusCode: 400,
    })
  }
})

test('evolution lease heartbeat aborts before renewal when wall time moves backwards', () => {
  const clock = createClock(10_000)
  let renewalCalls = 0
  const lease = holdEvolutionOperationLease({
    userId: 'heartbeat-user',
    id: 'heartbeat-operation',
    workerToken: 'worker-token',
    leaseOwnerId: 'lease-owner',
    leaseExpiresAt: 11_200,
    leaseMs: 1_200,
    now: clock.now,
    monotonicNow: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    renewLease() {
      renewalCalls += 1
      return true
    },
  })

  clock.setNow(5_000)
  assert.equal(clock.runNext(), true)
  assert.equal(renewalCalls, 0)
  assert.equal(lease.signal.aborted, true)
  assert.equal(lease.signal.reason?.code, 'EVOLUTION_OPERATION_LEASE_LOST')
  lease.stop()
})

test('evolution lease heartbeat uses elapsed time when wall time still appears unexpired', () => {
  const clock = createClock(10_000)
  let elapsed = 0
  let renewalCalls = 0
  const lease = holdEvolutionOperationLease({
    userId: 'heartbeat-user',
    id: 'heartbeat-operation',
    workerToken: 'worker-token',
    leaseOwnerId: 'lease-owner',
    leaseExpiresAt: 11_000,
    leaseMs: 1_000,
    now: clock.now,
    monotonicNow: () => elapsed,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    renewLease() {
      renewalCalls += 1
      return true
    },
  })

  clock.setNow(10_500)
  elapsed = 1_000
  assert.equal(clock.runNext(), true)
  assert.equal(renewalCalls, 0)
  assert.equal(lease.signal.aborted, true)
  assert.equal(lease.signal.reason?.code, 'EVOLUTION_OPERATION_LEASE_LOST')
  lease.stop()
})

test('evolution lease heartbeat retries a transient busy error without aborting', () => {
  const clock = createClock(1_000)
  const attempts = []
  const lease = holdEvolutionOperationLease({
    userId: 'heartbeat-user',
    id: 'heartbeat-operation',
    workerToken: 'worker-token',
    leaseOwnerId: 'lease-owner',
    leaseExpiresAt: 2_200,
    leaseMs: 1_200,
    now: clock.now,
    monotonicNow: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    renewLease(input) {
      attempts.push(input.now)
      if (attempts.length === 1) {
        throw Object.assign(new Error('database is temporarily locked'), { code: 'SQLITE_BUSY' })
      }
      return true
    },
  })

  clock.advanceTo(1_400)
  assert.equal(lease.signal.aborted, false)
  clock.advanceTo(1_500)
  assert.equal(lease.signal.aborted, false)
  assert.deepEqual(attempts, [1_400, 1_500])
  lease.stop()
})

test('evolution lease heartbeat aborts immediately on a permanent renewal error', () => {
  const clock = createClock(8_000)
  let attempts = 0
  const permanentError = Object.assign(new Error('worker fence no longer exists'), {
    code: 'EVOLUTION_OPERATION_FENCED',
    statusCode: 409,
  })
  const lease = holdEvolutionOperationLease({
    userId: 'heartbeat-user',
    id: 'heartbeat-operation',
    workerToken: 'worker-token',
    leaseOwnerId: 'lease-owner',
    leaseExpiresAt: 9_200,
    leaseMs: 1_200,
    now: clock.now,
    monotonicNow: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    renewLease() {
      attempts += 1
      throw permanentError
    },
  })

  clock.advanceTo(8_400)
  assert.equal(attempts, 1)
  assert.equal(lease.signal.aborted, true)
  assert.equal(lease.signal.reason, permanentError)
  clock.advanceTo(9_200)
  assert.equal(attempts, 1)
  lease.stop()
})

test('evolution lease heartbeat aborts only after retries reach the known deadline', () => {
  const clock = createClock(5_000)
  let attempts = 0
  const lease = holdEvolutionOperationLease({
    userId: 'heartbeat-user',
    id: 'heartbeat-operation',
    workerToken: 'worker-token',
    leaseOwnerId: 'lease-owner',
    leaseExpiresAt: 6_200,
    leaseMs: 1_200,
    now: clock.now,
    monotonicNow: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    renewLease() {
      attempts += 1
      throw Object.assign(new Error('database remains locked'), { code: 'SQLITE_BUSY' })
    },
  })

  clock.advanceTo(6_199)
  assert.equal(lease.signal.aborted, false)
  assert.ok(attempts > 1)
  clock.advanceTo(6_200)
  assert.equal(lease.signal.aborted, true)
  assert.equal(lease.signal.reason?.code, 'EVOLUTION_OPERATION_LEASE_LOST')
  lease.stop()
})
