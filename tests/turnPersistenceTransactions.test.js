import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-persistence-transactions-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, createUser, getDb } = await import('../server/db.js')
const {
  AGENT_EVENT_CONSUMER_CONTRACT_VERSION,
} = await import('../server/core/agentEventConsumerHost.js')
const {
  agentEventConsumerHost,
} = await import('../server/core/agentEventConsumerRuntime.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { createTurnExecutionLeaseCoordinator } = await import(
  '../server/services/turnExecutionLeaseRuntime.js'
)
const {
  createManagedAttachment,
  getManagedAttachment,
  bindManagedAttachmentsToMessage,
} = await import('../server/services/managedAttachmentStore.js')
const {
  getSession,
  listMessages,
  upsertMessage,
  upsertSession,
} = await import('../server/services/sessionStore.js')
const {
  createSqliteTurnPersistenceTransactions,
  SQLITE_TURN_PERSISTENCE_TRANSACTIONS,
} = await import('../server/services/sqliteTurnPersistenceTransactions.js')
const {
  appendTurnEvent,
  appendTurnEvents,
  appendTurnEventsInTransaction,
  listTurnEvents,
} = await import('../server/services/turnEventStore.js')
const { getTurnCheckpoint } = await import('../server/services/turnCheckpointStore.js')
const {
  claimTurnExecutionLease,
  getTurnExecutionLease,
} = await import('../server/services/turnExecutionLeaseStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { createTurnEventEmitter } = await import('../server/services/turnEventEmitter.js')

const userId = 'turn-persistence-aggregate-user'
createUser({ id: userId, email: 'turn-persistence-aggregate@example.com' })

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function startedEvent({
  sessionId,
  turnId,
  id = `${turnId}:started`,
  createdAt = 100,
  attachments = [],
} = {}) {
  return createTurnEvent({
    id,
    sessionId,
    turnId,
    sequence: 0,
    type: 'turn.started',
    payload: {
      content: 'persist this turn',
      userMessageId: `${turnId}:user`,
      attachments: attachments.map(({ id, name, mimeType, size, sha256 }) => ({
        id,
        name,
        mimeType,
        size,
        sha256,
      })),
    },
    createdAt,
  })
}

function startMessages({ sessionId, turnId, createdAt = 100 } = {}) {
  return [
    {
      id: `${turnId}:history:0`,
      userId,
      sessionId,
      role: 'assistant',
      content: 'imported history',
      createdAt: createdAt - 1,
      updatedAt: createdAt,
    },
    {
      id: `${turnId}:user`,
      userId,
      sessionId,
      role: 'user',
      content: 'persist this turn',
      modelContext: { version: 1, turnId },
      createdAt,
      updatedAt: createdAt,
    },
  ]
}

function aggregateRows({ sessionId, turnId }) {
  return {
    session: getSession({ userId, sessionId }),
    messages: listMessages({ userId, sessionId, limit: 100 }),
    events: listTurnEvents({ userId, sessionId, turnId, limit: 100 }),
  }
}

function claimExecutionLease({ sessionId, turnId, ownerId }) {
  const scope = { userId, sessionId, turnId }
  assert.equal(claimTurnExecutionLease({
    ...scope,
    ownerId,
    leaseMs: 60_000,
  }), true)
  const lease = getTurnExecutionLease(scope)
  return { ownerId: lease.ownerId, fencingToken: lease.fencingToken }
}

test('Agent Event plugins observe only newly committed Turn events', async () => {
  const sessionId = 'agent-event-durable-session'
  const turnId = 'agent-event-durable-turn'
  const received = []
  const registration = agentEventConsumerHost.register({
    id: 'test.agent-event.durable-commit',
    contractVersion: AGENT_EVENT_CONSUMER_CONTRACT_VERSION,
    eventTypes: ['turn.started', 'heartbeat'],
    listener: (envelope) => received.push(envelope.event.id),
  })
  upsertSession({
    id: sessionId,
    userId,
    title: 'Agent Event durable commit',
    createdAt: 50,
    updatedAt: 50,
  })
  const started = startedEvent({ sessionId, turnId, createdAt: 50 })

  try {
    appendTurnEvent({ userId, event: started })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(received, [started.id])

    // Idempotent re-append reads the existing event but must not fan it out a
    // second time because no new row committed.
    appendTurnEvent({ userId, event: started })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(received, [started.id])

    const failedId = `${turnId}:injected-write-failure`
    getDb().exec(`
      CREATE TRIGGER fail_agent_event_durable_commit
      BEFORE INSERT ON turn_events
      WHEN NEW.id = '${failedId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected Agent Event persistence failure');
      END;
    `)
    const failed = createTurnEvent({
      id: failedId,
      sessionId,
      turnId,
      sequence: 1,
      type: 'heartbeat',
      payload: { at: 51 },
      createdAt: 51,
    })
    assert.throws(
      () => appendTurnEvent({ userId, event: failed }),
      /injected Agent Event persistence failure/u,
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(received, [started.id])
  } finally {
    getDb().exec('DROP TRIGGER IF EXISTS fail_agent_event_durable_commit')
    await registration.revoke()
  }
})

test('commitTurnStart rolls back the new session, all messages, and turn.started together', async () => {
  const sessionId = 'aggregate-start-rollback-session'
  const turnId = 'aggregate-start-rollback-turn'
  const injectedFailure = new Error('fail after writing the user message')
  const transactions = createSqliteTurnPersistenceTransactions({
    writeMessage(message) {
      const stored = upsertMessage(message)
      if (message.id === `${turnId}:user`) throw injectedFailure
      return stored
    },
    publishEvents: () => {},
    notifySession: () => {},
  })

  await assert.rejects(
    transactions.commitTurnStart({
      userId,
      session: {
        id: sessionId,
        userId,
        title: 'Atomic start',
        createdAt: 100,
        updatedAt: 100,
      },
      messages: startMessages({ sessionId, turnId }),
      event: startedEvent({ sessionId, turnId }),
    }),
    (error) => error === injectedFailure,
  )

  assert.deepEqual(aggregateRows({ sessionId, turnId }), {
    session: null,
    messages: [],
    events: [],
  })
})

test('commitTurnStart rolls back attachment binding and can safely retry the whole aggregate', async () => {
  const sessionId = 'aggregate-start-attachment-session'
  const turnId = 'aggregate-start-attachment-turn'
  const attachment = await createManagedAttachment({
    userId,
    name: 'atomic-start.txt',
    mimeType: 'text/plain',
    source: (async function* source() { yield Buffer.from('atomic attachment') })(),
    now: 200,
  })
  const command = {
    userId,
    session: {
      id: sessionId,
      userId,
      title: 'Attachment start',
      createdAt: 200,
      updatedAt: 200,
    },
    messages: startMessages({ sessionId, turnId, createdAt: 200 }),
    attachmentBinding: {
      userId,
      sessionId,
      messageId: `${turnId}:user`,
      attachmentIds: [attachment.id],
      now: 200,
    },
    attachmentBindingAuthorized: true,
    event: startedEvent({
      sessionId,
      turnId,
      createdAt: 200,
      attachments: [attachment],
    }),
  }
  const injectedFailure = new Error('fail after attachment binding')
  const failingTransactions = createSqliteTurnPersistenceTransactions({
    bindAttachments(input) {
      bindManagedAttachmentsToMessage(input)
      throw injectedFailure
    },
    publishEvents: () => {},
    notifySession: () => {},
  })

  await assert.rejects(
    failingTransactions.commitTurnStart(command),
    (error) => error === injectedFailure,
  )
  assert.deepEqual(aggregateRows({ sessionId, turnId }), {
    session: null,
    messages: [],
    events: [],
  })
  assert.deepEqual(
    {
      sessionId: getManagedAttachment({ userId, id: attachment.id })?.sessionId,
      messageId: getManagedAttachment({ userId, id: attachment.id })?.messageId,
    },
    { sessionId: null, messageId: null },
  )

  await SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnStart({
    ...command,
    attachmentBindingAuthorized: true,
  })
  const committed = aggregateRows({ sessionId, turnId })
  assert.equal(committed.session?.id, sessionId)
  assert.deepEqual(committed.messages.map((message) => message.id), [
    `${turnId}:history:0`,
    `${turnId}:user`,
  ])
  assert.deepEqual(committed.events.map((event) => event.type), ['turn.started'])
  assert.deepEqual(
    {
      sessionId: getManagedAttachment({ userId, id: attachment.id })?.sessionId,
      messageId: getManagedAttachment({ userId, id: attachment.id })?.messageId,
    },
    { sessionId, messageId: `${turnId}:user` },
  )
})

test('SQLite turn start rolls back when the host has not authorized its attachment transaction domain', async () => {
    const sessionId = 'aggregate-start-unauthorized-binder-session'
    const turnId = 'aggregate-start-unauthorized-binder-turn'
    const attachment = {
      id: 'attachment-unauthorized-binder',
      name: 'contract.txt',
      mimeType: 'text/plain',
      size: 8,
      sha256: 'a'.repeat(64),
    }
    const command = {
      userId,
      session: { id: sessionId, userId, title: 'Atomic binder contract', createdAt: 225 },
      messages: startMessages({ sessionId, turnId, createdAt: 225 }),
      attachmentBinding: {
        userId,
        sessionId,
        messageId: `${turnId}:user`,
        attachmentIds: [attachment.id],
        now: 225,
      },
      event: startedEvent({ sessionId, turnId, createdAt: 225, attachments: [attachment] }),
    }

    await assert.rejects(
      SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnStart(command),
      (error) => error?.code === 'TURN_ATTACHMENT_ATOMIC_BINDING_UNAUTHORIZED'
        && error?.retryable === false,
    )
    assert.deepEqual(aggregateRows({ sessionId, turnId }), {
      session: null,
      messages: [],
      events: [],
    })
})

test('an exact commitTurnStart retry resolves a post-commit acknowledgement loss without duplicates', async () => {
  const sessionId = 'aggregate-start-ack-loss-session'
  const turnId = 'aggregate-start-ack-loss-turn'
  const command = {
    userId,
    session: {
      id: sessionId,
      userId,
      title: 'Start acknowledgement loss',
      createdAt: 250,
      updatedAt: 250,
    },
    messages: startMessages({ sessionId, turnId, createdAt: 250 }),
    event: startedEvent({ sessionId, turnId, createdAt: 250 }),
  }
  const acknowledgementLoss = new Error('commit response lost after SQLite COMMIT')
  let failPublishedCommit = true
  const transactions = createSqliteTurnPersistenceTransactions({
    publishEvents(insertedEvents) {
      if (failPublishedCommit && insertedEvents.length > 0) {
        failPublishedCommit = false
        throw acknowledgementLoss
      }
    },
    notifySession: () => {},
  })

  await assert.rejects(
    transactions.commitTurnStart(command),
    (error) => error === acknowledgementLoss,
  )
  assert.equal(aggregateRows({ sessionId, turnId }).events.length, 1)
  assert.equal(aggregateRows({ sessionId, turnId }).messages.length, 2)

  const receipt = await transactions.commitTurnStart(command)
  assert.equal(receipt.id, command.event.id)
  assert.equal(aggregateRows({ sessionId, turnId }).events.length, 1)
  assert.equal(aggregateRows({ sessionId, turnId }).messages.length, 2)
})

test('concurrent startTurn calls for one turnId never delete the winning user message', async () => {
  const sessionId = 'aggregate-concurrent-start-session'
  const turnId = 'aggregate-concurrent-start-turn'
  upsertSession({ id: sessionId, userId, title: 'Concurrent start' })

  let releaseLoop
  const loopGate = new Promise((resolve) => { releaseLoop = resolve })
  const engine = new TurnEngine({
    commitTurnStart: SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnStart,
    commitTurnCheckpoint: SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnCheckpoint,
    commitTurnBoundary: SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnBoundary,
    executionLeases: createTurnExecutionLeaseCoordinator({
      ownerId: 'aggregate-concurrent-worker',
      leaseMs: 60_000,
    }),
    resolveModelBinding: () => ({
      modelName: 'test-model',
      modelProviderId: 'test-provider',
      modelConfigRevision: 1,
      env: {},
    }),
    runLoop: async () => {
      await loopGate
      return { text: 'winner completed', artifactIds: [], iterations: 1 }
    },
    scheduleMemoryExtraction: () => {},
  })

  try {
    const input = { userId, sessionId, turnId, content: 'one durable user message' }
    const results = await Promise.allSettled([
      engine.startTurn(input),
      engine.startTurn(input),
    ])

    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
    assert.equal(results.filter(({ status }) => status === 'rejected').length, 1)
    const messages = listMessages({ userId, sessionId, limit: 100 })
    assert.equal(messages.filter(({ id }) => id === `${turnId}:user`).length, 1)
    assert.equal(messages.find(({ id }) => id === `${turnId}:user`)?.content, 'one durable user message')
    assert.deepEqual(
      listTurnEvents({ userId, sessionId, turnId, limit: 100 }).map((event) => event.type),
      ['turn.started'],
    )
  } finally {
    releaseLoop()
    await engine.waitForTurn({ userId, sessionId, turnId })
    await engine.shutdown()
  }
})

test('TurnEngine creates a missing session only through the aggregate start commit', async () => {
  const sessionId = 'aggregate-engine-new-session'
  const turnId = 'aggregate-engine-new-session-turn'
  let directSessionWrites = 0
  let directMessageWrites = 0
  const engine = new TurnEngine({
    commitTurnStart: SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnStart,
    commitTurnCheckpoint: SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnCheckpoint,
    commitTurnBoundary: SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnBoundary,
    writeSession: (session) => {
      directSessionWrites += 1
      return upsertSession(session)
    },
    writeMessage: (message) => {
      directMessageWrites += 1
      return upsertMessage(message)
    },
    executionLeases: createTurnExecutionLeaseCoordinator({
      ownerId: 'aggregate-new-session-worker',
      leaseMs: 60_000,
    }),
    resolveModelBinding: () => ({
      modelName: 'test-model',
      modelProviderId: 'test-provider',
      modelConfigRevision: 1,
      env: {},
    }),
    runLoop: async () => ({ text: 'new session completed', artifactIds: [], iterations: 1 }),
    scheduleMemoryExtraction: () => {},
  })

  try {
    await engine.startTurn({ userId, sessionId, turnId, content: 'create atomically' })
    await engine.waitForTurn({ userId, sessionId, turnId })

    assert.equal(directSessionWrites, 0)
    assert.equal(directMessageWrites, 0)
    assert.equal(getSession({ userId, sessionId })?.id, sessionId)
    assert.deepEqual(
      listMessages({ userId, sessionId, limit: 100 }).map((message) => message.id),
      [`${turnId}:user`, `${turnId}:assistant`],
    )
    assert.deepEqual(
      listTurnEvents({ userId, sessionId, turnId, limit: 100 }).map((event) => event.type),
      ['turn.started', 'turn.completed'],
    )
  } finally {
    await engine.shutdown()
  }
})

test('TurnEngine routes a completed boundary through the aggregate transaction', async () => {
  const sessionId = 'aggregate-engine-boundary-session'
  const turnId = 'aggregate-engine-boundary-turn'
  upsertSession({ id: sessionId, userId, title: 'Engine boundary' })

  let boundaryCommits = 0
  let directEvidenceWrites = 0
  let directBoundaryAppends = 0
  const engine = new TurnEngine({
    commitTurnStart: SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnStart,
    commitTurnCheckpoint: SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnCheckpoint,
    commitTurnBoundary: async (input) => {
      boundaryCommits += 1
      return SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnBoundary(input)
    },
    appendEvent: (entry) => {
      if (entry?.event?.type === 'turn.completed') directBoundaryAppends += 1
      return appendTurnEvent(entry)
    },
    appendEventBatch: appendTurnEvents,
    writeMessage: (message) => {
      if (message.id === `${turnId}:assistant`) directEvidenceWrites += 1
      return upsertMessage(message)
    },
    executionLeases: createTurnExecutionLeaseCoordinator({
      ownerId: 'aggregate-boundary-worker',
      leaseMs: 60_000,
    }),
    resolveModelBinding: () => ({
      modelName: 'test-model',
      modelProviderId: 'test-provider',
      modelConfigRevision: 1,
      env: {},
    }),
    runLoop: async () => ({ text: 'atomic completion', artifactIds: [], iterations: 1 }),
    scheduleMemoryExtraction: () => {},
  })

  try {
    await engine.startTurn({ userId, sessionId, turnId, content: 'complete atomically' })
    await engine.waitForTurn({ userId, sessionId, turnId })

    assert.equal(boundaryCommits, 1)
    assert.equal(directEvidenceWrites, 0)
    assert.equal(directBoundaryAppends, 0)
    assert.deepEqual(
      listTurnEvents({ userId, sessionId, turnId, limit: 100 }).map((event) => event.type),
      ['turn.started', 'turn.completed'],
    )
    const evidence = listMessages({ userId, sessionId, limit: 100 })
      .find(({ id }) => id === `${turnId}:assistant`)
    assert.equal(evidence?.content, 'atomic completion')
    assert.equal(evidence?.modelContext?.turnId, turnId)
  } finally {
    await engine.shutdown()
  }
})

test('commitTurnBoundary persists the boundary event and evidence message all-or-nothing', async () => {
  const sessionId = 'aggregate-boundary-session'
  const turnId = 'aggregate-boundary-turn'
  upsertSession({ id: sessionId, userId, title: 'Atomic boundary' })
  appendTurnEvent({ userId, event: startedEvent({ sessionId, turnId, createdAt: 300 }) })

  const boundaryEvent = createTurnEvent({
    id: `${turnId}:completed`,
    sessionId,
    turnId,
    sequence: 1,
    type: 'turn.completed',
    payload: { text: 'durable result', iterations: 1 },
    createdAt: 301,
  })
  const evidenceMessage = {
    id: `${turnId}:assistant`,
    userId,
    sessionId,
    role: 'assistant',
    content: 'durable result',
    modelContext: {
      version: 1,
      turnId,
      turnEvidence: true,
      evidenceState: 'completed',
      serverLastSequence: 1,
    },
    createdAt: 301,
    updatedAt: 301,
  }
  const injectedFailure = new Error('fail after evidence write')
  const executionLease = claimExecutionLease({
    sessionId,
    turnId,
    ownerId: 'aggregate-boundary-fault-worker',
  })
  const failingTransactions = createSqliteTurnPersistenceTransactions({
    writeMessage(message) {
      upsertMessage(message)
      throw injectedFailure
    },
    publishEvents: () => {},
  })

  await assert.rejects(
    failingTransactions.commitTurnBoundary({
      userId,
      event: boundaryEvent,
      message: evidenceMessage,
      executionLease,
    }),
    (error) => error === injectedFailure,
  )
  assert.deepEqual(
    listTurnEvents({ userId, sessionId, turnId, limit: 100 }).map((event) => event.type),
    ['turn.started'],
  )
  assert.equal(
    listMessages({ userId, sessionId, limit: 100 }).some(({ id }) => id === evidenceMessage.id),
    false,
  )

  await SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnBoundary({
    userId,
    event: boundaryEvent,
    message: evidenceMessage,
    executionLease,
  })
  assert.deepEqual(
    listTurnEvents({ userId, sessionId, turnId, limit: 100 }).map((event) => event.type),
    ['turn.started', 'turn.completed'],
  )
  assert.equal(
    listMessages({ userId, sessionId, limit: 100 }).find(({ id }) => id === evidenceMessage.id)?.content,
    'durable result',
  )
})

test('an exact commitTurnBoundary retry resolves a post-commit acknowledgement loss without duplicates', async () => {
  const sessionId = 'aggregate-boundary-ack-loss-session'
  const turnId = 'aggregate-boundary-ack-loss-turn'
  upsertSession({ id: sessionId, userId, title: 'Boundary acknowledgement loss' })
  appendTurnEvent({ userId, event: startedEvent({ sessionId, turnId, createdAt: 400 }) })
  const event = createTurnEvent({
    id: `${turnId}:completed`,
    sessionId,
    turnId,
    sequence: 1,
    type: 'turn.completed',
    payload: { text: 'committed before response loss' },
    createdAt: 401,
  })
  const message = {
    id: `${turnId}:assistant`,
    userId,
    sessionId,
    role: 'assistant',
    content: 'committed before response loss',
    modelContext: { version: 1, turnId },
    createdAt: 401,
    updatedAt: 401,
  }
  const acknowledgementLoss = new Error('boundary response lost after SQLite COMMIT')
  const executionLease = claimExecutionLease({
    sessionId,
    turnId,
    ownerId: 'aggregate-boundary-ack-worker',
  })
  let failPublishedCommit = true
  const transactions = createSqliteTurnPersistenceTransactions({
    publishEvents(insertedEvents) {
      if (failPublishedCommit && insertedEvents.length > 0) {
        failPublishedCommit = false
        throw acknowledgementLoss
      }
    },
  })

  await assert.rejects(
    transactions.commitTurnBoundary({ userId, event, message, executionLease }),
    (error) => error === acknowledgementLoss,
  )
  const receipt = await transactions.commitTurnBoundary({ userId, event, message, executionLease })
  assert.equal(receipt.id, event.id)
  assert.deepEqual(
    listTurnEvents({ userId, sessionId, turnId, limit: 100 }).map((stored) => stored.type),
    ['turn.started', 'turn.completed'],
  )
  assert.equal(
    listMessages({ userId, sessionId, limit: 100 })
      .filter((stored) => stored.id === message.id).length,
    1,
  )
})

test('commitTurnBoundary atomically advances one assistant projection across pause and completion', async () => {
  const sessionId = 'aggregate-boundary-transition-session'
  const turnId = 'aggregate-boundary-transition-turn'
  upsertSession({ id: sessionId, userId, title: 'Boundary transition' })
  appendTurnEvent({ userId, event: startedEvent({ sessionId, turnId, createdAt: 450 }) })
  const executionLease = claimExecutionLease({
    sessionId,
    turnId,
    ownerId: 'aggregate-boundary-transition-worker',
  })
  const pausedEvent = createTurnEvent({
    id: `${turnId}:paused`,
    sessionId,
    turnId,
    sequence: 1,
    type: 'turn.paused',
    payload: { text: 'waiting for approval', clarification: 'approve' },
    createdAt: 451,
  })
  const pausedMessage = {
    id: `${turnId}:assistant`,
    userId,
    sessionId,
    role: 'assistant',
    content: 'waiting for approval',
    modelContext: { version: 1, turnId, evidenceState: 'paused', serverLastSequence: 1 },
    createdAt: 451,
    updatedAt: 451,
  }
  await SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnBoundary({
    userId,
    event: pausedEvent,
    message: pausedMessage,
    executionLease,
  })

  const completedEvent = createTurnEvent({
    id: `${turnId}:completed`,
    sessionId,
    turnId,
    sequence: 2,
    type: 'turn.completed',
    payload: { text: 'approved result' },
    createdAt: 452,
  })
  const completedMessage = {
    ...pausedMessage,
    content: 'approved result',
    modelContext: { version: 1, turnId, evidenceState: 'completed', serverLastSequence: 2 },
    createdAt: 452,
    updatedAt: 452,
  }
  await SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnBoundary({
    userId,
    event: completedEvent,
    message: completedMessage,
    executionLease,
  })
  await SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnBoundary({
    userId,
    event: completedEvent,
    message: completedMessage,
    executionLease,
  })

  assert.deepEqual(
    listTurnEvents({ userId, sessionId, turnId, limit: 100 }).map((event) => event.type),
    ['turn.started', 'turn.paused', 'turn.completed'],
  )
  const [message] = listMessages({ userId, sessionId, limit: 100 })
    .filter((entry) => entry.id === completedMessage.id)
  assert.equal(message.content, 'approved result')
  assert.equal(message.createdAt, pausedMessage.createdAt)
  assert.equal(message.updatedAt, completedMessage.updatedAt)
  assert.equal(message.modelContext.evidenceState, 'completed')
})

test('commitTurnCheckpoint accepts an exact retry and rejects state drift at the same sequence', async () => {
  const sessionId = 'aggregate-checkpoint-identity-session'
  const turnId = 'aggregate-checkpoint-identity-turn'
  upsertSession({ id: sessionId, userId, title: 'Checkpoint identity' })
  appendTurnEvent({ userId, event: startedEvent({ sessionId, turnId, createdAt: 500 }) })
  const event = createTurnEvent({
    id: `${turnId}:checkpoint:1`,
    sessionId,
    turnId,
    sequence: 1,
    type: 'turn.checkpoint',
    payload: {
      storage: 'turn_checkpoints',
      checkpointVersion: 1,
      iterations: 1,
      toolCallCount: 0,
    },
    createdAt: 501,
  })
  const checkpointState = { messages: [{ role: 'user', content: 'stable' }], iterations: 1 }
  const executionLease = claimExecutionLease({
    sessionId,
    turnId,
    ownerId: 'aggregate-checkpoint-identity-worker',
  })

  const first = await SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnCheckpoint({
    userId,
    event,
    checkpointState,
    executionLease,
  })
  const retried = await SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnCheckpoint({
    userId,
    event,
    checkpointState: structuredClone(checkpointState),
    executionLease,
  })
  assert.equal(first.id, event.id)
  assert.equal(retried.id, event.id)

  await assert.rejects(
    SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnCheckpoint({
      userId,
      event,
      checkpointState: { ...checkpointState, iterations: 2 },
      executionLease,
    }),
    (error) => error?.code === 'TURN_CHECKPOINT_IDENTITY_CONFLICT',
  )
  const stored = getTurnCheckpoint({ userId, sessionId, turnId })
  assert.equal(stored?.eventSequence, 1)
  assert.equal(stored?.state?.iterations, 1)
  assert.equal(listTurnEvents({ userId, sessionId, turnId, limit: 100 }).length, 2)
})

test('appendTurnEventsInTransaction fails closed outside a caller-owned transaction with zero writes', () => {
  const sessionId = 'aggregate-transaction-required-session'
  const turnId = 'aggregate-transaction-required-turn'
  upsertSession({ id: sessionId, userId, title: 'Transaction required' })
  const event = startedEvent({ sessionId, turnId, createdAt: 600 })

  assert.throws(
    () => appendTurnEventsInTransaction([{ userId, event }], getDb()),
    (error) => error?.code === 'TURN_EVENT_TRANSACTION_REQUIRED',
  )
  assert.deepEqual(listTurnEvents({ userId, sessionId, turnId, limit: 100 }), [])
})

test('failed retry transaction bypass requires an explicitly retryable failure', () => {
  for (const retryable of [false, true]) {
    const suffix = retryable ? 'retryable' : 'non-retryable'
    const sessionId = `aggregate-failed-retry-guard-${suffix}-session`
    const turnId = `aggregate-failed-retry-guard-${suffix}-turn`
    upsertSession({ id: sessionId, userId, title: 'Failed retry guard' })
    appendTurnEvent({ userId, event: startedEvent({ sessionId, turnId, createdAt: 610 }) })
    appendTurnEvent({
      userId,
      event: createTurnEvent({
        id: `${turnId}:failed`,
        sessionId,
        turnId,
        sequence: 1,
        type: 'turn.failed',
        payload: {
          code: 'MODEL_FAILURE',
          message: 'model failed',
          error: { code: 'MODEL_FAILURE', message: 'model failed', retryable },
        },
        createdAt: 611,
      }),
    })
    const retryEvent = createTurnEvent({
      id: `${turnId}:attempt:2`,
      sessionId,
      turnId,
      sequence: 2,
      type: 'turn.attempt',
      payload: {
        attempt: 2,
        reason: 'failed_retry',
        resetStreaming: true,
        checkpointSequence: null,
        previousStreamSequence: 1,
        assistantText: '',
        reasoningText: '',
      },
      createdAt: 612,
    })
    const appendRetry = () => getDb().transaction(() => appendTurnEventsInTransaction(
      [{ userId, event: retryEvent }],
      getDb(),
      { allowFailedRetry: true },
    ))()

    if (retryable) {
      const committed = appendRetry()
      assert.equal(committed.insertedEvents.length, 1)
      assert.equal(committed.stored[0].id, retryEvent.id)
    } else {
      assert.throws(appendRetry, (error) => error?.code === 'TURN_ALREADY_TERMINAL')
    }
  }
})

test('concurrent failed retries coalesce to one attempt without journaling a write failure', async (t) => {
  const sessionId = 'aggregate-failed-retry-race-session'
  const turnId = 'aggregate-failed-retry-race-turn'
  upsertSession({ id: sessionId, userId, title: 'Failed retry race' })
  appendTurnEvent({ userId, event: startedEvent({ sessionId, turnId, createdAt: 620 }) })
  const executionLease = claimExecutionLease({
    sessionId,
    turnId,
    ownerId: 'aggregate-failed-retry-race-worker',
  })
  const checkpointEvent = createTurnEvent({
    id: `${turnId}:checkpoint`,
    sessionId,
    turnId,
    sequence: 1,
    type: 'turn.checkpoint',
    payload: {
      storage: 'turn_checkpoints',
      checkpointVersion: 1,
      iterations: 3,
      toolCallCount: 1,
    },
    createdAt: 621,
  })
  await SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnCheckpoint({
    userId,
    event: checkpointEvent,
    checkpointState: {
      iterations: 3,
      final: { incomplete: true },
      budget: { used: 7, modelCalls: 2, costUsd: 1.5 },
      toolCalls: [{ id: 'already-completed' }],
      modelInvocation: { id: 'model-request-1' },
    },
    executionLease,
  })
  await SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnBoundary({
    userId,
    event: createTurnEvent({
      id: `${turnId}:failed`,
      sessionId,
      turnId,
      sequence: 2,
      type: 'turn.failed',
      payload: {
        code: 'MODEL_UNAVAILABLE',
        message: 'model unavailable',
        error: { code: 'MODEL_UNAVAILABLE', message: 'model unavailable', retryable: true },
        partialText: 'durable partial',
      },
      createdAt: 622,
    }),
    executionLease,
  })

  const payload = {
    attempt: 2,
    reason: 'failed_retry',
    resetStreaming: true,
    checkpointSequence: 1,
    previousStreamSequence: 2,
    assistantText: 'durable partial',
    reasoningText: '',
  }
  const journal = []
  const observedAttemptIds = []
  const agentEventRegistration = agentEventConsumerHost.register({
    id: 'test.agent-event.failed-retry-race',
    contractVersion: AGENT_EVENT_CONSUMER_CONTRACT_VERSION,
    eventTypes: ['turn.attempt'],
    listener: (envelope) => observedAttemptIds.push(envelope.event.id),
  })
  t.after(() => agentEventRegistration.revoke())
  const emitRetry = async (id, createdAt) => {
    const emitter = createTurnEventEmitter({
      userId,
      sessionId,
      turnId,
      sequence: 3,
      idFactory: () => id,
      now: () => createdAt,
      appendEvent: (entry) => appendTurnEvent(entry),
      createEventWriteBehind: () => ({
        enqueue: () => null,
        flush: async () => {},
        close: async () => {},
      }),
      recordEventWriteFailure: (entry) => { journal.push(entry) },
    })
    try {
      return await emitter('turn.attempt', payload, {
        commitEvent: ({ event }) => SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnFailedRetry({
          userId,
          event,
          message: {
            id: `${turnId}:assistant`,
            userId,
            sessionId,
            role: 'assistant',
            content: payload.assistantText,
            modelContext: {
              turnEvidence: true,
              evidenceState: 'retrying',
              serverLastSequence: event.sequence,
            },
            createdAt: 622,
            updatedAt: event.createdAt,
          },
        }),
      })
    } finally {
      await emitter.close()
    }
  }

  const results = await Promise.all([
    emitRetry(`${turnId}:attempt-a`, 623),
    emitRetry(`${turnId}:attempt-b`, 624),
  ])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(results[0].id, results[1].id)
  assert.deepEqual(observedAttemptIds, [results[0].id])
  assert.equal(listTurnEvents({ userId, sessionId, turnId, limit: 100 })
    .filter((event) => event.type === 'turn.attempt').length, 1)
  assert.deepEqual(journal, [])
  const checkpoint = getTurnCheckpoint({ userId, sessionId, turnId })
  assert.equal(checkpoint.state.final, null)
  assert.equal(checkpoint.state.iterationWindowStart, 3)
  assert.equal(checkpoint.state.budget.used, 0)
  assert.deepEqual(checkpoint.state.toolCalls, [{ id: 'already-completed' }])
  assert.deepEqual(checkpoint.state.modelInvocation, { id: 'model-request-1' })
})

test('duplicate failed retry commits converge on one attempt without replaying projection writes', async () => {
  const sessionId = 'aggregate-failed-retry-idempotent-session'
  const turnId = 'aggregate-failed-retry-idempotent-turn'
  upsertSession({ id: sessionId, userId, title: 'Failed retry idempotency' })
  appendTurnEvent({ userId, event: startedEvent({ sessionId, turnId, createdAt: 630 }) })
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:checkpoint`,
      sessionId,
      turnId,
      sequence: 1,
      type: 'turn.checkpoint',
      payload: { storage: 'turn_checkpoints', checkpointVersion: 1 },
      createdAt: 631,
    }),
    checkpointState: {
      iterations: 3,
      final: { text: 'stale terminal projection' },
      sideEffectExecutions: [{ toolCallId: 'already-committed', status: 'committed' }],
      budget: { used: 7, modelCalls: 2, modelTokens: 90 },
    },
  })
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:failed`,
      sessionId,
      turnId,
      sequence: 2,
      type: 'turn.failed',
      payload: {
        code: 'TURN_INCOMPLETE',
        message: 'retry this turn',
        error: { code: 'TURN_INCOMPLETE', message: 'retry this turn', retryable: true },
        partialText: 'durable partial',
      },
      createdAt: 632,
    }),
  })

  const retryPayload = {
    attempt: 2,
    reason: 'failed_retry',
    resetStreaming: true,
    checkpointSequence: 1,
    previousStreamSequence: 2,
    assistantText: 'durable partial',
    reasoningText: '',
  }
  const retryEvent = (id, createdAt) => createTurnEvent({
    id,
    sessionId,
    turnId,
    sequence: 3,
    type: 'turn.attempt',
    payload: retryPayload,
    createdAt,
  })
  const retryMessage = {
    id: `${turnId}:assistant`,
    userId,
    sessionId,
    role: 'assistant',
    content: retryPayload.assistantText,
    modelContext: {
      version: 1,
      turnId,
      turnEvidence: true,
      evidenceState: 'retrying',
      serverLastSequence: 3,
    },
    createdAt: 632,
    updatedAt: 633,
  }
  let projectionWrites = 0
  const published = []
  const transactions = createSqliteTurnPersistenceTransactions({
    writeMessage(message) {
      projectionWrites += 1
      return upsertMessage(message)
    },
    publishEvents(events) { published.push(...events) },
  })

  const first = await transactions.commitTurnFailedRetry({
    userId,
    event: retryEvent(`${turnId}:attempt:first`, 633),
    message: retryMessage,
  })
  const duplicate = await transactions.commitTurnFailedRetry({
    userId,
    event: retryEvent(`${turnId}:attempt:duplicate`, 634),
    message: { ...retryMessage, updatedAt: 634 },
  })

  assert.equal(duplicate.id, first.id)
  assert.equal(projectionWrites, 1)
  assert.equal(published.length, 1)
  assert.deepEqual(
    listTurnEvents({ userId, sessionId, turnId, limit: 100 }).map(({ type }) => type),
    ['turn.started', 'turn.checkpoint', 'turn.failed', 'turn.attempt'],
  )
  const checkpoint = getTurnCheckpoint({ userId, sessionId, turnId })
  assert.equal(checkpoint.eventSequence, 1)
  assert.equal(checkpoint.state.final, null)
  assert.equal(checkpoint.state.iterationWindowStart, 3)
  assert.deepEqual(
    checkpoint.state.sideEffectExecutions,
    [{ toolCallId: 'already-committed', status: 'committed' }],
  )
  assert.equal(checkpoint.state.budget.used, 0)
})

