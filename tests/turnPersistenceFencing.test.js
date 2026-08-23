import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-persistence-fencing-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, createUser } = await import('../server/db.js')
const { upsertSession, listMessages } = await import('../server/services/sessionStore.js')
const { getTurnCheckpoint } = await import('../server/services/turnCheckpointStore.js')
const {
  claimTurnExecutionLease,
  getTurnExecutionLease,
  releaseTurnExecutionLease,
  renewTurnExecutionLease,
} = await import('../server/services/turnExecutionLeaseStore.js')
const {
  appendTurnEvent,
  listTurnEvents,
} = await import('../server/services/turnEventStore.js')
const {
  createSqliteTurnPersistenceTransactions,
} = await import('../server/services/sqliteTurnPersistenceTransactions.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')

const userId = 'turn-persistence-fencing-user'
const leaseMs = 1_000
const liveNow = 1_700_000_000_000
const turnPersistenceTransactions = createSqliteTurnPersistenceTransactions({
  now: () => liveNow,
})

createUser({ id: userId, email: 'turn-persistence-fencing@example.com' })

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function createStartedTurn(label) {
  const sessionId = `fencing-${label}-session`
  const turnId = `fencing-${label}-turn`
  upsertSession({ id: sessionId, userId, title: `Fencing ${label}` })
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:started`,
      sessionId,
      turnId,
      sequence: 0,
      type: 'turn.started',
      payload: { content: label, userMessageId: `${turnId}:user` },
      createdAt: liveNow - 3_000,
    }),
  })
  return { userId, sessionId, turnId }
}

function claimSnapshot(scope, ownerId, now) {
  assert.equal(claimTurnExecutionLease({ ...scope, ownerId, now, leaseMs }), true)
  return structuredClone(getTurnExecutionLease(scope))
}

function executionLease(lease) {
  return {
    ownerId: lease?.ownerId,
    fencingToken: lease?.fencingToken,
  }
}

async function captureError(operation) {
  try {
    await operation()
    return null
  } catch (error) {
    return {
      code: error?.code || null,
      status: error?.status || null,
    }
  }
}

function checkpointEvent(scope, sequence = 1) {
  return createTurnEvent({
    id: `${scope.turnId}:checkpoint:${sequence}`,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    sequence,
    type: 'turn.checkpoint',
    payload: {
      storage: 'turn_checkpoints',
      checkpointVersion: 1,
      iterations: sequence,
      toolCallCount: 0,
    },
    createdAt: liveNow + sequence,
  })
}

function completedEvent(scope, sequence = 1) {
  return createTurnEvent({
    id: `${scope.turnId}:completed:${sequence}`,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    sequence,
    type: 'turn.completed',
    payload: { text: 'durable winner', iterations: 1 },
    createdAt: liveNow + sequence,
  })
}

function completionMessage(scope) {
  return {
    id: `${scope.turnId}:assistant`,
    userId,
    sessionId: scope.sessionId,
    role: 'assistant',
    content: 'durable winner',
    modelContext: { version: 1, turnId: scope.turnId, turnEvidence: true },
    createdAt: liveNow + 1,
    updatedAt: liveNow + 1,
  }
}

test('lease takeover advances a durable monotonic fencing token', () => {
  const scope = createStartedTurn('monotonic-token')
  const staleLease = claimSnapshot(scope, 'worker-a', liveNow - 2_000)
  const liveLease = claimSnapshot(scope, 'worker-b', liveNow)
  const liveReleased = releaseTurnExecutionLease({
    ...scope,
    ownerId: liveLease.ownerId,
    fencingToken: liveLease.fencingToken,
  })
  const reclaimedLease = claimSnapshot(scope, 'worker-c', liveNow + 100)

  assert.deepEqual({
    staleTokenIsInteger: Number.isSafeInteger(staleLease?.fencingToken),
    liveTokenIsInteger: Number.isSafeInteger(liveLease?.fencingToken),
    reclaimedTokenIsInteger: Number.isSafeInteger(reclaimedLease?.fencingToken),
    tokenAdvanced: liveLease?.fencingToken > staleLease?.fencingToken,
    tokenSurvivedRelease: reclaimedLease?.fencingToken > liveLease?.fencingToken,
    liveReleased,
    reclaimedOwner: reclaimedLease?.ownerId,
  }, {
    staleTokenIsInteger: true,
    liveTokenIsInteger: true,
    reclaimedTokenIsInteger: true,
    tokenAdvanced: true,
    tokenSurvivedRelease: true,
    liveReleased: true,
    reclaimedOwner: 'worker-c',
  })
})

test('a stale lease cannot commit a checkpoint after takeover and the live lease can', async () => {
  const scope = createStartedTurn('stale-checkpoint')
  const staleLease = claimSnapshot(scope, 'worker-a', liveNow - 2_000)
  const liveLease = claimSnapshot(scope, 'worker-b', liveNow)
  const event = checkpointEvent(scope)
  const checkpointState = { messages: [{ role: 'user', content: 'winner state' }], iterations: 1 }

  const staleError = await captureError(() => (
    turnPersistenceTransactions.commitTurnCheckpoint({
      userId,
      event,
      checkpointState,
      executionLease: executionLease(staleLease),
    })
  ))
  const afterStale = {
    eventTypes: listTurnEvents({ ...scope, limit: 100 }).map(({ type }) => type),
    checkpoint: getTurnCheckpoint(scope),
  }

  const winnerError = await captureError(() => (
    turnPersistenceTransactions.commitTurnCheckpoint({
      userId,
      event,
      checkpointState,
      executionLease: executionLease(liveLease),
    })
  ))

  assert.deepEqual({
    staleError,
    afterStale,
    winnerError,
    finalEventTypes: listTurnEvents({ ...scope, limit: 100 }).map(({ type }) => type),
    finalCheckpointSequence: getTurnCheckpoint(scope)?.eventSequence ?? null,
  }, {
    staleError: { code: 'TURN_EXECUTION_LEASE_STALE', status: 409 },
    afterStale: { eventTypes: ['turn.started'], checkpoint: null },
    winnerError: null,
    finalEventTypes: ['turn.started', 'turn.checkpoint'],
    finalCheckpointSequence: 1,
  })
})

test('a stale lease cannot commit a terminal boundary or its evidence message after takeover', async () => {
  const scope = createStartedTurn('stale-boundary')
  const staleLease = claimSnapshot(scope, 'worker-a', liveNow - 2_000)
  const liveLease = claimSnapshot(scope, 'worker-b', liveNow)
  const event = completedEvent(scope)
  const message = completionMessage(scope)

  const staleError = await captureError(() => (
    turnPersistenceTransactions.commitTurnBoundary({
      userId,
      event,
      message,
      executionLease: executionLease(staleLease),
    })
  ))
  const afterStale = {
    eventTypes: listTurnEvents({ ...scope, limit: 100 }).map(({ type }) => type),
    evidenceMessageIds: listMessages({ userId, sessionId: scope.sessionId, limit: 100 })
      .map(({ id }) => id),
  }

  const winnerError = await captureError(() => (
    turnPersistenceTransactions.commitTurnBoundary({
      userId,
      event,
      message,
      executionLease: executionLease(liveLease),
    })
  ))

  assert.deepEqual({
    staleError,
    afterStale,
    winnerError,
    finalEventTypes: listTurnEvents({ ...scope, limit: 100 }).map(({ type }) => type),
    finalEvidenceMessageIds: listMessages({ userId, sessionId: scope.sessionId, limit: 100 })
      .map(({ id }) => id),
  }, {
    staleError: { code: 'TURN_EXECUTION_LEASE_STALE', status: 409 },
    afterStale: { eventTypes: ['turn.started'], evidenceMessageIds: [] },
    winnerError: null,
    finalEventTypes: ['turn.started', 'turn.completed'],
    finalEvidenceMessageIds: [message.id],
  })
})

test('checkpoint and boundary commits fail closed when the execution lease proof is missing', async () => {
  const checkpointScope = createStartedTurn('missing-checkpoint-proof')
  claimSnapshot(checkpointScope, 'worker-checkpoint', liveNow)
  const boundaryScope = createStartedTurn('missing-boundary-proof')
  claimSnapshot(boundaryScope, 'worker-boundary', liveNow)

  const checkpointError = await captureError(() => (
    turnPersistenceTransactions.commitTurnCheckpoint({
      userId,
      event: checkpointEvent(checkpointScope),
      checkpointState: { messages: [], iterations: 1 },
    })
  ))
  const boundaryError = await captureError(() => (
    turnPersistenceTransactions.commitTurnBoundary({
      userId,
      event: completedEvent(boundaryScope),
      message: completionMessage(boundaryScope),
    })
  ))

  assert.deepEqual({
    checkpointError,
    checkpointEventTypes: listTurnEvents({ ...checkpointScope, limit: 100 }).map(({ type }) => type),
    boundaryError,
    boundaryEventTypes: listTurnEvents({ ...boundaryScope, limit: 100 }).map(({ type }) => type),
    boundaryMessageCount: listMessages({ userId, sessionId: boundaryScope.sessionId, limit: 100 }).length,
  }, {
    checkpointError: { code: 'TURN_EXECUTION_LEASE_STALE', status: 409 },
    checkpointEventTypes: ['turn.started'],
    boundaryError: { code: 'TURN_EXECUTION_LEASE_STALE', status: 409 },
    boundaryEventTypes: ['turn.started'],
    boundaryMessageCount: 0,
  })
})

test('an expired execution lease proof is rejected even before another worker takes over', async () => {
  const scope = createStartedTurn('expired-proof')
  const expiredLease = claimSnapshot(scope, 'expired-worker', liveNow - 2_000)

  const checkpointError = await captureError(() => (
    turnPersistenceTransactions.commitTurnCheckpoint({
      userId,
      event: checkpointEvent(scope),
      checkpointState: { messages: [], iterations: 1 },
      executionLease: executionLease(expiredLease),
    })
  ))

  assert.deepEqual({
    checkpointError,
    eventTypes: listTurnEvents({ ...scope, limit: 100 }).map(({ type }) => type),
    checkpoint: getTurnCheckpoint(scope),
  }, {
    checkpointError: { code: 'TURN_EXECUTION_LEASE_STALE', status: 409 },
    eventTypes: ['turn.started'],
    checkpoint: null,
  })
})

test('an expired token cannot renew or release a replacement lease with the same owner id', () => {
  const scope = createStartedTurn('same-owner-aba')
  const staleLease = claimSnapshot(scope, 'reused-worker-id', liveNow - 2_000)
  const liveLease = claimSnapshot(scope, 'reused-worker-id', liveNow)

  const staleRenew = renewTurnExecutionLease({
    ...scope,
    ownerId: staleLease.ownerId,
    fencingToken: staleLease.fencingToken,
    now: liveNow + 100,
    leaseMs,
  })
  const staleRelease = releaseTurnExecutionLease({
    ...scope,
    ownerId: staleLease.ownerId,
    fencingToken: staleLease.fencingToken,
  })
  const afterStaleOperations = getTurnExecutionLease(scope)
  const liveRenew = renewTurnExecutionLease({
    ...scope,
    ownerId: liveLease.ownerId,
    fencingToken: liveLease.fencingToken,
    now: liveNow + 200,
    leaseMs,
  })
  const liveRelease = releaseTurnExecutionLease({
    ...scope,
    ownerId: liveLease.ownerId,
    fencingToken: liveLease.fencingToken,
  })

  assert.deepEqual({
    tokenAdvanced: liveLease.fencingToken > staleLease.fencingToken,
    staleRenew,
    staleRelease,
    replacementSurvived: Boolean(afterStaleOperations)
      && afterStaleOperations.fencingToken === liveLease.fencingToken,
    liveRenew,
    liveRelease,
  }, {
    tokenAdvanced: true,
    staleRenew: { renewed: false, cancelRequested: false },
    staleRelease: false,
    replacementSurvived: true,
    liveRenew: { renewed: true, cancelRequested: false },
    liveRelease: true,
  })
})

test('a live lease still cannot append checkpoint state after a terminal boundary', async () => {
  const scope = createStartedTurn('terminal-rejects-checkpoint')
  const liveLease = claimSnapshot(scope, 'terminal-worker', liveNow)

  await turnPersistenceTransactions.commitTurnBoundary({
    userId,
    event: completedEvent(scope),
    message: completionMessage(scope),
    executionLease: executionLease(liveLease),
  })
  const checkpointError = await captureError(() => (
    turnPersistenceTransactions.commitTurnCheckpoint({
      userId,
      event: checkpointEvent(scope, 2),
      checkpointState: { messages: [], iterations: 2 },
      executionLease: executionLease(liveLease),
    })
  ))

  assert.deepEqual({
    checkpointError,
    eventTypes: listTurnEvents({ ...scope, limit: 100 }).map(({ type }) => type),
    checkpoint: getTurnCheckpoint(scope),
  }, {
    checkpointError: { code: 'TURN_ALREADY_TERMINAL', status: 409 },
    eventTypes: ['turn.started', 'turn.completed'],
    checkpoint: null,
  })
})
