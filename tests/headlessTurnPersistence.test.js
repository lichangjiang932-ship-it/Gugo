import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// Initialize the production Headless/TurnEngine graph before importing the
// capability controller directly. Static sibling imports here would evaluate
// runtimeCapabilityHost through two paths and manufacture an ESM TDZ that the
// real CLI entrypoint does not have.
const { runHeadlessTurn } = await import('../server/services/headlessTurnRuntime.js')
const { runBuiltinHeadlessTurn } = await import('../server/adapters/headlessTurnHost.js')
const { SQLITE_TURN_PERSISTENCE_ADAPTER } = await import(
  '../server/adapters/sqliteTurnPersistenceAdapter.js'
)
const { closeTurnEngine, getTurnEngine } = await import('../server/services/turnEngineHost.js')
const { getToolLoopAdapterStatus } = await import('../server/core/toolLoopAdapter.js')
const {
  createCompactionArchivePortController,
  getCompactionArchivePortStatus,
} = await import(
  '../server/core/compactionArchivePort.js'
)
const {
  MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION,
  createManagedAttachmentRuntimePortController,
  getManagedAttachmentRuntimePortStatus,
} = await import(
  '../server/core/managedAttachmentRuntimePort.js'
)
const {
  createTurnPersistenceAdapterController,
  getTurnPersistenceAdapterStatus,
  TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION,
} = await import('../server/core/turnPersistenceAdapter.js')
const { SESSION_ADMIN_PORT_CONTRACT_VERSION } = await import('../server/core/sessionAdminPort.js')
const { getSubagentRunPersistencePortStatus } = await import(
  '../server/core/subagentRunPersistencePort.js'
)
const { BUILTIN_TOOL_LOOP_ADAPTER } = await import('../server/core/toolLoopAdapter.js')
const {
  listRuntimeCapabilityContributions,
} = await import('../server/core/runtimeCapabilityHost.js')

