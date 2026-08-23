import assert from 'node:assert/strict'
import test from 'node:test'

import { hubRetryBackoffMs } from '../server/hub/jobLeaseRuntime.js'
import { createHubRuntime } from '../server/hub/runtime.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function createClock(start = 1_000) {
  let current = start
  let sequence = 0
  const timers = new Map()

  const setTimeoutFn = (callback, delay = 0) => {
    const timer = {
      at: current + Math.max(0, Math.floor(Number(delay) || 0)),
      callback,
      id: ++sequence,
      unref() {},
    }
    timers.set(timer.id, timer)
    return timer
  }
  const clearTimeoutFn = (timer) => {
    if (timer) timers.delete(timer.id)
  }
  const nextTimer = (target = Number.POSITIVE_INFINITY) => Array.from(timers.values())
    .filter((timer) => timer.at <= target)
    .sort((left, right) => left.at - right.at || left.id - right.id)[0] || null

  return {
    now: () => current,
    setTimeoutFn,
    clearTimeoutFn,
    advance(milliseconds) {
      const target = current + milliseconds
      let timer = nextTimer(target)
      while (timer) {
        current = timer.at
        timers.delete(timer.id)
        timer.callback()
        timer = nextTimer(target)
      }
      current = Math.max(current, target)
    },
    jump(milliseconds) {
      current += milliseconds
    },
    nextDelay() {
      const timer = nextTimer()
      return timer ? timer.at - current : null
    },
    timerCount: () => timers.size,
  }
}

async function settle(rounds = 10) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

function silentLogger() {
  return { info() {}, error() {} }
}

function resolveNow(value) {
  return typeof value === 'function' ? value() : value
}

function resolveDbOptions(options) {
  return { ...options, now: resolveNow(options.now) }
}

function claimedJob(overrides = {}) {
  return {
    id: 'hub-job-1',
    name: 'test-handler',
    payload: { value: 1 },
    status: 'running',
    leaseOwner: 'hub-owner-a',
    leaseToken: 'lease-token-a',
    leaseExpiresAt: 1_900,
    ...overrides,
  }
}

test('Hub handler receives signal/lease, heartbeat renews, and completion is fenced', async () => {
  const clock = createClock()
  const completion = deferred()
  const claimCalls = []
  const renewCalls = []
  const doneCalls = []
  let handlerContext = null
  let claimed = false
  const job = claimedJob()
  const db = {
    claimNextPending(options) {
      claimCalls.push(resolveDbOptions(options))
      if (claimed) return null
      claimed = true
      return job
    },
    renewJobLease(id, options) {
      const resolved = resolveDbOptions(options)
      renewCalls.push({ id, options: resolved })
      return { ...job, leaseExpiresAt: resolved.now + resolved.leaseMs }
    },
    markDone(id, options) {
      doneCalls.push({ id, options: resolveDbOptions(options) })
      return { ...job, status: 'done' }
    },
    recordJobFailure() {
      assert.fail('successful handler must not record failure')
    },
  }
  const runtime = createHubRuntime({
    db,
    registry: {
      getHandler: () => async (handledJob, context) => {
        handlerContext = context
        handledJob.leaseToken = 'handler-mutated-token'
        return completion.promise
      },
    },
    logger: silentLogger(),
    createOwnerId: () => 'hub-owner-a',
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  })

  const run = runtime.runOnce()
  assert.equal(handlerContext.signal.aborted, false)
  assert.equal(handlerContext.lease.ownerId, 'hub-owner-a')
  assert.equal(handlerContext.lease.leaseToken, 'lease-token-a')
  assert.equal(handlerContext.lease.leaseMs, 30_000)
  assert.deepEqual(claimCalls, [{ ownerId: 'hub-owner-a', now: 1_000, leaseMs: 30_000 }])

  // The claimed proof above has a 900ms remaining lifetime, so configure the
  // runtime lease explicitly before testing the one-third heartbeat interval.
  completion.resolve('finished')
  await run
  assert.equal(renewCalls.length, 0)
  assert.deepEqual(doneCalls, [{
    id: 'hub-job-1',
    options: {
      ownerId: 'hub-owner-a',
      leaseToken: 'lease-token-a',
      lastError: 'finished',
      now: 1_000,
    },
  }])
  assert.equal(clock.timerCount(), 0)
})

