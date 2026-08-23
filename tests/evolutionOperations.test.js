import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-operations-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const { closeDb, getDb } = await import('../server/db.js')
const { handleEvolutionRequest } = await import('../server/routes/evolutionRoutes.js')
const { generateEvolutionCandidate } = await import('../server/services/evolutionCandidateService.js')
const { buildEvolutionDataset } = await import('../server/services/evolutionDatasetService.js')
const { appendEvolutionFeedback } = await import('../server/services/evolutionEvidenceStore.js')
const { evaluateEvolutionReplay } = await import('../server/services/evolutionEvaluationService.js')
const {
  blockEvolutionOperation,
  claimEvolutionOperation,
  checkpointEvolutionOperation,
  commitEvolutionOperation,
  failEvolutionOperation,
  getEvolutionOperation,
  MAX_EVOLUTION_OPERATION_LEASE_MS,
  openEvolutionOperation,
  reconcileExpiredEvolutionOperation,
  recoverEvolutionOperationNotSent,
  renewEvolutionOperationLease,
} = await import('../server/services/evolutionOperationService.js')
const {
  createEvolutionReplaySuite,
  runEvolutionReplay,
} = await import('../server/services/evolutionReplayService.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

getDb()
let candidateCalls = 0
let replayModel = async () => ({
  providerId: 'replay-provider',
  modelName: 'replay-model',
  content: 'replay output',
})
let candidateModel = async () => {
  candidateCalls += 1
  return {
    providerId: 'candidate-provider',
    modelName: 'candidate-model',
    content: JSON.stringify({
      title: 'Durable candidate',
      summary: 'Persist model-backed evolution work',
      content: 'Keep evolution operations resumable.',
      assumptions: [],
      expectedImpact: ['Avoid duplicate model work'],
      permissionsRequested: [],
    }),
  }
}
const server = http.createServer((req, res) => handleEvolutionRequest(req, res, {
  runCandidateModel: (input) => candidateModel(input),
  runReplayModel: (input) => replayModel(input),
}))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

function authHeaders(token, { json = false, idempotencyKey = null } = {}) {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  }
}

function seedDataset(userId, feedback) {
  appendEvolutionFeedback({ userId, feedback })
  return buildEvolutionDataset({ userId, limit: 200 })
}

function candidateInput(dataset, overrides = {}) {
  return {
    kind: 'prompt',
    target: 'prompt:durable-operation',
    objective: 'Make evolution work durable and observable',
    datasetFingerprint: dataset.datasetFingerprint,
    sourceRecordIds: [dataset.records[0].id],
    providerId: 'candidate-provider',
    modelName: 'candidate-model',
    ...overrides,
  }
}

async function postJson(token, pathname, body, idempotencyKey = null) {
  return fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: authHeaders(token, { json: true, idempotencyKey }),
    body: JSON.stringify(body || {}),
  })
}

