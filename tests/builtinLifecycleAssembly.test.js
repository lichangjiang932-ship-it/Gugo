import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILTIN_LIFECYCLE_CAPABILITY_IDS,
  createBuiltinLifecycleCapabilities,
  startBuiltinBackgroundRuntimes,
  stopBuiltinBackgroundRuntimes,
} from '../server/core/builtinLifecycleAssembly.js'
import {
  createLifecycleCapabilityGraph,
  createLifecycleCapabilityRegistry,
} from '../server/core/lifecycleCapabilityGraph.js'
import { SQLITE_TURN_PERSISTENCE_ADAPTER } from '../server/adapters/sqliteTurnPersistenceAdapter.js'
import {
  bootstrap,
  createLifecycleRuntime,
  gracefulShutdown,
  listLifecycleAuditEvents,
  listLifecycleCapabilities,
  resolveLifecycleShutdownTimeoutMs,
} from '../server/core/lifecycle.js'
import { getToolLoopAdapterStatus } from '../server/core/toolLoopAdapter.js'
import { getTurnPersistenceAdapterStatus } from '../server/core/turnPersistenceAdapter.js'
import {
  acquireCompactionArchivePort,
  getCompactionArchivePortStatus,
} from '../server/core/compactionArchivePort.js'
import { installHttpServerDrain } from '../server/core/httpServerDrain.js'
import { registerServerShutdownFinalizer } from '../server/core/serverShutdownFinalizers.js'

const TEST_SUBAGENT_RUN_PERSISTENCE_PORT = Object.freeze({
  apiVersion: 1,
  id: 'test.subagent-runs',
  createRun: () => assert.fail('test lifecycle must not create a subagent run'),
  getRun: () => null,
  markRunning: () => assert.fail('test lifecycle must not resume a subagent run'),
  saveRunningTrace: () => assert.fail('test lifecycle must not save a subagent trace'),
  finishRun: () => assert.fail('test lifecycle must not finish a subagent run'),
  listRunningRuns: () => [],
  interruptRunningRun: ({ userId, id }) => ({ userId, id, interrupted: false }),
})

function createNoopLifecycleAdapters() {
  const noop = () => {}
  return {
    closeDb: noop,
    recoverPendingSessionDeletion: noop,
    startSessionContentMaterializerRuntime: noop,
    closeSessionContentMaterializerRuntime: noop,
    shutdownMcpAll: noop,
    shutdownBrowsers: noop,
    warnShellTrust: noop,
    registerBrowserTools: noop,
    registerConnectorTools: noop,
    seedSystemSkills: noop,
    initializeRuntimePluginConfig: noop,
    initPlugins: noop,
    restoreEnabledRuntimePlugins: () => [],
    initCodexPluginSkills: noop,
    setVisionAssistResolver: noop,
    getEnabledIntegrationCredentials: () => null,
    listEnabledIntegrationCredentials: () => [],
    startSocialIntegration: noop,
    stopSocialBridges: noop,
    shutdownRuntimePlugins: noop,
    closeShellSessions: noop,
    closeJobRuntime: noop,
    startEvolutionOperationSweeperRuntime: noop,
    closeEvolutionOperationSweeperRuntime: noop,
    startEvolutionOnlineGraderRuntime: noop,
    closeEvolutionOnlineGraderRuntime: noop,
    closeTurnEngine: noop,
    startTurnRecoveryRuntime: noop,
    closeTurnRecoveryRuntime: noop,
    closeCronScheduler: noop,
    recoverInterruptedSubagentRuns: noop,
    warn: noop,
  }
}