test('HUB_LEASE_MS drives a one-third heartbeat and updates handler lease proof', async () => {
  const clock = createClock()
  const completion = deferred()
  const renewCalls = []
  const doneCalls = []
  const job = claimedJob()
  let context = null
  let claimed = false
  const runtime = createHubRuntime({
    db: {
      runHubMigrations() {},
      recoverStaleJobs: () => ({ recovered: 0, requeued: 0, deadLettered: 0 }),
      claimNextPending: () => {
        if (claimed) return null
        claimed = true
        return job
      },
      renewJobLease(id, options) {
        const resolved = resolveDbOptions(options)
        renewCalls.push({ id, options: resolved })
        return { ...job, leaseExpiresAt: resolved.now + resolved.leaseMs }
      },
      markDone(id, options) {
        doneCalls.push({ id, options: resolveDbOptions(options) })
        return { ...job, status: 'done' }
      },
      recordJobFailure() {
        assert.fail('successful handler must not record failure')
      },
    },
    registry: {
      listHandlers: () => ['test-handler'],
      getHandler: () => async (_job, handlerContext) => {
        context = handlerContext
        return completion.promise
      },
    },
    logger: silentLogger(),
    createOwnerId: () => 'hub-owner-a',
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  })
  // runOnce reads the runtime environment established by startHub in
  // production. A dedicated runtime may start and immediately claim at 0ms.
  runtime.startHub({ env: { HUB_LEASE_MS: '900', HUB_TICK_MS: '500' } })
  clock.advance(0)
  await settle()
  assert.equal(context.lease.leaseMs, 900)

  clock.advance(300)
  assert.deepEqual(renewCalls, [{
    id: 'hub-job-1',
    options: {
      ownerId: 'hub-owner-a',
      leaseToken: 'lease-token-a',
      now: 1_300,
      leaseMs: 900,
    },
  }])
  assert.equal(context.lease.expiresAt, 2_200)

  completion.resolve('heartbeat-finished')
  await settle()
  assert.equal(doneCalls.length, 1)
  assert.equal(doneCalls[0].options.leaseToken, 'lease-token-a')
  assert.equal(doneCalls[0].options.ownerId, 'hub-owner-a')
  assert.equal(doneCalls[0].options.lastError, 'heartbeat-finished')
  assert.equal(await runtime.shutdownHub(), 0)
})

test('heartbeat retries Node SQLite primary and extended busy errors before expiry', async () => {
  const clock = createClock()
  const completion = deferred()
  const job = claimedJob()
  const renewCalls = []
  let claimed = false
  let context = null
  let doneWrites = 0
  const runtime = createHubRuntime({
    db: {
      runHubMigrations() {},
      recoverStaleJobs: () => ({ recovered: 0, requeued: 0, deadLettered: 0 }),
      claimNextPending: () => {
        if (claimed) return null
        claimed = true
        return job
      },
      renewJobLease(id, options) {
        const resolved = resolveDbOptions(options)
        renewCalls.push({ id, options: resolved })
        if (renewCalls.length === 1) {
          throw Object.assign(new Error('database is locked'), {
            code: 'ERR_SQLITE_ERROR',
            errcode: 5,
          })
        }
        if (renewCalls.length === 2) {
          throw Object.assign(new Error('database is locked (extended)'), {
            code: 'ERR_SQLITE_ERROR',
            errcode: 261,
          })
        }
        return { ...job, leaseExpiresAt: resolved.now + resolved.leaseMs }
      },
      markDone() {
        doneWrites += 1
        return { ...job, status: 'done' }
      },
      recordJobFailure() {
        assert.fail('transient heartbeat contention must not fail the job')
      },
    },
    registry: {
      listHandlers: () => ['test-handler'],
      getHandler: () => async (_job, handlerContext) => {
        context = handlerContext
        return completion.promise
      },
    },
    logger: silentLogger(),
    createOwnerId: () => 'hub-owner-a',
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  })

  runtime.startHub({ env: { HUB_LEASE_MS: '900' } })
  clock.advance(0)
  await settle()
  clock.advance(300)
  assert.equal(renewCalls.length, 1)
  assert.equal(context.signal.aborted, false)
  assert.equal(clock.nextDelay(), 75)

  clock.advance(74)
  assert.equal(renewCalls.length, 1)
  clock.advance(1)
  assert.equal(renewCalls.length, 2)
  assert.equal(context.signal.aborted, false)

  clock.advance(75)
  assert.equal(renewCalls.length, 3)
  assert.equal(context.signal.aborted, false)
  assert.equal(context.lease.expiresAt, 2_350)

  completion.resolve('renewed after contention')
  await settle()
  assert.equal(doneWrites, 1)
  assert.equal(await runtime.shutdownHub(), 0)
})

