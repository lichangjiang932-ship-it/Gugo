import assert from 'node:assert/strict'
import test from 'node:test'

import Database from '../server/adapters/sqliteDriver.js'
import {
  HUB_SCHEMA_VERSION,
  claimNextPending,
  enqueueJob,
  getJob,
  markDone,
  recordJobFailure,
  recoverStaleJobs,
  renewJobLease,
  runHubMigrations,
} from '../server/hub/hubDb.js'

function createMetaDb(version = null) {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  if (version != null) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run('hub_schema_version', String(version))
  }
  return db
}

function createV2Db() {
  const db = createMetaDb(2)
  db.exec(`
    CREATE TABLE hub_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_run_at INTEGER,
      consumed_at INTEGER,
      last_error TEXT
    );
    CREATE INDEX idx_hub_jobs_status ON hub_jobs(status, created_at);
    CREATE INDEX idx_hub_jobs_consumable ON hub_jobs(status, consumed_at, created_at);
  `)
  return db
}

function createCurrentDb() {
  const db = createMetaDb()
  runHubMigrations(db)
  return db
}

function observeTransactionCallbacks(db) {
  let phase = 'outside'
  const observedDb = {
    prepare: db.prepare.bind(db),
    transaction(callback) {
      const transaction = db.transaction((...args) => {
        phase = 'callback'
        try {
          return callback(...args)
        } finally {
          phase = 'outside'
        }
      })
      const wrapped = (...args) => transaction(...args)
      for (const mode of ['deferred', 'immediate', 'exclusive']) {
        if (typeof transaction[mode] === 'function') {
          wrapped[mode] = (...args) => transaction[mode](...args)
        }
      }
      return wrapped
    },
  }
  return {
    db: observedDb,
    clock(label, value, calls) {
      return () => {
        assert.equal(phase, 'callback', `${label} sampled time before the write transaction`)
        calls.push(label)
        return value
      }
    },
  }
}

function isLeaseLost(error) {
  return error?.code === 'HUB_JOB_LEASE_LOST'
}

test('Hub v3 migration backfills pending availability and recovers legacy running rows', () => {
  const db = createV2Db()
  try {
    db.prepare(`
      INSERT INTO hub_jobs (
        id, name, payload, status, created_at, updated_at, last_run_at, consumed_at, last_error
      ) VALUES (?, 'echo', NULL, 'pending', ?, ?, NULL, NULL, NULL)
    `).run('legacy-pending', 100, 110)
    db.prepare(`
      INSERT INTO hub_jobs (
        id, name, payload, status, created_at, updated_at, last_run_at, consumed_at, last_error
      ) VALUES (?, 'echo', NULL, 'running', ?, ?, ?, ?, NULL)
    `).run('legacy-running', 200, 220, 210, 210)

    assert.equal(runHubMigrations(db), HUB_SCHEMA_VERSION)
    assert.equal(runHubMigrations(db), HUB_SCHEMA_VERSION, 'migration must be idempotent')

    const columns = new Set(db.prepare('PRAGMA table_info(hub_jobs)').all().map((row) => row.name))
    for (const column of [
      'attempt_count',
      'max_attempts',
      'available_at',
      'lease_owner',
      'lease_token',
      'lease_expires_at',
      'heartbeat_at',
      'dead_lettered_at',
    ]) {
      assert.ok(columns.has(column), `missing v3 column ${column}`)
    }

    const pending = getJob('legacy-pending', db)
    assert.equal(pending.availableAt, 100)
    assert.equal(pending.attemptCount, 0)
    assert.equal(pending.maxAttempts, 5)

    const recovery = recoverStaleJobs({ now: 300 }, db)
    assert.deepEqual(recovery, { recovered: 1, requeued: 1, deadLettered: 0 })
    const recovered = getJob('legacy-running', db)
    assert.equal(recovered.status, 'pending')
    assert.equal(recovered.availableAt, 300)
    assert.equal(recovered.attemptCount, 1)
    assert.equal(recovered.consumedAt, 210)
    assert.equal(recovered.leaseOwner, null)

    const version = db.prepare("SELECT value FROM meta WHERE key = 'hub_schema_version'").get()
    assert.equal(version.value, String(HUB_SCHEMA_VERSION))
  } finally {
    db.close()
  }
})

