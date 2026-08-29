import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  BUILTIN_LIFECYCLE_CAPABILITY_IDS,
} from '../server/core/builtinLifecycleAssembly.js'
import {
  bootstrap,
  createLifecycleRuntime,
  gracefulShutdown,
} from '../server/core/lifecycle.js'
import {
  getTurnPersistenceAdapterStatus,
  getSessionAdminPort,
  listTurnPersistenceAdapterAuditEvents,
  prepareTurnPersistenceAdapter,
  TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION,
} from '../server/core/turnPersistenceAdapter.js'
import {
  SQLITE_TURN_PERSISTENCE_ADAPTER,
  SQLITE_TURN_PERSISTENCE_ADAPTER_ID,
} from '../server/adapters/sqliteTurnPersistenceAdapter.js'
import { SESSION_ADMIN_PORT_CONTRACT_VERSION } from '../server/core/sessionAdminPort.js'
import {
  TurnEngine,
} from '../server/services/TurnEngine.js'
import {
  createTurnEnginePersistenceBundle,
} from '../server/services/turnEnginePersistenceBundle.js'
import {
  closeTurnEngine,
  getTurnEngine,
} from '../server/services/turnEngineHost.js'
import {
  claimLocalChatSession,
  deleteMessage,
  getPreviousUserMessage,
  getSession,
  isSessionIdOccupied,
  listMessages,
  upsertMessage,
  upsertSession,
} from '../server/services/sessionStore.js'
import {
  appendTurnEvent,
  appendTurnEvents,
  getLastTurnEvent,
  listTurnEvents,
  recordTurnEventWriteFailure,
  resolveTurnSession,
  verifyTurnEventCommit,
} from '../server/services/turnEventStore.js'
import {
  deleteTurnCheckpoint,
  getTurnCheckpoint,
  saveTurnCheckpoint,
} from '../server/services/turnCheckpointStore.js'

const noop = () => {}

const TEST_SUBAGENT_RUN_PERSISTENCE_PORT = Object.freeze({
  apiVersion: 1,
  id: 'test.turn-persistence-subagent-runs',
  createRun: () => assert.fail('turn persistence tests must not create a subagent run'),
  getRun: () => null,
  markRunning: () => assert.fail('turn persistence tests must not resume a subagent run'),
  saveRunningTrace: () => assert.fail('turn persistence tests must not save a subagent trace'),
  finishRun: () => assert.fail('turn persistence tests must not finish a subagent run'),
  listRunningRuns: () => [],
  interruptRunningRun: ({ userId, id }) => ({ userId, id, interrupted: false }),
})