test('background Job and Cron runtimes start only through the explicit post-ready helper', async () => {
  const events = []
  const cronScheduler = {
    start() { events.push('start:cron') },
  }
  assert.deepEqual(events, [])

  assert.deepEqual(await startBuiltinBackgroundRuntimes({
    resolveJobRuntime() {
      events.push('start:jobs')
      return {}
    },
    resolveCronScheduler() {
      events.push('resolve:cron')
      return cronScheduler
    },
    rollback() {
      events.push('rollback')
    },
  }), { jobsStarted: true, cronStarted: true })
  assert.deepEqual(events, ['start:jobs', 'resolve:cron', 'start:cron'])

  assert.equal(await stopBuiltinBackgroundRuntimes({
    stopCronScheduler() { events.push('stop:cron') },
    stopJobRuntime() { events.push('stop:jobs') },
  }), true)
  assert.deepEqual(events.slice(-2), ['stop:cron', 'stop:jobs'])
})

test('background runtime activation rolls back when Cron cannot start', async () => {
  const events = []
  await assert.rejects(
    startBuiltinBackgroundRuntimes({
      resolveJobRuntime() {
        events.push('start:jobs')
        return {}
      },
      resolveCronScheduler() {
        return {
          start() {
            events.push('start:cron')
            throw new Error('cron start failed')
          },
        }
      },
      rollback() {
        events.push('rollback')
      },
    }),
    /cron start failed/,
  )
  assert.deepEqual(events, ['start:jobs', 'start:cron', 'rollback'])
})