test('Hub schema metadata rejects invalid, negative, and future versions before writes', () => {
  const cases = [
    ['not-a-number', 'HUB_SCHEMA_VERSION_INVALID'],
    [-1, 'HUB_SCHEMA_VERSION_INVALID'],
    [HUB_SCHEMA_VERSION + 1, 'HUB_SCHEMA_VERSION_UNSUPPORTED'],
  ]

  for (const [version, code] of cases) {
    const db = createMetaDb(version)
    try {
      assert.throws(() => runHubMigrations(db), (error) => error?.code === code)
      const table = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hub_jobs'"
      ).get()
      assert.equal(table, undefined, `version ${version} must fail before creating hub_jobs`)
      const stored = db.prepare("SELECT value FROM meta WHERE key = 'hub_schema_version'").get()
      assert.equal(stored.value, String(version))
    } finally {
      db.close()
    }
  }
})

test('claim is exclusive and renew/terminal writes require the exact live lease proof', () => {
  const db = createCurrentDb()
  try {
    const now = Date.now()
    const queued = enqueueJob({ name: 'echo', availableAt: now }, db)
    const claimed = claimNextPending({ ownerId: 'owner-a', now, leaseMs: 100 }, db)

    assert.equal(claimed.id, queued.id)
    assert.equal(claimed.status, 'running')
    assert.equal(claimed.leaseOwner, 'owner-a')
    assert.ok(claimed.leaseToken)
    assert.equal(claimed.leaseExpiresAt, now + 100)
    assert.equal(claimed.attemptCount, 1)
    assert.equal(claimed.consumedAt, now)
    assert.equal(
      claimNextPending({ ownerId: 'owner-b', now: now + 1, leaseMs: 100 }, db),
      null
    )

    assert.throws(() => renewJobLease(claimed.id, {
      ownerId: 'owner-a',
      leaseToken: 'wrong-token',
      now: now + 1,
      leaseMs: 100,
    }, db), isLeaseLost)
    assert.throws(() => markDone(claimed.id, {
      ownerId: 'owner-b',
      leaseToken: claimed.leaseToken,
      now: now + 1,
    }, db), isLeaseLost)

    const renewed = renewJobLease(claimed.id, {
      ownerId: claimed.leaseOwner,
      leaseToken: claimed.leaseToken,
      now: now + 2,
      leaseMs: 200,
    }, db)
    assert.equal(renewed.leaseExpiresAt, now + 202)
    assert.equal(renewed.heartbeatAt, now + 2)

    const done = markDone(claimed.id, {
      ownerId: claimed.leaseOwner,
      leaseToken: claimed.leaseToken,
      now: now + 3,
      lastError: 'echo:ok',
    }, db)
    assert.equal(done.status, 'done')
    assert.equal(done.lastError, 'echo:ok')
    assert.equal(done.leaseOwner, null)
    assert.equal(done.leaseToken, null)
    assert.equal(done.leaseExpiresAt, null)
    assert.equal(done.heartbeatAt, null)
  } finally {
    db.close()
  }
})