test('continuous SQLITE_BUSY renewals abort at expiry without a terminal write', async () => {
  const clock = createClock()
  const job = claimedJob({ leaseExpiresAt: 1_300 })
  let claimed = false
  let renewAttempts = 0
  let abortReason = null
  let terminalWrites = 0
  const runtime = createHubRuntime({
    db: {
      runHubMigrations() {},
      recoverStaleJobs: () => ({ recovered: 0, requeued: 0, deadLettered: 0 }),
      claimNextPending: () => {
        if (claimed) return null
        claimed = true
        return job
      },
      renewJobLease() {
        renewAttempts += 1
        throw Object.assign(new Error('database remains busy'), { code: 'SQLITE_BUSY' })
      },
      markDone() { terminalWrites += 1 },
      recordJobFailure() { terminalWrites += 1 },
    },
    registry: {
      listHandlers: () => ['test-handler'],
      getHandler: () => (_job, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          abortReason = signal.reason
          reject(signal.reason)
        }, { once: true })
      }),
    },
    logger: silentLogger(),
    createOwnerId: () => 'hub-owner-a',
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  })

  runtime.startHub({ env: { HUB_LEASE_MS: '300' } })
  clock.advance(0)
  await settle()
  clock.advance(300)
  await settle()

  assert.ok(renewAttempts > 1, 'busy renewal should retry while the proof is live')
  assert.equal(abortReason?.code, 'HUB_JOB_LEASE_LOST')
  assert.equal(terminalWrites, 0)
  assert.equal(runtime.inspect().running, false)
  assert.equal(await runtime.shutdownHub(), 0)
})

test('renewal that returns after the prior deadline is treated as lease loss', async () => {
  const clock = createClock()
  const job = claimedJob()
  let claimed = false
  let abortReason = null
  let terminalWrites = 0
  const runtime = createHubRuntime({
    db: {
      runHubMigrations() {},
      recoverStaleJobs: () => ({ recovered: 0, requeued: 0, deadLettered: 0 }),
      claimNextPending: () => {
        if (claimed) return null
        claimed = true
        return job
      },
      renewJobLease(id, options) {
        // Simulate a synchronous SQLite busy wait that outlives the old proof.
        clock.jump(600)
        const resolved = resolveDbOptions(options)
        return { ...job, id, leaseExpiresAt: resolved.now + resolved.leaseMs }
      },
      markDone() { terminalWrites += 1 },
      recordJobFailure() { terminalWrites += 1 },
    },
    registry: {
      listHandlers: () => ['test-handler'],
      getHandler: () => (_job, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          abortReason = signal.reason
          reject(signal.reason)
        }, { once: true })
      }),
    },
    logger: silentLogger(),
    createOwnerId: () => 'hub-owner-a',
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  })

  runtime.startHub({ env: { HUB_LEASE_MS: '900' } })
  clock.advance(0)
  await settle()
  clock.advance(300)
  await settle()

  assert.equal(abortReason?.code, 'HUB_JOB_LEASE_LOST')
  assert.equal(terminalWrites, 0)
  assert.equal(runtime.inspect().running, false)
  assert.equal(await runtime.shutdownHub(), 0)
})

