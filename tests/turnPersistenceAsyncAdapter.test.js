import assert from 'node:assert/strict'
import test from 'node:test'

import { TurnEngine } from '../server/services/TurnEngine.js'

const {
  prepareTurnPersistenceAdapter,
  TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION,
} = await import('../server/core/turnPersistenceAdapter.js')
const { SESSION_ADMIN_PORT_CONTRACT_VERSION } = await import('../server/core/sessionAdminPort.js')

const USER_ID = 'async-persistence-user'

function scopeKey({ userId, sessionId, id, turnId = '' } = {}) {
  return `${userId}\u0000${sessionId || id}\u0000${turnId}`
}

function createAsyncAdapter({ failures = {}, modelRecoveryResults = {} } = {}) {
  const calls = []
  const sessions = new Map()
  const messages = new Map()
  const events = new Map()
  const checkpoints = new Map()

  const rejectIfConfigured = async (method) => {
    calls.push(`${method}:start`)
    await Promise.resolve()
    if (failures[method]) throw failures[method]
  }
  const finish = (method, value) => {
    calls.push(`${method}:end`)
    return value
  }
  const sessionMessages = ({ userId, sessionId }) => (
    [...messages.values()]
      .filter((message) => message.userId === userId && message.sessionId === sessionId)
      .sort((left, right) => left.createdAt - right.createdAt)
  )
  const turnEvents = ({ userId, sessionId, turnId, type = null }) => (
    (events.get(scopeKey({ userId, sessionId, turnId })) || [])
      .filter((event) => !type || event.type === type)
      .sort((left, right) => left.sequence - right.sequence)
  )
  const storeEvent = ({ userId, event }) => {
    const key = scopeKey({ userId, sessionId: event.sessionId, turnId: event.turnId })
    const stored = events.get(key) || []
    const existing = stored.find((candidate) => candidate.id === event.id)
    if (!existing) stored.push(structuredClone(event))
    events.set(key, stored)
    return existing || event
  }

  const session = {
    async getSession(input) {
      await rejectIfConfigured('getSession')
      return finish('getSession', sessions.get(scopeKey(input)) || null)
    },
    async isSessionIdOccupied({ sessionId }) {
      await rejectIfConfigured('isSessionIdOccupied')
      const occupied = [...sessions.values()].some((candidate) => candidate.id === sessionId)
      return finish('isSessionIdOccupied', occupied)
    },
    async claimLocalChatSession(input) {
      await rejectIfConfigured('claimLocalChatSession')
      const claimed = sessions.get(scopeKey(input)) || null
      return finish('claimLocalChatSession', claimed)
    },
    async upsertSession(input) {
      await rejectIfConfigured('upsertSession')
      sessions.set(scopeKey(input), structuredClone(input))
      return finish('upsertSession', input)
    },
    async listMessages(input) {
      await rejectIfConfigured('listMessages')
      return finish('listMessages', sessionMessages(input))
    },
    async getPreviousUserMessage({ userId, sessionId, messageId }) {
      await rejectIfConfigured('getPreviousUserMessage')
      const before = sessionMessages({ userId, sessionId })
      const index = before.findIndex((message) => message.id === messageId)
      const previous = before.slice(0, index < 0 ? before.length : index)
        .filter((message) => message.role === 'user')
        .at(-1) || null
      return finish('getPreviousUserMessage', previous)
    },
    async upsertMessage(input) {
      await rejectIfConfigured('upsertMessage')
      messages.set(`${input.userId}\u0000${input.id}`, structuredClone(input))
      return finish('upsertMessage', input)
    },
    async deleteMessage({ userId, messageId }) {
      await rejectIfConfigured('deleteMessage')
      return finish('deleteMessage', messages.delete(`${userId}\u0000${messageId}`) ? 1 : 0)
    },
  }

  const eventLog = {
    async appendTurnEvent(entry) {
      await rejectIfConfigured('appendTurnEvent')
      const stored = storeEvent(entry)
      if (entry.checkpointState !== null && entry.checkpointState !== undefined) {
        checkpoints.set(scopeKey({
          userId: entry.userId,
          sessionId: entry.event.sessionId,
          turnId: entry.event.turnId,
        }), {
          userId: entry.userId,
          sessionId: entry.event.sessionId,
          turnId: entry.event.turnId,
          eventSequence: entry.event.sequence,
          state: structuredClone(entry.checkpointState),
        })
      }
      return finish('appendTurnEvent', stored)
    },
    async appendTurnEvents(entries) {
      await rejectIfConfigured('appendTurnEvents')
      return finish('appendTurnEvents', entries.map((entry) => storeEvent(entry)))
    },
    async getLastTurnEvent(input) {
      await rejectIfConfigured('getLastTurnEvent')
      return finish('getLastTurnEvent', turnEvents(input).at(-1) || null)
    },
    async listTurnEvents(input) {
      await rejectIfConfigured('listTurnEvents')
      return finish('listTurnEvents', turnEvents(input))
    },
    async recordTurnEventWriteFailure() {
      await rejectIfConfigured('recordTurnEventWriteFailure')
      return finish('recordTurnEventWriteFailure', 1)
    },
    async verifyTurnEventCommit({ event, storedEvent }) {
      await rejectIfConfigured('verifyTurnEventCommit')
      const committed = storedEvent?.id === event?.id
      return finish('verifyTurnEventCommit', {
        committed,
        receipt: committed ? { eventId: event.id, sequence: event.sequence } : null,
      })
    },
    async getTurnCheckpoint(input) {
      await rejectIfConfigured('getTurnCheckpoint')
      return finish('getTurnCheckpoint', checkpoints.get(scopeKey(input)) || null)
    },
    async saveTurnCheckpoint(input) {
      await rejectIfConfigured('saveTurnCheckpoint')
      checkpoints.set(scopeKey(input), structuredClone(input))
      return finish('saveTurnCheckpoint', input)
    },
    async deleteTurnCheckpoint(input) {
      await rejectIfConfigured('deleteTurnCheckpoint')
      return finish('deleteTurnCheckpoint', checkpoints.delete(scopeKey(input)) ? 1 : 0)
    },
  }

  const transactions = {
    async commitTurnStart(input) {
      await rejectIfConfigured('commitTurnStart')
      if (input.session) sessions.set(scopeKey(input.session), structuredClone(input.session))
      for (const message of input.messages || []) {
        messages.set(`${message.userId}\u0000${message.id}`, structuredClone(message))
      }
      const stored = storeEvent({ userId: input.userId, event: input.event })
      return finish('commitTurnStart', stored)
    },
    async commitTurnCheckpoint(input) {
      await rejectIfConfigured('commitTurnCheckpoint')
      const stored = storeEvent({ userId: input.userId, event: input.event })
      checkpoints.set(scopeKey({
        userId: input.userId,
        sessionId: input.event.sessionId,
        turnId: input.event.turnId,
      }), {
        userId: input.userId,
        sessionId: input.event.sessionId,
        turnId: input.event.turnId,
        eventSequence: input.event.sequence,
        state: structuredClone(input.checkpointState),
      })
      return finish('commitTurnCheckpoint', stored)
    },
    async commitTurnBoundary(input) {
      await rejectIfConfigured('commitTurnBoundary')
      if (input.message) {
        messages.set(`${input.message.userId}\u0000${input.message.id}`, structuredClone(input.message))
      }
      const stored = storeEvent({ userId: input.userId, event: input.event })
      return finish('commitTurnBoundary', stored)
    },
  }

  const asyncResult = (method, result) => async () => {
    await rejectIfConfigured(method)
    return finish(method, result)
  }
  const execution = {
    claimTurnExecutionLease: asyncResult('claimTurnExecutionLease', null),
    getTurnExecutionLease: asyncResult('getTurnExecutionLease', null),
    renewTurnExecutionLease: asyncResult('renewTurnExecutionLease', false),
    releaseTurnExecutionLease: asyncResult('releaseTurnExecutionLease', false),
    isTurnExecutionLeaseActive: asyncResult('isTurnExecutionLeaseActive', false),
    hasActiveTurnExecutionLeaseForSession: asyncResult('hasActiveTurnExecutionLeaseForSession', false),
    requestTurnExecutionCancellation: asyncResult('requestTurnExecutionCancellation', false),
    tryCloseTurnSteeringInbox: asyncResult('tryCloseTurnSteeringInbox', null),
    listUnfinishedTurnExecutions: asyncResult('listUnfinishedTurnExecutions', []),
  }
  const steering = {
    enqueueTurnSteering: asyncResult('enqueueTurnSteering', null),
    listTurnSteering: asyncResult('listTurnSteering', []),
    claimTurnSteering: asyncResult('claimTurnSteering', null),
    acknowledgeTurnSteering: asyncResult('acknowledgeTurnSteering', 0),
    acknowledgeAppliedTurnSteering: asyncResult('acknowledgeAppliedTurnSteering', 0),
    releaseTurnSteeringLease: asyncResult('releaseTurnSteeringLease', 0),
    releaseTurnSteeringLeasesForTurn: asyncResult('releaseTurnSteeringLeasesForTurn', 0),
  }
  const recovery = {
    getTurnRecoveryState: asyncResult('getTurnRecoveryState', null),
    recordTurnRecoveryFailure: asyncResult('recordTurnRecoveryFailure', null),
    clearTurnRecoveryState: asyncResult('clearTurnRecoveryState', 0),
    listTurnRecoveryStates: asyncResult('listTurnRecoveryStates', []),
    pruneResolvedTurnRecoveryStates: asyncResult('pruneResolvedTurnRecoveryStates', 0),
  }
  const modelRequestRecovery = {
    getPendingModelRequestRecovery: asyncResult(
      'getPendingModelRequestRecovery',
      modelRecoveryResults.getPendingModelRequestRecovery ?? null,
    ),
    readModelRequestRecoveryResolution: asyncResult(
      'readModelRequestRecoveryResolution',
      modelRecoveryResults.readModelRequestRecoveryResolution ?? null,
    ),
    resolvePendingModelRequest: asyncResult(
      'resolvePendingModelRequest',
      modelRecoveryResults.resolvePendingModelRequest ?? null,
    ),
  }
  const sessionAdmin = {
    contractVersion: SESSION_ADMIN_PORT_CONTRACT_VERSION,
    searchMessages: asyncResult('searchMessages', []),
    listSessions: asyncResult('listSessions', []),
    getSessionSnapshot: asyncResult('getSessionSnapshot', null),
    getSessionBranches: asyncResult('getSessionBranches', null),
    forkSession: asyncResult('forkSession', null),
    replaceSessionMessages: asyncResult('replaceSessionMessages', null),
    deleteSession: asyncResult('deleteSession', null),
    archiveSession: asyncResult('archiveSession', null),
    unarchiveSession: asyncResult('unarchiveSession', null),
    pinSession: asyncResult('pinSession', null),
    unpinSession: asyncResult('unpinSession', null),
  }

  const adapter = prepareTurnPersistenceAdapter({
    id: `test.async-${Math.random().toString(36).slice(2)}`,
    contractVersion: TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION,
    session,
    eventLog,
    transactions,
    execution,
    steering,
    recovery,
    modelRequestRecovery,
    sessionAdmin,
  })

  return {
    adapter,
    calls,
    seedSession(value) {
      sessions.set(scopeKey(value), structuredClone(value))
    },
    seedEvent(userId, event) {
      storeEvent({ userId, event })
    },
    seedCheckpoint(value) {
      checkpoints.set(scopeKey(value), structuredClone(value))
    },
    eventsFor(input) {
      return turnEvents(input)
    },
  }
}

