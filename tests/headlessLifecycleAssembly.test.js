import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createHeadlessLifecycleCapabilities,
  HEADLESS_LIFECYCLE_CAPABILITY_IDS,
} from '../server/core/headlessLifecycleAssembly.js'
import {
  createLifecycleCapabilityGraph,
  createLifecycleCapabilityRegistry,
} from '../server/core/lifecycleCapabilityGraph.js'

test('headless lifecycle starts only local durability/plugin services and stops in reverse order', async () => {
  const events = []
  const runtimeEnv = Object.freeze({ APP_DATA_DIR: 'headless-data', MARKER: 'exact' })
  const cwd = 'headless-runtime-root'
  const adapters = {
    closeDb: () => { events.push('stop:database') },
    recoverPendingSessionDeletion: () => { events.push('start:session-deletion-recovery') },
    startSessionContentMaterializerRuntime: (options) => {
      assert.strictEqual(options.env, runtimeEnv)
      assert.equal(options.cwd, cwd)
      events.push('start:materializer')
    },
    closeSessionContentMaterializerRuntime: () => { events.push('stop:materializer') },
    seedSystemSkills: (options) => {
      assert.deepEqual(options, { silent: true })
      events.push('start:skills')
    },
    initializeRuntimePluginConfig: (options) => {
      assert.strictEqual(options.env, runtimeEnv)
      assert.equal(options.cwd, cwd)
      events.push('start:plugin-config')
    },
    initPlugins: (options) => {
      assert.equal(options.rootDir, 'headless-plugin-root')
      assert.equal(options.silent, true)
      assert.equal(options.includeManaged, true)
      assert.equal(options.cwd, cwd)
      assert.strictEqual(options.env, runtimeEnv)
      events.push('start:plugin-discovery')
    },
    restoreEnabledRuntimePlugins: (options) => {
      assert.strictEqual(options.env, runtimeEnv)
      events.push('start:runtime-plugins')
      return [{ ok: true, pluginId: 'test-plugin' }]
    },
    shutdownRuntimePlugins: () => { events.push('stop:runtime-plugins') },
    startLspRuntime: (options) => {
      assert.strictEqual(options.env, runtimeEnv)
      events.push('start:lsp')
    },
    closeLspRuntime: () => { events.push('stop:lsp') },
    closeTurnEngine: () => { events.push('stop:turn-engine') },
    warn: (message) => { events.push(`warn:${message}`) },
  }
  const compactionArchiveController = {
    activate: () => { events.push('start:compaction-archive') },
    release: () => { events.push('stop:compaction-archive') },
  }
  const managedAttachmentRuntimeController = {
    activate: () => { events.push('start:managed-attachments') },
    release: () => { events.push('stop:managed-attachments') },
  }
  const definitions = createHeadlessLifecycleCapabilities({
    adapters,
    managedAttachmentRuntimeController,
    compactionArchiveController,
    cwd,
    pluginRoot: 'headless-plugin-root',
    runtimeEnv,
    silent: true,
  })
  const registry = createLifecycleCapabilityRegistry()
  registry.registerAll(definitions)
  const graph = createLifecycleCapabilityGraph({ registry })

  const started = await graph.startAll().ready
  assert.equal(started.failures.length, 0)
  assert.deepEqual(events, [
    'start:managed-attachments',
    'start:compaction-archive',
    'start:session-deletion-recovery',
    'start:materializer',
    'start:skills',
    'start:plugin-config',
    'start:plugin-discovery',
    'start:runtime-plugins',
    'start:lsp',
  ])

  const stopped = await graph.stopAll()
  assert.equal(stopped.exitCode, 0)
  assert.deepEqual(events.slice(-7), [
    'stop:turn-engine',
    'stop:lsp',
    'stop:runtime-plugins',
    'stop:materializer',
    'stop:compaction-archive',
    'stop:managed-attachments',
    'stop:database',
  ])
  assert.deepEqual(
    new Set(definitions.map((entry) => entry.id)),
    new Set(Object.values(HEADLESS_LIFECYCLE_CAPABILITY_IDS)),
  )
  assert.equal(definitions.some((entry) => /cron|social|browser|evolution|job/u.test(entry.id)), false)
})

