import assert from 'node:assert/strict'
import test from 'node:test'

import { createHubRuntime } from '../server/hub/runtime.js'
import {
  createHubSessionDeletionRecoveryBarrier,
} from '../server/hub/sessionDeletionRecoveryBarrier.js'

function silentLogger() {
  return { info() {}, error() {} }
}

function runtimeDependencies(overrides = {}) {
  return {
    db: {
      runHubMigrations() {},
      recoverStaleJobs: () => ({ recovered: 0, requeued: 0, deadLettered: 0 }),
      claimNextPending: () => null,
      ...overrides.db,
    },
    registry: {
      listHandlers: () => [],
      getHandler: () => null,
      ...overrides.registry,
    },
    logger: silentLogger(),
    closeDb() {},
    createOwnerId: () => 'hub-recovery-test',
    setTimeoutFn: () => Object.freeze({ id: 'hub-timer' }),
    clearTimeoutFn() {},
    ...overrides,
  }
}

test('Hub recovery assembly activates the production-shaped port before recovery and releases it', () => {
  const events = []
  const db = Object.freeze({ id: 'shared-db' })
  const runtimeEnv = Object.freeze({ APP_DATA_DIR: 'hub-data' })
  const adapter = Object.freeze({ id: 'archive-adapter' })
  const controller = {
    activate() { events.push('activate') },
    release() { events.push('release') },
  }
  const barrier = createHubSessionDeletionRecoveryBarrier({
    getDb: () => {
      events.push('database')
      return db
    },
    createCompactionArchiveAdapter: (options) => {
      events.push('adapter')
      assert.strictEqual(options.db, db)
      assert.strictEqual(options.env, runtimeEnv)
      return adapter
    },
    createCompactionArchivePortController: (input, options) => {
      events.push('controller')
      assert.strictEqual(input, adapter)
      assert.deepEqual(options, { source: 'hub.runtime' })
      return controller
    },
    recoverPendingSessionDeletion: (options) => {
      events.push('recover')
      assert.strictEqual(options.db, db)
      return { recovered: true }
    },
  })

  assert.deepEqual(barrier.start({ env: runtimeEnv }), { recovered: true })
  assert.equal(barrier.stop(), true)
  assert.equal(barrier.stop(), false)
  assert.deepEqual(events, [
    'database',
    'adapter',
    'controller',
    'activate',
    'recover',
    'release',
  ])
})

test('Hub recovery assembly releases its port and preserves a recovery failure', () => {
  const recoveryError = new Error('pending session deletion is inconsistent')
  const events = []
  const barrier = createHubSessionDeletionRecoveryBarrier({
    getDb: () => ({}),
    createCompactionArchiveAdapter: () => ({}),
    createCompactionArchivePortController: () => ({
      activate() { events.push('activate') },
      release() { events.push('release') },
    }),
    recoverPendingSessionDeletion: () => {
      events.push('recover')
      throw recoveryError
    },
  })

  assert.throws(() => barrier.start(), (error) => error === recoveryError)
  assert.equal(barrier.stop(), false)
  assert.deepEqual(events, ['activate', 'recover', 'release'])
})

test('startHub crosses the session recovery barrier before Hub database work and dispatch', async () => {
  const events = []
  const runtime = createHubRuntime(runtimeDependencies({
    sessionDeletionRecoveryBarrier: {
      start() { events.push('barrier:start') },
      stop() { events.push('barrier:stop') },
    },
    db: {
      runHubMigrations() { events.push('hub:migrate') },
      recoverStaleJobs() {
        events.push('hub:recover')
        return { recovered: 0, requeued: 0, deadLettered: 0 }
      },
      claimNextPending() {
        events.push('hub:claim')
        return null
      },
    },
    setTimeoutFn(_callback, delay) {
      events.push(`timer:${delay}`)
      return Object.freeze({ id: 'hub-timer' })
    },
    clearTimeoutFn() { events.push('timer:clear') },
    closeDb() { events.push('database:close') },
  }))

  assert.equal(runtime.startHub({ env: { HUB_TICK_MS: '100' } }), true)
  assert.equal(runtime.inspect().sessionDeletionRecoveryReady, true)
  assert.deepEqual(events, ['barrier:start', 'hub:migrate', 'hub:recover', 'timer:0'])

  assert.equal(await runtime.shutdownHub(), 0)
  assert.deepEqual(events, [
    'barrier:start',
    'hub:migrate',
    'hub:recover',
    'timer:0',
    'timer:clear',
    'barrier:stop',
    'database:close',
  ])
  assert.equal(events.includes('hub:claim'), false)
})