test('builtin lifecycle assembly preserves legacy startup and shutdown ordering', async () => {
  const events = []
  let visionResolver = null
  const adapters = {
    closeDb: () => { events.push('stop:database') },
    recoverPendingSessionDeletion: () => { events.push('start:session-deletion-recovery') },
    startSessionContentMaterializerRuntime: () => {},
    closeSessionContentMaterializerRuntime: () => {},
    shutdownMcpAll: () => { events.push('stop:mcp') },
    shutdownBrowsers: () => { events.push('stop:browsers') },
    warnShellTrust: () => { events.push('start:shell-trust') },
    registerBrowserTools: () => { events.push('start:browser-tools') },
    registerConnectorTools: () => { events.push('start:connector-tools') },
    seedSystemSkills: () => { events.push('start:system-skills') },
    initializeRuntimePluginConfig: ({ cwd, env }) => {
      events.push(`start:runtime-plugin-config:${cwd}:${env.RUNTIME_MARKER}`)
    },
    initPlugins: ({ rootDir, silent, includeManaged, cwd, env }) => {
      assert.equal(includeManaged, true)
      assert.equal(cwd, 'test-runtime-root')
      assert.equal(env.RUNTIME_MARKER, 'exact-snapshot')
      events.push(`start:plugins:${rootDir}:${silent}`)
    },
    restoreEnabledRuntimePlugins: () => {
      events.push('start:runtime-plugin-restore')
      return Promise.resolve([])
    },
    initCodexPluginSkills: () => { events.push('start:codex-plugin-skills') },
    setVisionAssistResolver: (resolver) => {
      events.push('start:vision-assist')
      visionResolver = resolver
    },
    getEnabledIntegrationCredentials: ({ userId, provider }) => ({ userId, provider }),
    listEnabledIntegrationCredentials: ({ kind }) => {
      events.push(`start:social-list:${kind}`)
      return [{ provider: 'alpha' }, { provider: 'beta' }]
    },
    startSocialIntegration: (integration) => {
      events.push(`start:social:${integration.provider}`)
      return Promise.resolve()
    },
    stopSocialBridges: () => { events.push('stop:social') },
    shutdownRuntimePlugins: () => { events.push('stop:runtime-plugins') },
    closeShellSessions: () => { events.push('stop:shell-sessions') },
    closeJobRuntime: () => { events.push('stop:jobs') },
    startEvolutionOperationSweeperRuntime: () => { events.push('start:evolution-operation-sweeper') },
    closeEvolutionOperationSweeperRuntime: () => { events.push('stop:evolution-operation-sweeper') },
    startEvolutionOnlineGraderRuntime: () => { events.push('start:evolution-online-grader') },
    closeEvolutionOnlineGraderRuntime: () => { events.push('stop:evolution-online-grader') },
    closeTurnEngine: () => { events.push('stop:turn-engine') },
    startTurnRecoveryRuntime: () => { events.push('start:turn-recovery') },
    closeTurnRecoveryRuntime: () => { events.push('stop:turn-recovery') },
    closeCronScheduler: () => { events.push('stop:cron') },
    recoverInterruptedSubagentRuns: () => { events.push('start:subagent-recovery') },
    warn: (message) => { events.push(`warn:${message}`) },
  }
  const definitions = createBuiltinLifecycleCapabilities({
    silent: true,
    pluginRoot: 'test-plugin-root',
    adapters,
    turnPersistenceAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
    managedAttachmentRuntimeController: {
      activate: () => { events.push('start:managed-attachments') },
      release: () => { events.push('stop:managed-attachments') },
    },
    subagentRunPersistenceAdapter: TEST_SUBAGENT_RUN_PERSISTENCE_PORT,
    cwd: 'test-runtime-root',
    runtimeEnv: Object.freeze({ RUNTIME_MARKER: 'exact-snapshot' }),
  })
  const registry = createLifecycleCapabilityRegistry()
  registry.registerAll(definitions)
  const graph = createLifecycleCapabilityGraph({ registry })

  await graph.startAll().ready
  assert.deepEqual(events, [
    'start:managed-attachments',
    'start:session-deletion-recovery',
    'start:shell-trust',
    'start:browser-tools',
    'start:connector-tools',
    'start:system-skills',
    'start:runtime-plugin-config:test-runtime-root:exact-snapshot',
    'start:plugins:test-plugin-root:true',
    'start:runtime-plugin-restore',
    'start:codex-plugin-skills',
    'start:vision-assist',
    'start:social-list:social',
    'start:social:alpha',
    'start:social:beta',
    'start:evolution-operation-sweeper',
    'start:evolution-online-grader',
    'start:turn-recovery',
    'start:subagent-recovery',
  ])
  assert.deepEqual(visionResolver('owner-1'), {
    userId: 'owner-1',
    provider: 'vision_assist',
  })
  assert.equal(visionResolver(null), null)

  const stopped = await graph.stopAll()
  assert.equal(stopped.exitCode, 0)
  assert.deepEqual(events.slice(-13), [
    'stop:cron',
    'stop:turn-recovery',
    'stop:turn-engine',
    'stop:evolution-online-grader',
    'stop:jobs',
    'stop:shell-sessions',
    'stop:evolution-operation-sweeper',
    'stop:runtime-plugins',
    'stop:social',
    'stop:browsers',
    'stop:mcp',
    'stop:managed-attachments',
    'stop:database',
  ])

  const ids = BUILTIN_LIFECYCLE_CAPABILITY_IDS
  assert.ok(stopped.order.indexOf(ids.turnEngine) < stopped.order.indexOf(ids.jobs))
  assert.ok(stopped.order.indexOf(ids.turnEngine) < stopped.order.indexOf(ids.evolutionOnlineGrader))
  assert.ok(stopped.order.indexOf(ids.evolutionOnlineGrader) < stopped.order.indexOf(ids.jobs))
  assert.ok(stopped.order.indexOf(ids.jobs) < stopped.order.indexOf(ids.shellSessions))
  assert.ok(stopped.order.indexOf(ids.shellSessions) < stopped.order.indexOf(ids.evolutionOperationSweeper))
  assert.ok(stopped.order.indexOf(ids.jobs) < stopped.order.indexOf(ids.evolutionOperationSweeper))
  assert.ok(stopped.order.indexOf(ids.evolutionOperationSweeper) < stopped.order.indexOf(ids.runtimePlugins))
  assert.ok(stopped.order.indexOf(ids.jobs) < stopped.order.indexOf(ids.runtimePlugins))
  assert.ok(stopped.order.indexOf(ids.runtimePlugins) < stopped.order.indexOf(ids.socialBridges))
  assert.ok(stopped.order.indexOf(ids.managedAttachments) < stopped.order.indexOf(ids.database))
  assert.equal(registry.get(ids.turnEngine).stopFailure, 'fail')
  assert.equal(registry.get(ids.evolutionOnlineGrader).stopFailure, 'fail')
  assert.equal(registry.get(ids.evolutionOnlineGrader).hasStop, true)
  assert.equal(registry.get(ids.evolutionOnlineGrader).stopTimeoutMs, 120_000)
  assert.equal(registry.get(ids.evolutionOperationSweeper).hasStop, true)
  assert.equal(registry.get(ids.runtimePlugins).stopFailure, 'fail')
  assert.equal(registry.get(ids.subagentRecovery).hasStop, false)
  assert.equal(
    resolveLifecycleShutdownTimeoutMs({ capabilities: registry.list() }),
    15_000 + definitions
      .filter((entry) => typeof entry.stop === 'function')
      .reduce((total, entry) => total + entry.stopTimeoutMs, 0),
  )
})