test('headless runtime plugin restore remains fail-soft per plugin but lifecycle-audited', async () => {
  const warnings = []
  const definitions = createHeadlessLifecycleCapabilities({
    managedAttachmentRuntimeController: {
      activate: () => {},
      release: () => {},
    },
    compactionArchiveController: {
      activate: () => {},
      release: () => {},
    },
    adapters: {
      closeDb: () => {},
      recoverPendingSessionDeletion: () => {},
      startSessionContentMaterializerRuntime: () => {},
      closeSessionContentMaterializerRuntime: () => {},
      seedSystemSkills: () => {},
      initializeRuntimePluginConfig: () => {},
      initPlugins: () => {},
      restoreEnabledRuntimePlugins: () => [{
        ok: false,
        pluginId: 'broken-plugin',
        error: 'health check failed',
      }],
      shutdownRuntimePlugins: () => {},
      startLspRuntime: () => {},
      closeLspRuntime: () => {},
      closeTurnEngine: () => {},
      warn: (message) => warnings.push(message),
    },
  })
  const registry = createLifecycleCapabilityRegistry()
  registry.registerAll(definitions)
  const graph = createLifecycleCapabilityGraph({ registry })

  const started = await graph.startAll().ready
  assert.equal(started.failures.length, 0)
  assert.deepEqual(warnings, [
    '[plugins] runtime restore failed for broken-plugin: health check failed',
  ])
  assert.equal((await graph.stopAll()).exitCode, 0)
})

test('headless lifecycle fails closed before materialization when session deletion recovery fails', async () => {
  const events = []
  const definitions = createHeadlessLifecycleCapabilities({
    managedAttachmentRuntimeController: {
      activate: () => { events.push('start:managed-attachments') },
      release: () => { events.push('stop:managed-attachments') },
    },
    compactionArchiveController: {
      activate: () => { events.push('start:compaction-archive') },
      release: () => { events.push('stop:compaction-archive') },
    },
    adapters: {
      closeDb: () => { events.push('stop:database') },
      recoverPendingSessionDeletion: () => {
        events.push('start:session-deletion-recovery')
        throw new Error('pending deletion evidence conflict')
      },
      startSessionContentMaterializerRuntime: () => { events.push('start:materializer') },
      closeSessionContentMaterializerRuntime: () => { events.push('stop:materializer') },
      seedSystemSkills: () => { events.push('start:skills') },
      initializeRuntimePluginConfig: () => { events.push('start:plugin-config') },
      initPlugins: () => { events.push('start:plugin-discovery') },
      restoreEnabledRuntimePlugins: () => [],
      shutdownRuntimePlugins: () => { events.push('stop:runtime-plugins') },
      startLspRuntime: () => { events.push('start:lsp') },
      closeLspRuntime: () => { events.push('stop:lsp') },
      closeTurnEngine: () => { events.push('stop:turn-engine') },
      warn: () => {},
    },
  })
  const registry = createLifecycleCapabilityRegistry()
  registry.registerAll(definitions)
  const graph = createLifecycleCapabilityGraph({ registry })

  const started = await graph.startAll().ready
  assert.equal(started.failures.length, 1)
  assert.equal(
    started.failures[0].capability.id,
    HEADLESS_LIFECYCLE_CAPABILITY_IDS.sessionDeletionRecovery,
  )
  assert.equal(started.failures[0].capability.startFailure, 'fail')
  assert.deepEqual(events, [
    'start:managed-attachments',
    'start:compaction-archive',
    'start:session-deletion-recovery',
  ])

  const stopped = await graph.stopAll()
  assert.equal(stopped.exitCode, 0)
  assert.deepEqual(events.slice(-3), [
    'stop:compaction-archive',
    'stop:managed-attachments',
    'stop:database',
  ])
})