function createExecutionLeases({ claim = true } = {}) {
  let active = false
  return {
    claim() {
      if (!claim || active) return false
      active = true
      return true
    },
    proof: () => ({ ownerId: 'async-adapter-worker', fencingToken: 1 }),
    hold: () => () => { active = false },
    isActive: () => active,
    owns: () => active,
    hasActiveSession: () => active,
    requestCancellation: () => false,
    closeSteeringInbox: () => ({ closed: true }),
  }
}

function createEngine(backend, overrides = {}) {
  const {
    session,
    eventLog,
    transactions,
    modelRequestRecovery,
  } = backend.adapter
  return new TurnEngine({
    readSession: session.getSession,
    sessionIdOccupied: session.isSessionIdOccupied,
    claimSession: session.claimLocalChatSession,
    writeSession: session.upsertSession,
    readMessages: session.listMessages,
    readPreviousUserMessage: session.getPreviousUserMessage,
    writeMessage: session.upsertMessage,
    removeMessage: session.deleteMessage,
    appendEvent: eventLog.appendTurnEvent,
    appendEventBatch: eventLog.appendTurnEvents,
    lastEvent: eventLog.getLastTurnEvent,
    replayEvents: eventLog.listTurnEvents,
    recordEventWriteFailure: eventLog.recordTurnEventWriteFailure,
    verifyEventCommit: eventLog.verifyTurnEventCommit,
    readCheckpoint: eventLog.getTurnCheckpoint,
    writeCheckpoint: eventLog.saveTurnCheckpoint,
    clearCheckpoint: eventLog.deleteTurnCheckpoint,
    supportsAtomicCheckpointState: true,
    commitTurnStart: transactions.commitTurnStart,
    commitTurnCheckpoint: transactions.commitTurnCheckpoint,
    commitTurnBoundary: transactions.commitTurnBoundary,
    readPendingModelRequest: modelRequestRecovery.getPendingModelRequestRecovery,
    readModelRequestResolution: modelRequestRecovery.readModelRequestRecoveryResolution,
    commitPendingModelRequest: modelRequestRecovery.resolvePendingModelRequest,
    executionLeases: createExecutionLeases(),
    resolveModelBinding: () => ({
      modelName: 'async-test-model',
      providerId: 'async-test-provider',
      configRevision: 1,
      env: {},
    }),
    validateAttachments: () => [],
    preparePromptContext: async () => ({
      messages: [],
      effectiveAgentId: null,
      skillIds: [],
      memoryIds: [],
      pluginPromptBlockIds: [],
      compactionArchiveId: null,
      compactionBoundary: null,
    }),
    resolveCanaryAssignment: async () => null,
    resolveToolSpecs: async () => [],
    resolveToolImplementationRevisions: () => ({
      version: 1,
      builtinRevision: `sha256-${'a'.repeat(64)}`,
      connectorRevision: null,
      mcpTools: [],
    }),
    readRuntimePlugins: () => [],
    readRuntimePluginStates: () => [],
    readApprovalMode: () => 'normal',
    readFileAccessStatus: () => ({ grants: [] }),
    scheduleMemoryExtraction: () => {},
    dispatchHooks: async () => [],
    acknowledgeAppliedSteering: async () => 0,
    releaseStaleSteering: async () => 0,
    readRecoveryState: () => null,
    clearRecoveryState: () => 0,
    ...overrides,
  })
}