test('builtin lifecycle fails closed before materialization when session deletion recovery fails', async () => {
  const events = []
  const adapters = createNoopLifecycleAdapters()
  const definitions = createBuiltinLifecycleCapabilities({
    adapters: {
      ...adapters,
      closeDb: () => { events.push('stop:database') },
      recoverPendingSessionDeletion: () => {
        events.push('start:session-deletion-recovery')
        throw new Error('pending deletion evidence conflict')
      },
      startSessionContentMaterializerRuntime: () => { events.push('start:materializer') },
      seedSystemSkills: () => { events.push('start:system-skills') },
      initPlugins: () => { events.push('start:plugins') },
    },
    turnPersistenceController: {
      activate: () => { events.push('start:turn-persistence') },
      release: () => { events.push('stop:turn-persistence') },
    },
    managedAttachmentRuntimeController: {
      activate: () => { events.push('start:managed-attachments') },
      release: () => { events.push('stop:managed-attachments') },
    },
    subagentRunPersistenceAdapter: TEST_SUBAGENT_RUN_PERSISTENCE_PORT,
    compactionArchiveController: {
      activate: () => { events.push('start:compaction-archive') },
      release: () => { events.push('stop:compaction-archive') },
    },
    toolLoopController: {
      activate: () => { events.push('start:tool-loop') },
      release: () => { events.push('stop:tool-loop') },
    },
  })
  const registry = createLifecycleCapabilityRegistry()
  registry.registerAll(definitions)
  const graph = createLifecycleCapabilityGraph({ registry })

  const started = await graph.startAll().ready
  assert.deepEqual(started.failures.map((entry) => entry.capability.id), [
    BUILTIN_LIFECYCLE_CAPABILITY_IDS.sessionDeletionRecovery,
  ])
  assert.equal(started.failures[0].capability.startFailure, 'fail')
  assert.deepEqual(events, [
    'start:managed-attachments',
    'start:turn-persistence',
    'start:compaction-archive',
    'start:session-deletion-recovery',
  ])
  assert.ok(started.skipped.some((entry) => (
    entry.capability.id === BUILTIN_LIFECYCLE_CAPABILITY_IDS.sessionContentMaterializer
  )))
  assert.ok(started.skipped.some((entry) => (
    entry.capability.id === BUILTIN_LIFECYCLE_CAPABILITY_IDS.pluginDiscovery
  )))

  assert.equal((await graph.stopAll()).exitCode, 0)
  assert.deepEqual(events.slice(-4), [
    'stop:compaction-archive',
    'stop:turn-persistence',
    'stop:managed-attachments',
    'stop:database',
  ])
})

test('graceful shutdown drains HTTP before stopping the injected lifecycle graph and stays idempotent', async () => {
  const events = []
  const runtime = {
    async stop() {
      events.push('capabilities:stop')
      return { exitCode: 0 }
    },
  }
  const server = {
    close(callback) {
      events.push('http:drain')
      callback()
    },
  }
  registerServerShutdownFinalizer(server, () => {
    events.push('host:finalize')
  })

  const first = gracefulShutdown(server, {
    silent: true,
    exit: false,
    runtime,
  })
  const second = gracefulShutdown(server, {
    silent: true,
    exit: false,
    runtime,
  })
  assert.strictEqual(second, first)
  assert.equal(await first, 0)
  assert.deepEqual(events, ['http:drain', 'capabilities:stop', 'host:finalize'])
})