test('stale recovery fences every old token write after the same owner reclaims the job', () => {
  const db = createCurrentDb()
  try {
    const now = Date.now()
    const queued = enqueueJob({ name: 'echo', availableAt: now }, db)
    const first = claimNextPending({ ownerId: 'owner-a', now, leaseMs: 100 }, db)

    assert.deepEqual(
      recoverStaleJobs({ now: now + 100 }, db),
      { recovered: 1, requeued: 1, deadLettered: 0 }
    )
    const second = claimNextPending({ ownerId: 'owner-a', now: now + 100, leaseMs: 100 }, db)
    assert.equal(second.id, queued.id)
    assert.equal(second.leaseOwner, first.leaseOwner)
    assert.notEqual(second.leaseToken, first.leaseToken)
    assert.equal(second.attemptCount, 2)
    assert.equal(second.consumedAt, first.consumedAt, 'consumed_at records only the first claim')

    const staleProof = {
      ownerId: first.leaseOwner,
      leaseToken: first.leaseToken,
      now: now + 101,
    }
    assert.throws(() => renewJobLease(first.id, {
      ...staleProof,
      leaseMs: 100,
    }, db), isLeaseLost)
    assert.throws(() => markDone(first.id, staleProof, db), isLeaseLost)
    assert.throws(() => recordJobFailure(first.id, {
      ...staleProof,
      retryable: true,
      errorMessage: 'late first attempt',
    }, db), isLeaseLost)

    const unchanged = getJob(second.id, db)
    assert.equal(unchanged.status, 'running')
    assert.equal(unchanged.leaseOwner, second.leaseOwner)
    assert.equal(unchanged.leaseToken, second.leaseToken)

    const done = markDone(second.id, {
      ownerId: second.leaseOwner,
      leaseToken: second.leaseToken,
      now: now + 101,
    }, db)
    assert.equal(done.status, 'done')
  } finally {
    db.close()
  }
})

test('legacy claims return a proof but id-only terminal writes fail closed across generations', () => {
  const db = createCurrentDb()
  try {
    const now = Date.now()
    const queued = enqueueJob({ name: 'echo', availableAt: now }, db)
    const first = claimNextPending({ now, leaseMs: 100 }, db)

    recoverStaleJobs({ now: now + 100 }, db)
    const second = claimNextPending({ now: now + 100, leaseMs: 100 }, db)
    assert.equal(second.id, queued.id)
    assert.equal(second.leaseOwner, first.leaseOwner)
    assert.notEqual(second.leaseToken, first.leaseToken)

    assert.throws(() => markDone(second.id, { now: now + 101 }, db), {
      name: 'TypeError',
      message: 'ownerId must be a non-empty string',
    })
    assert.equal(getJob(second.id, db).status, 'running')

    assert.equal(markDone(second.id, {
      ownerId: second.leaseOwner,
      leaseToken: second.leaseToken,
      now: now + 101,
    }, db).status, 'done')
  } finally {
    db.close()
  }
})

test('retry backoff is respected and exhausted attempts enter dead letter', () => {
  const db = createCurrentDb()
  try {
    const now = Date.now()
    enqueueJob({ name: 'echo', maxAttempts: 2, availableAt: now }, db)
    const first = claimNextPending({ ownerId: 'owner-a', now, leaseMs: 1_000 }, db)
    const retry = recordJobFailure(first.id, {
      ownerId: first.leaseOwner,
      leaseToken: first.leaseToken,
      now: now + 10,
      retryable: true,
      backoffMs: 50,
      errorMessage: 'temporary',
    }, db)

    assert.equal(retry.status, 'pending')
    assert.equal(retry.availableAt, now + 60)
    assert.equal(retry.deadLetteredAt, null)
    assert.equal(retry.leaseOwner, null)
    assert.equal(
      claimNextPending({ ownerId: 'owner-b', now: now + 59, leaseMs: 1_000 }, db),
      null
    )

    const second = claimNextPending({ ownerId: 'owner-b', now: now + 60, leaseMs: 1_000 }, db)
    assert.equal(second.attemptCount, 2)
    const failed = recordJobFailure(second.id, {
      ownerId: second.leaseOwner,
      leaseToken: second.leaseToken,
      now: now + 61,
      retryable: true,
      backoffMs: 50,
      errorMessage: 'still broken',
    }, db)

    assert.equal(failed.status, 'failed')
    assert.equal(failed.lastError, 'still broken')
    assert.equal(failed.availableAt, null)
    assert.equal(failed.deadLetteredAt, now + 61)
    assert.equal(failed.leaseOwner, null)
    assert.equal(failed.leaseToken, null)
    assert.equal(
      claimNextPending({ ownerId: 'owner-c', now: now + 1_000, leaseMs: 1_000 }, db),
      null
    )

    enqueueJob({ name: 'echo', maxAttempts: 3, availableAt: now + 2_000 }, db)
    const nonRetryable = claimNextPending({
      ownerId: 'owner-c',
      now: now + 2_000,
      leaseMs: 1_000,
    }, db)
    const ordinaryFailure = recordJobFailure(nonRetryable.id, {
      ownerId: nonRetryable.leaseOwner,
      leaseToken: nonRetryable.leaseToken,
      now: now + 2_001,
      retryable: false,
      errorMessage: 'permanent validation error',
    }, db)
    assert.equal(ordinaryFailure.status, 'failed')
    assert.equal(ordinaryFailure.deadLetteredAt, null)
  } finally {
    db.close()
  }
})