test('non-busy ERR_SQLITE_ERROR aborts immediately and suppresses terminal writes', async () => {
  const clock = createClock()
  const job = claimedJob()
  let abortReason = null
  let terminalWrites = 0
  let claimed = false
  const runtime = createHubRuntime({
    db: {
      runHubMigrations() {},
      recoverStaleJobs: () => ({ recovered: 0, requeued: 0, deadLettered: 0 }),
      claimNextPending: () => {
        if (claimed) return null
        claimed = true
        return job
      },
      renewJobLease() {
        throw Object.assign(new Error('SQL logic error'), {
          code: 'ERR_SQLITE_ERROR',
          errcode: 1,
        })
      },
      markDone() { terminalWrites += 1 },
      recordJobFailure() { terminalWrites += 1 },
    },
    registry: {
      listHandlers: () => ['test-handler'],
      getHandler: () => (_job, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          abortReason = signal.reason
          reject(signal.reason)
        }, { once: true })
      }),
    },
    logger: silentLogger(),
    createOwnerId: () => 'hub-owner-a',
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  })
  runtime.startHub({ env: { HUB_LEASE_MS: '900' } })
  clock.advance(0)
  await settle()

  clock.advance(300)
  await settle()
  assert.equal(abortReason?.code, 'HUB_JOB_LEASE_LOST')
  assert.equal(terminalWrites, 0)
  assert.equal(runtime.inspect().running, false)
  assert.equal(await runtime.shutdownHub(), 0)
})

test('handler failures and unknown handlers use fenced retry policy arguments', async () => {
  const clock = createClock()
  const failureCalls = []
  const jobs = [
    claimedJob({ id: 'known-failure', attemptCount: 3 }),
    claimedJob({ id: 'unknown-failure', name: 'missing-handler' }),
  ]
  const runtime = createHubRuntime({
    db: {
      claimNextPending: () => jobs.shift() || null,
      renewJobLease() {
        assert.fail('short handlers should not need a heartbeat')
      },
      markDone() {
        assert.fail('failed handlers must not complete')
      },
      recordJobFailure(id, options) {
        failureCalls.push({ id, options: resolveDbOptions(options) })
        return { id, status: options.retryable ? 'pending' : 'failed' }
      },
    },
    registry: {
      getHandler: (name) => name === 'test-handler'
        ? async (handledJob) => {
            handledJob.leaseToken = 'handler-mutated-token'
            throw new Error('handler exploded')
          }
        : null,
    },
    logger: silentLogger(),
    createOwnerId: () => 'hub-owner-a',
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  })

  assert.equal(await runtime.runOnce(), true)
  assert.equal(await runtime.runOnce(), true)
  assert.deepEqual(failureCalls, [
    {
      id: 'known-failure',
      options: {
        ownerId: 'hub-owner-a',
        leaseToken: 'lease-token-a',
        retryable: true,
        backoffMs: 4_000,
        errorMessage: 'handler exploded',
        now: 1_000,
      },
    },
    {
      id: 'unknown-failure',
      options: {
        ownerId: 'hub-owner-a',
        leaseToken: 'lease-token-a',
        retryable: false,
        errorMessage: 'no handler registered for "missing-handler"',
        now: 1_000,
      },
    },
  ])
})

test('retry backoff grows exponentially from attemptCount and caps at 60 seconds', () => {
  assert.equal(hubRetryBackoffMs(1), 1_000)
  assert.equal(hubRetryBackoffMs(2), 2_000)
  assert.equal(hubRetryBackoffMs(3), 4_000)
  assert.equal(hubRetryBackoffMs(7), 60_000)
  assert.equal(hubRetryBackoffMs(100), 60_000)
})