test('startHub fails closed when recovery fails and never opens the queue', () => {
  const recoveryError = new Error('session deletion recovery failed')
  const events = []
  const runtime = createHubRuntime(runtimeDependencies({
    sessionDeletionRecoveryBarrier: {
      start() {
        events.push('barrier:start')
        throw recoveryError
      },
      stop() { events.push('barrier:stop') },
    },
    db: {
      runHubMigrations() { events.push('hub:migrate') },
      recoverStaleJobs() {
        events.push('hub:recover')
        return { recovered: 0, requeued: 0, deadLettered: 0 }
      },
      claimNextPending() {
        events.push('hub:claim')
        return null
      },
    },
    setTimeoutFn() {
      events.push('timer')
      return Object.freeze({ id: 'hub-timer' })
    },
  }))

  assert.throws(() => runtime.startHub(), (error) => error === recoveryError)
  assert.deepEqual(events, ['barrier:start'])
  assert.equal(runtime.inspect().started, false)
  assert.equal(runtime.inspect().sessionDeletionRecoveryReady, false)
})

test('startHub rolls back an activated recovery barrier when later startup fails', () => {
  const migrationError = new Error('Hub migration failed')
  const events = []
  const runtime = createHubRuntime(runtimeDependencies({
    sessionDeletionRecoveryBarrier: {
      start() { events.push('barrier:start') },
      stop() { events.push('barrier:stop') },
    },
    db: {
      runHubMigrations() {
        events.push('hub:migrate')
        throw migrationError
      },
    },
  }))

  assert.throws(() => runtime.startHub(), (error) => error === migrationError)
  assert.deepEqual(events, ['barrier:start', 'hub:migrate', 'barrier:stop'])
  assert.equal(runtime.inspect().started, false)
  assert.equal(runtime.inspect().sessionDeletionRecoveryReady, false)
})

test('direct runOnce cannot dispatch a handler before session deletion recovery', async () => {
  const events = []
  const job = {
    id: 'hub-job-recovery',
    name: 'echo',
    payload: null,
    status: 'running',
    leaseOwner: 'hub-recovery-test',
    leaseToken: 'lease-token-recovery',
    leaseExpiresAt: Date.now() + 60_000,
  }
  let claimed = false
  const runtime = createHubRuntime(runtimeDependencies({
    sessionDeletionRecoveryBarrier: {
      start() { events.push('barrier:start') },
      stop() { events.push('barrier:stop') },
    },
    db: {
      claimNextPending() {
        events.push('hub:claim')
        if (claimed) return null
        claimed = true
        return job
      },
      renewJobLease() { return job },
      markDone() {
        events.push('hub:done')
        return { ...job, status: 'done' }
      },
      recordJobFailure() {
        assert.fail('successful handler must not fail')
      },
    },
    registry: {
      getHandler: () => async () => {
        events.push('handler')
        return 'done'
      },
    },
    closeDb() { events.push('database:close') },
  }))

  assert.equal(await runtime.runOnce(), true)
  assert.deepEqual(events.slice(0, 4), ['barrier:start', 'hub:claim', 'handler', 'hub:done'])
  assert.equal(await runtime.shutdownHub(), 0)
  assert.deepEqual(events.slice(-2), ['barrier:stop', 'database:close'])
})