test('Promise model recovery facade stays on the active adapter without SQLite fallback', async () => {
  const pending = Object.freeze({ modelRequestId: 'async-model-request' })
  const resolution = Object.freeze({ outcome: 'completed', source: 'async-adapter' })
  const resolved = Object.freeze({ status: 'resolved_pending_resume' })
  const backend = createAsyncAdapter({
    modelRecoveryResults: {
      getPendingModelRequestRecovery: pending,
      readModelRequestRecoveryResolution: resolution,
      resolvePendingModelRequest: resolved,
    },
  })
  const engine = createEngine(backend)
  const scope = {
    userId: USER_ID,
    sessionId: 'async-model-recovery-session',
    turnId: 'async-model-recovery-turn',
  }

  try {
    assert.strictEqual(
      engine.deps.readPendingModelRequest,
      backend.adapter.modelRequestRecovery.getPendingModelRequestRecovery,
    )
    assert.strictEqual(
      engine.deps.readModelRequestResolution,
      backend.adapter.modelRequestRecovery.readModelRequestRecoveryResolution,
    )
    assert.strictEqual(
      engine.deps.commitPendingModelRequest,
      backend.adapter.modelRequestRecovery.resolvePendingModelRequest,
    )
    assert.strictEqual(await engine.getPendingModelRequestRecovery(scope), pending)
    assert.strictEqual(await engine.deps.readModelRequestResolution(scope), resolution)
    assert.strictEqual(await engine.resolvePendingModelRequest(scope), resolved)
    assert.deepEqual(
      backend.calls.filter((entry) => /ModelRequest|modelRequest/u.test(entry)),
      [
        'getPendingModelRequestRecovery:start',
        'getPendingModelRequestRecovery:end',
        'readModelRequestRecoveryResolution:start',
        'readModelRequestRecoveryResolution:end',
        'resolvePendingModelRequest:start',
        'resolvePendingModelRequest:end',
      ],
    )
  } finally {
    await engine.shutdown()
  }
})