test('session admin and turn persistence modules support fresh direct imports', () => {
  for (const modulePath of [
    './server/core/sessionAdminPort.js',
    './server/core/turnPersistenceAdapter.js',
  ]) {
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(modulePath)})`,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })

    assert.equal(
      result.status,
      0,
      [modulePath, result.stdout, result.stderr].filter(Boolean).join('\n'),
    )
  }
})

function lifecycleAdapters({ closeEngine = closeTurnEngine } = {}) {
  return {
    closeDb: noop,
    shutdownMcpAll: noop,
    shutdownBrowsers: noop,
    warnShellTrust: noop,
    registerBrowserTools: noop,
    registerConnectorTools: noop,
    seedSystemSkills: noop,
    initializeRuntimePluginConfig: noop,
    initPlugins: noop,
    restoreEnabledRuntimePlugins: () => [],
    startCodexAppServerRuntime: noop,
    closeCodexAppServerRuntime: noop,
    initCodexPluginSkills: noop,
    setVisionAssistResolver: noop,
    getEnabledIntegrationCredentials: () => null,
    listEnabledIntegrationCredentials: () => [],
    startSocialIntegration: noop,
    stopSocialBridges: noop,
    shutdownRuntimePlugins: noop,
    closeJobRuntime: noop,
    closeTurnEngine: closeEngine,
    startTurnRecoveryRuntime: noop,
    closeTurnRecoveryRuntime: noop,
    closeCronScheduler: noop,
    recoverInterruptedSubagentRuns: noop,
    warn: noop,
  }
}

function memoryAdapter(id) {
  const calls = []
  let checkpoint = null
  const session = {
    getSession: (input) => { calls.push(['getSession', input]); return null },
    isSessionIdOccupied: (input) => { calls.push(['isSessionIdOccupied', input]); return false },
    claimLocalChatSession: (input) => { calls.push(['claimLocalChatSession', input]); return null },
    upsertSession: (input) => { calls.push(['upsertSession', input]); return input },
    listMessages: (input) => { calls.push(['listMessages', input]); return [] },
    getPreviousUserMessage: (input) => { calls.push(['getPreviousUserMessage', input]); return null },
    upsertMessage: (input) => { calls.push(['upsertMessage', input]); return input },
    deleteMessage: (input) => { calls.push(['deleteMessage', input]); return 1 },
  }
  const eventLog = {
    appendTurnEvent: (entry) => {
      calls.push(['appendTurnEvent', entry])
      if (entry.checkpointState !== null && entry.checkpointState !== undefined) {
        checkpoint = {
          userId: entry.userId,
          sessionId: entry.event.sessionId,
          turnId: entry.event.turnId,
          eventSequence: entry.event.sequence,
          state: entry.checkpointState,
        }
      }
      return entry.event
    },
    appendTurnEvents: (entries) => {
      calls.push(['appendTurnEvents', entries])
      return entries.map((entry) => entry.event)
    },
    getLastTurnEvent: (input) => { calls.push(['getLastTurnEvent', input]); return null },
    listTurnEvents: (input) => { calls.push(['listTurnEvents', input]); return [] },
    recordTurnEventWriteFailure: (input) => {
      calls.push(['recordTurnEventWriteFailure', input])
      return 1
    },
    verifyTurnEventCommit: ({ event, storedEvent }) => {
      calls.push(['verifyTurnEventCommit', { event, storedEvent }])
      const committed = storedEvent?.id === event?.id
      return {
        committed,
        receipt: committed ? { eventId: event.id, sequence: event.sequence } : null,
      }
    },
    getTurnCheckpoint: (input) => { calls.push(['getTurnCheckpoint', input]); return checkpoint },
    saveTurnCheckpoint: (input) => {
      calls.push(['saveTurnCheckpoint', input])
      checkpoint = input
      return checkpoint
    },
    deleteTurnCheckpoint: (input) => {
      calls.push(['deleteTurnCheckpoint', input])
      checkpoint = null
      return 1
    },
  }
  const transactions = {
    commitTurnStart: async (input) => {
      calls.push(['commitTurnStart', input])
      return eventLog.appendTurnEvent({ userId: input.userId, event: input.event })
    },
    commitTurnCheckpoint: async (input) => {
      calls.push(['commitTurnCheckpoint', input])
      return eventLog.appendTurnEvent({
        userId: input.userId,
        event: input.event,
        checkpointState: input.checkpointState,
      })
    },
    commitTurnBoundary: async (input) => {
      calls.push(['commitTurnBoundary', input])
      return eventLog.appendTurnEvent({ userId: input.userId, event: input.event })
    },
  }
  const execution = {
    claimTurnExecutionLease: (input) => { calls.push(['claimTurnExecutionLease', input]); return null },
    getTurnExecutionLease: (input) => { calls.push(['getTurnExecutionLease', input]); return null },
    renewTurnExecutionLease: (input) => { calls.push(['renewTurnExecutionLease', input]); return false },
    releaseTurnExecutionLease: (input) => { calls.push(['releaseTurnExecutionLease', input]); return false },
    isTurnExecutionLeaseActive: (input) => { calls.push(['isTurnExecutionLeaseActive', input]); return false },
    hasActiveTurnExecutionLeaseForSession: (input) => {
      calls.push(['hasActiveTurnExecutionLeaseForSession', input])
      return false
    },
    requestTurnExecutionCancellation: (input) => {
      calls.push(['requestTurnExecutionCancellation', input])
      return false
    },
    tryCloseTurnSteeringInbox: (input) => { calls.push(['tryCloseTurnSteeringInbox', input]); return null },
    listUnfinishedTurnExecutions: (input) => {
      calls.push(['listUnfinishedTurnExecutions', input])
      return []
    },
  }
  const steering = {
    enqueueTurnSteering: (input) => { calls.push(['enqueueTurnSteering', input]); return input },
    listTurnSteering: (input) => { calls.push(['listTurnSteering', input]); return [] },
    claimTurnSteering: (input) => { calls.push(['claimTurnSteering', input]); return null },
    acknowledgeTurnSteering: (input) => { calls.push(['acknowledgeTurnSteering', input]); return 0 },
    acknowledgeAppliedTurnSteering: (input) => {
      calls.push(['acknowledgeAppliedTurnSteering', input])
      return 0
    },
    releaseTurnSteeringLease: (input) => { calls.push(['releaseTurnSteeringLease', input]); return 0 },
    releaseTurnSteeringLeasesForTurn: (input) => {
      calls.push(['releaseTurnSteeringLeasesForTurn', input])
      return 0
    },
  }
  const recovery = {
    getTurnRecoveryState: (input) => { calls.push(['getTurnRecoveryState', input]); return null },
    recordTurnRecoveryFailure: (input) => { calls.push(['recordTurnRecoveryFailure', input]); return input },
    clearTurnRecoveryState: (input) => { calls.push(['clearTurnRecoveryState', input]); return 0 },
    listTurnRecoveryStates: (input) => { calls.push(['listTurnRecoveryStates', input]); return [] },
    pruneResolvedTurnRecoveryStates: (input) => {
      calls.push(['pruneResolvedTurnRecoveryStates', input])
      return 0
    },
  }
  const modelRequestRecovery = {
    getPendingModelRequestRecovery: (input) => {
      calls.push(['getPendingModelRequestRecovery', input])
      return null
    },
    readModelRequestRecoveryResolution: (input) => {
      calls.push(['readModelRequestRecoveryResolution', input])
      return null
    },
    resolvePendingModelRequest: (input) => {
      calls.push(['resolvePendingModelRequest', input])
      return input
    },
  }
  const sessionAdmin = {
    contractVersion: SESSION_ADMIN_PORT_CONTRACT_VERSION,
    searchMessages: (input) => { calls.push(['searchMessages', input]); return [] },
    listSessions: (input) => { calls.push(['listSessions', input]); return [] },
    getSessionSnapshot: (input) => { calls.push(['getSessionSnapshot', input]); return null },
    getSessionBranches: (input) => { calls.push(['getSessionBranches', input]); return null },
    forkSession: (input) => { calls.push(['forkSession', input]); return null },
    replaceSessionMessages: (input) => { calls.push(['replaceSessionMessages', input]); return null },
    deleteSession: (input) => { calls.push(['deleteSession', input]); return null },
    archiveSession: (input) => { calls.push(['archiveSession', input]); return null },
    unarchiveSession: (input) => { calls.push(['unarchiveSession', input]); return null },
    pinSession: (input) => { calls.push(['pinSession', input]); return null },
    unpinSession: (input) => { calls.push(['unpinSession', input]); return null },
  }
  return {
    adapter: {
      id,
      contractVersion: TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION,
      session,
      eventLog,
      transactions,
      execution,
      steering,
      recovery,
      modelRequestRecovery,
      sessionAdmin,
    },
    calls,
  }
}

test('TurnEngine rejects incomplete or forged persistence bundles with a stable error', () => {
  assert.throws(
    () => new TurnEngine({ persistence: Object.freeze({ version: 1 }) }),
    (error) => error?.code === 'TURN_ENGINE_PERSISTENCE_BUNDLE_INVALID'
      && error?.retryable === false,
  )
})

test('TurnEngine persistence bundles are frozen and cannot mix with flat persistence overrides', () => {
  const { adapter } = memoryAdapter('test.bundle-conflict')
  const persistence = createTurnEnginePersistenceBundle(prepareTurnPersistenceAdapter(adapter))
  assert.equal(Object.isFrozen(persistence), true)
  assert.equal(Object.isFrozen(persistence.session), true)
  assert.equal(Object.isFrozen(persistence.eventLog), true)

  assert.throws(
    () => new TurnEngine({ persistence, readSession: () => null }),
    (error) => error?.code === 'TURN_ENGINE_PERSISTENCE_BUNDLE_CONFLICT'
      && /readSession/.test(error.message)
      && error?.retryable === false,
  )
})

test('persistence attachment atomic domains are explicit, frozen, and host-negotiated', async () => {
  const { adapter, calls } = memoryAdapter('test.attachment-atomic-domain')
  const prepared = prepareTurnPersistenceAdapter({
    ...adapter,
    atomicAttachmentRuntimePortIds: ['test.attachments'],
  })
  assert.deepEqual(prepared.atomicAttachmentRuntimePortIds, ['test.attachments'])
  assert.equal(Object.isFrozen(prepared.atomicAttachmentRuntimePortIds), true)

  for (const ids of [['test.attachments', 'test.attachments'], ['Invalid Port Id']]) {
    const { adapter: invalidAdapter } = memoryAdapter(`test.invalid-attachment-domain-${ids.length}`)
    assert.throws(
      () => prepareTurnPersistenceAdapter({
        ...invalidAdapter,
        atomicAttachmentRuntimePortIds: ids,
      }),
      (error) => error?.code === 'TURN_PERSISTENCE_ADAPTER_INVALID'
        && /atomicAttachmentRuntimePortIds/.test(error.message),
    )
  }

  let bindingCalls = 0
  const bindAttachments = () => { bindingCalls += 1; return [] }
  const compatible = createTurnEnginePersistenceBundle(prepared, {
    attachmentRuntime: { id: 'test.attachments', bindAttachments },
  })
  await compatible.transactions.commitTurnStart({
    userId: 'user-atomic-domain',
    attachmentBinding: { attachmentIds: ['attachment-1'] },
    event: { id: 'event-atomic-domain' },
  })
  const startCall = calls.find(([method]) => method === 'commitTurnStart')
  assert.equal(startCall?.[1]?.attachmentBindingAuthorized, true)

  const { adapter: mismatchAdapter } = memoryAdapter('test.attachment-domain-mismatch')
  let rejectedBindingCalls = 0
  const mismatch = createTurnEnginePersistenceBundle(
    prepareTurnPersistenceAdapter(mismatchAdapter),
    {
      attachmentRuntime: {
        id: 'test.attachments',
        async bindAttachments() { rejectedBindingCalls += 1; return [] },
      },
    },
  )
  assert.throws(
    () => mismatch.transactions.commitTurnStart({
      attachmentBinding: { attachmentIds: ['attachment-1'] },
    }),
    (error) => error?.code === 'TURN_ATTACHMENT_ATOMIC_DOMAIN_MISMATCH'
      && error?.retryable === false,
  )
  assert.equal(bindingCalls, 0)
  assert.equal(rejectedBindingCalls, 0)
})

test('optional turn session resolution remains backward compatible and fail-closed', () => {
  const { adapter: legacyAdapter } = memoryAdapter('test.optional-resolver-legacy')
  const preparedLegacy = prepareTurnPersistenceAdapter(legacyAdapter)
  assert.equal(preparedLegacy.contractVersion, TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION)
  assert.equal(Object.hasOwn(preparedLegacy.eventLog, 'resolveTurnSession'), false)

  const resolver = async ({ turnId }) => ({ status: 'found', sessionId: `session-${turnId}` })
  const { adapter } = memoryAdapter('test.optional-resolver')
  const prepared = prepareTurnPersistenceAdapter({
    ...adapter,
    eventLog: { ...adapter.eventLog, resolveTurnSession: resolver },
  })
  assert.strictEqual(prepared.eventLog.resolveTurnSession, resolver)
  assert.equal(Object.isFrozen(prepared.eventLog), true)

  for (const invalidResolver of [null, 'resolve', {}]) {
    const { adapter: invalidAdapter } = memoryAdapter(`test.invalid-resolver-${typeof invalidResolver}`)
    assert.throws(
      () => prepareTurnPersistenceAdapter({
        ...invalidAdapter,
        eventLog: { ...invalidAdapter.eventLog, resolveTurnSession: invalidResolver },
      }),
      (error) => error?.code === 'TURN_PERSISTENCE_ADAPTER_INVALID'
        && /resolveTurnSession/.test(error.message),
    )
  }
})

test('TurnEngine and SessionAdmin fail closed until a host activates persistence', () => {
  assert.equal(getTurnPersistenceAdapterStatus().configured, false)
  assert.throws(
    () => getTurnEngine(),
    (error) => error?.code === 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED'
      && error?.retryable === false,
  )
  assert.throws(
    () => getSessionAdminPort(),
    (error) => error?.code === 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED'
      && error?.retryable === false,
  )
  assert.equal(getTurnPersistenceAdapterStatus().configured, false)
})

test('explicit host activation binds the distribution SQLite persistence adapter', async () => {
  const runtime = createLifecycleRuntime({
    silent: true,
    adapters: lifecycleAdapters(),
    turnPersistenceAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
    subagentRunPersistenceAdapter: TEST_SUBAGENT_RUN_PERSISTENCE_PORT,
  })
  await runtime.start().ready
  const engine = getTurnEngine()

  assert.equal(getTurnPersistenceAdapterStatus().adapterId, SQLITE_TURN_PERSISTENCE_ADAPTER_ID)
  assert.equal(Object.isFrozen(engine.persistence), true)
  assert.equal(engine.persistence.adapterId, SQLITE_TURN_PERSISTENCE_ADAPTER_ID)
  assert.strictEqual(engine.persistence.session.getSession, getSession)
  assert.strictEqual(engine.deps.readSession, getSession)
  assert.strictEqual(engine.deps.sessionIdOccupied, isSessionIdOccupied)
  assert.strictEqual(engine.deps.claimSession, claimLocalChatSession)
  assert.strictEqual(engine.deps.writeSession, upsertSession)
  assert.strictEqual(engine.deps.readMessages, listMessages)
  assert.strictEqual(engine.deps.readPreviousUserMessage, getPreviousUserMessage)
  assert.strictEqual(engine.deps.writeMessage, upsertMessage)
  assert.strictEqual(engine.deps.removeMessage, deleteMessage)
  assert.strictEqual(engine.deps.appendEvent, appendTurnEvent)
  assert.strictEqual(engine.deps.lastEvent, getLastTurnEvent)
  assert.strictEqual(engine.deps.replayEvents, listTurnEvents)
  assert.strictEqual(engine.deps.recordEventWriteFailure, recordTurnEventWriteFailure)
  assert.strictEqual(engine.deps.verifyEventCommit, verifyTurnEventCommit)
  assert.strictEqual(SQLITE_TURN_PERSISTENCE_ADAPTER.eventLog.resolveTurnSession, resolveTurnSession)
  assert.deepEqual(engine.deps.runtimeCore.checkpoint.load({}), getTurnCheckpoint({}))
  assert.strictEqual(SQLITE_TURN_PERSISTENCE_ADAPTER.eventLog.appendTurnEvents, appendTurnEvents)
  assert.strictEqual(SQLITE_TURN_PERSISTENCE_ADAPTER.eventLog.saveTurnCheckpoint, saveTurnCheckpoint)
  assert.strictEqual(SQLITE_TURN_PERSISTENCE_ADAPTER.eventLog.deleteTurnCheckpoint, deleteTurnCheckpoint)
  assert.strictEqual(
    engine.deps.readPendingModelRequest,
    SQLITE_TURN_PERSISTENCE_ADAPTER.modelRequestRecovery.getPendingModelRequestRecovery,
  )
  assert.strictEqual(
    engine.deps.readModelRequestResolution,
    SQLITE_TURN_PERSISTENCE_ADAPTER.modelRequestRecovery.readModelRequestRecoveryResolution,
  )
  assert.strictEqual(
    engine.deps.commitPendingModelRequest,
    SQLITE_TURN_PERSISTENCE_ADAPTER.modelRequestRecovery.resolvePendingModelRequest,
  )

  await runtime.stop()
  assert.equal(getTurnPersistenceAdapterStatus().configured, false)
})

test('incomplete host adapters fail closed without mixing missing functions from SQLite', async () => {
  const { adapter } = memoryAdapter('test.partial')
  const partial = {
    ...adapter,
    eventLog: { ...adapter.eventLog },
  }
  delete partial.eventLog.appendTurnEvents

  assert.throws(
    () => createLifecycleRuntime({
      silent: true,
      adapters: lifecycleAdapters(),
      turnPersistenceAdapter: partial,
    }),
    (error) => error?.code === 'TURN_PERSISTENCE_ADAPTER_INVALID'
      && /appendTurnEvents/.test(error.message),
  )
  assert.equal(getTurnPersistenceAdapterStatus().configured, false)

  assert.throws(
    () => getTurnEngine(),
    (error) => error?.code === 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
  )
})

test('host adapters without terminal commit verification fail closed', () => {
  const { adapter } = memoryAdapter('test.no-commit-verifier')
  const incomplete = {
    ...adapter,
    eventLog: { ...adapter.eventLog },
  }
  delete incomplete.eventLog.verifyTurnEventCommit

  assert.throws(
    () => createLifecycleRuntime({
      silent: true,
      adapters: lifecycleAdapters(),
      turnPersistenceAdapter: incomplete,
    }),
    (error) => error?.code === 'TURN_PERSISTENCE_ADAPTER_INVALID'
      && /verifyTurnEventCommit/.test(error.message),
  )
})

test('custom persistence backends missing any aggregate transaction fail closed', () => {
  for (const method of ['commitTurnStart', 'commitTurnCheckpoint', 'commitTurnBoundary']) {
    const transactions = { ...SQLITE_TURN_PERSISTENCE_ADAPTER.transactions }
    delete transactions[method]
    const incomplete = {
      ...SQLITE_TURN_PERSISTENCE_ADAPTER,
      id: `test.missing-${method.toLowerCase()}`,
      transactions,
    }

    assert.throws(
      () => prepareTurnPersistenceAdapter(incomplete),
      (error) => error?.code === 'TURN_PERSISTENCE_ADAPTER_INVALID'
        && error.message.includes(method),
      method,
    )
  }
})

test('custom persistence backends missing any model request recovery function fail closed', () => {
  for (const method of [
    'getPendingModelRequestRecovery',
    'readModelRequestRecoveryResolution',
    'resolvePendingModelRequest',
  ]) {
    const modelRequestRecovery = { ...SQLITE_TURN_PERSISTENCE_ADAPTER.modelRequestRecovery }
    delete modelRequestRecovery[method]
    const incomplete = {
      ...SQLITE_TURN_PERSISTENCE_ADAPTER,
      id: `test.missing-${method.toLowerCase()}`,
      modelRequestRecovery,
    }

    assert.throws(
      () => prepareTurnPersistenceAdapter(incomplete),
      (error) => error?.code === 'TURN_PERSISTENCE_ADAPTER_INVALID'
        && error.message.includes(method),
      method,
    )
  }
})

test('custom persistence backends missing any Session admin function fail closed', () => {
  const { adapter } = memoryAdapter('test.no-session-admin-delete')
  const sessionAdmin = { ...adapter.sessionAdmin }
  delete sessionAdmin.deleteSession
  const incomplete = { ...adapter, sessionAdmin }

  assert.throws(
    () => prepareTurnPersistenceAdapter(incomplete),
    (error) => error?.code === 'SESSION_ADMIN_PORT_INVALID'
      && /deleteSession/.test(error.message),
  )
})

test('host assembly replaces the complete persistence boundary and can reassemble only after shutdown', async () => {
  const first = memoryAdapter('test.memory-a')
  const second = memoryAdapter('test.memory-b')
  const firstRuntime = createLifecycleRuntime({
    silent: true,
    adapters: lifecycleAdapters(),
    turnPersistenceAdapter: first.adapter,
    subagentRunPersistenceAdapter: TEST_SUBAGENT_RUN_PERSISTENCE_PORT,
  })
  const secondRuntime = createLifecycleRuntime({
    silent: true,
    adapters: lifecycleAdapters(),
    turnPersistenceAdapter: second.adapter,
    subagentRunPersistenceAdapter: TEST_SUBAGENT_RUN_PERSISTENCE_PORT,
  })

  try {
    await firstRuntime.start().ready
    const firstEngine = getTurnEngine()
    assert.strictEqual(firstEngine.deps.readSession, first.adapter.session.getSession)
    assert.notStrictEqual(getSessionAdminPort().listSessions, first.adapter.sessionAdmin.listSessions)
    assert.deepEqual(await getSessionAdminPort().listSessions({
      userId: 'session-admin-user',
      archived: 'all',
      limit: '3',
      offset: '2',
    }), [])
    assert.deepEqual(first.calls.at(-1), [
      'listSessions',
      { userId: 'session-admin-user', archived: 'all', limit: 3, offset: 2 },
    ])
    assert.strictEqual(firstEngine.deps.writeSession, first.adapter.session.upsertSession)
    assert.strictEqual(firstEngine.deps.appendEvent, first.adapter.eventLog.appendTurnEvent)
    assert.strictEqual(firstEngine.deps.lastEvent, first.adapter.eventLog.getLastTurnEvent)
    assert.strictEqual(firstEngine.deps.replayEvents, first.adapter.eventLog.listTurnEvents)
    assert.strictEqual(
      firstEngine.deps.readPendingModelRequest,
      first.adapter.modelRequestRecovery.getPendingModelRequestRecovery,
    )
    assert.strictEqual(
      firstEngine.deps.readModelRequestResolution,
      first.adapter.modelRequestRecovery.readModelRequestRecoveryResolution,
    )
    assert.strictEqual(
      firstEngine.deps.commitPendingModelRequest,
      first.adapter.modelRequestRecovery.resolvePendingModelRequest,
    )
    assert.strictEqual(
      firstEngine.deps.recordEventWriteFailure,
      first.adapter.eventLog.recordTurnEventWriteFailure,
    )
    firstEngine.deps.runtimeCore.checkpoint.save(
      { userId: 'u', sessionId: 's', turnId: 't' },
      { step: 1 },
      { eventSequence: 2 },
    )
    assert.equal(
      firstEngine.deps.runtimeCore.checkpoint.load({ userId: 'u', sessionId: 's', turnId: 't' })
        ?.eventSequence,
      2,
    )
    firstEngine.deps.runtimeCore.checkpoint.clear({ userId: 'u', sessionId: 's', turnId: 't' })
    const writer = firstEngine.deps.createEventWriteBehind()
    writer.enqueue({
      userId: 'u',
      event: { id: 'e', sessionId: 's', turnId: 't', sequence: 0, type: 'assistant.delta' },
      checkpointState: null,
    })
    await writer.close()
    assert.ok(first.calls.some(([name]) => name === 'appendTurnEvents'))

    assert.throws(
      () => secondRuntime.start(),
      (error) => error?.code === 'TURN_PERSISTENCE_ADAPTER_ALREADY_ACTIVE',
    )
    assert.strictEqual(getTurnEngine(), firstEngine)

    const firstStop = await firstRuntime.stop()
    assert.equal(firstStop.exitCode, 0)
    assert.equal(getTurnPersistenceAdapterStatus().configured, false)

    await secondRuntime.start().ready
    const secondEngine = getTurnEngine()
    assert.notStrictEqual(secondEngine, firstEngine)
    assert.strictEqual(secondEngine.deps.readSession, second.adapter.session.getSession)
    assert.strictEqual(secondEngine.deps.appendEvent, second.adapter.eventLog.appendTurnEvent)
    assert.strictEqual(
      secondEngine.deps.readPendingModelRequest,
      second.adapter.modelRequestRecovery.getPendingModelRequestRecovery,
    )
    assert.strictEqual(
      secondEngine.deps.readModelRequestResolution,
      second.adapter.modelRequestRecovery.readModelRequestRecoveryResolution,
    )
    assert.strictEqual(
      secondEngine.deps.commitPendingModelRequest,
      second.adapter.modelRequestRecovery.resolvePendingModelRequest,
    )
  } finally {
    await secondRuntime.stop()
    await closeTurnEngine()
  }
  assert.equal(getTurnPersistenceAdapterStatus().configured, false)
})

test('TurnEngine recognizes a custom Session Store ownership conflict by stable error code only', async () => {
  const ownershipConflict = Object.assign(new Error('owned elsewhere'), {
    code: 'SESSION_OWNERSHIP_CONFLICT',
  })
  const engine = new TurnEngine({
    readSession: () => null,
    sessionIdOccupied: () => false,
    lastEvent: () => null,
    resolveModelBinding: () => ({
      modelName: 'test-model',
      providerId: 'test-provider',
      configRevision: 1,
      env: {},
    }),
    writeSession: () => { throw ownershipConflict },
    scheduleMemoryExtraction: noop,
  })

  await assert.rejects(
    engine.startTurn({
      userId: 'owner',
      sessionId: 'custom-session',
      turnId: 'custom-turn',
      content: 'hello',
    }),
    (error) => error?.code === 'SESSION_NOT_FOUND'
      && error?.status === 404,
  )
  await engine.shutdown()
})

test('async lifecycle start failure keeps persistence frozen until engine shutdown releases it', async () => {
  const { adapter } = memoryAdapter('test.async-failure')
  const closeOrder = []
  let engine = null
  const runtime = createLifecycleRuntime({
    silent: true,
    adapters: lifecycleAdapters({
      closeEngine: async () => {
        closeOrder.push('engine:close-start')
        await closeTurnEngine()
        closeOrder.push('engine:close-end')
      },
    }),
    turnPersistenceAdapter: adapter,
    subagentRunPersistenceAdapter: TEST_SUBAGENT_RUN_PERSISTENCE_PORT,
    capabilities: [{
      id: 'test.async-start-failure',
      owner: 'test',
      priority: 1,
      dependsOn: [BUILTIN_LIFECYCLE_CAPABILITY_IDS.compactionArchive],
      start: async () => {
        engine = getTurnEngine()
        throw new Error('async start failed')
      },
    }],
    onError: noop,
  })

  const started = runtime.start()
  const ready = await started.ready
  assert.ok(engine)
  assert.ok(ready.failures.some((result) => result.capability.id === 'test.async-start-failure'))
  assert.equal(getTurnPersistenceAdapterStatus().engineBound, true)

  const stopped = await runtime.stop()
  assert.equal(stopped.exitCode, 0)
  assert.deepEqual(closeOrder, ['engine:close-start', 'engine:close-end'])
  assert.equal(getTurnPersistenceAdapterStatus().configured, false)
  assert.equal(engine.closing, true)

  const audit = listTurnPersistenceAdapterAuditEvents()
    .filter((entry) => entry.adapterId === adapter.id)
  const engineReleased = audit.find((entry) => entry.event === 'turn_persistence.engine_released')
  const adapterReleased = audit.find((entry) => entry.event === 'turn_persistence.released')
  assert.ok(engineReleased)
  assert.ok(adapterReleased)
  assert.ok(engineReleased.sequence < adapterReleased.sequence)
})

test('default bootstrap can select a new adapter after graceful shutdown completes', async () => {
  const first = memoryAdapter('test.bootstrap-a')
  const second = memoryAdapter('test.bootstrap-b')
  const server = () => ({
    close(callback) { callback() },
  })

  await bootstrap({
    silent: true,
    adapters: lifecycleAdapters(),
    turnPersistenceAdapter: first.adapter,
    subagentRunPersistenceAdapter: TEST_SUBAGENT_RUN_PERSISTENCE_PORT,
  }).ready
  assert.strictEqual(getTurnEngine().deps.readSession, first.adapter.session.getSession)
  assert.equal(await gracefulShutdown(server(), { silent: true, exit: false }), 0)
  assert.equal(getTurnPersistenceAdapterStatus().configured, false)

  await bootstrap({
    silent: true,
    adapters: lifecycleAdapters(),
    turnPersistenceAdapter: second.adapter,
    subagentRunPersistenceAdapter: TEST_SUBAGENT_RUN_PERSISTENCE_PORT,
  }).ready
  assert.strictEqual(getTurnEngine().deps.readSession, second.adapter.session.getSession)
  assert.equal(await gracefulShutdown(server(), { silent: true, exit: false }), 0)
  assert.equal(getTurnPersistenceAdapterStatus().configured, false)
})