test('an event retry with a different createdAt conflicts and preserves the original event', () => {
  const sessionId = 'aggregate-event-created-at-session'
  const turnId = 'aggregate-event-created-at-turn'
  upsertSession({ id: sessionId, userId, title: 'Event identity' })
  const event = startedEvent({ sessionId, turnId, createdAt: 700 })
  appendTurnEvent({ userId, event })

  assert.throws(
    () => appendTurnEvent({
      userId,
      event: startedEvent({ sessionId, turnId, id: event.id, createdAt: 701 }),
    }),
    (error) => error?.code === 'TURN_EVENT_SEQUENCE_CONFLICT',
  )
  assert.deepEqual(
    listTurnEvents({ userId, sessionId, turnId, limit: 100 }).map(({ id, createdAt }) => ({ id, createdAt })),
    [{ id: event.id, createdAt: 700 }],
  )
})

test('checkpoint retries compare canonical JSON state instead of non-serializable object shape', async () => {
  const sessionId = 'aggregate-checkpoint-canonical-session'
  const turnId = 'aggregate-checkpoint-canonical-turn'
  upsertSession({ id: sessionId, userId, title: 'Canonical checkpoint' })
  appendTurnEvent({ userId, event: startedEvent({ sessionId, turnId, createdAt: 800 }) })
  const event = createTurnEvent({
    id: `${turnId}:checkpoint:1`,
    sessionId,
    turnId,
    sequence: 1,
    type: 'turn.checkpoint',
    payload: { storage: 'turn_checkpoints', checkpointVersion: 1 },
    createdAt: 801,
  })
  const checkpointState = {
    messages: [{ role: 'user', content: 'canonical' }],
    optional: undefined,
  }
  const executionLease = claimExecutionLease({
    sessionId,
    turnId,
    ownerId: 'aggregate-checkpoint-canonical-worker',
  })

  await SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnCheckpoint({
    userId,
    event,
    checkpointState,
    executionLease,
  })
  const retried = await SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnCheckpoint({
    userId,
    event,
    checkpointState,
    executionLease,
  })

  assert.equal(retried.id, event.id)
  assert.deepEqual(getTurnCheckpoint({ userId, sessionId, turnId })?.state, {
    checkpointVersion: 1,
    messages: [{ role: 'user', content: 'canonical' }],
  })
})