function createAsyncHeadlessAdapter({ userId, sessionId, turnId }) {
  const calls = []
  const session = { id: sessionId, userId, title: 'Async headless session' }
  const events = [
    {
      id: `${turnId}:started`,
      userId,
      sessionId,
      turnId,
      sequence: 0,
      type: 'turn.started',
      payload: { content: 'already complete' },
      createdAt: 1,
    },
    {
      id: `${turnId}:completed`,
      userId,
      sessionId,
      turnId,
      sequence: 1,
      type: 'turn.completed',
      payload: { text: 'completed by custom async persistence' },
      createdAt: 2,
    },
  ]
  const method = (name, implementation) => async (input) => {
    calls.push(`${name}:start`)
    await Promise.resolve()
    const result = implementation(input)
    calls.push(`${name}:end`)
    return result
  }
  const constant = (name, value) => method(name, () => value)
  const inScope = (input = {}) => input.userId === userId
    && (input.sessionId || input.id) === sessionId

  return {
    calls,
    adapter: {
      id: 'test.headless-async',
      contractVersion: TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION,
      session: {
        getSession: method('getSession', (input) => inScope(input) ? session : null),
        isSessionIdOccupied: method(
          'isSessionIdOccupied',
          (input) => input?.sessionId === sessionId,
        ),
        claimLocalChatSession: method(
          'claimLocalChatSession',
          (input) => inScope(input) ? session : null,
        ),
        upsertSession: method('upsertSession', (input) => input),
        listMessages: constant('listMessages', []),
        getPreviousUserMessage: constant('getPreviousUserMessage', null),
        upsertMessage: method('upsertMessage', (input) => input),
        deleteMessage: constant('deleteMessage', 0),
      },
      eventLog: {
        appendTurnEvent: method('appendTurnEvent', (input) => input?.event || null),
        appendTurnEvents: method(
          'appendTurnEvents',
          (entries) => entries.map((entry) => entry.event),
        ),
        getLastTurnEvent: method('getLastTurnEvent', (input = {}) => events
          .filter((event) => inScope(input)
            && event.turnId === input.turnId
            && (!input.type || event.type === input.type))
          .at(-1) || null),
        listTurnEvents: method('listTurnEvents', (input = {}) => {
          const after = Number.isInteger(input.after) ? input.after : -1
          const limit = Number.isInteger(input.limit) ? input.limit : events.length
          return events
            .filter((event) => inScope(input)
              && event.turnId === input.turnId
              && event.sequence > after
              && (!input.type || event.type === input.type))
            .slice(0, limit)
        }),
        resolveTurnSession: method('resolveTurnSession', (input = {}) => (
          input.userId === userId && input.turnId === turnId
            ? Object.freeze({ status: 'found', sessionId })
            : Object.freeze({ status: 'not_found' })
        )),
        recordTurnEventWriteFailure: constant('recordTurnEventWriteFailure', 1),
        verifyTurnEventCommit: method('verifyTurnEventCommit', ({ event, storedEvent }) => ({
          committed: event?.id === storedEvent?.id,
          receipt: null,
        })),
        getTurnCheckpoint: constant('getTurnCheckpoint', null),
        saveTurnCheckpoint: method('saveTurnCheckpoint', (input) => input),
        deleteTurnCheckpoint: constant('deleteTurnCheckpoint', 0),
      },
      transactions: {
        commitTurnStart: method('commitTurnStart', (input) => input?.event || null),
        commitTurnCheckpoint: method('commitTurnCheckpoint', (input) => input?.event || null),
        commitTurnBoundary: method('commitTurnBoundary', (input) => input?.event || null),
      },
      execution: {
        claimTurnExecutionLease: constant('claimTurnExecutionLease', null),
        getTurnExecutionLease: constant('getTurnExecutionLease', null),
        renewTurnExecutionLease: constant('renewTurnExecutionLease', false),
        releaseTurnExecutionLease: constant('releaseTurnExecutionLease', false),
        isTurnExecutionLeaseActive: constant('isTurnExecutionLeaseActive', false),
        hasActiveTurnExecutionLeaseForSession: constant(
          'hasActiveTurnExecutionLeaseForSession',
          false,
        ),
        requestTurnExecutionCancellation: constant('requestTurnExecutionCancellation', false),
        tryCloseTurnSteeringInbox: constant('tryCloseTurnSteeringInbox', null),
        listUnfinishedTurnExecutions: constant('listUnfinishedTurnExecutions', []),
      },
      steering: {
        enqueueTurnSteering: constant('enqueueTurnSteering', null),
        listTurnSteering: constant('listTurnSteering', []),
        claimTurnSteering: constant('claimTurnSteering', null),
        acknowledgeTurnSteering: constant('acknowledgeTurnSteering', 0),
        acknowledgeAppliedTurnSteering: constant('acknowledgeAppliedTurnSteering', 0),
        releaseTurnSteeringLease: constant('releaseTurnSteeringLease', 0),
        releaseTurnSteeringLeasesForTurn: constant('releaseTurnSteeringLeasesForTurn', 0),
      },
      recovery: {
        getTurnRecoveryState: constant('getTurnRecoveryState', null),
        recordTurnRecoveryFailure: constant('recordTurnRecoveryFailure', null),
        clearTurnRecoveryState: constant('clearTurnRecoveryState', 0),
        listTurnRecoveryStates: constant('listTurnRecoveryStates', []),
        pruneResolvedTurnRecoveryStates: constant('pruneResolvedTurnRecoveryStates', 0),
      },
      modelRequestRecovery: {
        getPendingModelRequestRecovery: constant('getPendingModelRequestRecovery', null),
        readModelRequestRecoveryResolution: constant('readModelRequestRecoveryResolution', null),
        resolvePendingModelRequest: constant('resolvePendingModelRequest', null),
      },
      sessionAdmin: {
        contractVersion: SESSION_ADMIN_PORT_CONTRACT_VERSION,
        searchMessages: constant('searchMessages', []),
        listSessions: constant('listSessions', []),
        getSessionSnapshot: constant('getSessionSnapshot', null),
        getSessionBranches: constant('getSessionBranches', null),
        forkSession: constant('forkSession', null),
        replaceSessionMessages: constant('replaceSessionMessages', null),
        deleteSession: constant('deleteSession', null),
        archiveSession: constant('archiveSession', null),
        unarchiveSession: constant('unarchiveSession', null),
        pinSession: constant('pinSession', null),
        unpinSession: constant('unpinSession', null),
      },
    },
  }
}

function importSpecifiers(source) {
  const specifiers = []
  const staticImport = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g
  const dynamicImport = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of source.matchAll(staticImport)) specifiers.push(match[1])
  for (const match of source.matchAll(dynamicImport)) specifiers.push(match[1])
  return specifiers
}

function createHeadlessHostTestDependencies(backend, userId) {
  const snapshot = Object.freeze({
    get(type) {
      if (type === 'persistence') return backend.adapter
      if (type === 'loop') return BUILTIN_TOOL_LOOP_ADAPTER
      return null
    },
  })
  return {
    toolLoopAdapter: BUILTIN_TOOL_LOOP_ADAPTER,
    prepareRuntimeCapabilitySnapshot: async () => snapshot,
    createCompactionArchiveAdapter: () => ({}),
    createCompactionArchivePortController: () => ({}),
    createManagedAttachmentRuntimeAdapter: () => ({}),
    createManagedAttachmentRuntimePortController: () => ({}),
    createHeadlessLifecycleCapabilities: () => [],
    createLifecycleRuntime: () => ({
      start: () => ({ ready: Promise.resolve({ failures: [] }) }),
      stop: async () => ({ exitCode: 0 }),
    }),
    configureWorkspace: (value) => value,
    bootstrapAuth: async () => ({ authenticated: true, mode: 'local', user: { id: userId } }),
    persistenceAdapter: backend.adapter,
    engine: {
      startTurn: async () => {},
      recoverTurn: async () => ({ terminal: true }),
      waitForTurn: async () => {},
      listEvents: (input) => backend.adapter.eventLog.listTurnEvents(input),
    },
  }
}