test('host shutdown finalizers stay armed until lifecycle stop succeeds', async () => {
  const events = []
  let stopCalls = 0
  const runtime = {
    async stop() {
      stopCalls += 1
      events.push(`capabilities:stop:${stopCalls}`)
      return { exitCode: stopCalls === 1 ? 1 : 0 }
    },
  }
  const server = {
    close(callback) {
      events.push('http:drain')
      callback()
    },
  }
  registerServerShutdownFinalizer(server, () => {
    events.push('host:finalize')
  })

  assert.equal(await gracefulShutdown(server, { silent: true, exit: false, runtime }), 1)
  assert.deepEqual(events, ['http:drain', 'capabilities:stop:1'])

  assert.equal(await gracefulShutdown(server, { silent: true, exit: false, runtime }), 0)
  assert.deepEqual(events, [
    'http:drain',
    'capabilities:stop:1',
    'http:drain',
    'capabilities:stop:2',
    'host:finalize',
  ])
})

test('a later exit request upgrades the shared in-flight shutdown without repeating stop work', async () => {
  let resolveStop
  let drainCalls = 0
  let stopCalls = 0
  const exitCodes = []
  const pendingStop = new Promise((resolve) => { resolveStop = resolve })
  const runtime = {
    stop() {
      stopCalls += 1
      return pendingStop
    },
  }
  const server = {
    close(callback) {
      drainCalls += 1
      callback()
    },
  }

  const rollback = gracefulShutdown(server, {
    silent: true,
    exit: false,
    runtime,
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(drainCalls, 1)
  assert.equal(stopCalls, 1)

  const signaled = gracefulShutdown(server, {
    silent: true,
    exit: true,
    exitProcess: (code) => exitCodes.push(code),
    runtime,
  })
  assert.strictEqual(signaled, rollback)
  assert.deepEqual(exitCodes, [])

  resolveStop({ exitCode: 0 })
  assert.equal(await rollback, 0)
  assert.deepEqual(exitCodes, [0])
  assert.equal(drainCalls, 1)
  assert.equal(stopCalls, 1)

  const repeatedSignal = gracefulShutdown(server, {
    silent: true,
    exit: true,
    exitProcess: (code) => exitCodes.push(code),
    runtime,
  })
  assert.strictEqual(repeatedSignal, rollback)
  assert.deepEqual(exitCodes, [0])
})

test('forced HTTP drain still stops capabilities but returns a failed shutdown', async () => {
  let stopCalls = 0
  const runtime = {
    async stop() {
      stopCalls += 1
      return { exitCode: 0 }
    },
  }
  const server = {
    on() { return this },
    close(callback) {
      const error = new Error('listener refused to close')
      error.code = 'HTTP_DRAIN_FAILED'
      callback(error)
    },
  }
  installHttpServerDrain(server)

  const code = await gracefulShutdown(server, {
    silent: true,
    exit: false,
    runtime,
  })

  assert.equal(code, 1)
  assert.equal(stopCalls, 1)
})

test('shutdown timeout shares the in-flight stop and permits retry only after it settles', async () => {
  let resolveFirstStop
  let stopCalls = 0
  const firstStop = new Promise((resolve) => { resolveFirstStop = resolve })
  const runtime = {
    stop() {
      stopCalls += 1
      return stopCalls === 1 ? firstStop : Promise.resolve({ exitCode: 0 })
    },
  }
  const server = {
    close(callback) { callback() },
  }

  const first = gracefulShutdown(server, {
    silent: true,
    exit: false,
    runtime,
    timeoutMs: 5,
  })
  const keepAlive = setTimeout(() => {}, 100)
  assert.equal(await first, 1)
  clearTimeout(keepAlive)

  const second = gracefulShutdown(server, {
    silent: true,
    exit: false,
    runtime,
    timeoutMs: 5,
  })
  assert.strictEqual(second, first)
  assert.equal(await second, 1)
  assert.equal(stopCalls, 1)

  resolveFirstStop({ exitCode: 0 })
  await new Promise((resolve) => setImmediate(resolve))

  const third = gracefulShutdown(server, {
    silent: true,
    exit: false,
    runtime,
    timeoutMs: 50,
  })
  assert.notStrictEqual(third, first)
  assert.equal(await third, 0)
  assert.equal(stopCalls, 2)
})

test('lifecycle runtime releases host adapters after their graph capabilities are replaced', async () => {
  const replacements = () => [{
    id: 'test.turn-persistence-replacement',
    owner: 'test',
    priority: 100,
    replaces: BUILTIN_LIFECYCLE_CAPABILITY_IDS.turnPersistence,
    start: () => {},
    stop: () => {},
  }, {
    id: 'test.tool-loop-replacement',
    owner: 'test',
    priority: 100,
    replaces: BUILTIN_LIFECYCLE_CAPABILITY_IDS.toolLoop,
    start: () => {},
    stop: () => {},
  }]

  for (let run = 0; run < 2; run += 1) {
    const runtime = createLifecycleRuntime({
      silent: true,
      adapters: createNoopLifecycleAdapters(),
      capabilities: replacements(),
      turnPersistenceAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
      subagentRunPersistenceAdapter: TEST_SUBAGENT_RUN_PERSISTENCE_PORT,
    })
    await runtime.start().ready
    assert.equal(getToolLoopAdapterStatus().configured, true)
    assert.equal(getTurnPersistenceAdapterStatus().configured, true)
    const stopped = await runtime.stop()
    assert.equal(stopped.exitCode, 0)
    assert.equal(getToolLoopAdapterStatus().configured, false)
    assert.equal(getTurnPersistenceAdapterStatus().configured, false)
  }
})

test('fatal replacement stop preserves host controllers until the unresolved branch retries', async () => {
  let allowToolLoopStop = false
  let toolLoopStopAttempts = 0
  let independentStops = 0
  const runtime = createLifecycleRuntime({
    silent: true,
    adapters: createNoopLifecycleAdapters(),
    turnPersistenceAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
    subagentRunPersistenceAdapter: TEST_SUBAGENT_RUN_PERSISTENCE_PORT,
    onError: () => {},
    capabilities: [{
      id: 'test.failing-tool-loop-replacement',
      owner: 'test',
      priority: 100,
      replaces: BUILTIN_LIFECYCLE_CAPABILITY_IDS.toolLoop,
      start: () => {},
      stopFailure: 'fail',
      stop: () => {
        toolLoopStopAttempts += 1
        if (!allowToolLoopStop) throw new Error('tool loop still owns runtime dependencies')
      },
    }, {
      id: 'test.independent-stop',
      owner: 'test',
      priority: 0,
      stop: () => { independentStops += 1 },
    }],
  })
  await runtime.start().ready
  assert.equal(getToolLoopAdapterStatus().configured, true)
  assert.equal(getTurnPersistenceAdapterStatus().configured, true)

  const first = await runtime.stop()
  assert.equal(first.exitCode, 1)
  assert.equal(toolLoopStopAttempts, 1)
  assert.equal(independentStops, 1)
  assert.equal(getToolLoopAdapterStatus().configured, true)
  assert.equal(getTurnPersistenceAdapterStatus().configured, true)
  assert.ok(first.skipped.some((entry) => (
    entry.capability.slotId === BUILTIN_LIFECYCLE_CAPABILITY_IDS.runtimePlugins
    && entry.blockingCapabilityIds.includes('test.failing-tool-loop-replacement')
  )))

  allowToolLoopStop = true
  const second = await runtime.stop()
  assert.equal(second.exitCode, 0)
  assert.equal(toolLoopStopAttempts, 2)
  assert.equal(independentStops, 1)
  assert.equal(second.skipped.length, 0)
  assert.equal(getToolLoopAdapterStatus().configured, false)
  assert.equal(getTurnPersistenceAdapterStatus().configured, false)
})

test('active archive leases preserve persistence and database until shutdown can be retried', async (t) => {
  const events = []
  const adapters = {
    ...createNoopLifecycleAdapters(),
    closeDb: () => { events.push('stop:database') },
  }
  const runtime = createLifecycleRuntime({
    silent: true,
    adapters,
    turnPersistenceAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
    subagentRunPersistenceAdapter: TEST_SUBAGENT_RUN_PERSISTENCE_PORT,
    compactionArchiveAdapter: {
      apiVersion: 1,
      id: 'test.lifecycle-active-archive-lease',
      create: (input) => ({
        id: input.id || 'archive-1',
        userId: input.userId,
        sessionId: input.sessionId,
        replacedMessageCount: input.archivedMessages.length,
        archivedMessages: input.archivedMessages,
        summaryText: input.summaryText,
        createdAt: 1,
      }),
      get: () => null,
      cleanup: () => ({ removed: 0 }),
    },
  })
  await runtime.start().ready
  let lease = acquireCompactionArchivePort()
  t.after(async () => {
    lease?.release()
    lease = null
    await runtime.stop()
  })

  const first = await runtime.stop()
  assert.equal(first.exitCode, 1)
  assert.deepEqual(events, [])
  assert.equal(getCompactionArchivePortStatus().configured, true)
  assert.equal(getTurnPersistenceAdapterStatus().configured, true)
  assert.deepEqual(first.skipped.map((entry) => entry.capability.id), [
    BUILTIN_LIFECYCLE_CAPABILITY_IDS.turnPersistence,
    BUILTIN_LIFECYCLE_CAPABILITY_IDS.subagentPersistence,
    BUILTIN_LIFECYCLE_CAPABILITY_IDS.managedAttachments,
    BUILTIN_LIFECYCLE_CAPABILITY_IDS.database,
  ])

  lease.release()
  lease = null
  const second = await runtime.stop()
  assert.equal(second.exitCode, 0)
  assert.deepEqual(events, ['stop:database'])
  assert.equal(getCompactionArchivePortStatus().configured, false)
  assert.equal(getTurnPersistenceAdapterStatus().configured, false)
})

test('lifecycle passes the exact startup environment and cwd to the session materializer', async () => {
  const runtimeEnv = Object.freeze({
    APP_DATA_DIR: 'D:\\runtime-data',
    APP_DB_PATH: 'D:\\runtime-data\\app.db',
  })
  const cwd = 'D:\\runtime-root'
  const starts = []
  const runtime = createLifecycleRuntime({
    silent: true,
    adapters: {
      ...createNoopLifecycleAdapters(),
      startSessionContentMaterializerRuntime: (options) => { starts.push(options) },
    },
    turnPersistenceAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
    subagentRunPersistenceAdapter: TEST_SUBAGENT_RUN_PERSISTENCE_PORT,
    runtimeEnv,
    cwd,
  })

  await runtime.start().ready
  assert.equal(starts.length, 1)
  assert.strictEqual(starts[0].env, runtimeEnv)
  assert.equal(starts[0].cwd, cwd)
  assert.equal((await runtime.stop()).exitCode, 0)
})

test('default graceful shutdown budget covers HTTP drain and every serial stop timeout', () => {
  const capabilities = [
    { hasStop: true, stopTimeoutMs: 90_000 },
    { hasStop: true, stopTimeoutMs: 120_000 },
    { hasStop: false, stopTimeoutMs: 600_000 },
  ]

  assert.equal(resolveLifecycleShutdownTimeoutMs({ capabilities }), 225_000)
  assert.equal(resolveLifecycleShutdownTimeoutMs({ capabilities: [] }), 15_000)
  assert.equal(resolveLifecycleShutdownTimeoutMs({ timeoutMs: 2_500, capabilities }), 2_500)
  assert.equal(resolveLifecycleShutdownTimeoutMs({
    capabilities: Array.from({ length: 6 }, () => ({
      hasStop: true,
      stopTimeoutMs: 120_000,
    })),
  }), 600_000)
  assert.throws(
    () => resolveLifecycleShutdownTimeoutMs({ timeoutMs: 0, capabilities }),
    /between 1 and 600000/,
  )
  assert.throws(
    () => resolveLifecycleShutdownTimeoutMs({ timeoutMs: 600_001, capabilities }),
    /between 1 and 600000/,
  )
  assert.throws(
    () => resolveLifecycleShutdownTimeoutMs({ timeoutMs: 1.5, capabilities }),
    /between 1 and 600000/,
  )
})

test('pre-bootstrap inspection does not consume custom default runtime options', async () => {
  const events = []
  const noop = () => {}
  const adapters = {
    closeDb: noop,
    recoverPendingSessionDeletion: noop,
    startSessionContentMaterializerRuntime: noop,
    closeSessionContentMaterializerRuntime: noop,
    shutdownMcpAll: noop,
    shutdownBrowsers: noop,
    warnShellTrust: noop,
    registerBrowserTools: noop,
    registerConnectorTools: noop,
    seedSystemSkills: noop,
    initializeRuntimePluginConfig: noop,
    initPlugins: noop,
    restoreEnabledRuntimePlugins: () => [],
    initCodexPluginSkills: noop,
    setVisionAssistResolver: noop,
    getEnabledIntegrationCredentials: () => null,
    listEnabledIntegrationCredentials: () => [],
    startSocialIntegration: noop,
    stopSocialBridges: noop,
    shutdownRuntimePlugins: noop,
    closeShellSessions: noop,
    closeJobRuntime: noop,
    startEvolutionOperationSweeperRuntime: noop,
    closeEvolutionOperationSweeperRuntime: noop,
    startEvolutionOnlineGraderRuntime: noop,
    closeEvolutionOnlineGraderRuntime: noop,
    closeTurnEngine: noop,
    startTurnRecoveryRuntime: noop,
    closeTurnRecoveryRuntime: noop,
    closeCronScheduler: noop,
    recoverInterruptedSubagentRuns: noop,
    warn: noop,
  }

  assert.ok(listLifecycleCapabilities().length > 0)
  assert.deepEqual(listLifecycleAuditEvents(), [])
  bootstrap({
    silent: true,
    adapters,
    turnPersistenceAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
    subagentRunPersistenceAdapter: TEST_SUBAGENT_RUN_PERSISTENCE_PORT,
    capabilities: [{
      id: 'test.custom-startup',
      owner: 'test',
      priority: 1,
      start: () => { events.push('custom:start') },
      stop: () => { events.push('custom:stop') },
    }],
  })

  assert.ok(listLifecycleCapabilities().some((entry) => entry.id === 'test.custom-startup'))
  assert.deepEqual(events, ['custom:start'])
  assert.ok(listLifecycleAuditEvents().some((entry) => (
    entry.event === 'lifecycle_capability.registered'
    && entry.capabilityId === 'test.custom-startup'
  )))
  assert.equal(await gracefulShutdown(null, { silent: true, exit: false }), 0)
  assert.deepEqual(events, ['custom:start', 'custom:stop'])
})

test('shutdown before bootstrap uses an inert graph without activating host adapters', async () => {
  assert.equal(getToolLoopAdapterStatus().configured, false)
  assert.equal(getTurnPersistenceAdapterStatus().configured, false)

  assert.equal(await gracefulShutdown(null, { silent: true, exit: false }), 0)

  assert.equal(getToolLoopAdapterStatus().configured, false)
  assert.equal(getTurnPersistenceAdapterStatus().configured, false)
})