test('retry backoff prevents one tick from exhausting the same job attempts', async () => {
  const clock = createClock()
  const failureCalls = []
  let availableAt = 0
  let attemptCount = 0
  let claimCalls = 0
  const runtime = createHubRuntime({
    db: {
      runHubMigrations() {},
      recoverStaleJobs: () => ({ recovered: 0, requeued: 0, deadLettered: 0 }),
      claimNextPending(options) {
        const resolved = resolveDbOptions(options)
        claimCalls += 1
        if (resolved.now < availableAt || attemptCount >= 2) return null
        attemptCount += 1
        return claimedJob({
          attemptCount,
          leaseToken: `lease-token-${attemptCount}`,
          leaseExpiresAt: resolved.now + resolved.leaseMs,
        })
      },
      renewJobLease() {
        assert.fail('short failing handler must not renew')
      },
      markDone() {
        assert.fail('failing handler must not complete')
      },
      recordJobFailure(id, options) {
        const resolved = resolveDbOptions(options)
        failureCalls.push({ id, options: resolved })
        availableAt = resolved.now + resolved.backoffMs
        return { id, status: 'pending', availableAt }
      },
    },
    registry: {
      listHandlers: () => ['test-handler'],
      getHandler: () => async () => { throw new Error('retry me') },
    },
    logger: silentLogger(),
    closeDb() {},
    createOwnerId: () => 'hub-owner-a',
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  })

  runtime.startHub({ env: { HUB_LEASE_MS: '900', HUB_TICK_MS: '500' } })
  clock.advance(0)
  await settle()
  assert.equal(attemptCount, 1)
  assert.equal(claimCalls, 2, 'tick checks once more, then observes delayed availability')
  assert.equal(failureCalls[0].options.backoffMs, 1_000)

  clock.advance(500)
  await settle()
  assert.equal(attemptCount, 1, 'job remains unavailable at the intermediate tick')

  clock.advance(500)
  await settle()
  assert.equal(attemptCount, 2)
  assert.equal(failureCalls[1].options.backoffMs, 2_000)
  assert.equal(await runtime.shutdownHub(), 0)
})

test('startHub recovers stale work and schedules the first tick at 0ms', async () => {
  const clock = createClock()
  const calls = []
  let closed = 0
  const runtime = createHubRuntime({
    db: {
      runHubMigrations() { calls.push('migrate') },
      recoverStaleJobs(options) {
        calls.push({ recover: resolveDbOptions(options) })
        return { recovered: 2, requeued: 1, deadLettered: 1 }
      },
      claimNextPending(options) {
        calls.push({ claim: resolveDbOptions(options) })
        return null
      },
    },
    registry: { getHandler: () => null, listHandlers: () => ['test-handler'] },
    logger: silentLogger(),
    closeDb: () => { closed += 1 },
    createOwnerId: () => 'hub-owner-start',
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  })

  runtime.startHub({ env: { HUB_LEASE_MS: '900', HUB_TICK_MS: '450' } })
  assert.equal(runtime.inspect().ownerId, 'hub-owner-start')
  assert.equal(clock.nextDelay(), 0)
  assert.deepEqual(calls, ['migrate', { recover: { now: 1_000 } }])

  clock.advance(0)
  await settle()
  assert.deepEqual(calls[2], { recover: { now: 1_000 } })
  assert.deepEqual(calls[3], {
    claim: { ownerId: 'hub-owner-start', now: 1_000, leaseMs: 900 },
  })
  assert.equal(clock.nextDelay(), 450)
  assert.equal(await runtime.shutdownHub(), 0)
  assert.equal(closed, 1)
})

