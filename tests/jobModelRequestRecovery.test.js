import assert from 'node:assert/strict'
import test from 'node:test'

import Database from 'better-sqlite3'

import { migrateToV38 } from '../server/migrations/v38JobExecutionLeases.js'
import { migrateToV86 } from '../server/migrations/v86JobModelRequestRecovery.js'
import {
  getPendingJobModelRequestRecovery,
  readJobModelRequestRecoveryResolution,
  resolvePendingJobModelRequest,
} from '../server/services/jobModelRequestRecoveryService.js'
import {
  appendModelProviderAttempt,
  createModelInvocation,
} from '../server/services/loop/modelInvocationCheckpoint.js'

function recoveryFixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE job_steps (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE
    );
    INSERT INTO users (id) VALUES ('owner-a'), ('owner-b');
    INSERT INTO jobs (id, user_id) VALUES ('job-a', 'owner-a'), ('job-b', 'owner-b');
    INSERT INTO job_steps (id, job_id) VALUES ('step-a', 'job-a'), ('step-b', 'job-b');
  `)
  migrateToV38(db)
  migrateToV86(db)
  const logicalInvocation = createModelInvocation({
    fingerprint: 'a'.repeat(64),
    jobId: 'job-a',
    stepId: 'step-a',
    iteration: 1,
    attempt: 1,
    modelName: 'model-a',
    modelProviderId: 'provider-a',
    modelConfigRevision: 7,
  })
  const invocation = appendModelProviderAttempt(logicalInvocation, {
    version: 1,
    sequence: 1,
    providerAttempt: 1,
    failoverIndex: 1,
    providerId: 'provider-b',
    modelName: 'model-b',
    providerKind: 'openai-compatible',
    endpointFingerprint: 'b'.repeat(64),
    configFingerprint: 'c'.repeat(64),
    providerCapability: {
      id: 'model-provider:openai-compatible',
      owner: 'builtin',
      version: '1',
      revision: 2,
      releaseDigest: null,
    },
  })
  db.prepare(`
    INSERT INTO job_turn_checkpoints (
      step_id, job_id, user_id, state_json, created_at, updated_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('step-a', 'job-a', 'owner-a', JSON.stringify({
    version: 1,
    messages: [{ role: 'user', content: 'charge this request once' }],
    iterations: 1,
    modelInvocation: invocation,
  }), 1_000, 1_000, 1)
  return { db, invocation }
}

function resolutionInput(pending, overrides = {}) {
  return {
    userId: 'owner-a',
    jobId: 'job-a',
    stepId: 'step-a',
    expectedCheckpointRevision: pending.checkpointRevision,
    modelRequestId: pending.modelRequestId,
    requestFingerprint: pending.requestFingerprint,
    providerId: pending.providerId,
    modelName: pending.modelName,
    configRevision: pending.configRevision,
    idempotencyKey: pending.idempotencyKey,
    verificationConfirmed: true,
    confirmModelRequestId: pending.modelRequestId,
    resolution: 'unknown',
    db: overrides.db,
    ...overrides,
  }
}