function startedEvent({ sessionId, turnId, sequence = 0, createdAt = 100 } = {}) {
  return {
    id: `${turnId}:started`,
    sessionId,
    turnId,
    sequence,
    type: 'turn.started',
    payload: {
      content: 'resume this turn',
      displayContent: 'resume this turn',
      modelName: 'async-test-model',
      modelProviderId: 'async-test-provider',
      modelConfigRevision: 1,
      modelMode: 'agent',
    },
    createdAt,
  }
}

test('start/get await a fully asynchronous adapter and checkpoint aggregate readback', async () => {
  const backend = createAsyncAdapter()
  const sessionId = 'async-start-session'
  const turnId = 'async-start-turn'
  let checkpointReturned = false
  const engine = createEngine(backend, {
    runLoop: async ({ saveCheckpoint }) => {
      await saveCheckpoint({
        messages: [{ role: 'user', content: 'persist asynchronously' }],
        artifactIds: [],
        iterations: 1,
      })
      checkpointReturned = true
      return { text: 'async adapter completed', artifactIds: [], iterations: 1 }
    },
  })

  try {
    const started = await engine.startTurn({
      userId: USER_ID,
      sessionId,
      turnId,
      content: 'persist asynchronously',
    })
    assert.equal(started.turnId, turnId)
    await engine.waitForTurn({ userId: USER_ID, sessionId, turnId })

    const completed = await engine.getTurn({ userId: USER_ID, sessionId, turnId })
    assert.equal(completed.status, 'completed')
    assert.equal(checkpointReturned, true)
    assert.deepEqual(
      backend.eventsFor({ userId: USER_ID, sessionId, turnId }).map((event) => event.type),
      ['turn.started', 'turn.checkpoint', 'turn.completed'],
    )
    assert.ok(backend.calls.indexOf('commitTurnStart:end') < backend.calls.lastIndexOf('getSession:end'))
    assert.ok(backend.calls.indexOf('commitTurnCheckpoint:end') < backend.calls.lastIndexOf('getTurnCheckpoint:end'))
    assert.ok(backend.calls.indexOf('getTurnCheckpoint:end') < backend.calls.indexOf('commitTurnBoundary:start'))
    assert.ok(backend.calls.indexOf('commitTurnBoundary:end') < backend.calls.lastIndexOf('getLastTurnEvent:end'))
  } finally {
    await engine.shutdown()
  }
})