test('builtin headless host activates and releases its CLI capability bindings on failure', async () => {
  const sentinel = new Error('headless bootstrap sentinel')
  let inspected = false

  await assert.rejects(
    runBuiltinHeadlessTurn({}, {
      turnPersistenceAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
      configureWorkspace: (value) => value,
      bootstrapAuth: async () => {
        inspected = true
        const persistence = getTurnPersistenceAdapterStatus()
        const subagentPersistence = getSubagentRunPersistencePortStatus()
        const loop = getToolLoopAdapterStatus()
        const compactionArchive = getCompactionArchivePortStatus()
        const managedAttachments = getManagedAttachmentRuntimePortStatus()
        assert.equal(persistence.configured, true)
        assert.equal(persistence.source, 'cli.headless')
        assert.equal(subagentPersistence.configured, true)
        assert.equal(subagentPersistence.source, 'cli.headless')
        assert.equal(loop.configured, true)
        assert.equal(loop.source, 'registry_default')
        assert.equal(loop.binding.owner, 'builtin')
        assert.equal(loop.binding.provenance.source, 'registry_default')
        assert.equal(compactionArchive.configured, true)
        assert.equal(compactionArchive.source, 'cli.headless')
        assert.equal(managedAttachments.configured, true)
        assert.equal(managedAttachments.source, 'cli.headless')
        throw sentinel
      },
    }),
    (error) => error === sentinel,
  )

  assert.equal(inspected, true)
  assert.equal(getTurnPersistenceAdapterStatus().configured, false)
  assert.equal(getSubagentRunPersistencePortStatus().configured, false)
  assert.equal(getToolLoopAdapterStatus().configured, false)
  assert.equal(getCompactionArchivePortStatus().configured, false)
  assert.equal(getManagedAttachmentRuntimePortStatus().configured, false)
  assert.equal(
    listRuntimeCapabilityContributions().some((entry) => entry.type === 'persistence'),
    false,
  )
})

test('headless composition injects one SQLite Subagent adapter built with the shared getDb', async () => {
  const userId = 'subagent-wiring-user'
  const sessionId = 'subagent-wiring-session'
  const turnId = 'subagent-wiring-turn'
  const backend = createAsyncHeadlessAdapter({ userId, sessionId, turnId })
  const subagentRunPersistenceAdapter = Object.freeze({ id: 'test.subagent-wiring' })
  const databaseAccessor = () => {
    throw new Error('the wiring test must not open SQLite')
  }
  let receivedLifecycleOptions = null
  let receivedAssemblyOptions = null
  let factoryCalls = 0
  let managedAttachmentFactoryCalls = 0
  const managedAttachmentRuntimeAdapter = Object.freeze({ id: 'test.managed-attachments' })
  const managedAttachmentRuntimeController = Object.freeze({
    activate: () => true,
    release: () => true,
  })

  const result = await runBuiltinHeadlessTurn({
    runtimeEnv: { GUGO_LOAD_DOTENV: '0' },
    resumeTurnId: turnId,
    sessionId,
    turnPersistenceAdapter: backend.adapter,
  }, {
    ...createHeadlessHostTestDependencies(backend, userId),
    getDb: databaseAccessor,
    createSqliteSubagentRunPersistenceAdapter: ({ getDb: receivedGetDb }) => {
      factoryCalls += 1
      assert.equal(receivedGetDb, databaseAccessor)
      return subagentRunPersistenceAdapter
    },
    createManagedAttachmentRuntimeAdapter: ({ env }) => {
      managedAttachmentFactoryCalls += 1
      assert.deepEqual(env, { GUGO_LOAD_DOTENV: '0' })
      return managedAttachmentRuntimeAdapter
    },
    createManagedAttachmentRuntimePortController: (adapter, options) => {
      assert.equal(adapter, managedAttachmentRuntimeAdapter)
      assert.deepEqual(options, { source: 'cli.headless' })
      return managedAttachmentRuntimeController
    },
    createHeadlessLifecycleCapabilities: (options) => {
      receivedAssemblyOptions = options
      return []
    },
    createLifecycleRuntime: (options) => {
      receivedLifecycleOptions = options
      return {
        start: () => ({ ready: Promise.resolve({ failures: [] }) }),
        stop: async () => ({ exitCode: 0 }),
      }
    },
  })

  assert.equal(result.status, 'completed')
  assert.equal(factoryCalls, 1)
  assert.equal(managedAttachmentFactoryCalls, 1)
  assert.equal(
    receivedLifecycleOptions.subagentRunPersistenceAdapter,
    subagentRunPersistenceAdapter,
  )
  assert.strictEqual(receivedLifecycleOptions.toolLoopAdapter, BUILTIN_TOOL_LOOP_ADAPTER)
  assert.equal(Object.hasOwn(receivedLifecycleOptions, 'toolLoopBinding'), false)
  assert.equal(
    receivedAssemblyOptions.managedAttachmentRuntimeController,
    managedAttachmentRuntimeController,
  )
})