test('startHub validates the registry before mutating the database or entering started state', async () => {
  const clock = createClock()
  const calls = []
  const registry = { getHandler: () => null }
  const runtime = createHubRuntime({
    db: {
      runHubMigrations() { calls.push('migrate') },
      recoverStaleJobs() {
        calls.push('recover')
        return { recovered: 0, requeued: 0, deadLettered: 0 }
      },
      claimNextPending() { return null },
    },
    registry,
    logger: silentLogger(),
    closeDb() {},
    createOwnerId: () => 'hub-owner-validation',
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  })

  assert.throws(
    () => runtime.startHub({ env: { HUB_TICK_MS: '100' } }),
    (error) => error?.code === 'HUB_RUNTIME_DEPENDENCY_MISSING'
      && /listHandlers/.test(error.message),
  )
  assert.deepEqual(calls, [])
  assert.equal(runtime.inspect().started, false)
  assert.equal(runtime.inspect().shuttingDown, false)
  assert.equal(clock.timerCount(), 0)

  registry.listHandlers = () => []
  assert.equal(runtime.startHub({ env: { HUB_TICK_MS: '100' } }), true)
  assert.deepEqual(calls, ['migrate', 'recover'])
  assert.equal(runtime.inspect().started, true)
  assert.equal(clock.nextDelay(), 0)
  assert.equal(await runtime.shutdownHub(), 0)
})

test('tick sweeps before claim and skips the whole tick when recovery is busy', async () => {
  const clock = createClock()
  const events = []
  const errors = []
  let recoveryCalls = 0
  let claimCalls = 0
  const runtime = createHubRuntime({
    db: {
      runHubMigrations() { events.push('migrate') },
      recoverStaleJobs() {
        recoveryCalls += 1
        events.push(`recover-${recoveryCalls}`)
        if (recoveryCalls === 2) {
          throw Object.assign(new Error('sweep busy'), { code: 'SQLITE_BUSY' })
        }
        return recoveryCalls === 3
          ? { recovered: 1, requeued: 1, deadLettered: 0 }
          : { recovered: 0, requeued: 0, deadLettered: 0 }
      },
      claimNextPending() {
        claimCalls += 1
        events.push(`claim-${claimCalls}`)
        return null
      },
    },
    registry: { getHandler: () => null, listHandlers: () => [] },
    logger: { info() {}, error(...args) { errors.push(args.join(' ')) } },
    closeDb() {},
    createOwnerId: () => 'hub-owner-sweep',
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  })

  runtime.startHub({ env: { HUB_TICK_MS: '100' } })
  assert.deepEqual(events, ['migrate', 'recover-1'])
  clock.advance(0)
  await settle()
  assert.deepEqual(events, ['migrate', 'recover-1', 'recover-2'])
  assert.equal(claimCalls, 0, 'busy recovery must not be bypassed by claim')
  assert.ok(errors.some((entry) => entry.includes('tick error: sweep busy')))

  clock.advance(100)
  await settle()
  assert.deepEqual(events, ['migrate', 'recover-1', 'recover-2', 'recover-3', 'claim-1'])
  assert.equal(claimCalls, 1)
  assert.equal(await runtime.shutdownHub(), 0)
})

test('forced shutdown aborts active work and a late handler cannot write terminal state', async () => {
  const clock = createClock()
  const completion = deferred()
  const job = claimedJob()
  let claimed = false
  let closeCount = 0
  let handlerSignal = null
  let terminalWrites = 0
  const runtime = createHubRuntime({
    db: {
      runHubMigrations() {},
      recoverStaleJobs: () => ({ recovered: 0, requeued: 0, deadLettered: 0 }),
      claimNextPending: () => {
        if (claimed) return null
        claimed = true
        return job
      },
      renewJobLease(id, options) {
        const resolved = resolveDbOptions(options)
        return { ...job, id, leaseExpiresAt: resolved.now + resolved.leaseMs }
      },
      markDone() { terminalWrites += 1 },
      recordJobFailure() { terminalWrites += 1 },
    },
    registry: {
      listHandlers: () => ['test-handler'],
      getHandler: () => async (_job, { signal }) => {
        handlerSignal = signal
        return completion.promise
      },
    },
    logger: silentLogger(),
    closeDb: () => { closeCount += 1 },
    createOwnerId: () => 'hub-owner-a',
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    shutdownTimeoutMs: 20,
    shutdownPollMs: 5,
  })

  runtime.startHub({ env: { HUB_LEASE_MS: '900' } })
  clock.advance(0)
  await settle()
  assert.equal(runtime.inspect().activeJobId, 'hub-job-1')

  const shutdown = runtime.shutdownHub()
  clock.advance(20)
  assert.equal(handlerSignal.aborted, true)
  assert.equal(handlerSignal.reason?.code, 'HUB_RUNTIME_SHUTDOWN')
  assert.equal(closeCount, 0, 'DB stays open until the stopped lease expires')

  completion.resolve('too late')
  await settle()
  assert.equal(terminalWrites, 0)
  assert.equal(runtime.inspect().running, false)

  clock.advance(880)
  assert.equal(await shutdown, 1)
  assert.equal(closeCount, 1)
  assert.equal(clock.timerCount(), 0)
})