test('shutdown rejects when an active turn cannot close its event writer', async () => {
  const backend = createAsyncAdapter()
  const sessionId = 'async-shutdown-writer-session'
  const turnId = 'async-shutdown-writer-turn'
  const closeFailure = Object.assign(new Error('event writer close failed'), {
    code: 'TURN_EVENT_PERSISTENCE_FAILED',
  })
  let markLoopStarted
  const loopStarted = new Promise((resolve) => { markLoopStarted = resolve })
  const engine = createEngine(backend, {
    eventWriteBehindFactory: () => ({
      enqueue: (entry) => entry,
      flush: async () => {},
      close: async () => { throw closeFailure },
    }),
    runLoop: async ({ signal }) => {
      markLoopStarted()
      await new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      return { text: 'must not complete', artifactIds: [], iterations: 0 }
    },
  })

  await engine.startTurn({
    userId: USER_ID,
    sessionId,
    turnId,
    content: 'stay active until shutdown',
  })
  await loopStarted

  await assert.rejects(
    engine.shutdown(),
    (error) => error instanceof AggregateError
      && error.errors.length === 1
      && error.errors[0] === closeFailure,
  )
  assert.deepEqual(
    backend.eventsFor({ userId: USER_ID, sessionId, turnId }).map((event) => event.type),
    ['turn.started'],
  )
})

test('shutdown retains a starting turn writer whose close fails until a later flush succeeds', async () => {
  const backend = createAsyncAdapter()
  const sessionId = 'async-starting-shutdown-writer-session'
  const turnId = 'async-starting-shutdown-writer-turn'
  const closeFailure = Object.assign(new Error('starting event writer close failed'), {
    code: 'TURN_EVENT_PERSISTENCE_FAILED',
  })
  let markCommitEntered
  let releaseCommit
  const commitEntered = new Promise((resolve) => { markCommitEntered = resolve })
  const commitGate = new Promise((resolve) => { releaseCommit = resolve })
  const commitTurnStart = backend.adapter.transactions.commitTurnStart
  let closeCalls = 0
  let flushCalls = 0
  const writer = {
    enqueue: (entry) => entry,
    flush: async () => { flushCalls += 1 },
    close: async () => {
      closeCalls += 1
      throw closeFailure
    },
  }
  const engine = createEngine(backend, {
    commitTurnStart: async (input) => {
      markCommitEntered()
      await commitGate
      return await commitTurnStart(input)
    },
    eventWriteBehindFactory: () => writer,
  })

  const starting = engine.startTurn({
    userId: USER_ID,
    sessionId,
    turnId,
    content: 'shutdown while the turn is starting',
  })
  await commitEntered
  const shuttingDown = engine.shutdown()
  releaseCommit()

  await assert.rejects(starting, (error) => error === closeFailure)
  await assert.rejects(
    shuttingDown,
    (error) => error instanceof AggregateError
      && error.errors.length === 1
      && error.errors[0] === closeFailure,
  )
  assert.equal(closeCalls, 2)
  assert.equal(flushCalls, 1)
  await engine.shutdown()
  assert.equal(closeCalls, 2)
  assert.equal(flushCalls, 2)
})

