import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  appendModelProviderAttempt,
  assertModelInvocationRetrySafe,
  createModelInvocation,
  MODEL_REQUEST_OUTCOME_UNKNOWN,
  normalizeModelInvocation,
  reconcileRecoveredModelInvocation,
  snapshotModelResponse,
} from '../server/services/loop/modelInvocationCheckpoint.js'

const fingerprint = 'a'.repeat(64)

function invocation(overrides = {}) {
  return createModelInvocation({
    fingerprint,
    jobId: 'turn-1',
    stepId: 'turn-1',
    iteration: 2,
    attempt: 1,
    modelName: 'model-1',
    modelProviderId: 'provider-1',
    modelConfigRevision: 7,
    ...overrides,
  })
}

function recoveryOptions(reconcileRequest) {
  return {
    fingerprint,
    iteration: 2,
    modelName: 'model-1',
    modelProviderId: 'provider-1',
    modelConfigRevision: 7,
    reconcileRequest,
  }
}

function providerEvidence(restored, receipt) {
  const physicalAttempt = restored.providerAttempts.at(-1) || null
  return {
    authoritative: true,
    receipt,
    verification: {
      modelRequestId: restored.id,
      idempotencyKey: restored.idempotencyKey,
      requestFingerprint: restored.fingerprint,
      providerId: physicalAttempt?.providerId || restored.providerId,
      modelName: physicalAttempt?.modelName || restored.modelName,
      configFingerprint: physicalAttempt?.configFingerprint || '',
      physicalAttemptSequence: physicalAttempt?.sequence ?? null,
      providerCapability: physicalAttempt?.providerCapability || null,
    },
  }
}

test('model response checkpoints omit unknown cost but preserve an explicit measured zero', () => {
  const unknown = snapshotModelResponse({ content: 'unknown', toolCalls: [], costUsd: null })
  assert.equal(Object.hasOwn(unknown, 'costUsd'), false)

  const measuredZero = snapshotModelResponse({ content: 'local', toolCalls: [], costUsd: 0 })
  assert.equal(measuredZero.costUsd, 0)
})

test('provider reconciliation replays completed responses without a fresh model request', async () => {
  const restored = invocation()
  const result = await reconcileRecoveredModelInvocation(restored, recoveryOptions(async () => ({
    contractVersion: 1,
    outcome: 'completed',
    response: { content: 'authoritative', toolCalls: [] },
    ...providerEvidence(restored, { lookupId: 'receipt-1' }),
  })))

  assert.equal(result.kind, 'replay')
  assert.equal(result.checkpointRequired, true)
  assert.equal(result.invocation.status, 'completed')
  assert.equal(result.invocation.usageApplied, false)
  assert.equal(result.response.content, 'authoritative')
  assert.equal(result.invocation.id, restored.id)
})

test('completed checkpoints distinguish unapplied recovered usage from legacy applied usage', async () => {
  const completed = {
    ...invocation(),
    status: 'completed',
    response: { content: 'authoritative', toolCalls: [] },
    usageApplied: false,
  }
  const recovered = await reconcileRecoveredModelInvocation(completed, recoveryOptions())
  assert.equal(recovered.kind, 'replay')
  assert.equal(recovered.checkpointRequired, true)
  assert.equal(recovered.invocation.usageApplied, false)

  const { usageApplied, ...legacyCheckpoint } = completed
  assert.equal(usageApplied, false)
  const legacy = normalizeModelInvocation(legacyCheckpoint)
  assert.equal(legacy.usageApplied, true)
  const replayedLegacy = await reconcileRecoveredModelInvocation(legacyCheckpoint, recoveryOptions())
  assert.equal(replayedLegacy.kind, 'replay')
  assert.equal(replayedLegacy.checkpointRequired, undefined)

  const legacyManualCheckpoint = {
    ...legacyCheckpoint,
    reconciliation: {
      contractVersion: 1,
      source: 'manual',
      outcome: 'completed',
      reconciledAt: Date.now(),
    },
  }
  const legacyManual = normalizeModelInvocation(legacyManualCheckpoint)
  assert.equal(legacyManual.usageApplied, false)
  const replayedLegacyManual = await reconcileRecoveredModelInvocation(
    legacyManualCheckpoint,
    recoveryOptions(),
  )
  assert.equal(replayedLegacyManual.kind, 'replay')
  assert.equal(replayedLegacyManual.checkpointRequired, true)
})