test('transient terminal SQLITE_BUSY retries inside the live lease without rerunning the handler', async () => {
  const clock = createClock()
  let claimed = false
  let handlerCalls = 0
  let terminalAttempts = 0
  let status = 'pending'
  const job = claimedJob({ leaseExpiresAt: 1_300 })

  const runtime = createHubRuntime({
    db: {
      runHubMigrations() {},
      recoverStaleJobs: () => ({ recovered: 0, requeued: 0, deadLettered: 0 }),
      claimNextPending() {
        if (claimed) return null
        claimed = true
        status = 'running'
        return job
      },
      renewJobLease() {
        assert.fail('terminal retry should finish before the first heartbeat')
      },
      markDone() {
        terminalAttempts += 1
        if (terminalAttempts === 1) {
          throw Object.assign(new Error('terminal write is briefly busy'), { code: 'SQLITE_BUSY' })
        }
        status = 'done'
        return { ...job, status }
      },
      recordJobFailure() {
        assert.fail('successful handler must not record failure')
      },
    },
    registry: {
      listHandlers: () => ['test-handler'],
      getHandler: () => async () => {
        handlerCalls += 1
        return 'completed once'
      },
    },
    logger: silentLogger(),
    closeDb() {},
    createOwnerId: () => 'hub-owner-a',
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  })

  runtime.startHub({ env: { HUB_LEASE_MS: '300', HUB_TICK_MS: '100' } })
  clock.advance(0)
  await settle()
  assert.equal(status, 'running')
  assert.equal(handlerCalls, 1)
  assert.equal(terminalAttempts, 1)
  assert.equal(clock.nextDelay(), 25)

  clock.advance(24)
  await settle()
  assert.equal(terminalAttempts, 1)
  clock.advance(1)
  await settle()

  assert.equal(status, 'done')
  assert.equal(handlerCalls, 1)
  assert.equal(terminalAttempts, 2)
  assert.equal(await runtime.shutdownHub(), 0)
})