test('shutdown retries a failed turn execution lease release and reports repeated failure', async () => {
  const backend = createAsyncAdapter()
  const sessionId = 'async-shutdown-lease-release-session'
  const turnId = 'async-shutdown-lease-release-turn'
  const releaseFailure = new Error('turn execution lease release failed')
  let active = false
  let releaseCalls = 0
  let markLoopStarted
  let finishLoop
  const loopStarted = new Promise((resolve) => { markLoopStarted = resolve })
  const loopGate = new Promise((resolve) => { finishLoop = resolve })
  const engine = createEngine(backend, {
    executionLeases: {
      claim: () => {
        if (active) return false
        active = true
        return true
      },
      proof: () => ({ ownerId: 'async-adapter-worker', fencingToken: 3 }),
      hold: () => async () => {
        releaseCalls += 1
        if (releaseCalls < 3) throw releaseFailure
        active = false
        return true
      },
      isActive: () => active,
      owns: () => active,
      hasActiveSession: () => active,
      requestCancellation: () => false,
      closeSteeringInbox: () => ({ closed: true }),
    },
    runLoop: async () => {
      markLoopStarted()
      await loopGate
      return { text: 'completed before lease release', artifactIds: [], iterations: 1 }
    },
  })
  const scope = { userId: USER_ID, sessionId, turnId }

  await engine.startTurn({ ...scope, content: 'release the execution lease' })
  await loopStarted
  const execution = engine.waitForTurn(scope)
  finishLoop()
  await assert.rejects(execution, (error) => error === releaseFailure)
  assert.equal(releaseCalls, 1)
  await assert.rejects(
    engine.shutdown(),
    (error) => error instanceof AggregateError
      && error.errors.length === 1
      && error.errors[0] === releaseFailure,
  )
  assert.equal(releaseCalls, 2)
  await engine.shutdown()
  assert.equal(releaseCalls, 3)
  assert.equal(active, false)
})

test('resume awaits asynchronous session and event-log projections instead of treating Promises as events', async () => {
  const backend = createAsyncAdapter()
  const sessionId = 'async-resume-session'
  const turnId = 'async-resume-turn'
  backend.seedSession({ id: sessionId, userId: USER_ID, title: 'Async resume' })
  backend.seedEvent(USER_ID, startedEvent({ sessionId, turnId }))
  backend.seedEvent(USER_ID, {
    id: `${turnId}:completed`,
    sessionId,
    turnId,
    sequence: 1,
    type: 'turn.completed',
    payload: { text: 'already complete' },
    createdAt: 101,
  })
  let runLoopCalls = 0
  const engine = createEngine(backend, {
    runLoop: async () => {
      runLoopCalls += 1
      return { text: 'must not rerun' }
    },
  })

  try {
    const resumed = await engine.resumeTurn({ userId: USER_ID, sessionId, turnId })
    assert.equal(resumed.status, 'completed')
    assert.equal(resumed.lastEvent.type, 'turn.completed')
    assert.equal(runLoopCalls, 0)
    assert.ok(backend.calls.includes('getSession:end'))
    assert.ok(backend.calls.filter((call) => call === 'getLastTurnEvent:end').length >= 4)
  } finally {
    await engine.shutdown()
  }
})

test('cancel awaits async replay/checkpoint reads and the aggregate boundary before projecting terminal state', async () => {
  const backend = createAsyncAdapter()
  const sessionId = 'async-cancel-session'
  const turnId = 'async-cancel-turn'
  backend.seedSession({ id: sessionId, userId: USER_ID, title: 'Async cancel' })
  backend.seedEvent(USER_ID, startedEvent({ sessionId, turnId }))
  backend.seedCheckpoint({
    userId: USER_ID,
    sessionId,
    turnId,
    eventSequence: 0,
    state: { messages: [], artifactIds: [], iterations: 0 },
  })
  const engine = createEngine(backend)

  try {
    const cancelled = await engine.cancelTurn({ userId: USER_ID, sessionId, turnId })
    assert.equal(cancelled.status, 'cancelled')
    assert.deepEqual(
      backend.eventsFor({ userId: USER_ID, sessionId, turnId }).map((event) => event.type),
      ['turn.started', 'turn.cancelled'],
    )
    assert.ok(backend.calls.indexOf('listTurnEvents:end') < backend.calls.indexOf('getTurnCheckpoint:start'))
    assert.ok(backend.calls.indexOf('getTurnCheckpoint:end') < backend.calls.indexOf('commitTurnBoundary:start'))
    assert.ok(backend.calls.indexOf('commitTurnBoundary:end') < backend.calls.lastIndexOf('getLastTurnEvent:end'))
  } finally {
    await engine.shutdown()
  }
})