test('headless managed attachment assembly failure releases the host persistence lease', async () => {
  const backend = createAsyncHeadlessAdapter({
    userId: 'managed-attachment-assembly-user',
    sessionId: 'managed-attachment-assembly-session',
    turnId: 'managed-attachment-assembly-turn',
  })
  const sentinel = new Error('managed attachment controller construction failed')
  let releaseCalls = 0

  await assert.rejects(runBuiltinHeadlessTurn({
    runtimeEnv: { GUGO_LOAD_DOTENV: '0' },
    turnPersistenceAdapter: backend.adapter,
  }, {
    ...createHeadlessHostTestDependencies(backend, 'managed-attachment-assembly-user'),
    acquireHostTurnPersistenceCapability: (adapter) => Object.freeze({
      adapter,
      release() {
        releaseCalls += 1
        return true
      },
    }),
    createManagedAttachmentRuntimePortController: () => { throw sentinel },
  }), (error) => error === sentinel)

  assert.equal(releaseCalls, 1)
})

test('builtin headless host releases its registration when snapshot preparation fails', async () => {
  const sentinel = new Error('snapshot preparation failed')
  const backend = createAsyncHeadlessAdapter({
    userId: 'snapshot-user',
    sessionId: 'snapshot-session',
    turnId: 'snapshot-turn',
  })

  await assert.rejects(
    runBuiltinHeadlessTurn({ runtimeEnv: { GUGO_LOAD_DOTENV: '0' } }, {
      turnPersistenceAdapter: backend.adapter,
      prepareRuntimeCapabilitySnapshot: async () => { throw sentinel },
    }),
    (error) => error === sentinel,
  )
  assert.equal(
    listRuntimeCapabilityContributions().some((entry) => entry.type === 'persistence'),
    false,
  )
})

test('builtin headless preparation reports a false persistence release result', async () => {
  const backend = createAsyncHeadlessAdapter({
    userId: 'snapshot-release-user',
    sessionId: 'snapshot-release-session',
    turnId: 'snapshot-release-turn',
  })
  const preparationFailure = new Error('snapshot preparation failed before false release')

  await assert.rejects(runBuiltinHeadlessTurn({ runtimeEnv: { GUGO_LOAD_DOTENV: '0' } }, {
    turnPersistenceAdapter: backend.adapter,
    acquireHostTurnPersistenceCapability: (adapter) => Object.freeze({
      adapter,
      release: () => false,
    }),
    prepareRuntimeCapabilitySnapshot: async () => { throw preparationFailure },
  }), (error) => error instanceof AggregateError
    && error.code === 'HEADLESS_TURN_PREPARATION_AND_RELEASE_FAILED'
    && error.cause === preparationFailure
    && error.errors.length === 2
    && error.errors[0] === preparationFailure
    && error.errors[1]?.code === 'HEADLESS_TURN_PERSISTENCE_RELEASE_FAILED')
})

test('builtin headless host retains registration when lifecycle shutdown fails', async () => {
  const backend = createAsyncHeadlessAdapter({
    userId: 'shutdown-user',
    sessionId: 'shutdown-session',
    turnId: 'shutdown-turn',
  })
  const snapshot = Object.freeze({
    get(type) {
      if (type === 'persistence') return backend.adapter
      if (type === 'loop') return BUILTIN_TOOL_LOOP_ADAPTER
      return null
    },
  })
  const startupFailure = new Error('headless startup failed')
  let acquiredAdapter = null
  let releaseCalls = 0

  await assert.rejects(
    runBuiltinHeadlessTurn({ runtimeEnv: { GUGO_LOAD_DOTENV: '0' } }, {
      turnPersistenceAdapter: backend.adapter,
      toolLoopAdapter: BUILTIN_TOOL_LOOP_ADAPTER,
      acquireHostTurnPersistenceCapability: (adapter) => {
        acquiredAdapter = adapter
        return Object.freeze({
          adapter,
          release() {
            releaseCalls += 1
            return true
          },
        })
      },
      prepareRuntimeCapabilitySnapshot: async () => snapshot,
      createCompactionArchiveAdapter: () => ({}),
      createCompactionArchivePortController: () => ({}),
      createHeadlessLifecycleCapabilities: () => [],
      createLifecycleRuntime: () => ({
        start: () => ({
          ready: Promise.resolve({
            failures: [{
              capability: { id: 'test.startup', startFailure: 'fail' },
              error: startupFailure,
            }],
          }),
        }),
        stop: async () => ({ exitCode: 1 }),
      }),
    }),
    (error) => error instanceof AggregateError
      && error.code === 'HEADLESS_TURN_AND_SHUTDOWN_FAILED'
      && error.errors.length === 2
      && error.cause === error.errors[0]
      && error.errors[0]?.code === 'HEADLESS_RUNTIME_STARTUP_CAPABILITY_FAILED'
      && error.errors[0]?.cause === startupFailure
      && error.errors[1]?.code === 'HEADLESS_RUNTIME_SHUTDOWN_FAILED',
  )
  assert.equal(acquiredAdapter, backend.adapter)
  assert.equal(releaseCalls, 0)
  assert.equal(
    listRuntimeCapabilityContributions().some((entry) => entry.type === 'persistence'),
    false,
  )
})