test('persistent terminal SQLITE_BUSY is reclaimed only after the lease expires', async () => {
  const clock = createClock()
  const errors = []
  let status = 'pending'
  let leaseExpiresAt = null
  let leaseToken = null
  let attemptCount = 0
  let handlerCalls = 0
  let recoveryCount = 0
  let busyTerminalWrites = 0
  let doneWrites = 0

  const runtime = createHubRuntime({
    db: {
      runHubMigrations() {},
      recoverStaleJobs(options) {
        const { now } = resolveDbOptions(options)
        if (status !== 'running' || leaseExpiresAt > now) {
          return { recovered: 0, requeued: 0, deadLettered: 0 }
        }
        status = 'pending'
        leaseExpiresAt = null
        leaseToken = null
        recoveryCount += 1
        return { recovered: 1, requeued: 1, deadLettered: 0 }
      },
      claimNextPending(options) {
        const resolved = resolveDbOptions(options)
        if (status !== 'pending') return null
        attemptCount += 1
        status = 'running'
        leaseToken = `lease-token-${attemptCount}`
        leaseExpiresAt = resolved.now + resolved.leaseMs
        return claimedJob({
          attemptCount,
          leaseExpiresAt,
          leaseToken,
          status,
        })
      },
      renewJobLease() {
        throw Object.assign(new Error('lease renewal remains busy'), { code: 'SQLITE_BUSY' })
      },
      markDone() {
        doneWrites += 1
        status = 'done'
        leaseExpiresAt = null
        leaseToken = null
        return claimedJob({ attemptCount, status })
      },
      recordJobFailure() {
        busyTerminalWrites += 1
        throw Object.assign(new Error('terminal write is busy'), { code: 'SQLITE_BUSY' })
      },
    },
    registry: {
      listHandlers: () => ['test-handler'],
      getHandler: () => async () => {
        handlerCalls += 1
        if (handlerCalls === 1) throw new Error('retry after terminal contention')
        return 'recovered on the next claim'
      },
    },
    logger: { info() {}, error(...args) { errors.push(args.join(' ')) } },
    closeDb() {},
    createOwnerId: () => 'hub-owner-a',
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  })

  runtime.startHub({ env: { HUB_LEASE_MS: '300', HUB_TICK_MS: '100' } })
  clock.advance(0)
  await settle()
  assert.equal(status, 'running')
  assert.equal(attemptCount, 1)
  assert.equal(busyTerminalWrites, 1)

  clock.advance(299)
  await settle()
  assert.equal(status, 'running', 'the live proof must not be recovered early')
  assert.equal(handlerCalls, 1)
  assert.ok(busyTerminalWrites > 1)

  clock.advance(1)
  await settle()
  assert.equal(recoveryCount, 0, 'expiry fences the writer before the next sweep')
  assert.equal(handlerCalls, 1)

  clock.advance(100)
  await settle()
  assert.equal(recoveryCount, 1)
  assert.equal(attemptCount, 2)
  assert.equal(handlerCalls, 2)
  assert.equal(doneWrites, 1)
  assert.equal(status, 'done')
  assert.equal(errors.some((entry) => entry.includes('tick error: terminal write is busy')), false)
  assert.equal(await runtime.shutdownHub(), 0)
})

test('handlers settling after forced shutdown closes the DB never access it again', async () => {
  for (const settlement of ['resolve', 'reject']) {
    const clock = createClock()
    const completion = deferred()
    const ownerId = `hub-owner-${settlement}`
    const job = claimedJob({ leaseOwner: ownerId })
    let claimed = false
    let databaseClosed = false
    let postCloseCalls = 0
    let terminalWrites = 0
    let handlerSignal = null

    const observeDbCall = () => {
      if (databaseClosed) postCloseCalls += 1
    }
    const runtime = createHubRuntime({
      db: {
        runHubMigrations() { observeDbCall() },
        recoverStaleJobs() {
          observeDbCall()
          return { recovered: 0, requeued: 0, deadLettered: 0 }
        },
        claimNextPending() {
          observeDbCall()
          if (claimed) return null
          claimed = true
          return job
        },
        renewJobLease() {
          observeDbCall()
          return job
        },
        markDone() {
          observeDbCall()
          terminalWrites += 1
          return { ...job, status: 'done' }
        },
        recordJobFailure() {
          observeDbCall()
          terminalWrites += 1
          return { ...job, status: 'failed' }
        },
      },
      registry: {
        listHandlers: () => ['test-handler'],
        getHandler: () => async (_job, { signal }) => {
          handlerSignal = signal
          return completion.promise
        },
      },
      logger: silentLogger(),
      closeDb: () => { databaseClosed = true },
      createOwnerId: () => ownerId,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      shutdownTimeoutMs: 20,
      shutdownPollMs: 5,
    })

    runtime.startHub({ env: { HUB_LEASE_MS: '900' } })
    clock.advance(0)
    await settle()
    const shutdown = runtime.shutdownHub()
    clock.advance(20)
    assert.equal(handlerSignal.aborted, true)
    clock.advance(880)
    assert.equal(await shutdown, 1)
    assert.equal(databaseClosed, true)

    if (settlement === 'resolve') completion.resolve('finished after close')
    else completion.reject(new Error('failed after close'))
    await settle()

    assert.equal(postCloseCalls, 0, `${settlement} must not touch the closed DB`)
    assert.equal(terminalWrites, 0)
    assert.equal(runtime.inspect().running, false)
    assert.equal(clock.timerCount(), 0)
  }
})
