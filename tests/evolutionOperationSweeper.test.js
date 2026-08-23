import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-operation-sweeper-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const { closeDb, getDb } = await import('../server/db.js')
const {
  claimEvolutionOperation,
  getEvolutionOperation,
  openEvolutionOperation,
  sweepExpiredEvolutionOperations,
} = await import('../server/services/evolutionOperationService.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

getDb()

function openAndClaim(userId, key, {
  openedAt = 1,
  claimedAt = 2,
  leaseMs = 1_000,
  monotonicAt = 0,
} = {}) {
  const operation = openEvolutionOperation({
    userId,
    kind: 'candidate',
    idempotencyKey: key,
    request: { objective: key },
    now: openedAt,
  })
  const claim = claimEvolutionOperation({
    userId,
    id: operation.id,
    stage: 'candidate:model_call',
    leaseMs,
    now: claimedAt,
    monotonicNow: () => monotonicAt,
  })
  return { operation, claim }
}

test.beforeEach(() => {
  getDb().prepare('DELETE FROM evolution_operations').run()
})

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('sweep freezes expired and future-timestamp rows without touching an active lease', () => {
  const session = issueTestSession({ email: 'evolution-sweep-evidence@example.com' })
  const active = openAndClaim(session.userId, 'sweep-active', {
    openedAt: 99,
    claimedAt: 100,
    leaseMs: 10_000,
  })
  const expired = openAndClaim(session.userId, 'sweep-expired', {
    openedAt: 99,
    claimedAt: 100,
    leaseMs: 1_000,
  })
  const rollback = openAndClaim(session.userId, 'sweep-clock-rollback', {
    openedAt: 1_999,
    claimedAt: 2_000,
    leaseMs: 10_000,
  })

  const result = sweepExpiredEvolutionOperations({
    now: 1_500,
    monotonicNow: () => 100,
    limit: 10,
  })

  assert.equal(result.frozen, 2)
  assert.deepEqual(new Set(result.frozenIds), new Set([expired.operation.id, rollback.operation.id]))
  assert.equal(getEvolutionOperation({ userId: session.userId, id: active.operation.id }).state, 'running')
  assert.equal(
    getEvolutionOperation({ userId: session.userId, id: expired.operation.id }).error.code,
    'EVOLUTION_OPERATION_LEASE_EXPIRED',
  )
  assert.equal(
    getEvolutionOperation({ userId: session.userId, id: rollback.operation.id }).error.code,
    'EVOLUTION_OPERATION_CLOCK_ROLLBACK',
  )
})

test('sweep is batch-bounded and repeated instances converge through CAS', () => {
  const session = issueTestSession({ email: 'evolution-sweep-bounded@example.com' })
  const operations = Array.from({ length: 3 }, (_, index) => openAndClaim(
    session.userId,
    `sweep-bounded-${index}`,
  ).operation)

  const first = sweepExpiredEvolutionOperations({ now: 1_002, limit: 2 })
  assert.equal(first.frozen, 2)
  assert.equal(first.hasMore, true)

  const second = sweepExpiredEvolutionOperations({ now: 1_002, limit: 2 })
  assert.equal(second.frozen, 1)
  assert.equal(second.hasMore, false)

  const losingInstance = sweepExpiredEvolutionOperations({ now: 1_002, limit: 2 })
  assert.equal(losingInstance.frozen, 0)
  assert.equal(losingInstance.hasMore, false)
  assert.deepEqual(
    operations.map((operation) => getEvolutionOperation({
      userId: session.userId,
      id: operation.id,
    }).state),
    ['blocked', 'blocked', 'blocked'],
  )
})

test('sweep freezes a locally lost monotonic lease before its wall-clock deadline', () => {
  const session = issueTestSession({ email: 'evolution-sweep-monotonic@example.com' })
  const { operation } = openAndClaim(session.userId, 'sweep-monotonic-lost', {
    openedAt: 99,
    claimedAt: 100,
    leaseMs: 1_000,
    monotonicAt: 0,
  })

  const result = sweepExpiredEvolutionOperations({
    now: 500,
    monotonicNow: () => 1_000,
    limit: 1_000,
  })

  assert.equal(result.frozen, 1)
  assert.deepEqual(result.frozenIds, [operation.id])
  assert.equal(getEvolutionOperation({ userId: session.userId, id: operation.id }).state, 'blocked')
})

test('sweep exposes SQLite writer contention as a retryable busy result', () => {
  const session = issueTestSession({ email: 'evolution-sweep-busy@example.com' })
  const { operation } = openAndClaim(session.userId, 'sweep-busy')
  const primaryDb = getDb()
  const secondDb = new Database(process.env.APP_DB_PATH)
  secondDb.pragma('journal_mode = WAL')
  primaryDb.pragma('busy_timeout = 1')
  secondDb.exec('BEGIN IMMEDIATE')
  try {
    assert.throws(
      () => sweepExpiredEvolutionOperations({ now: 1_002 }),
      (error) => error?.code === 'EVOLUTION_OPERATION_SWEEP_BUSY' && error?.retryable === true,
    )
    assert.equal(getEvolutionOperation({ userId: session.userId, id: operation.id }).state, 'running')
  } finally {
    secondDb.exec('ROLLBACK')
    secondDb.close()
    primaryDb.pragma('busy_timeout = 5000')
  }

  assert.equal(sweepExpiredEvolutionOperations({ now: 1_002 }).frozen, 1)
})