test('steer awaits async local-session claim before enqueueing the steering command', async () => {
  const backend = createAsyncAdapter()
  const sessionId = 'async-steer-session'
  const turnId = 'async-steer-turn'
  backend.seedSession({ id: sessionId, userId: USER_ID, title: 'Async steering' })
  const order = []
  const engine = createEngine(backend, {
    readSession: async () => {
      order.push('read:start')
      await Promise.resolve()
      order.push('read:end')
      return null
    },
    claimSession: async () => {
      order.push('claim:start')
      await Promise.resolve()
      order.push('claim:end')
      return { id: sessionId, userId: USER_ID }
    },
    enqueueSteering: async (input) => {
      order.push('enqueue')
      return { id: 'steering-1', content: input.content }
    },
  })

  try {
    const steered = await engine.steerTurn({
      userId: USER_ID,
      sessionId,
      turnId,
      content: 'change direction',
      authMode: 'local',
    })
    assert.equal(steered.content, 'change direction')
    assert.deepEqual(order, ['read:start', 'read:end', 'claim:start', 'claim:end', 'enqueue'])
  } finally {
    await engine.shutdown()
  }
})

test('async adapter rejection propagates and prevents later persistence or runtime operations', async (t) => {
  await t.test('start read rejection does not probe occupancy, commit, or schedule', async () => {
    const failure = new Error('async session read failed')
    const backend = createAsyncAdapter({ failures: { getSession: failure } })
    let runLoopCalls = 0
    const engine = createEngine(backend, {
      runLoop: async () => { runLoopCalls += 1; return { text: 'unexpected' } },
    })
    try {
      await assert.rejects(
        engine.startTurn({
          userId: USER_ID,
          sessionId: 'async-reject-start-session',
          turnId: 'async-reject-start-turn',
          content: 'must fail before mutation',
        }),
        (error) => error === failure,
      )
      assert.equal(runLoopCalls, 0)
      assert.equal(backend.calls.includes('isSessionIdOccupied:start'), false)
      assert.equal(backend.calls.includes('commitTurnStart:start'), false)
    } finally {
      await engine.shutdown()
    }
  })

  await t.test('start aggregate rejection does not perform commit readback or schedule execution', async () => {
    const failure = new Error('async start aggregate failed')
    const backend = createAsyncAdapter({ failures: { commitTurnStart: failure } })
    let runLoopCalls = 0
    const engine = createEngine(backend, {
      runLoop: async () => { runLoopCalls += 1; return { text: 'unexpected' } },
    })
    try {
      await assert.rejects(
        engine.startTurn({
          userId: USER_ID,
          sessionId: 'async-reject-start-commit-session',
          turnId: 'async-reject-start-commit-turn',
          content: 'aggregate must reject',
        }),
        (error) => error?.code === 'TURN_EVENT_PERSISTENCE_FAILED'
          && error?.cause === failure,
      )
      assert.equal(runLoopCalls, 0)
      assert.equal(backend.calls.filter((call) => call === 'getSession:start').length, 1)
      assert.equal(backend.calls.includes('commitTurnCheckpoint:start'), false)
      assert.equal(backend.calls.includes('commitTurnBoundary:start'), false)
    } finally {
      await engine.shutdown()
    }
  })

  await t.test('checkpoint aggregate rejection skips readback and cannot become a completed turn', async () => {
    const failure = new Error('async checkpoint aggregate failed')
    const backend = createAsyncAdapter({ failures: { commitTurnCheckpoint: failure } })
    const sessionId = 'async-reject-checkpoint-session'
    const turnId = 'async-reject-checkpoint-turn'
    let continuedAfterCheckpoint = false
    const engine = createEngine(backend, {
      runLoop: async ({ saveCheckpoint }) => {
        await saveCheckpoint({ messages: [], artifactIds: [], iterations: 1 })
        continuedAfterCheckpoint = true
        return { text: 'must not complete', artifactIds: [], iterations: 1 }
      },
    })
    try {
      await engine.startTurn({
        userId: USER_ID,
        sessionId,
        turnId,
        content: 'checkpoint must reject',
      })
      await engine.waitForTurn({ userId: USER_ID, sessionId, turnId })

      const projected = await engine.getTurn({ userId: USER_ID, sessionId, turnId })
      assert.equal(projected.status, 'failed')
      assert.equal(continuedAfterCheckpoint, false)
      assert.equal(backend.calls.filter((call) => call === 'getTurnCheckpoint:start').length, 1)
      assert.equal(backend.calls.filter((call) => call === 'commitTurnBoundary:start').length, 1)
      assert.deepEqual(
        backend.eventsFor({ userId: USER_ID, sessionId, turnId }).map((event) => event.type),
        ['turn.started', 'turn.failed'],
      )
    } finally {
      await engine.shutdown()
    }
  })

  await t.test('terminal boundary rejection propagates and never projects an uncommitted completion', async () => {
    const failure = new Error('async terminal aggregate failed')
    const backend = createAsyncAdapter({ failures: { commitTurnBoundary: failure } })
    const sessionId = 'async-reject-boundary-session'
    const turnId = 'async-reject-boundary-turn'
    let releaseLoop
    const loopGate = new Promise((resolve) => { releaseLoop = resolve })
    const engine = createEngine(backend, {
      runLoop: async () => {
        await loopGate
        return { text: 'uncommitted completion', artifactIds: [], iterations: 1 }
      },
    })
    try {
      await engine.startTurn({
        userId: USER_ID,
        sessionId,
        turnId,
        content: 'boundary must reject',
      })
      const completion = engine.waitForTurn({ userId: USER_ID, sessionId, turnId })
      releaseLoop()
      await assert.rejects(
        completion,
        (error) => error?.code === 'TURN_TERMINAL_PERSISTENCE_FAILED'
          && error?.cause === failure,
      )
      assert.deepEqual(
        backend.eventsFor({ userId: USER_ID, sessionId, turnId }).map((event) => event.type),
        ['turn.started'],
      )
      assert.equal(backend.calls.filter((call) => call === 'commitTurnBoundary:start').length, 1)
      assert.equal(backend.calls.includes('commitTurnBoundary:end'), false)
    } finally {
      releaseLoop?.()
      await engine.shutdown()
    }
  })

  await t.test('resume replay rejection does not schedule execution or append an event', async () => {
    const failure = new Error('async event replay failed')
    const backend = createAsyncAdapter({ failures: { listTurnEvents: failure } })
    const sessionId = 'async-reject-resume-session'
    const turnId = 'async-reject-resume-turn'
    backend.seedSession({ id: sessionId, userId: USER_ID, title: 'Reject resume' })
    backend.seedEvent(USER_ID, startedEvent({ sessionId, turnId }))
    let runLoopCalls = 0
    const engine = createEngine(backend, {
      runLoop: async () => { runLoopCalls += 1; return { text: 'unexpected' } },
    })
    try {
      await assert.rejects(
        engine.resumeTurn({ userId: USER_ID, sessionId, turnId }),
        (error) => error === failure,
      )
      assert.equal(runLoopCalls, 0)
      assert.equal(backend.calls.includes('appendTurnEvent:start'), false)
      assert.equal(backend.calls.includes('commitTurnBoundary:start'), false)
    } finally {
      await engine.shutdown()
    }
  })

  await t.test('cancel checkpoint rejection does not commit a cancellation boundary', async () => {
    const failure = new Error('async checkpoint read failed')
    const backend = createAsyncAdapter({ failures: { getTurnCheckpoint: failure } })
    const sessionId = 'async-reject-cancel-session'
    const turnId = 'async-reject-cancel-turn'
    backend.seedSession({ id: sessionId, userId: USER_ID, title: 'Reject cancel' })
    backend.seedEvent(USER_ID, startedEvent({ sessionId, turnId }))
    const engine = createEngine(backend)
    try {
      await assert.rejects(
        engine.cancelTurn({ userId: USER_ID, sessionId, turnId }),
        (error) => error === failure,
      )
      assert.equal(backend.calls.includes('commitTurnBoundary:start'), false)
      assert.deepEqual(
        backend.eventsFor({ userId: USER_ID, sessionId, turnId }).map((event) => event.type),
        ['turn.started'],
      )
    } finally {
      await engine.shutdown()
    }
  })

  await t.test('steer session rejection does not claim or enqueue', async () => {
    const failure = new Error('async steering session read failed')
    const backend = createAsyncAdapter()
    let claims = 0
    let enqueues = 0
    const engine = createEngine(backend, {
      readSession: async () => { throw failure },
      claimSession: async () => { claims += 1; return null },
      enqueueSteering: async () => { enqueues += 1; return null },
    })
    try {
      await assert.rejects(
        engine.steerTurn({
          userId: USER_ID,
          sessionId: 'async-reject-steer-session',
          turnId: 'async-reject-steer-turn',
          content: 'must not enqueue',
          authMode: 'local',
        }),
        (error) => error === failure,
      )
      assert.equal(claims, 0)
      assert.equal(enqueues, 0)
    } finally {
      await engine.shutdown()
    }
  })

  await t.test('get projection rejection is returned unchanged', async () => {
    const failure = new Error('async projection failed')
    const backend = createAsyncAdapter({ failures: { getLastTurnEvent: failure } })
    const engine = createEngine(backend)
    try {
      await assert.rejects(
        engine.getTurn({
          userId: USER_ID,
          sessionId: 'async-reject-get-session',
          turnId: 'async-reject-get-turn',
        }),
        (error) => error === failure,
      )
    } finally {
      await engine.shutdown()
    }
  })
})