function injectEvolutionOperationCommitFailure(operationId) {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_evolution_commit_failure_parents (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS test_evolution_commit_failure_children (
      operation_id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL REFERENCES test_evolution_commit_failure_parents(id)
        DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE IF NOT EXISTS test_evolution_commit_failure_targets (
      operation_id TEXT PRIMARY KEY
    );
    CREATE TRIGGER IF NOT EXISTS test_evolution_operation_commit_failure
    AFTER UPDATE ON evolution_operations
    WHEN EXISTS (
      SELECT 1 FROM test_evolution_commit_failure_targets
      WHERE operation_id = NEW.id
    )
    BEGIN
      INSERT INTO test_evolution_commit_failure_children (operation_id, parent_id)
      VALUES (NEW.id, 'missing-parent');
    END;
  `)
  db.prepare(`
    INSERT OR REPLACE INTO test_evolution_commit_failure_targets (operation_id) VALUES (?)
  `).run(operationId)
  return () => db.prepare(`
    DELETE FROM test_evolution_commit_failure_targets WHERE operation_id = ?
  `).run(operationId)
}

function assertEvolutionOperationCommitFailure(callback) {
  assert.throws(callback, (error) => error?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY')
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('candidate HTTP idempotency replays one completed result and rejects identity drift', async () => {
  const alice = issueTestSession({ email: 'evolution-operation-alice@example.com' })
  const bob = issueTestSession({ email: 'evolution-operation-bob@example.com' })
  const dataset = seedDataset(alice.userId, 'Candidate requests must survive client retries')
  const input = candidateInput(dataset)
  const key = 'candidate-http-idempotency-1'
  candidateCalls = 0

  const firstResponse = await postJson(alice.token, '/api/evolution/candidates/generate', input, key)
  assert.equal(firstResponse.status, 201)
  const first = await firstResponse.json()
  const operationId = firstResponse.headers.get('x-evolution-operation-id')
  assert.ok(operationId)
  assert.equal(first.operation.id, operationId)
  assert.equal(first.operation.state, 'completed')

  const replayedResponse = await postJson(alice.token, '/api/evolution/candidates/generate', input, key)
  assert.equal(replayedResponse.status, 201)
  const replayed = await replayedResponse.json()
  assert.equal(replayed.candidate.id, first.candidate.id)
  assert.equal(replayed.operation.id, operationId)
  assert.equal(candidateCalls, 1)

  const conflictResponse = await postJson(alice.token, '/api/evolution/candidates/generate', {
    ...input,
    objective: 'A different request must not reuse this identity',
  }, key)
  assert.equal(conflictResponse.status, 409)
  const conflict = await conflictResponse.json()
  assert.equal(conflict.error.code, 'EVOLUTION_OPERATION_IDEMPOTENCY_CONFLICT')
  assert.equal(conflict.error.operationId, operationId)
  assert.equal(candidateCalls, 1)

  const detailResponse = await fetch(`${origin}/api/evolution/operations/${operationId}`, {
    headers: authHeaders(alice.token),
  })
  assert.equal(detailResponse.status, 200)
  assert.equal((await detailResponse.json()).operation.result.id, first.candidate.id)

  const completedResumeResponse = await postJson(
    alice.token,
    `/api/evolution/operations/${operationId}/resume`,
    {},
  )
  assert.equal(completedResumeResponse.status, 200)
  const completedResume = await completedResumeResponse.json()
  assert.equal(completedResume.operation.state, 'completed')
  for (const privateField of [
    'request',
    'checkpoint',
    'workerToken',
    'leaseOwnerId',
    'leaseExpiresAt',
  ]) {
    assert.equal(Object.hasOwn(completedResume.operation, privateField), false)
  }

  const crossUser = await fetch(`${origin}/api/evolution/operations/${operationId}`, {
    headers: authHeaders(bob.token),
  })
  assert.equal(crossUser.status, 404)
})

test('recover and resume refuse an active running lease', async () => {
  const session = issueTestSession({ email: 'evolution-operation-active-recovery@example.com' })
  const operation = openEvolutionOperation({
    userId: session.userId,
    kind: 'candidate',
    idempotencyKey: 'active-recovery-must-be-rejected',
    request: { objective: 'This request must remain private.' },
    now: 100,
  })
  claimEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    stage: 'calling_model',
  })

  const response = await postJson(
    session.token,
    `/api/evolution/operations/${operation.id}/recover-not-sent`,
    { verificationConfirmed: true, confirmOperationId: operation.id },
  )
  assert.equal(response.status, 409)
  const body = await response.json()
  assert.equal(body.error.code, 'EVOLUTION_OPERATION_IN_PROGRESS')
  assert.equal(body.error.operationId, operation.id)
  assert.equal(
    getEvolutionOperation({ userId: session.userId, id: operation.id }).state,
    'running',
  )

  const resume = await postJson(
    session.token,
    `/api/evolution/operations/${operation.id}/resume`,
    {},
  )
  assert.equal(resume.status, 409)
  assert.equal((await resume.json()).error.code, 'EVOLUTION_OPERATION_IN_PROGRESS')
})

test('claim maps a second SQLite writer race to a stable operation conflict', () => {
  const session = issueTestSession({ email: 'evolution-operation-claim-race@example.com' })
  const operation = openEvolutionOperation({
    userId: session.userId,
    kind: 'candidate',
    idempotencyKey: 'claim-race-stable-conflict',
    request: { objective: 'Exercise the database claim fence.' },
    now: 200,
  })
  const primaryDb = getDb()
  const secondDb = new Database(process.env.APP_DB_PATH)
  secondDb.pragma('journal_mode = WAL')
  primaryDb.pragma('busy_timeout = 1')
  secondDb.exec('BEGIN IMMEDIATE')
  try {
    assert.throws(
      () => claimEvolutionOperation({
        userId: session.userId,
        id: operation.id,
        stage: 'calling_model',
        now: 201,
      }),
      (error) => (
        error?.code === 'EVOLUTION_OPERATION_IN_PROGRESS'
        && error?.statusCode === 409
        && error?.operationId === operation.id
      ),
    )
    assert.equal(
      getEvolutionOperation({ userId: session.userId, id: operation.id }).state,
      'pending',
    )
  } finally {
    secondDb.exec('ROLLBACK')
    secondDb.close()
    primaryDb.pragma('busy_timeout = 5000')
  }
})

test('operation leases reject invalid durations before SQLite can persist an immortal lease', () => {
  const session = issueTestSession({ email: 'evolution-operation-invalid-lease@example.com' })
  const operation = openEvolutionOperation({
    userId: session.userId,
    kind: 'candidate',
    idempotencyKey: 'invalid-lease-duration',
    request: { objective: 'Never persist an invalid lease timestamp.' },
    now: 100,
  })
  const invalidDurations = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    MAX_EVOLUTION_OPERATION_LEASE_MS + 1,
    999,
    1_000.5,
  ]
  for (const leaseMs of invalidDurations) {
    assert.throws(() => claimEvolutionOperation({
      userId: session.userId,
      id: operation.id,
      stage: 'candidate:model_call',
      leaseMs,
      now: 101,
    }), {
      code: 'EVOLUTION_OPERATION_LEASE_DURATION_INVALID',
      statusCode: 400,
    })
  }
  assert.equal(
    getEvolutionOperation({ userId: session.userId, id: operation.id }).state,
    'pending',
  )

  const claim = claimEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    stage: 'candidate:model_call',
    leaseMs: 1_000,
    now: 101,
  })
  for (const leaseMs of invalidDurations) {
    assert.throws(() => renewEvolutionOperationLease({
      userId: session.userId,
      id: operation.id,
      workerToken: claim.workerToken,
      leaseOwnerId: claim.leaseOwnerId,
      leaseMs,
      now: 102,
    }), {
      code: 'EVOLUTION_OPERATION_LEASE_DURATION_INVALID',
      statusCode: 400,
    })
  }
  const stillRunning = getEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    includePayload: true,
  })
  assert.equal(stillRunning.state, 'running')
  assert.equal(stillRunning.leaseExpiresAt, 1_101)

  const overflowOperation = openEvolutionOperation({
    userId: session.userId,
    kind: 'candidate',
    idempotencyKey: 'lease-expiration-overflow',
    request: { objective: 'Keep lease expiration inside safe integer range.' },
    now: Number.MAX_SAFE_INTEGER - 1_000,
  })
  assert.throws(() => claimEvolutionOperation({
    userId: session.userId,
    id: overflowOperation.id,
    stage: 'candidate:model_call',
    leaseMs: 1_000,
    now: Number.MAX_SAFE_INTEGER - 500,
  }), {
    code: 'EVOLUTION_OPERATION_LEASE_DURATION_INVALID',
    statusCode: 400,
  })
})

test('monotonic expiry fences a worker even when a rolled-back wall clock still appears unexpired', () => {
  const session = issueTestSession({ email: 'evolution-operation-monotonic-expiry@example.com' })
  let elapsed = 0
  const monotonicNow = () => elapsed
  const operation = openEvolutionOperation({
    userId: session.userId,
    kind: 'candidate',
    idempotencyKey: 'monotonic-expiry-worker-fence',
    request: { objective: 'Use elapsed time as the authoritative local lease fence.' },
    now: 9_999,
  })
  const claim = claimEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    stage: 'candidate:model_call',
    leaseMs: 1_000,
    now: 10_000,
    monotonicNow,
  })
  assert.equal(claim.leaseExpiresAt, 11_000)

  elapsed = 1_000
  assert.equal(renewEvolutionOperationLease({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    leaseMs: 1_000,
    now: 10_500,
    monotonicNow,
  }), false)
  assert.throws(() => checkpointEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    stage: 'candidate:late_checkpoint',
    checkpoint: { output: 'must not persist' },
    now: 10_550,
    monotonicNow,
  }), { code: 'EVOLUTION_OPERATION_FENCED' })

  let writeResultCalls = 0
  assert.throws(() => commitEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    resultType: 'candidate',
    resultId: 'monotonic-expired-result',
    checkpoint: { output: 'must not persist' },
    writeResult() { writeResultCalls += 1 },
    now: 10_550,
    leaseCheckedAt: 10_550,
    monotonicNow,
  }), { code: 'EVOLUTION_OPERATION_FENCED' })
  assert.equal(writeResultCalls, 0)
  for (const stopOperation of [blockEvolutionOperation, failEvolutionOperation]) {
    assert.throws(() => stopOperation({
      userId: session.userId,
      id: operation.id,
      workerToken: claim.workerToken,
      leaseOwnerId: claim.leaseOwnerId,
      error: new Error('expired worker must not choose a terminal state'),
      now: 10_550,
      monotonicNow,
    }), { code: 'EVOLUTION_OPERATION_FENCED' })
  }
  assert.equal(
    getEvolutionOperation({ userId: session.userId, id: operation.id }).state,
    'running',
  )

  const blocked = reconcileExpiredEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    now: 10_550,
    monotonicNow,
  })
  assert.equal(blocked.state, 'blocked')
  assert.equal(blocked.error.code, 'EVOLUTION_OPERATION_LEASE_EXPIRED')
  assert.equal(blocked.result, null)

  recoverEvolutionOperationNotSent({
    userId: session.userId,
    id: operation.id,
    verificationConfirmed: true,
    confirmOperationId: operation.id,
    recoveryChallenge: blocked.recoveryChallenge,
    recoveryRevision: blocked.recoveryRevision,
    now: 10_551,
    monotonicNow,
  })
  elapsed = 1_001
  const nextClaim = claimEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    stage: 'candidate:finalizing',
    leaseMs: 1_000,
    now: 10_552,
    monotonicNow,
  })
  assert.throws(() => commitEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    resultType: 'candidate',
    resultId: 'stale-monotonic-result',
    checkpoint: {},
    writeResult() { writeResultCalls += 1 },
    now: 10_553,
    leaseCheckedAt: 10_553,
    monotonicNow,
  }), { code: 'EVOLUTION_OPERATION_FENCED' })
  assert.equal(writeResultCalls, 0)

  const completed = commitEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: nextClaim.workerToken,
    leaseOwnerId: nextClaim.leaseOwnerId,
    resultType: 'candidate',
    resultId: 'fresh-monotonic-result',
    checkpoint: {},
    writeResult() { writeResultCalls += 1 },
    now: 10_553,
    leaseCheckedAt: 10_553,
    monotonicNow,
  })
  assert.equal(writeResultCalls, 1)
  assert.equal(completed.state, 'completed')
})

test('clock rollback fences every old-worker mutation before freezing the outcome as unknown', () => {
  const session = issueTestSession({ email: 'evolution-operation-clock-rollback@example.com' })
  const operation = openEvolutionOperation({
    userId: session.userId,
    kind: 'candidate',
    idempotencyKey: 'clock-rollback-worker-fence',
    request: { objective: 'Fail closed when wall time moves backwards.' },
    now: 9_999,
  })
  const claim = claimEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    stage: 'candidate:model_call',
    leaseMs: 1_000,
    now: 10_000,
  })
  assert.equal(claim.leaseExpiresAt, 11_000)

  assert.equal(renewEvolutionOperationLease({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    leaseMs: 1_000,
    now: 5_000,
  }), false)
  assert.throws(() => checkpointEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    stage: 'candidate:stale_checkpoint',
    checkpoint: { output: 'must not persist' },
    now: 5_500,
  }), { code: 'EVOLUTION_OPERATION_FENCED' })

  let writeResultCalled = false
  assert.throws(() => commitEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    resultType: 'candidate',
    resultId: 'clock-rollback-result',
    checkpoint: { output: 'must not persist' },
    writeResult() { writeResultCalled = true },
    now: 5_500,
    leaseCheckedAt: 5_500,
  }), { code: 'EVOLUTION_OPERATION_FENCED' })
  assert.equal(writeResultCalled, false)
  assert.throws(() => blockEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    error: new Error('stale worker must not decide the outcome'),
    now: 5_500,
  }), { code: 'EVOLUTION_OPERATION_FENCED' })
  assert.throws(() => failEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    error: new Error('stale worker must not fail the operation'),
    now: 5_500,
  }), { code: 'EVOLUTION_OPERATION_FENCED' })

  const running = getEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    includePayload: true,
  })
  assert.equal(running.state, 'running')
  assert.equal(running.updatedAt, 10_000)
  assert.equal(running.result, null)

  const blocked = reconcileExpiredEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    now: 5_500,
  })
  assert.equal(blocked.state, 'blocked')
  assert.equal(blocked.stage, 'model_outcome_unknown')
  assert.equal(blocked.error.code, 'EVOLUTION_OPERATION_CLOCK_ROLLBACK')
  assert.equal(
    blocked.error.message,
    'the system clock is earlier than the operation lease timestamp; the model outcome is unknown',
  )
  assert.equal(blocked.updatedAt, 10_000)
  assert.equal(blocked.workerToken, null)
  assert.equal(blocked.leaseOwnerId, null)
  assert.equal(blocked.leaseExpiresAt, null)
  assert.match(blocked.recoveryChallenge, /^[0-9a-f-]{36}$/u)

  assert.throws(() => commitEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    resultType: 'candidate',
    resultId: 'clock-rollback-result',
    checkpoint: { output: 'must not persist' },
    writeResult() { writeResultCalled = true },
    now: 10_500,
    leaseCheckedAt: 10_500,
  }), { code: 'EVOLUTION_OPERATION_FENCED' })
  assert.equal(writeResultCalled, false)
  assert.equal(
    getEvolutionOperation({ userId: session.userId, id: operation.id }).state,
    'blocked',
  )
})

test('recover freezes a running operation when the database timestamp is in the future', () => {
  const session = issueTestSession({ email: 'evolution-operation-recover-clock-rollback@example.com' })
  const operation = openEvolutionOperation({
    userId: session.userId,
    kind: 'candidate',
    idempotencyKey: 'recover-clock-rollback-fence',
    request: { objective: 'Freeze unknown work before accepting recovery.' },
    now: 19_999,
  })
  claimEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    stage: 'candidate:model_call',
    leaseMs: 1_000,
    now: 20_000,
  })
  assert.throws(() => recoverEvolutionOperationNotSent({
    userId: session.userId,
    id: operation.id,
    verificationConfirmed: true,
    confirmOperationId: operation.id,
    now: 15_000,
  }), {
    code: 'EVOLUTION_OPERATION_OUTCOME_UNKNOWN',
    statusCode: 409,
  })
  const blocked = getEvolutionOperation({ userId: session.userId, id: operation.id })
  assert.equal(blocked.state, 'blocked')
  assert.equal(blocked.error.code, 'EVOLUTION_OPERATION_CLOCK_ROLLBACK')
  assert.match(blocked.recoveryChallenge, /^[0-9a-f-]{36}$/u)
  assert.equal(blocked.recoveryRevision, 1)
})

test('operation mutations map SQLite writer contention without poisoning finalization', () => {
  const session = issueTestSession({ email: 'evolution-operation-mutation-race@example.com' })
  const operation = openEvolutionOperation({
    userId: session.userId,
    kind: 'candidate',
    idempotencyKey: 'mutation-race-stable-conflict',
    request: { objective: 'Keep a retryable finalization running.' },
  })
  const claim = claimEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    stage: 'candidate:finalizing',
  })
  const primaryDb = getDb()
  const secondDb = new Database(process.env.APP_DB_PATH)
  secondDb.pragma('journal_mode = WAL')
  primaryDb.pragma('busy_timeout = 1')
  secondDb.exec('BEGIN IMMEDIATE')
  let writeResultCalled = false
  const assertBusyConflict = (callback) => assert.throws(
    callback,
    (error) => (
      error?.code === 'EVOLUTION_OPERATION_IN_PROGRESS'
      && error?.statusCode === 409
      && error?.operationId === operation.id
    ),
  )
  try {
    assertBusyConflict(() => renewEvolutionOperationLease({
      userId: session.userId,
      id: operation.id,
      workerToken: claim.workerToken,
      leaseOwnerId: claim.leaseOwnerId,
    }))
    assertBusyConflict(() => checkpointEvolutionOperation({
      userId: session.userId,
      id: operation.id,
      workerToken: claim.workerToken,
      leaseOwnerId: claim.leaseOwnerId,
      stage: 'candidate:checkpointed',
      checkpoint: { output: 'retry later' },
    }))
    assertBusyConflict(() => commitEvolutionOperation({
      userId: session.userId,
      id: operation.id,
      workerToken: claim.workerToken,
      leaseOwnerId: claim.leaseOwnerId,
      resultType: 'candidate',
      resultId: 'retryable-result',
      checkpoint: { output: 'retry later' },
      writeResult() { writeResultCalled = true },
    }))
    assertBusyConflict(() => failEvolutionOperation({
      userId: session.userId,
      id: operation.id,
      workerToken: claim.workerToken,
      leaseOwnerId: claim.leaseOwnerId,
      error: new Error('must not poison the operation'),
    }))
    assert.equal(writeResultCalled, false)
    assert.equal(
      getEvolutionOperation({ userId: session.userId, id: operation.id }).state,
      'running',
    )
  } finally {
    secondDb.exec('ROLLBACK')
    secondDb.close()
    primaryDb.pragma('busy_timeout = 5000')
  }

  const completed = commitEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    resultType: 'candidate',
    resultId: 'retryable-result',
    checkpoint: { output: 'retry later' },
    writeResult() { writeResultCalled = true },
  })
  assert.equal(writeResultCalled, true)
  assert.equal(completed.state, 'completed')
})

test('a finalization COMMIT failure does not advance or release the local worker fence', () => {
  const session = issueTestSession({ email: 'evolution-operation-finalize-commit-failure@example.com' })
  const operation = openEvolutionOperation({
    userId: session.userId,
    kind: 'candidate',
    idempotencyKey: 'finalize-commit-failure-fence',
    request: { objective: 'Keep the local fence retryable until SQLite commits.' },
    now: 100,
  })
  const claim = claimEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    stage: 'candidate:finalizing',
    leaseMs: 1_000,
    now: 101,
    monotonicNow: () => 0,
  })
  const disableFailure = injectEvolutionOperationCommitFailure(operation.id)
  try {
    assertEvolutionOperationCommitFailure(() => commitEvolutionOperation({
      userId: session.userId,
      id: operation.id,
      workerToken: claim.workerToken,
      leaseOwnerId: claim.leaseOwnerId,
      resultType: 'candidate',
      resultId: 'commit-failure-result',
      checkpoint: { phase: 'first-attempt' },
      writeResult() {},
      now: 102,
      leaseCheckedAt: 102,
      monotonicNow: () => 500,
    }))
  } finally {
    disableFailure()
  }
  assert.equal(
    getEvolutionOperation({ userId: session.userId, id: operation.id }).state,
    'running',
  )

  const completed = commitEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    resultType: 'candidate',
    resultId: 'commit-failure-result',
    checkpoint: { phase: 'retry' },
    writeResult() {},
    now: 103,
    leaseCheckedAt: 103,
    monotonicNow: () => 400,
  })
  assert.equal(completed.state, 'completed')
})

test('a freeze COMMIT failure does not tombstone a still-durable worker fence', () => {
  const session = issueTestSession({ email: 'evolution-operation-freeze-commit-failure@example.com' })
  const operation = openEvolutionOperation({
    userId: session.userId,
    kind: 'candidate',
    idempotencyKey: 'freeze-commit-failure-fence',
    request: { objective: 'Rollback speculative monotonic fence observations with SQLite.' },
    now: 200,
  })
  const claim = claimEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    stage: 'candidate:model_call',
    leaseMs: 1_000,
    now: 201,
    monotonicNow: () => 0,
  })
  const disableFailure = injectEvolutionOperationCommitFailure(operation.id)
  try {
    assertEvolutionOperationCommitFailure(() => reconcileExpiredEvolutionOperation({
      userId: session.userId,
      id: operation.id,
      now: 500,
      monotonicNow: () => 1_000,
    }))
  } finally {
    disableFailure()
  }
  assert.equal(
    getEvolutionOperation({ userId: session.userId, id: operation.id }).state,
    'running',
  )

  const checkpointed = checkpointEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    stage: 'candidate:checkpointed',
    checkpoint: { phase: 'retry-after-freeze-rollback' },
    now: 501,
    monotonicNow: () => 500,
  })
  assert.equal(checkpointed.state, 'pending')
})

test('a recovery COMMIT failure does not release an existing local worker fence', () => {
  const session = issueTestSession({ email: 'evolution-operation-recovery-commit-failure@example.com' })
  const operation = openEvolutionOperation({
    userId: session.userId,
    kind: 'candidate',
    idempotencyKey: 'recovery-commit-failure-fence',
    request: { objective: 'Release stale fences only after recovery commits.' },
    now: 300,
  })
  const claim = claimEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    stage: 'candidate:model_call',
    leaseMs: 1_000,
    now: 301,
    monotonicNow: () => 0,
  })
  const recoveryChallenge = '11111111-1111-4111-8111-111111111111'
  getDb().prepare(`
    UPDATE evolution_operations
    SET state = 'blocked', stage = 'model_outcome_unknown', worker_token = NULL,
        lease_owner_id = NULL, lease_expires_at = NULL,
        recovery_challenge = ?, recovery_revision = recovery_revision + 1,
        error_code = 'TEST_OUTCOME_UNKNOWN', error_message = 'test recovery rollback',
        updated_at = 302, finished_at = 302
    WHERE id = ? AND user_id = ?
  `).run(recoveryChallenge, operation.id, session.userId)

  const disableFailure = injectEvolutionOperationCommitFailure(operation.id)
  try {
    assertEvolutionOperationCommitFailure(() => recoverEvolutionOperationNotSent({
      userId: session.userId,
      id: operation.id,
      verificationConfirmed: true,
      confirmOperationId: operation.id,
      recoveryChallenge,
      recoveryRevision: 1,
      now: 303,
      monotonicNow: () => 100,
    }))
  } finally {
    disableFailure()
  }
  assert.equal(
    getEvolutionOperation({ userId: session.userId, id: operation.id }).state,
    'blocked',
  )

  getDb().prepare(`
    UPDATE evolution_operations
    SET state = 'running', stage = 'candidate:model_call', worker_token = ?,
        lease_owner_id = ?, lease_expires_at = 1301,
        recovery_challenge = NULL, error_code = NULL, error_message = NULL,
        updated_at = 304, finished_at = NULL
    WHERE id = ? AND user_id = ?
  `).run(claim.workerToken, claim.leaseOwnerId, operation.id, session.userId)
  const checkpointed = checkpointEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    stage: 'candidate:checkpointed',
    checkpoint: { phase: 'retry-after-recovery-rollback' },
    now: 305,
    monotonicNow: () => 100,
  })
  assert.equal(checkpointed.state, 'pending')
})

test('recover maps a second SQLite writer race to a stable operation conflict', async () => {
  const session = issueTestSession({ email: 'evolution-operation-recover-race@example.com' })
  const operation = openEvolutionOperation({
    userId: session.userId,
    kind: 'candidate',
    idempotencyKey: 'recover-race-stable-conflict',
    request: { objective: 'Exercise the recovery database fence.' },
  })
  const claim = claimEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    stage: 'calling_model',
  })
  const blocked = blockEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    error: Object.assign(new Error('unknown outcome'), { code: 'MODEL_OUTCOME_UNKNOWN' }),
  })

  const primaryDb = getDb()
  const secondDb = new Database(process.env.APP_DB_PATH)
  secondDb.pragma('journal_mode = WAL')
  primaryDb.pragma('busy_timeout = 1')
  secondDb.exec('BEGIN IMMEDIATE')
  try {
    const response = await postJson(
      session.token,
      `/api/evolution/operations/${operation.id}/recover-not-sent`,
      {
        verificationConfirmed: true,
        confirmOperationId: operation.id,
        recoveryChallenge: blocked.recoveryChallenge,
        recoveryRevision: blocked.recoveryRevision,
      },
    )
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'EVOLUTION_OPERATION_IN_PROGRESS')
  } finally {
    secondDb.exec('ROLLBACK')
    secondDb.close()
    primaryDb.pragma('busy_timeout = 5000')
  }
})

test('an expired worker cannot block or fail before the lease reconciler records unknown outcome', () => {
  const session = issueTestSession({ email: 'evolution-operation-expired-stop@example.com' })
  const operation = openEvolutionOperation({
    userId: session.userId,
    kind: 'candidate',
    idempotencyKey: 'expired-worker-stop-fence',
    request: { objective: 'Fence every expired worker transition.' },
    now: 100,
  })
  const claim = claimEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    stage: 'calling_model',
    leaseMs: 1_000,
    now: 101,
  })
  const expiredAt = claim.leaseExpiresAt

  assert.throws(() => checkpointEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    stage: 'late:checkpoint',
    checkpoint: { output: 'must remain fenced' },
    now: expiredAt,
  }), { code: 'EVOLUTION_OPERATION_FENCED' })
  let wroteExpiredResult = false
  assert.throws(() => commitEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    resultType: 'candidate',
    resultId: 'expired-result',
    checkpoint: { output: 'must remain fenced' },
    writeResult() { wroteExpiredResult = true },
    now: 101,
  }), { code: 'EVOLUTION_OPERATION_FENCED' })
  assert.equal(wroteExpiredResult, false)
  assert.throws(() => blockEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    error: new Error('late block'),
    now: expiredAt,
  }), { code: 'EVOLUTION_OPERATION_FENCED' })
  assert.throws(() => failEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: claim.workerToken,
    leaseOwnerId: claim.leaseOwnerId,
    error: new Error('late failure'),
    now: expiredAt,
  }), { code: 'EVOLUTION_OPERATION_FENCED' })
  assert.equal(
    getEvolutionOperation({ userId: session.userId, id: operation.id }).state,
    'running',
  )

  const reconciled = reconcileExpiredEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    now: expiredAt,
  })
  assert.equal(reconciled.state, 'blocked')
  assert.equal(reconciled.stage, 'model_outcome_unknown')
})

test('an expired worker survives restart only through blocked review and fences its old token', async () => {
  const session = issueTestSession({ email: 'evolution-operation-restart-lease@example.com' })
  const operation = openEvolutionOperation({
    userId: session.userId,
    kind: 'candidate',
    idempotencyKey: 'restart-expired-running-operation',
    request: { objective: 'Recover an orphan without replaying it automatically.' },
    now: 1,
  })
  const staleClaim = claimEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    stage: 'calling_model',
    leaseMs: 1_000,
    now: 2,
  })
  closeDb()
  getDb()

  const resume = await postJson(
    session.token,
    `/api/evolution/operations/${operation.id}/resume`,
    {},
  )
  assert.equal(resume.status, 409)
  assert.equal((await resume.json()).error.code, 'EVOLUTION_OPERATION_OUTCOME_UNKNOWN')
  const blocked = getEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    includePayload: true,
  })
  assert.equal(blocked.state, 'blocked')
  assert.equal(blocked.stage, 'model_outcome_unknown')
  assert.equal(blocked.workerToken, null)
  assert.equal(blocked.leaseOwnerId, null)
  assert.equal(blocked.leaseExpiresAt, null)

  assert.throws(() => checkpointEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: staleClaim.workerToken,
    leaseOwnerId: staleClaim.leaseOwnerId,
    stage: 'stale:checkpoint',
    checkpoint: { output: 'must not commit' },
  }), { code: 'EVOLUTION_OPERATION_FENCED' })
  let wroteResult = false
  assert.throws(() => commitEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: staleClaim.workerToken,
    leaseOwnerId: staleClaim.leaseOwnerId,
    resultType: 'candidate',
    resultId: 'stale-result',
    checkpoint: { output: 'must not commit' },
    writeResult() { wroteResult = true },
  }), { code: 'EVOLUTION_OPERATION_FENCED' })
  assert.equal(wroteResult, false)

  const recovered = recoverEvolutionOperationNotSent({
    userId: session.userId,
    id: operation.id,
    verificationConfirmed: true,
    confirmOperationId: operation.id,
    recoveryChallenge: blocked.recoveryChallenge,
    recoveryRevision: blocked.recoveryRevision,
  })
  assert.equal(recovered.state, 'pending')
  assert.equal(Object.hasOwn(recovered, 'request'), false)
  assert.equal(Object.hasOwn(recovered, 'checkpoint'), false)
  assert.equal(Object.hasOwn(recovered, 'recoveryChallenge'), false)
  assert.equal(Object.hasOwn(recovered, 'recoveryRevision'), false)
})

test('recovery challenge is issued after freezing and can be consumed only once', async () => {
  const session = issueTestSession({ email: 'evolution-operation-recovery-challenge@example.com' })
  const operation = openEvolutionOperation({
    userId: session.userId,
    kind: 'candidate',
    idempotencyKey: 'recovery-challenge-single-use',
    request: { objective: 'Reject pre-signed and replayed recovery requests.' },
    now: 100,
  })
  claimEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    stage: 'candidate:model_call',
    leaseMs: 1_000,
    now: 101,
  })
  const beforeFreeze = getEvolutionOperation({ userId: session.userId, id: operation.id })
  assert.equal(Object.hasOwn(beforeFreeze, 'recoveryChallenge'), false)
  assert.equal(Object.hasOwn(beforeFreeze, 'recoveryRevision'), false)

  const presignedBody = {
    verificationConfirmed: true,
    confirmOperationId: operation.id,
    recoveryChallenge: '00000000-0000-4000-8000-000000000000',
    recoveryRevision: 1,
  }
  const freeze = await postJson(
    session.token,
    `/api/evolution/operations/${operation.id}/recover-not-sent`,
    presignedBody,
  )
  assert.equal(freeze.status, 409)
  assert.equal((await freeze.json()).error.code, 'EVOLUTION_OPERATION_OUTCOME_UNKNOWN')

  const detailResponse = await fetch(`${origin}/api/evolution/operations/${operation.id}`, {
    headers: authHeaders(session.token),
  })
  assert.equal(detailResponse.status, 200)
  const blocked = (await detailResponse.json()).operation
  assert.equal(blocked.state, 'blocked')
  assert.match(blocked.recoveryChallenge, /^[0-9a-f-]{36}$/u)
  assert.notEqual(blocked.recoveryChallenge, presignedBody.recoveryChallenge)
  assert.equal(blocked.recoveryRevision, 1)
  for (const privateField of ['request', 'checkpoint', 'workerToken', 'leaseOwnerId', 'leaseExpiresAt']) {
    assert.equal(Object.hasOwn(blocked, privateField), false)
  }

  const oldBody = await postJson(
    session.token,
    `/api/evolution/operations/${operation.id}/recover-not-sent`,
    { verificationConfirmed: true, confirmOperationId: operation.id },
  )
  assert.equal(oldBody.status, 409)
  assert.equal((await oldBody.json()).error.code, 'EVOLUTION_OPERATION_RECOVERY_CHALLENGE_INVALID')

  const presignedReplay = await postJson(
    session.token,
    `/api/evolution/operations/${operation.id}/recover-not-sent`,
    presignedBody,
  )
  assert.equal(presignedReplay.status, 409)
  assert.equal(
    (await presignedReplay.json()).error.code,
    'EVOLUTION_OPERATION_RECOVERY_CHALLENGE_INVALID',
  )

  const recoveryBody = {
    verificationConfirmed: true,
    confirmOperationId: operation.id,
    recoveryChallenge: blocked.recoveryChallenge,
    recoveryRevision: blocked.recoveryRevision,
  }
  const duplicateResponses = await Promise.all([
    postJson(session.token, `/api/evolution/operations/${operation.id}/recover-not-sent`, recoveryBody),
    postJson(session.token, `/api/evolution/operations/${operation.id}/recover-not-sent`, recoveryBody),
  ])
  assert.deepEqual(duplicateResponses.map((response) => response.status).sort(), [200, 409])
  const duplicateBodies = await Promise.all(duplicateResponses.map((response) => response.json()))
  const successfulRecovery = duplicateBodies.find((body) => body.ok === true)
  assert.equal(successfulRecovery.operation.state, 'pending')
  assert.equal(Object.hasOwn(successfulRecovery.operation, 'recoveryChallenge'), false)
  assert.equal(Object.hasOwn(successfulRecovery.operation, 'recoveryRevision'), false)

  const nextClaim = claimEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    stage: 'candidate:model_call',
  })
  const nextBlocked = blockEvolutionOperation({
    userId: session.userId,
    id: operation.id,
    workerToken: nextClaim.workerToken,
    leaseOwnerId: nextClaim.leaseOwnerId,
    error: Object.assign(new Error('outcome unknown again'), { code: 'MODEL_OUTCOME_UNKNOWN' }),
  })
  assert.equal(nextBlocked.recoveryRevision, blocked.recoveryRevision + 1)
  assert.notEqual(nextBlocked.recoveryChallenge, blocked.recoveryChallenge)
  assert.throws(() => recoverEvolutionOperationNotSent({
    userId: session.userId,
    id: operation.id,
    ...recoveryBody,
  }), { code: 'EVOLUTION_OPERATION_RECOVERY_CHALLENGE_INVALID' })
})

test('replay unknown outcome is fail-closed and resumes only after the last durable checkpoint', async () => {
  const session = issueTestSession({ email: 'evolution-operation-replay@example.com' })
  const dataset = seedDataset(session.userId, 'Replay every candidate against stable evidence')
  const candidate = await generateEvolutionCandidate({
    userId: session.userId,
    ...candidateInput(dataset, { target: 'prompt:durable-replay' }),
    idempotencyKey: 'durable-replay-candidate',
    runModel: candidateModel,
  })
  const suite = createEvolutionReplaySuite({
    userId: session.userId,
    name: 'Durable replay suite',
    datasetFingerprint: dataset.datasetFingerprint,
    cases: [{
      sourceRecordId: dataset.records[0].id,
      title: 'One durable case',
      input: 'Explain how the runtime avoids repeated work.',
    }],
  })
  const replayInput = {
    userId: session.userId,
    suiteId: suite.id,
    candidateId: candidate.id,
    baselineContent: 'Use the baseline runtime instructions.',
    providerId: 'replay-provider',
    modelName: 'replay-model',
    parameters: { temperature: 0, maxTokens: 256 },
    idempotencyKey: 'durable-replay-operation-1',
  }
  let initialCalls = 0
  let interruptedError
  await assert.rejects(
    runEvolutionReplay({
      ...replayInput,
      runModel: async () => {
        initialCalls += 1
        if (initialCalls === 2) throw new Error('connection ended after dispatch')
        return {
          providerId: 'replay-provider',
          modelName: 'replay-model',
          content: 'checkpointed baseline output',
        }
      },
    }),
    (error) => {
      interruptedError = error
      return error.code === 'EVOLUTION_REPLAY_MODEL_FAILED' && Boolean(error.operationId)
    },
  )
  assert.equal(initialCalls, 2)
  let operation = getEvolutionOperation({
    userId: session.userId,
    id: interruptedError.operationId,
    includePayload: true,
  })
  assert.equal(operation.state, 'blocked')
  assert.equal(operation.stage, 'model_outcome_unknown')
  assert.equal(operation.checkpoint.results[0].baseline.output, 'checkpointed baseline output')
  assert.equal(operation.checkpoint.results[0].candidate, undefined)

  let forbiddenRetryCalls = 0
  await assert.rejects(
    runEvolutionReplay({
      ...replayInput,
      runModel: async () => {
        forbiddenRetryCalls += 1
        return { providerId: 'replay-provider', modelName: 'replay-model', content: 'must not run' }
      },
    }),
    { code: 'EVOLUTION_OPERATION_OUTCOME_UNKNOWN' },
  )
  assert.equal(forbiddenRetryCalls, 0)

  const wrongRecovery = await postJson(
    session.token,
    `/api/evolution/operations/${operation.id}/recover-not-sent`,
    { verificationConfirmed: true, confirmOperationId: 'wrong-id' },
  )
  assert.equal(wrongRecovery.status, 400)
  assert.equal(
    (await wrongRecovery.json()).error.code,
    'EVOLUTION_OPERATION_RECOVERY_CONFIRMATION_REQUIRED',
  )
  const recovery = await postJson(
    session.token,
    `/api/evolution/operations/${operation.id}/recover-not-sent`,
    {
      verificationConfirmed: true,
      confirmOperationId: operation.id,
      recoveryChallenge: operation.recoveryChallenge,
      recoveryRevision: operation.recoveryRevision,
    },
  )
  assert.equal(recovery.status, 200)
  operation = (await recovery.json()).operation
  assert.equal(operation.state, 'pending')
  assert.equal(Object.hasOwn(operation, 'request'), false)
  assert.equal(Object.hasOwn(operation, 'checkpoint'), false)
  assert.equal(Object.hasOwn(operation, 'workerToken'), false)
  assert.equal(Object.hasOwn(operation, 'recoveryChallenge'), false)
  assert.equal(Object.hasOwn(operation, 'recoveryRevision'), false)

  let resumedCalls = 0
  replayModel = async () => {
    resumedCalls += 1
    return {
      providerId: 'replay-provider',
      modelName: 'replay-model',
      content: 'resumed candidate output',
    }
  }
  const resumeResponse = await postJson(
    session.token,
    `/api/evolution/operations/${operation.id}/resume`,
    {},
  )
  assert.equal(resumeResponse.status, 200)
  const resumed = await resumeResponse.json()
  assert.equal(resumedCalls, 1)
  assert.equal(resumed.operation.state, 'completed')
  assert.equal(resumed.replay.results[0].baseline.output, 'checkpointed baseline output')
  assert.equal(resumed.replay.results[0].candidate.output, 'resumed candidate output')

  let evaluatorCalls = 0
  const evaluationInput = {
    userId: session.userId,
    replayId: resumed.replay.id,
    evaluatorProviderId: 'grader-provider',
    evaluatorModelName: 'grader-model',
    idempotencyKey: 'durable-evaluation-operation-1',
    runModel: async () => {
      evaluatorCalls += 1
      return {
        providerId: 'grader-provider',
        modelName: 'grader-model',
        content: JSON.stringify({
          summary: 'Candidate preserves the expected behavior.',
          cases: [{
            caseId: suite.cases[0].id,
            baselineScore: 2,
            candidateScore: 3,
            safety: 'pass',
            evidence: ['The candidate directly explains durable checkpoints.'],
            issues: [],
          }],
        }),
      }
    },
  }
  const evaluation = await evaluateEvolutionReplay(evaluationInput)
  const replayedEvaluation = await evaluateEvolutionReplay(evaluationInput)
  assert.equal(replayedEvaluation.id, evaluation.id)
  assert.equal(evaluatorCalls, 1)
})