test('only an authoritative not_sent result creates the next logical attempt', async () => {
  const restored = invocation()
  const result = await reconcileRecoveredModelInvocation(restored, recoveryOptions(async () => ({
    contractVersion: 1,
    outcome: 'not_sent',
    ...providerEvidence(restored, { query: 'provider-ledger' }),
  })))

  assert.equal(result.kind, 'fresh')
  assert.equal(result.checkpointRequired, true)
  assert.equal(result.invocation.status, 'not_sent')
  assert.equal(result.nextAttempt, 2)
})

test('non-authoritative not_sent and empty completed provider results remain blocked', async () => {
  const restored = invocation()
  const invalidResults = [
    {
      contractVersion: 1,
      outcome: 'not_sent',
      ...providerEvidence(restored, { query: 'provider-ledger' }),
      authoritative: false,
    },
    {
      contractVersion: 1,
      outcome: 'completed',
      ...providerEvidence(restored, { lookupId: 'empty-response' }),
      response: { content: '', toolCalls: [] },
    },
  ]

  for (const invalidResult of invalidResults) {
    await assert.rejects(
      reconcileRecoveredModelInvocation(
        restored,
        recoveryOptions(async () => invalidResult),
      ),
      (error) => error?.code === MODEL_REQUEST_OUTCOME_UNKNOWN
        && error?.unsafeToReplay === true
        && error?.retryable === false
        && error?.cause instanceof TypeError,
    )
  }
})

test('unknown, unsupported, and failed provider queries remain blocked', async () => {
  for (const reconcileRequest of [
    async () => ({ contractVersion: 1, outcome: 'unknown' }),
    async () => ({ contractVersion: 1, outcome: 'unsupported' }),
    async () => { throw Object.assign(new Error('lookup failed'), { code: 'LOOKUP_FAILED' }) },
  ]) {
    await assert.rejects(
      reconcileRecoveredModelInvocation(invocation(), recoveryOptions(reconcileRequest)),
      (error) => error?.code === MODEL_REQUEST_OUTCOME_UNKNOWN
        && error?.unsafeToReplay === true
        && error?.retryable === false,
    )
  }
})

test('provider, model, or config drift blocks reconciliation before querying the provider', async () => {
  let queries = 0
  await assert.rejects(
    reconcileRecoveredModelInvocation(invocation(), {
      ...recoveryOptions(async () => { queries += 1 }),
      modelConfigRevision: 8,
    }),
    (error) => error?.code === 'MODEL_REQUEST_CONTEXT_DRIFT',
  )
  assert.equal(queries, 0)
})

test('explicit retry preserves same-binding reconciliation and blocks mixed model bindings', () => {
  const pending = invocation()
  const sameBinding = {
    modelName: 'model-1',
    modelProviderId: 'provider-1',
    modelConfigRevision: 7,
  }

  assert.doesNotThrow(() => assertModelInvocationRetrySafe(pending, sameBinding))
  assert.throws(
    () => assertModelInvocationRetrySafe(pending, {
      ...sameBinding,
      modelConfigRevision: 8,
    }),
    (error) => error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
      && error?.requiresUserVerification === true
      && error?.targetConfigRevision === 8,
  )

  const completed = {
    ...pending,
    status: 'completed',
    response: { content: 'durable response', toolCalls: [] },
  }
  assert.throws(
    () => assertModelInvocationRetrySafe(completed, {
      ...sameBinding,
      modelConfigRevision: 8,
    }),
    (error) => error?.code === 'MODEL_REQUEST_CONTEXT_DRIFT'
      && error?.requiresUserVerification === false,
  )

  assert.doesNotThrow(() => assertModelInvocationRetrySafe({
    ...pending,
    status: 'failed',
    errorCode: 'UPSTREAM_FAILED',
  }, {
    ...sameBinding,
    modelConfigRevision: 8,
  }))
})

test('malformed model invocation checkpoints fail closed instead of becoming fresh requests', async () => {
  const pending = invocation()
  const sameBinding = {
    modelName: 'model-1',
    modelProviderId: 'provider-1',
    modelConfigRevision: 7,
  }
  const malformed = [
    { ...pending, fingerprint: 'not-a-sha256-fingerprint' },
    { ...pending, idempotencyKey: 'different-request-id' },
    { ...pending, status: 'IN_FLIGHT' },
    'truncated-checkpoint',
  ]

  for (const checkpoint of malformed) {
    assert.throws(
      () => assertModelInvocationRetrySafe(checkpoint, sameBinding),
      (error) => error?.code === 'MODEL_REQUEST_CONTEXT_DRIFT'
        && error?.checkpointInvalid === true
        && error?.unsafeToReplay === true
        && error?.action === 'recreate_job',
    )
  }

  let providerQueries = 0
  await assert.rejects(
    reconcileRecoveredModelInvocation(
      { ...pending, idempotencyKey: 'mismatched-idempotency-key' },
      recoveryOptions(async () => { providerQueries += 1 }),
    ),
    (error) => error?.code === 'MODEL_REQUEST_CONTEXT_DRIFT'
      && error?.checkpointInvalid === true,
  )
  assert.equal(providerQueries, 0)
})

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-model-request-recovery-'))
const previousDataDir = process.env.APP_DATA_DIR
process.env.APP_DATA_DIR = tempDir