function observeTransactionModes(db, modes) {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'transaction') {
        return (callback, ...args) => {
          const transaction = target.transaction(callback, ...args)
          const wrapped = (...parameters) => {
            modes.push('deferred')
            return transaction(...parameters)
          }
          for (const mode of ['deferred', 'immediate', 'exclusive']) {
            if (typeof transaction[mode] === 'function') {
              wrapped[mode] = (...parameters) => {
                modes.push(mode)
                return transaction[mode](...parameters)
              }
            }
          }
          return wrapped
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('job model-request recovery is owner-isolated and identity/revision guarded', () => {
  const { db } = recoveryFixture()
  try {
    const pending = getPendingJobModelRequestRecovery({
      userId: 'owner-a', jobId: 'job-a', stepId: 'step-a', db,
    })
    assert.ok(pending)
    assert.deepEqual(pending.lastProviderAttempt, {
      sequence: 1,
      providerAttempt: 1,
      failoverIndex: 1,
      providerId: 'provider-b',
      modelName: 'model-b',
      providerKind: 'openai-compatible',
    })
    for (const forbidden of [
      'endpointFingerprint',
      'configFingerprint',
      'providerCapability',
      'releaseDigest',
    ]) {
      assert.equal(JSON.stringify(pending).includes(forbidden), false)
    }
    assert.equal(getPendingJobModelRequestRecovery({
      userId: 'owner-b', jobId: 'job-a', stepId: 'step-a', db,
    }), null)
    assert.throws(
      () => resolvePendingJobModelRequest(resolutionInput(pending, {
        userId: 'owner-b',
        db,
      })),
      (error) => error?.code === 'JOB_MODEL_REQUEST_RECOVERY_NOT_FOUND'
        && error?.statusCode === 404,
    )
    assert.throws(
      () => resolvePendingJobModelRequest(resolutionInput(pending, {
        requestFingerprint: 'b'.repeat(64),
        db,
      })),
      (error) => error?.code === 'JOB_MODEL_REQUEST_RECOVERY_CONFLICT'
        && error?.statusCode === 409,
    )
    assert.throws(
      () => resolvePendingJobModelRequest(resolutionInput(pending, {
        expectedCheckpointRevision: pending.checkpointRevision + 1,
        db,
      })),
      (error) => error?.code === 'JOB_MODEL_REQUEST_RECOVERY_CONFLICT'
        && error?.statusCode === 409,
    )
  } finally {
    db.close()
  }
})

test('manual recovery rejects a live execution lease without writes but accepts an expired lease', () => {
  const { db } = recoveryFixture()
  try {
    const pending = getPendingJobModelRequestRecovery({
      userId: 'owner-a', jobId: 'job-a', stepId: 'step-a', db,
    })
    db.prepare(`
      INSERT INTO job_execution_leases (job_id, owner_id, acquired_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run('job-a', 'live-worker', 1_000, 3_000)
    const before = db.prepare(`
      SELECT state_json, revision FROM job_turn_checkpoints
       WHERE user_id = ? AND job_id = ? AND step_id = ?
    `).get('owner-a', 'job-a', 'step-a')

    assert.throws(
      () => resolvePendingJobModelRequest(resolutionInput(pending, {
        resolution: 'not_sent',
        receipt: { checkedAt: 2_000 },
        now: () => 2_000,
        db,
      })),
      (error) => error?.code === 'JOB_MODEL_REQUEST_RECOVERY_EXECUTION_ACTIVE'
        && error?.statusCode === 409,
    )
    assert.deepEqual(db.prepare(`
      SELECT state_json, revision FROM job_turn_checkpoints
       WHERE user_id = ? AND job_id = ? AND step_id = ?
    `).get('owner-a', 'job-a', 'step-a'), before)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM job_model_request_recovery_resolutions
    `).get().count, 0)

    const resolved = resolvePendingJobModelRequest(resolutionInput(pending, {
      resolution: 'not_sent',
      receipt: { checkedAt: 3_000 },
      now: () => 3_000,
      db,
    }))
    assert.equal(resolved.status, 'resolved_pending_resume')
  } finally {
    db.close()
  }
})

test('manual recovery acquires an immediate transaction before checking the execution lease', () => {
  const { db } = recoveryFixture()
  const modes = []
  try {
    const observedDb = observeTransactionModes(db, modes)
    const pending = getPendingJobModelRequestRecovery({
      userId: 'owner-a', jobId: 'job-a', stepId: 'step-a', db: observedDb,
    })
    const resolved = resolvePendingJobModelRequest(resolutionInput(pending, {
      resolution: 'not_sent',
      receipt: { checkedAt: 3_000 },
      now: () => 3_000,
      db: observedDb,
    }))
    assert.equal(resolved.status, 'resolved_pending_resume')
    assert.deepEqual(modes, ['immediate'])
  } finally {
    db.close()
  }
})

test('completed recovery rejects empty or malformed responses without writing recovery state', () => {
  for (const response of [
    undefined,
    null,
    'text',
    1,
    true,
    [],
    {},
    { content: '', toolCalls: [] },
    { content: {} },
    { content: 'text', toolCalls: {} },
    { toolCalls: [{}] },
    { toolCalls: [{ name: 'read_file', arguments: '[]' }] },
    { toolCalls: [{ function: { name: '', arguments: '{}' } }] },
  ]) {
    const { db } = recoveryFixture()
    try {
      const pending = getPendingJobModelRequestRecovery({
        userId: 'owner-a', jobId: 'job-a', stepId: 'step-a', db,
      })
      const before = db.prepare(`
        SELECT state_json, revision FROM job_turn_checkpoints
         WHERE user_id = ? AND job_id = ? AND step_id = ?
      `).get('owner-a', 'job-a', 'step-a')
      assert.throws(
        () => resolvePendingJobModelRequest(resolutionInput(pending, {
          resolution: 'completed',
          response,
          receipt: { providerRequestId: 'provider-request-invalid' },
          db,
        })),
        (error) => error?.code === 'JOB_MODEL_REQUEST_RECOVERY_INVALID'
          && error?.statusCode === 400,
        JSON.stringify(response),
      )
      const after = db.prepare(`
        SELECT state_json, revision FROM job_turn_checkpoints
         WHERE user_id = ? AND job_id = ? AND step_id = ?
      `).get('owner-a', 'job-a', 'step-a')
      assert.deepEqual(after, before)
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM job_model_request_recovery_resolutions
      `).get().count, 0)
    } finally {
      db.close()
    }
  }
})

test('completed recovery accepts a structurally valid tool-call-only response', () => {
  const { db } = recoveryFixture()
  try {
    const pending = getPendingJobModelRequestRecovery({
      userId: 'owner-a', jobId: 'job-a', stepId: 'step-a', db,
    })
    const resolved = resolvePendingJobModelRequest(resolutionInput(pending, {
      resolution: 'completed',
      response: {
        content: '',
        toolCalls: [{
          id: 'call-read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"README.md"}' },
        }],
      },
      receipt: { providerRequestId: 'provider-request-tool-call' },
      db,
    }))
    assert.equal(resolved.status, 'resolved_pending_resume')
    assert.equal(resolved.resolution, 'completed')
  } finally {
    db.close()
  }
})

test('an unknown job model request has exactly one final resolution winner', () => {
  const { db } = recoveryFixture()
  try {
    const pending = getPendingJobModelRequestRecovery({
      userId: 'owner-a', jobId: 'job-a', stepId: 'step-a', db,
    })
    const unresolved = resolvePendingJobModelRequest(resolutionInput(pending, { db }))
    assert.equal(unresolved.status, 'unknown')
    const winner = resolvePendingJobModelRequest(resolutionInput(pending, {
      resolution: 'not_sent',
      receipt: { checkedAt: 2_000 },
      db,
    }))
    assert.equal(winner.status, 'resolved_pending_resume')
    assert.equal(winner.resolution, 'not_sent')
    assert.throws(
      () => resolvePendingJobModelRequest(resolutionInput(pending, {
        resolution: 'completed',
        response: { content: 'must lose', toolCalls: [] },
        receipt: { providerRequestId: 'provider-request-a' },
        db,
      })),
      (error) => error?.code === 'JOB_MODEL_REQUEST_RECOVERY_CONFLICT'
        && error?.statusCode === 409,
    )
  } finally {
    db.close()
  }
})

test('a final manual resolution is atomically materialized and rejects the stale in-flight view', () => {
  const { db, invocation } = recoveryFixture()
  try {
    const pending = getPendingJobModelRequestRecovery({
      userId: 'owner-a', jobId: 'job-a', stepId: 'step-a', db,
    })
    const resolved = resolvePendingJobModelRequest(resolutionInput(pending, {
      resolution: 'completed',
      response: { content: 'verified provider response', toolCalls: [] },
      receipt: { providerRequestId: 'provider-request-a' },
      db,
    }))
    assert.equal(resolved.status, 'resolved_pending_resume')
    assert.equal(resolved.checkpointRevision, pending.checkpointRevision + 1)
    const materialized = getPendingJobModelRequestRecovery({
      userId: 'owner-a', jobId: 'job-a', stepId: 'step-a', db,
    })
    assert.equal(materialized.status, 'resolved_pending_resume')
    assert.equal(materialized.resolution, 'completed')
    const state = JSON.parse(db.prepare(`
      SELECT state_json FROM job_turn_checkpoints
       WHERE job_id = ? AND step_id = ? AND user_id = ?
    `).get('job-a', 'step-a', 'owner-a').state_json)
    assert.equal(state.modelInvocation.status, 'completed')
    assert.equal(state.modelInvocation.reconciliation.source, 'manual')
    assert.equal(state.modelInvocation.reconciliation.outcome, 'completed')
    assert.equal(state.modelInvocation.response.content, 'verified provider response')
    assert.throws(
      () => readJobModelRequestRecoveryResolution({
        userId: 'owner-a', jobId: 'job-a', stepId: 'step-a', invocation, db,
      }),
      (error) => error?.code === 'JOB_MODEL_REQUEST_RECOVERY_CONFLICT'
        && error?.statusCode === 409,
    )
  } finally {
    db.close()
  }
})