test('sequence zero is reserved exclusively for turn.started', async () => {
  const sessionId = 'aggregate-sequence-zero-session'
  upsertSession({ id: sessionId, userId, title: 'Sequence zero' })
  const checkpointTurnId = 'aggregate-sequence-zero-checkpoint-turn'
  const completedTurnId = 'aggregate-sequence-zero-completed-turn'
  const checkpoint = createTurnEvent({
    id: `${checkpointTurnId}:checkpoint:0`,
    sessionId,
    turnId: checkpointTurnId,
    sequence: 0,
    type: 'turn.checkpoint',
    payload: { storage: 'turn_checkpoints', checkpointVersion: 1 },
    createdAt: 900,
  })
  const completed = createTurnEvent({
    id: `${completedTurnId}:completed:0`,
    sessionId,
    turnId: completedTurnId,
    sequence: 0,
    type: 'turn.completed',
    payload: { text: 'must not commit' },
    createdAt: 901,
  })
  const checkpointExecutionLease = claimExecutionLease({
    sessionId,
    turnId: checkpointTurnId,
    ownerId: 'aggregate-sequence-zero-checkpoint-worker',
  })
  const completedExecutionLease = claimExecutionLease({
    sessionId,
    turnId: completedTurnId,
    ownerId: 'aggregate-sequence-zero-completed-worker',
  })

  await assert.rejects(
    SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnCheckpoint({
      userId,
      event: checkpoint,
      checkpointState: { messages: [] },
      executionLease: checkpointExecutionLease,
    }),
    (error) => error?.code === 'TURN_EVENT_SEQUENCE_INVALID',
  )
  await assert.rejects(
    SQLITE_TURN_PERSISTENCE_TRANSACTIONS.commitTurnBoundary({
      userId,
      event: completed,
      executionLease: completedExecutionLease,
    }),
    (error) => error?.code === 'TURN_EVENT_SEQUENCE_INVALID',
  )
  assert.deepEqual(listTurnEvents({ userId, sessionId, turnId: checkpointTurnId }), [])
  assert.deepEqual(listTurnEvents({ userId, sessionId, turnId: completedTurnId }), [])
})

