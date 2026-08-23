import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { SQLITE_TURN_PERSISTENCE_ADAPTER } from '../server/adapters/sqliteTurnPersistenceAdapter.js'
import {
  SUBAGENT_RUN_PERSISTENCE_PORT_CONTRACT_VERSION,
} from '../server/core/subagentRunPersistencePort.js'
import { createLifecycleRuntime } from '../server/core/lifecycle.js'
import {
  listEffectiveRuntimeCapabilityBindings,
  prepareRuntimeCapabilitySnapshot,
  selectedToolLoopAdapter,
} from '../server/core/runtimeCapabilityHost.js'
import {
  TOOL_LOOP_ADAPTER_BROKER_VERSION,
  TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
  TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3,
} from '../server/core/toolLoopAdapter.js'
import {
  getRuntimePlugin,
  registerPlugin,
  unregisterPlugin,
} from '../server/plugins/pluginRegistry.js'
import { runToolsLoop } from '../server/services/loop/index.js'

const BUILTIN_LOOP_ID = 'builtin.agent-loop'

function createMemorySubagentRunPersistenceAdapter() {
  const runs = new Map()
  const key = ({ userId, id }) => `${userId}\u0000${id}`
  const getRun = (input) => runs.get(key(input)) || null

  return Object.freeze({
    id: 'test.memory-subagent-runs',
    apiVersion: SUBAGENT_RUN_PERSISTENCE_PORT_CONTRACT_VERSION,
    createRun(input) {
      const run = {
        ...input,
        status: 'running',
        resultText: '',
        tokensIn: null,
        tokensOut: null,
        finishedAt: null,
      }
      runs.set(key(input), run)
      return run
    },
    getRun,
    markRunning(input) {
      const current = getRun(input)
      if (!current) throw new Error('subagent run not found')
      const run = { ...current, status: 'running', trace: input.trace, finishedAt: null }
      runs.set(key(input), run)
      return run
    },
    saveRunningTrace(input) {
      const current = getRun(input)
      if (!current || current.status !== 'running') {
        throw new Error('subagent run is not running')
      }
      const run = { ...current, trace: input.trace }
      runs.set(key(input), run)
      return run
    },
    finishRun(input) {
      const current = getRun(input)
      if (!current) return null
      const run = {
        ...current,
        status: input.status,
        resultText: input.resultText,
        trace: input.trace,
        finishedAt: input.finishedAt,
      }
      runs.set(key(input), run)
      return run
    },
    listRunningRuns() {
      return [...runs.values()].filter((run) => run.status === 'running')
    },
    interruptRunningRun(input) {
      const current = getRun(input)
      if (!current || current.status !== 'running') {
        return { userId: input.userId, id: input.id, interrupted: false }
      }
      runs.set(key(input), {
        ...current,
        status: input.status,
        resultText: input.resultText,
        trace: input.trace,
        finishedAt: input.finishedAt,
      })
      return { userId: input.userId, id: input.id, interrupted: true }
    },
  })
}

function manifest(id, loopId) {
  return {
    id,
    name: id,
    version: '1.2.3',
    integrity: `sha256-${'d'.repeat(64)}`,
    contributes: [`loop:${loopId}`],
  }
}

function loopBinding() {
  return listEffectiveRuntimeCapabilityBindings()
    .find((entry) => entry.binding === 'loop:loop') || null
}

function noopLifecycleAdapters() {
  const noop = () => {}
  return {
    closeDb: noop,
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
    configureSubagentModelBindingResolver: () => noop,
    resolveSubagentModelBinding: noop,
    warn: noop,
  }
}

test.beforeEach(async () => {
  await prepareRuntimeCapabilitySnapshot({
    env: {
      APP_DATA_DIR: 'Z:\\gugo-runtime-plugin-loop-missing',
      GUGO_LOAD_DOTENV: '0',
    },
  })
})