const { closeDb, createSession, createUser, getDb } = await import('../server/db.js')
const { saveTurnCheckpoint } = await import('../server/services/turnCheckpointStore.js')
const {
  getPendingModelRequestRecovery,
  readModelRequestRecoveryResolution,
  resolvePendingModelRequest,
} = await import('../server/services/modelRequestRecoveryService.js')
const { createAppServer } = await import('../server/appServer.js')
const { SQLITE_TURN_PERSISTENCE_ADAPTER } = await import('../server/adapters/sqliteTurnPersistenceAdapter.js')
const { createTurnPersistenceAdapterController } = await import('../server/core/turnPersistenceAdapter.js')
const { closeTurnEngine } = await import('../server/services/turnEngineHost.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { activateTestCompactionArchivePort } = await import('./helpers/testCompactionArchivePort.js')
const persistence = createTurnPersistenceAdapterController(SQLITE_TURN_PERSISTENCE_ADAPTER, {
  source: 'test.model-request-recovery',
})
persistence.activate()
const compactionArchiveController = activateTestCompactionArchivePort({
  source: 'test.model-request-recovery',
})
const server = createAppServer({ getEnv: () => ({ AUTH_MODE: 'local' }) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await closeTurnEngine()
  compactionArchiveController.release()
  persistence.release()
  closeDb()
  if (previousDataDir === undefined) delete process.env.APP_DATA_DIR
  else process.env.APP_DATA_DIR = previousDataDir
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function createOwner(marker) {
  const userId = `model-recovery-user-${marker}`
  const sessionId = `model-recovery-session-${marker}`
  createUser({ id: userId, email: `${marker}@model-recovery.test`, now: 1 })
  createSession({ token: sessionId, userId, now: 1 })
  return { userId, sessionId }
}

function persistPending(owner, marker, { physicalAttempt = null } = {}) {
  const turnId = `model-recovery-turn-${marker}`
  const logicalInvocation = invocation({ jobId: turnId, stepId: turnId })
  const modelInvocation = physicalAttempt
    ? appendModelProviderAttempt(logicalInvocation, physicalAttempt)
    : logicalInvocation
  saveTurnCheckpoint({
    ...owner,
    turnId,
    eventSequence: 11,
    state: { iterations: 2, modelInvocation },
    now: 2,
  })
  return { turnId, modelInvocation }
}

function resolutionInput(owner, pending, resolution, extras = {}) {
  return {
    ...owner,
    turnId: pending.turnId,
    expectedCheckpointSequence: 11,
    modelRequestId: pending.modelInvocation.id,
    requestFingerprint: pending.modelInvocation.fingerprint,
    providerId: pending.modelInvocation.providerId,
    modelName: pending.modelInvocation.modelName,
    configRevision: pending.modelInvocation.configRevision,
    idempotencyKey: pending.modelInvocation.idempotencyKey,
    confirmModelRequestId: pending.modelInvocation.id,
    verificationConfirmed: true,
    resolution,
    now: () => 3,
    ...extras,
  }
}

test('manual completed resolution is owner-bound and survives a database read', async () => {
  const owner = createOwner('completed')
  const other = createOwner('completed-other')
  const pending = persistPending(owner, 'completed')

  assert.equal(await getPendingModelRequestRecovery({ ...other, turnId: pending.turnId }), null)
  const resolved = await resolvePendingModelRequest(resolutionInput(owner, pending, 'completed', {
    response: { content: 'cached manual response', toolCalls: [] },
    receipt: { providerRecord: 'record-1' },
  }))
  assert.equal(resolved.status, 'resolved_pending_resume')
  assert.equal(resolved.resolution, 'completed')

  const read = readModelRequestRecoveryResolution({
    ...owner,
    turnId: pending.turnId,
    invocation: pending.modelInvocation,
  })
  assert.equal(read.source, 'manual')
  assert.equal(read.outcome, 'completed')
  assert.equal(read.response.content, 'cached manual response')
  assert.deepEqual(read.receipt, { providerRecord: 'record-1' })
})

test('manual completed resolution rejects empty or malformed responses without writing recovery state', async () => {
  const invalidResponses = [
    undefined,
    null,
    'text',
    1,
    true,
    [],
    {},
    { content: '', toolCalls: [] },
    { content: '   ', toolCalls: [] },
    { content: {} },
    { content: 'text', toolCalls: {} },
    { toolCalls: [{}] },
    { toolCalls: [{ name: 'read_file', arguments: '[]' }] },
    { toolCalls: [{ function: { name: '', arguments: '{}' } }] },
    { toolCalls: [{ function: { name: 'read_file', arguments: '{' } }] },
  ]

  for (const [index, response] of invalidResponses.entries()) {
    const owner = createOwner(`invalid-completed-${index}`)
    const pending = persistPending(owner, `invalid-completed-${index}`)

    await assert.rejects(
      resolvePendingModelRequest(resolutionInput(owner, pending, 'completed', {
        response,
        receipt: { providerRecord: `invalid-${index}` },
      })),
      (error) => error?.code === 'MODEL_REQUEST_RECOVERY_INVALID'
        && error?.statusCode === 400
        && /^response must /u.test(error.message),
      JSON.stringify(response),
    )
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM model_request_recovery_resolutions
      WHERE owner_id = ? AND session_id = ? AND turn_id = ?
    `).get(owner.userId, owner.sessionId, pending.turnId).count, 0)
  }
})

test('manual completed resolution accepts a valid tool-call-only response', async () => {
  const owner = createOwner('completed-tool-call')
  const pending = persistPending(owner, 'completed-tool-call')
  const response = {
    content: '',
    toolCalls: [{
      id: 'call-read',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"README.md"}' },
    }],
  }

  const resolved = await resolvePendingModelRequest(resolutionInput(owner, pending, 'completed', {
    response,
    receipt: { providerRecord: 'record-tool-call' },
  }))
  assert.equal(resolved.status, 'resolved_pending_resume')
  const read = readModelRequestRecoveryResolution({
    ...owner,
    turnId: pending.turnId,
    invocation: pending.modelInvocation,
  })
  assert.deepEqual(read.response, response)
})

test('manual terminal resolution uses exact checkpoint identity and has one CAS winner', async () => {
  const owner = createOwner('cas')
  const pending = persistPending(owner, 'cas')
  const first = await resolvePendingModelRequest(resolutionInput(owner, pending, 'not_sent'))
  assert.equal(first.resolution, 'not_sent')

  await assert.rejects(
    resolvePendingModelRequest(resolutionInput(owner, pending, 'not_sent')),
    (error) => error?.code === 'MODEL_REQUEST_RECOVERY_CONFLICT' && error?.statusCode === 409,
  )
  await assert.rejects(
    resolvePendingModelRequest(resolutionInput(owner, pending, 'unknown', {
      requestFingerprint: 'b'.repeat(64),
    })),
    (error) => error?.code === 'MODEL_REQUEST_RECOVERY_CONFLICT',
  )
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM model_request_recovery_resolutions
    WHERE owner_id = ? AND session_id = ? AND turn_id = ?
  `).get(owner.userId, owner.sessionId, pending.turnId).count, 1)
})

test('manual turn recovery rejects a live execution lease without writes and accepts an expired lease', async () => {
  const owner = createOwner('execution-lease')
  const pending = persistPending(owner, 'execution-lease')
  getDb().prepare(`
    INSERT INTO turn_execution_leases (
      user_id, session_id, turn_id, owner_id, acquired_at, expires_at,
      cancel_requested_at, accepting_steering, fencing_token
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?)
  `).run(owner.userId, owner.sessionId, pending.turnId, 'live-worker', 1_000, 3_000, 'lease-token')

  await assert.rejects(
    resolvePendingModelRequest(resolutionInput(owner, pending, 'not_sent', {
      receipt: { checkedAt: 2_000 },
      now: () => 2_000,
    })),
    (error) => error?.code === 'MODEL_REQUEST_RECOVERY_EXECUTION_ACTIVE'
      && error?.statusCode === 409,
  )
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM model_request_recovery_resolutions
    WHERE owner_id = ? AND session_id = ? AND turn_id = ?
  `).get(owner.userId, owner.sessionId, pending.turnId).count, 0)

  const resolved = await resolvePendingModelRequest(resolutionInput(owner, pending, 'not_sent', {
    receipt: { checkedAt: 3_000 },
    now: () => 3_000,
  }))
  assert.equal(resolved.resolution, 'not_sent')
})

test('manual turn recovery refuses to consume a resolution from an older checkpoint sequence', async () => {
  const owner = createOwner('stale-sequence')
  const pending = persistPending(owner, 'stale-sequence')
  await resolvePendingModelRequest(resolutionInput(owner, pending, 'not_sent'))
  saveTurnCheckpoint({
    ...owner,
    turnId: pending.turnId,
    eventSequence: 12,
    state: { iterations: 2, modelInvocation: pending.modelInvocation },
    now: 4,
  })

  assert.throws(
    () => readModelRequestRecoveryResolution({
      ...owner,
      turnId: pending.turnId,
      invocation: pending.modelInvocation,
    }),
    (error) => error?.code === 'MODEL_REQUEST_RECOVERY_CONFLICT'
      && error?.statusCode === 409
      && /older checkpoint sequence/u.test(error.message),
  )
})

test('model request recovery HTTP API is authenticated, owner-only, and returns a resume descriptor', async () => {
  const ownerAuth = issueTestSession({ email: 'model-request-api-owner@example.com' })
  const otherAuth = issueTestSession({ email: 'model-request-api-other@example.com' })
  const owner = { userId: ownerAuth.userId, sessionId: 'model-request-api-chat' }
  createSession({ token: owner.sessionId, userId: owner.userId, now: 1 })
  const pending = persistPending(owner, 'api', {
    physicalAttempt: {
      version: 1,
      sequence: 1,
      providerAttempt: 1,
      failoverIndex: 1,
      providerId: 'actual-failover-provider',
      modelName: 'actual-failover-model',
      providerKind: 'plugin-provider-kind',
      endpointFingerprint: 'b'.repeat(64),
      configFingerprint: 'c'.repeat(64),
      providerCapability: {
        id: 'provider-capability',
        owner: 'plugin-provider-owner',
        version: '1.2.3',
        revision: 4,
        releaseDigest: `sha256-${'d'.repeat(64)}`,
      },
    },
  })
  const path = `/api/turns/${encodeURIComponent(pending.turnId)}/model-request-recovery`

  assert.equal((await fetch(`${origin}${path}?sessionId=${owner.sessionId}`)).status, 401)
  const hidden = await fetch(`${origin}${path}?sessionId=${owner.sessionId}`, {
    headers: { Authorization: `Bearer ${otherAuth.token}` },
  })
  assert.equal(hidden.status, 404)

  const getResponse = await fetch(`${origin}${path}?sessionId=${owner.sessionId}`, {
    headers: { Authorization: `Bearer ${ownerAuth.token}` },
  })
  assert.equal(getResponse.status, 200)
  const recovery = (await getResponse.json()).recovery
  assert.equal(recovery.modelRequestId, pending.modelInvocation.id)
  assert.deepEqual(recovery.lastProviderAttempt, {
    sequence: 1,
    providerAttempt: 1,
    failoverIndex: 1,
    providerId: 'actual-failover-provider',
    modelName: 'actual-failover-model',
    providerKind: 'plugin-provider-kind',
  })
  for (const forbidden of [
    'endpointFingerprint',
    'configFingerprint',
    'providerCapability',
    'releaseDigest',
  ]) {
    assert.equal(JSON.stringify(recovery).includes(forbidden), false)
  }
  assert.equal(Object.hasOwn(recovery, 'response'), false)

  const resolveResponse = await fetch(`${origin}${path}/resolve`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerAuth.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: owner.sessionId,
      checkpointSequence: recovery.checkpointSequence,
      modelRequestId: recovery.modelRequestId,
      requestFingerprint: recovery.requestFingerprint,
      providerId: recovery.providerId,
      modelName: recovery.modelName,
      configRevision: recovery.configRevision,
      idempotencyKey: recovery.idempotencyKey,
      confirmModelRequestId: recovery.modelRequestId,
      verificationConfirmed: true,
      resolution: 'not_sent',
    }),
  })
  assert.equal(resolveResponse.status, 200)
  const resolved = await resolveResponse.json()
  assert.equal(resolved.recovery.resolution, 'not_sent')
  assert.deepEqual(resolved.resume, {
    ready: true,
    sessionId: owner.sessionId,
    turnId: pending.turnId,
  })
})