test('builtin headless host retains its lease when lifecycle shutdown rejects', async () => {
  const backend = createAsyncHeadlessAdapter({
    userId: 'shutdown-reject-user',
    sessionId: 'shutdown-reject-session',
    turnId: 'shutdown-reject-turn',
  })
  const snapshot = Object.freeze({
    get(type) {
      if (type === 'persistence') return backend.adapter
      if (type === 'loop') return BUILTIN_TOOL_LOOP_ADAPTER
      return null
    },
  })
  const startupFailure = new Error('headless startup failed')
  const shutdownFailure = new Error('headless shutdown rejected')
  let releaseCalls = 0

  await assert.rejects(
    runBuiltinHeadlessTurn({ runtimeEnv: { GUGO_LOAD_DOTENV: '0' } }, {
      turnPersistenceAdapter: backend.adapter,
      toolLoopAdapter: BUILTIN_TOOL_LOOP_ADAPTER,
      acquireHostTurnPersistenceCapability: (adapter) => Object.freeze({
        adapter,
        release() {
          releaseCalls += 1
          return true
        },
      }),
      prepareRuntimeCapabilitySnapshot: async () => snapshot,
      createCompactionArchiveAdapter: () => ({}),
      createCompactionArchivePortController: () => ({}),
      createHeadlessLifecycleCapabilities: () => [],
      createLifecycleRuntime: () => ({
        start: () => ({
          ready: Promise.resolve({
            failures: [{
              capability: { id: 'test.startup', startFailure: 'fail' },
              error: startupFailure,
            }],
          }),
        }),
        stop: async () => { throw shutdownFailure },
      }),
    }),
    (error) => error instanceof AggregateError
      && error.code === 'HEADLESS_TURN_AND_SHUTDOWN_FAILED'
      && error.errors.length === 2
      && error.cause === error.errors[0]
      && error.errors[0]?.code === 'HEADLESS_RUNTIME_STARTUP_CAPABILITY_FAILED'
      && error.errors[0]?.cause === startupFailure
      && error.errors[1] === shutdownFailure,
  )
  assert.equal(releaseCalls, 0)
  assert.equal(
    listRuntimeCapabilityContributions().some((entry) => entry.type === 'persistence'),
    false,
  )
})

test('builtin headless preserves a lone shutdown failure without wrapping it', async () => {
  const userId = 'shutdown-only-user'
  const sessionId = 'shutdown-only-session'
  const turnId = 'shutdown-only-turn'
  const backend = createAsyncHeadlessAdapter({ userId, sessionId, turnId })
  const shutdownFailure = new Error('headless shutdown failed after a successful turn')
  let releaseCalls = 0

  await assert.rejects(runBuiltinHeadlessTurn({
    runtimeEnv: { GUGO_LOAD_DOTENV: '0' },
    resumeTurnId: turnId,
    sessionId,
    turnPersistenceAdapter: backend.adapter,
  }, {
    ...createHeadlessHostTestDependencies(backend, userId),
    acquireHostTurnPersistenceCapability: (adapter) => Object.freeze({
      adapter,
      release() {
        releaseCalls += 1
        return true
      },
    }),
    createLifecycleRuntime: () => ({
      start: () => ({ ready: Promise.resolve({ failures: [] }) }),
      stop: async () => { throw shutdownFailure },
    }),
  }), (error) => error === shutdownFailure)

  assert.equal(releaseCalls, 0)
})