test('plugin Loop is selected before lifecycle activation and reaches the shared production entry safely', async () => {
  const pluginId = 'bound-loop-plugin'
  const loopId = `plugin.${pluginId}.loop`
  let healthChecks = 0
  let receivedContext = null
  await registerPlugin(manifest(pluginId, loopId), (context) => {
    context.loops.register({
      id: loopId,
      contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
      async run(loopContext) {
        receivedContext = loopContext
        const denied = await loopContext.tools.execute({
          name: 'write_file',
          args: { path: 'forged.txt', content: 'forged' },
        })
        return {
          text: denied.code,
          artifactIds: ['forged-artifact'],
          deliveryArtifactIds: ['forged-artifact'],
          paused: true,
        }
      },
    }, {
      replaces: BUILTIN_LOOP_ID,
      priority: 100,
      revision: 7,
      healthCheck: async () => {
        healthChecks += 1
        return { ok: true }
      },
    })
  })

  const snapshot = await prepareRuntimeCapabilitySnapshot({
    env: {
      APP_DATA_DIR: 'Z:\\gugo-runtime-plugin-loop-missing',
      GUGO_LOAD_DOTENV: '0',
    },
  })
  const selected = loopBinding()
  assert.equal(selected?.id, loopId)
  assert.equal(selected?.owner, pluginId)
  assert.equal(selected?.version, '1.2.3')
  assert.equal(selected?.revision, 7)
  assert.equal(selected?.releaseDigest, `sha256-${'d'.repeat(64)}`)
  assert.equal(selected?.replaces, BUILTIN_LOOP_ID)
  assert.equal(healthChecks, 1)

  const runtime = createLifecycleRuntime({
    silent: true,
    adapters: noopLifecycleAdapters(),
    turnPersistenceAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
    subagentRunPersistenceAdapter: createMemorySubagentRunPersistenceAdapter(),
    toolLoopAdapter: selectedToolLoopAdapter(snapshot),
  })
  await runtime.start().ready
  try {
    const challengerId = 'challenger-loop-plugin'
    const challengerLoopId = `plugin.${challengerId}.loop`
    await assert.rejects(
      registerPlugin(manifest(challengerId, challengerLoopId), (context) => {
        context.loops.register({
          id: challengerLoopId,
          contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
          run: async () => ({ text: 'must never become active' }),
        }, {
          replaces: BUILTIN_LOOP_ID,
          priority: 200,
        })
      }),
      (error) => error?.code === 'PLUGIN_LOOP_CAPABILITY_IN_USE',
    )
    assert.equal(getRuntimePlugin(challengerId), null)
    assert.equal(loopBinding()?.id, loopId)

    const result = await runToolsLoop({
      messages: [],
      executeTool: async () => ({ ok: true, forged: true }),
      runModel: async () => ({ content: 'forged model' }),
    })
    assert.deepEqual(result, {
      text: 'tool_execution_broker_required',
      artifactIds: [],
      deliveryArtifactIds: [],
      iterations: 0,
    })
    assert.ok(receivedContext)
    assert.equal(receivedContext.checkpoint.save, undefined)
    assert.equal(receivedContext.approvals.request, undefined)
    assert.equal(receivedContext.model.onDelta, undefined)

    await assert.rejects(
      unregisterPlugin(pluginId),
      (error) => error?.code === 'PLUGIN_LOOP_CAPABILITY_IN_USE',
    )
    assert.equal(getRuntimePlugin(pluginId)?.state, 'active')
  } finally {
    await runtime.stop()
  }

  assert.equal(await unregisterPlugin(pluginId), true)
  assert.equal(loopBinding()?.id, BUILTIN_LOOP_ID)
})

test('v3 Loop broker declaration survives plugin wrapping without exposing raw host authority', async () => {
  const pluginId = 'broker-v3-loop-plugin'
  const loopId = `plugin.${pluginId}.loop`
  let receivedDenials = null
  let hostModelCalls = 0
  let hostToolExecutions = 0
  let runtime = null

  try {
    await registerPlugin(manifest(pluginId, loopId), (context) => {
      context.loops.register({
        id: loopId,
        contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3,
        hostCapabilities: { loopBroker: TOOL_LOOP_ADAPTER_BROKER_VERSION },
        async run(loopContext) {
          let modelCode = null
          try {
            await loopContext.model.run({ messages: [] })
          } catch (error) {
            modelCode = error?.code || null
          }
          const toolResult = await loopContext.tools.execute({
            name: 'write_file',
            args: { path: 'forged.txt', content: 'forged' },
          })
          const brokerResult = await loopContext.harness.model.request({})
          receivedDenials = { modelCode, toolCode: toolResult.code }
          return { text: `${modelCode}:${toolResult.code}:${brokerResult.content}` }
        },
      }, {
        replaces: BUILTIN_LOOP_ID,
        priority: 100,
      })
    })

    const snapshot = await prepareRuntimeCapabilitySnapshot({
      env: {
        APP_DATA_DIR: 'Z:\\gugo-runtime-plugin-loop-missing',
        GUGO_LOAD_DOTENV: '0',
      },
    })
    const selected = selectedToolLoopAdapter(snapshot)
    assert.equal(selected.contractVersion, TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3)
    assert.deepEqual(selected.hostCapabilities, {
      loopBroker: TOOL_LOOP_ADAPTER_BROKER_VERSION,
    })
    assert.equal(Object.isFrozen(selected.hostCapabilities), true)

    runtime = createLifecycleRuntime({
      silent: true,
      adapters: noopLifecycleAdapters(),
      turnPersistenceAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
      subagentRunPersistenceAdapter: createMemorySubagentRunPersistenceAdapter(),
      toolLoopAdapter: selected,
    })
    await runtime.start().ready
    const result = await runToolsLoop({
      messages: [],
      runModel: async () => {
        hostModelCalls += 1
        return { content: 'canonical broker response', toolCalls: [] }
      },
      executeTool: async () => {
        hostToolExecutions += 1
        return { ok: true }
      },
    })

    assert.deepEqual(receivedDenials, {
      modelCode: 'model_execution_broker_required',
      toolCode: 'tool_execution_broker_required',
    })
    assert.equal(
      result.text,
      'model_execution_broker_required:tool_execution_broker_required:canonical broker response',
    )
    assert.equal(hostModelCalls, 1)
    assert.equal(hostToolExecutions, 0)
  } finally {
    if (runtime) await runtime.stop()
    if (getRuntimePlugin(pluginId)) await unregisterPlugin(pluginId)
  }
  assert.equal(loopBinding()?.id, BUILTIN_LOOP_ID)
})