test('lease clocks are sampled only after entering each immediate transaction', () => {
  const db = createCurrentDb()
  try {
    const observed = observeTransactionCallbacks(db)
    const calls = []
    const now = Date.now()

    enqueueJob({ name: 'echo', availableAt: now }, db)
    const first = claimNextPending({
      ownerId: 'owner-a',
      now: observed.clock('claim', now, calls),
      leaseMs: 100,
    }, observed.db)
    const renewed = renewJobLease(first.id, {
      ownerId: first.leaseOwner,
      leaseToken: first.leaseToken,
      now: observed.clock('renew', now + 1, calls),
      leaseMs: 100,
    }, observed.db)
    markDone(first.id, {
      ownerId: first.leaseOwner,
      leaseToken: first.leaseToken,
      now: observed.clock('done', now + 2, calls),
    }, observed.db)
    assert.equal(renewed.heartbeatAt, now + 1)

    enqueueJob({ name: 'echo', availableAt: now + 3 }, db)
    const second = claimNextPending({
      ownerId: 'owner-b',
      now: now + 3,
      leaseMs: 100,
    }, db)
    recordJobFailure(second.id, {
      ownerId: second.leaseOwner,
      leaseToken: second.leaseToken,
      now: observed.clock('failure', now + 4, calls),
      retryable: false,
      errorMessage: 'permanent',
    }, observed.db)

    enqueueJob({ name: 'echo', availableAt: now + 5 }, db)
    claimNextPending({ ownerId: 'owner-c', now: now + 5, leaseMs: 10 }, db)
    const recovery = recoverStaleJobs({
      now: observed.clock('recovery', now + 15, calls),
    }, observed.db)

    assert.deepEqual(calls, ['claim', 'renew', 'done', 'failure', 'recovery'])
    assert.deepEqual(recovery, { recovered: 1, requeued: 1, deadLettered: 0 })
  } finally {
    db.close()
  }
})

test('lease proof is rejected at the sampled expiry deadline', () => {
  const db = createCurrentDb()
  try {
    const now = Date.now()
    enqueueJob({ name: 'echo', availableAt: now }, db)
    const claimed = claimNextPending({ ownerId: 'owner-a', now, leaseMs: 10 }, db)
    const expiredClock = () => now + 10
    const proof = {
      ownerId: claimed.leaseOwner,
      leaseToken: claimed.leaseToken,
      now: expiredClock,
    }

    assert.throws(() => renewJobLease(claimed.id, {
      ...proof,
      leaseMs: 100,
    }, db), isLeaseLost)
    assert.throws(() => markDone(claimed.id, proof, db), isLeaseLost)
    assert.throws(() => recordJobFailure(claimed.id, {
      ...proof,
      retryable: true,
      errorMessage: 'late failure',
    }, db), isLeaseLost)

    const unchanged = getJob(claimed.id, db)
    assert.equal(unchanged.status, 'running')
    assert.equal(unchanged.leaseOwner, claimed.leaseOwner)
    assert.equal(unchanged.leaseToken, claimed.leaseToken)
    assert.equal(unchanged.leaseExpiresAt, now + 10)
  } finally {
    db.close()
  }
})