test('builtin headless aggregates a turn failure with a false persistence release', async () => {
  const backend = createAsyncHeadlessAdapter({
    userId: 'run-false-release-user',
    sessionId: 'run-false-release-session',
    turnId: 'run-false-release-turn',
  })
  const runFailure = new Error('headless turn failed before false release')

  await assert.rejects(runBuiltinHeadlessTurn({
    runtimeEnv: { GUGO_LOAD_DOTENV: '0' },
    turnPersistenceAdapter: backend.adapter,
  }, {
    ...createHeadlessHostTestDependencies(backend, 'run-false-release-user'),
    acquireHostTurnPersistenceCapability: (adapter) => Object.freeze({
      adapter,
      release: () => false,
    }),
    bootstrapAuth: async () => { throw runFailure },
  }), (error) => error instanceof AggregateError
    && error.code === 'HEADLESS_TURN_AND_SHUTDOWN_FAILED'
    && error.cause === runFailure
    && error.errors.length === 2
    && error.errors[0] === runFailure
    && error.errors[1]?.code === 'HEADLESS_TURN_PERSISTENCE_RELEASE_FAILED')
})

test('builtin headless preserves a thrown persistence release error in turn failure order', async () => {
  const backend = createAsyncHeadlessAdapter({
    userId: 'run-throw-release-user',
    sessionId: 'run-throw-release-session',
    turnId: 'run-throw-release-turn',
  })
  const runFailure = new Error('headless turn failed before throwing release')
  const releaseFailure = new Error('headless persistence release threw')

  await assert.rejects(runBuiltinHeadlessTurn({
    runtimeEnv: { GUGO_LOAD_DOTENV: '0' },
    turnPersistenceAdapter: backend.adapter,
  }, {
    ...createHeadlessHostTestDependencies(backend, 'run-throw-release-user'),
    acquireHostTurnPersistenceCapability: (adapter) => Object.freeze({
      adapter,
      release: () => { throw releaseFailure },
    }),
    bootstrapAuth: async () => { throw runFailure },
  }), (error) => error instanceof AggregateError
    && error.code === 'HEADLESS_TURN_AND_SHUTDOWN_FAILED'
    && error.cause === runFailure
    && error.errors.length === 2
    && error.errors[0] === runFailure
    && error.errors[1] === releaseFailure)
})

test('generic headless resume requires an explicit session lookup capability', async () => {
  const engine = {
    startTurn: async () => {},
    recoverTurn: async () => {},
    waitForTurn: async () => {},
    listEvents: async () => [],
  }

  await assert.rejects(
    runHeadlessTurn({ resumeTurnId: 'resume-without-session' }, {
      configureWorkspace: (value) => value,
      bootstrapAuth: async () => ({
        authenticated: true,
        mode: 'local',
        user: { id: 'headless-resume-user' },
      }),
      engine,
      persistenceAdapter: { id: 'test.no-session-lookup' },
    }),
    (error) => error?.code === 'TURN_SESSION_LOOKUP_UNSUPPORTED'
      && error?.exitCode === 2,
  )
})

test('generic headless resume rejects malformed adapter lookup results', async () => {
  const engine = {
    startTurn: async () => {},
    recoverTurn: async () => {},
    waitForTurn: async () => {},
    listEvents: async () => [],
  }
  const dependencies = {
    configureWorkspace: (value) => value,
    bootstrapAuth: async () => ({
      authenticated: true,
      mode: 'local',
      user: { id: 'headless-invalid-lookup-user' },
    }),
    engine,
  }
  const invalidResults = [
    null,
    Object.freeze({ status: 'unsupported' }),
    Object.freeze({ status: 'found', sessionId: ' ' }),
    Object.create({ status: 'not_found' }),
  ]

  for (const result of invalidResults) {
    await assert.rejects(
      runHeadlessTurn({ resumeTurnId: 'invalid-lookup-turn' }, {
        ...dependencies,
        persistenceAdapter: {
          id: 'test.invalid-session-lookup',
          eventLog: { resolveTurnSession: async () => result },
        },
      }),
      (error) => error?.code === 'TURN_PERSISTENCE_ADAPTER_INVALID',
    )
  }
})

test('builtin Headless resume consumes the selected adapter-owned session lookup', async () => {
  const userId = 'headless-canonical-user'
  const sessionId = 'headless-canonical-session'
  const turnId = 'headless-canonical-turn'
  const backend = createAsyncHeadlessAdapter({ userId, sessionId, turnId })

  const result = await runBuiltinHeadlessTurn({
    runtimeEnv: { GUGO_LOAD_DOTENV: '0' },
    resumeTurnId: turnId,
    turnPersistenceAdapter: backend.adapter,
  }, {
    ...createHeadlessHostTestDependencies(backend, userId),
  })

  assert.ok(backend.calls.includes('resolveTurnSession:start'))
  assert.ok(backend.calls.includes('resolveTurnSession:end'))
  assert.equal(result.status, 'completed')
  assert.equal(result.sessionId, sessionId)
})