test('an exact start retry does not execute attachment binding again', async () => {
  const sessionId = 'aggregate-attachment-retry-session'
  const turnId = 'aggregate-attachment-retry-turn'
  const attachment = await createManagedAttachment({
    userId,
    name: 'retry-once.txt',
    mimeType: 'text/plain',
    source: (async function* source() { yield Buffer.from('bind exactly once') })(),
    now: 1_000,
  })
  const command = {
    userId,
    session: {
      id: sessionId,
      userId,
      title: 'Attachment retry',
      createdAt: 1_000,
      updatedAt: 1_000,
    },
    messages: startMessages({ sessionId, turnId, createdAt: 1_000 }),
    attachmentBinding: {
      userId,
      sessionId,
      messageId: `${turnId}:user`,
      attachmentIds: [attachment.id],
      now: 1_000,
    },
    attachmentBindingAuthorized: true,
    event: startedEvent({
      sessionId,
      turnId,
      createdAt: 1_000,
      attachments: [attachment],
    }),
  }
  let bindingCalls = 0
  const transactions = createSqliteTurnPersistenceTransactions({
    bindAttachments(input) {
      bindingCalls += 1
      return bindManagedAttachmentsToMessage(input)
    },
    publishEvents: () => {},
    notifySession: () => {},
  })

  await transactions.commitTurnStart(command)
  await transactions.commitTurnStart(command)

  assert.equal(bindingCalls, 1)
  assert.equal(getManagedAttachment({ userId, id: attachment.id })?.messageId, `${turnId}:user`)
})

test('upsertMessage rejects a global message id owned by another session', () => {
  const firstSessionId = 'message-ownership-first-session'
  const secondSessionId = 'message-ownership-second-session'
  const messageId = 'message-ownership-global-id'
  upsertSession({ id: firstSessionId, userId, title: 'First owner' })
  upsertSession({ id: secondSessionId, userId, title: 'Second owner' })
  upsertMessage({
    id: messageId,
    userId,
    sessionId: firstSessionId,
    role: 'user',
    content: 'original owner',
    createdAt: 1_100,
    updatedAt: 1_100,
  })

  assert.throws(
    () => upsertMessage({
      id: messageId,
      userId,
      sessionId: secondSessionId,
      role: 'user',
      content: 'must not move',
      createdAt: 1_101,
      updatedAt: 1_101,
    }),
    (error) => error?.code === 'MESSAGE_OWNERSHIP_CONFLICT',
  )
  assert.equal(listMessages({ userId, sessionId: secondSessionId }).length, 0)
  assert.equal(listMessages({ userId, sessionId: firstSessionId })[0]?.content, 'original owner')
})