test('v2 Loop declarations cannot retain or acquire the broker capability', async () => {
  const pluginId = 'broker-v2-spoof-loop-plugin'
  const loopId = `plugin.${pluginId}.loop`
  let receivedDenials = null
  let hostModelCalls = 0
  let hostToolExecutions = 0
  let runtime = null

  try {
    await registerPlugin(manifest(pluginId, loopId), (context) => {
      context.loops.register({
        id: loopId,
        contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
        hostCapabilities: { loopBroker: TOOL_LOOP_ADAPTER_BROKER_VERSION },
        async run(loopContext) {
          let modelCode = null
          try {
            await loopContext.model.run({ messages: [] })
          } catch (error) {
            modelCode = error?.code || null
          }
          const toolResult = await loopContext.tools.execute({
            name: 'write_file',
            args: { path: 'forged.txt', content: 'forged' },
          })
          receivedDenials = { modelCode, toolCode: toolResult.code }
          return { text: `${modelCode}:${toolResult.code}` }
        },
      }, {
        replaces: BUILTIN_LOOP_ID,
        priority: 100,
      })
    })

    const snapshot = await prepareRuntimeCapabilitySnapshot({
      env: {
        APP_DATA_DIR: 'Z:\\gugo-runtime-plugin-loop-missing',
        GUGO_LOAD_DOTENV: '0',
      },
    })
    const selected = selectedToolLoopAdapter(snapshot)
    assert.equal(selected.contractVersion, TOOL_LOOP_ADAPTER_CONTRACT_VERSION)
    assert.equal(Object.hasOwn(selected, 'hostCapabilities'), false)

    runtime = createLifecycleRuntime({
      silent: true,
      adapters: noopLifecycleAdapters(),
      turnPersistenceAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
      subagentRunPersistenceAdapter: createMemorySubagentRunPersistenceAdapter(),
      toolLoopAdapter: selected,
    })
    await runtime.start().ready
    const result = await runToolsLoop({
      messages: [],
      runModel: async () => {
        hostModelCalls += 1
        return { content: 'must not be reached' }
      },
      executeTool: async () => {
        hostToolExecutions += 1
        return { ok: true }
      },
    })

    assert.deepEqual(receivedDenials, {
      modelCode: 'model_execution_broker_required',
      toolCode: 'tool_execution_broker_required',
    })
    assert.equal(result.text, 'model_execution_broker_required:tool_execution_broker_required')
    assert.equal(hostModelCalls, 0)
    assert.equal(hostToolExecutions, 0)
  } finally {
    if (runtime) await runtime.stop()
    if (getRuntimePlugin(pluginId)) await unregisterPlugin(pluginId)
  }
  assert.equal(loopBinding()?.id, BUILTIN_LOOP_ID)
})

test('Loop setup failure and invalid replacement declarations leave the builtin binding authoritative', async () => {
  const pluginId = 'rollback-loop-plugin'
  const loopId = `plugin.${pluginId}.loop`
  await assert.rejects(
    registerPlugin(manifest(pluginId, loopId), (context) => {
      context.loops.register({
        id: loopId,
        contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
        run: async () => ({ text: 'must not remain visible' }),
      }, { replaces: BUILTIN_LOOP_ID, priority: 100 })
      throw Object.assign(new Error('fixture setup failed'), { code: 'FIXTURE_SETUP_FAILED' })
    }),
    (error) => error?.code === 'FIXTURE_SETUP_FAILED',
  )
  assert.equal(getRuntimePlugin(pluginId), null)
  assert.equal(loopBinding()?.id, BUILTIN_LOOP_ID)

  await assert.rejects(
    registerPlugin(manifest('implicit-loop-plugin', 'plugin.implicit-loop-plugin.loop'), (context) => {
      context.loops.register({
        id: 'plugin.implicit-loop-plugin.loop',
        contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
        run: async () => ({ text: 'unreachable' }),
      }, { priority: 100 })
    }),
    (error) => error?.code === 'PLUGIN_LOOP_REPLACEMENT_REQUIRED',
  )
  assert.equal(loopBinding()?.id, BUILTIN_LOOP_ID)
})

test('app server restores runtime plugins before resolving and activating the Loop snapshot', () => {
  const source = fs.readFileSync(new URL('../server/appServer.js', import.meta.url), 'utf8')
  const restoreIndex = source.indexOf('restoreEnabledRuntimePlugins({ env: runtimeEnv })')
  const snapshotIndex = source.indexOf('prepareRuntimeCapabilitySnapshot({ env: runtimeEnv, cwd })')
  const bootstrapIndex = source.indexOf('const startup = bootstrap({')
  assert.ok(restoreIndex >= 0)
  assert.ok(snapshotIndex > restoreIndex)
  assert.ok(bootstrapIndex > snapshotIndex)
})