test('builtin Headless maps an adapter-owned ambiguous turn lookup without guessing', async () => {
  const userId = 'headless-custom-provenance-user'
  const sessionId = 'headless-custom-provenance-session'
  const turnId = 'headless-custom-provenance-turn'
  const backend = createAsyncHeadlessAdapter({ userId, sessionId, turnId })
  const ambiguousAdapter = {
    ...backend.adapter,
    id: 'test.headless-ambiguous',
    eventLog: {
      ...backend.adapter.eventLog,
      resolveTurnSession: async () => Object.freeze({ status: 'ambiguous' }),
    },
  }

  await assert.rejects(runBuiltinHeadlessTurn({
    runtimeEnv: { GUGO_LOAD_DOTENV: '0' },
    resumeTurnId: turnId,
    turnPersistenceAdapter: ambiguousAdapter,
  }, {
    ...createHeadlessHostTestDependencies(backend, userId),
  }), (error) => error?.code === 'TURN_SESSION_AMBIGUOUS'
    && error?.exitCode === 2)
})

test('builtin Headless reports a false persistence release after a successful run', async () => {
  const userId = 'headless-false-release-user'
  const sessionId = 'headless-false-release-session'
  const turnId = 'headless-false-release-turn'
  const backend = createAsyncHeadlessAdapter({ userId, sessionId, turnId })

  await assert.rejects(runBuiltinHeadlessTurn({
    runtimeEnv: { GUGO_LOAD_DOTENV: '0' },
    resumeTurnId: turnId,
    sessionId,
    turnPersistenceAdapter: backend.adapter,
  }, {
    ...createHeadlessHostTestDependencies(backend, userId),
    acquireHostTurnPersistenceCapability: (adapter) => Object.freeze({
      adapter,
      release: () => false,
    }),
  }), (error) => error?.code === 'HEADLESS_TURN_PERSISTENCE_RELEASE_FAILED'
    && error?.retryable === true)
})

test('headless and core persistence boundaries do not import concrete SQLite services', async () => {
  const sources = await Promise.all([
    readFile(new URL('../server/core/turnPersistenceAdapter.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/core/runtimeCapabilityHost.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/services/headlessTurnRuntime.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/services/turnRecoveryRuntime.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/adapters/headlessTurnHost.js', import.meta.url), 'utf8'),
  ])
  const [persistenceCoreSource, capabilityHostSource, headlessRuntimeSource, recoveryRuntimeSource,
    headlessHostSource] = sources
  const [persistenceCore, capabilityHost, headlessRuntime, recoveryRuntime] = [
    persistenceCoreSource,
    capabilityHostSource,
    headlessRuntimeSource,
    recoveryRuntimeSource,
  ].map(importSpecifiers)

  assert.equal(
    persistenceCore.some((specifier) => /(^|\/)services\//.test(specifier)),
    false,
    'turnPersistenceAdapter must not import service implementations',
  )
  assert.equal(
    persistenceCore.some((specifier) => /(^|\/)db(?:\.js)?$/.test(specifier)
      || /sqliteTurnPersistenceAdapter/i.test(specifier)),
    false,
    'turnPersistenceAdapter must not import DB or SQLite implementations',
  )
  assert.equal(
    capabilityHost.some((specifier) => /sqliteTurnPersistenceAdapter/i.test(specifier)),
    false,
    'runtimeCapabilityHost must not import the concrete SQLite adapter',
  )
  for (const [label, specifiers] of [
    ['headlessTurnRuntime', headlessRuntime],
    ['turnRecoveryRuntime', recoveryRuntime],
  ]) {
    assert.equal(
      specifiers.some((specifier) => /(^|\/)db\.js$/.test(specifier)
        || /sqliteTurnPersistenceAdapter/i.test(specifier)),
      false,
      `${label} must not import DB or SQLite implementations`,
    )
  }
  assert.doesNotMatch(headlessHostSource, /\bFROM\s+turn_events\b/i)
  assert.doesNotMatch(headlessHostSource, /findSqliteResumeSession/)
})

test('headless runtime uses the active async persistence adapter without SQLite fallback', async () => {
  const userId = 'headless-async-user'
  const sessionId = 'headless-async-session'
  const turnId = 'headless-async-turn'
  const backend = createAsyncHeadlessAdapter({ userId, sessionId, turnId })
  const controller = createTurnPersistenceAdapterController(backend.adapter, {
    source: 'test.headless-async',
  })
  const compactionArchiveController = createCompactionArchivePortController({
    apiVersion: 1,
    id: 'test.headless-async-archive',
    create: (input) => ({
      id: 'headless-archive',
      userId: input.userId,
      sessionId: input.sessionId,
      replacedMessageCount: input.archivedMessages.length,
      archivedMessages: input.archivedMessages,
      summaryText: input.summaryText,
      createdAt: 1,
    }),
    get: () => null,
    cleanup: () => ({ removed: 0 }),
  }, { source: 'test.headless-async' })
  const managedAttachmentRuntimeController = createManagedAttachmentRuntimePortController({
    apiVersion: MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION,
    id: 'test.headless-async-attachments',
    validateAttachments: () => [],
    bindAttachments: () => [],
    prepareAttachments: ({ text }) => ({ attachments: [], content: text }),
  }, { source: 'test.headless-async' })
  controller.activate()
  managedAttachmentRuntimeController.activate()
  compactionArchiveController.activate()
  const dependencies = {
    configureWorkspace: (value) => value,
    bootstrapAuth: async () => ({ authenticated: true, mode: 'local', user: { id: userId } }),
  }

  try {
    const delivered = []
    const result = await runHeadlessTurn({
      resumeTurnId: turnId,
      sessionId,
      onEvent: (event) => delivered.push(event.type),
    }, dependencies)

    assert.equal(result.status, 'completed')
    assert.equal(result.lastEvent.payload.text, 'completed by custom async persistence')
    assert.deepEqual(delivered, ['turn.started', 'turn.completed'])
    assert.ok(backend.calls.includes('listTurnEvents:start'))
    assert.ok(backend.calls.includes('listTurnEvents:end'))
    assert.ok(backend.calls.includes('getLastTurnEvent:start'))
    assert.equal(backend.calls.some((entry) => entry.startsWith('commitTurn')), false)

    const sharedEngine = getTurnEngine()
    assert.equal(sharedEngine.closing, false)
    assert.deepEqual(getTurnPersistenceAdapterStatus(), {
      configured: true,
      adapterId: backend.adapter.id,
      contractVersion: TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION,
      engineBound: true,
      source: 'test.headless-async',
    })
  } finally {
    await closeTurnEngine()
    compactionArchiveController.release()
    managedAttachmentRuntimeController.release()
    controller.release()
  }
})

test('builtin headless abort cancels once, waits for durable cancellation, and stops lifecycle', async () => {
  const userId = 'headless-abort-user'
  const sessionId = 'headless-abort-session'
  const turnId = 'headless-abort-turn'
  const backend = createAsyncHeadlessAdapter({ userId, sessionId, turnId })
  const events = []
  let subscriber = () => {}
  let finishTurn
  const completed = new Promise((resolve) => { finishTurn = resolve })
  const abortListeners = new Set()
  const signal = {
    aborted: false,
    addEventListener(type, listener) {
      if (type === 'abort') abortListeners.add(listener)
    },
    removeEventListener(type, listener) {
      if (type === 'abort') abortListeners.delete(listener)
    },
    abort() {
      this.aborted = true
      for (const listener of [...abortListeners]) listener()
    },
  }
  const emit = (type, payload = {}) => {
    const event = {
      id: `${turnId}:${events.length}`,
      userId,
      sessionId,
      turnId,
      sequence: events.length,
      type,
      payload,
      createdAt: events.length + 1,
    }
    events.push(event)
    subscriber(event)
  }
  let cancelCalls = 0
  let cancelledScope = null
  let stopCalls = 0
  const dependencies = {
    ...createHeadlessHostTestDependencies(backend, userId),
    idFactory: (() => {
      const ids = [turnId, sessionId]
      return () => ids.shift()
    })(),
    subscribeEvents: (_scope, callback) => {
      subscriber = callback
      return () => { subscriber = () => {} }
    },
    listEvents: ({ after }) => events.filter((event) => event.sequence > after),
    engine: {
      startTurn: async () => {
        emit('turn.started')
        signal.abort()
        signal.abort()
      },
      recoverTurn: async () => ({ terminal: false }),
      cancelTurn: async (scope) => {
        cancelCalls += 1
        cancelledScope = scope
        emit('turn.cancelled', { reason: 'Cancelled by user' })
        finishTurn()
      },
      waitForTurn: async () => completed,
      listEvents: ({ after }) => events.filter((event) => event.sequence > after),
    },
    createLifecycleRuntime: () => ({
      start: () => ({ ready: Promise.resolve({ failures: [] }) }),
      stop: async () => {
        stopCalls += 1
        return { exitCode: 0 }
      },
    }),
  }

  const delivered = []
  const result = await runBuiltinHeadlessTurn({
    prompt: 'cancel this turn',
    runtimeEnv: { GUGO_LOAD_DOTENV: '0' },
    signal,
    onEvent: (event) => delivered.push(event.type),
    turnPersistenceAdapter: backend.adapter,
  }, dependencies)

  assert.equal(result.status, 'cancelled')
  assert.equal(result.exitCode, 1)
  assert.equal(cancelCalls, 1)
  assert.deepEqual(cancelledScope, { userId, sessionId, turnId, authMode: 'local' })
  assert.deepEqual(delivered, ['turn.started', 'turn.cancelled'])
  assert.equal(stopCalls, 1)
  assert.equal(abortListeners.size, 0)
})
