import assert from 'node:assert/strict'
import test from 'node:test'

import {
  _resetRuntimePluginsForTests,
  getPluginService,
  registerPlugin,
  unregisterPlugin,
} from '../server/plugins/pluginRegistry.js'
import { createRuntimePluginRegistry } from '../server/plugins/runtimePluginRegistry.js'
import { createLoopEvents } from '../server/services/loop/events.js'
import { executeServerTool } from '../server/services/loop/heuristics/toolExecutor.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { classifyToolRisk } from '../server/utils/approvalPolicy.js'
import {
  getDynamicTool,
  registerDynamicTool,
  unregisterDynamicTool,
} from '../server/utils/toolSchemaCatalog.js'

const TOOL_SPEC = {
  type: 'function',
  function: {
    name: 'plugin_echo',
    description: 'Echo a value from a runtime plugin.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
}

const TEST_CONTRIBUTIONS = Object.freeze([
  'tool:plugin_echo',
  'tool:plugin_failed',
  'tool:plugin_restore',
  'tool:plugin_mutable_probe',
  'tool:plugin_cyclic_probe',
  'tool:plugin_registration_shadow_race',
  'tool:plugin_registration_restore_race',
  'tool:reflect',
  'tool:connected_app_list',
  'tool:mcp__example__read',
  'tool:browser_plugin_probe',
  'event:request',
  'event:pre-step',
  'prompt:lifecycle-context',
  'service:echo',
  'service:base-service',
  'service:immutable-base-service',
  'service:shutdown-installing-service',
  'service:async-base-service',
  'service:cleanup-base-service',
  'service:rollback-base-service',
  'service:loop-marker',
  'service:atomic-service',
])

function manifest(id, overrides = {}) {
  return {
    id,
    name: id,
    version: '1.0.0',
    contributes: TEST_CONTRIBUTIONS,
    ...overrides,
  }
}

function settleWithin(promise, timeoutMs = 1_000) {
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('plugin lifecycle operation timed out')), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId))
}

test.afterEach(async () => {
  await _resetRuntimePluginsForTests()
  for (const name of ['plugin_echo', 'plugin_restore', 'plugin_failed']) {
    unregisterDynamicTool(name)
  }
})

test('runtime plugin installs real tool, event, and service contributions and reverses every effect', async () => {
  const registry = createRuntimePluginRegistry()
  const events = createLoopEvents()
  const cleanupOrder = []
  const unbind = registry.bindLoopEvents(events, { turnId: 'turn-plugin-lifecycle' })

  const installed = await registry.registerPlugin(
    manifest('lifecycle-plugin', {
      contributes: [
        'tool:plugin_echo',
        'event:request',
        'prompt:lifecycle-context',
        'service:echo',
      ],
    }),
    (ctx) => {
      ctx.lifecycle.onDispose(() => cleanupOrder.push('first'))
      ctx.tools.register({
        name: 'plugin_echo',
        spec: TOOL_SPEC,
        exec: async ({ value }) => ({ ok: true, value }),
      })
      ctx.events.on('request', (request) => ({ ...request, lifecyclePlugin: true }))
      ctx.prompts.register({
        id: 'lifecycle-context',
        render(scope) {
          assert.deepEqual(Object.keys(scope), ['userId', 'sessionId', 'agentId', 'skillIds'])
          assert.equal(Object.isFrozen(scope), true)
          assert.equal(Object.isFrozen(scope.skillIds), true)
          return `Scoped to ${scope.sessionId}`
        },
      })
      ctx.services.provide('echo', { source: ctx.plugin.id })
      ctx.lifecycle.onDispose(() => cleanupOrder.push('second'))
      return () => cleanupOrder.push('returned')
    },
  )

  assert.equal(installed.state, 'active')
  assert.equal(getDynamicTool('plugin_echo')?.source, 'lifecycle-plugin')
  assert.deepEqual(registry.getService('echo'), { source: 'lifecycle-plugin' })
  assert.deepEqual(
    await events.waterfall('request', { model: 'test' }, {}),
    { model: 'test', lifecyclePlugin: true },
  )
  assert.deepEqual(registry.renderPromptBlocks({
    userId: 'prompt-user',
    sessionId: 'prompt-session',
    agentId: 'prompt-agent',
    skillIds: ['skill-b', 'skill-a', 'skill-a'],
    query: 'must not cross the prompt plugin boundary',
  }), {
    blocks: [{
      id: 'lifecycle-context',
      pluginId: 'lifecycle-plugin',
      text: 'Scoped to prompt-session',
    }],
    errors: [],
  })

  assert.equal(await registry.unregisterPlugin('lifecycle-plugin'), true)
  assert.equal(await registry.unregisterPlugin('lifecycle-plugin'), false)
  assert.equal(getDynamicTool('plugin_echo'), null)
  assert.equal(registry.getService('echo'), undefined)
  assert.deepEqual(registry.renderPromptBlocks({ sessionId: 'after-unload' }), { blocks: [], errors: [] })
  assert.deepEqual(await events.waterfall('request', { model: 'test' }, {}), { model: 'test' })
  assert.deepEqual(cleanupOrder, ['returned', 'second', 'first'])
  assert.equal(unbind(), true)
  assert.equal(unbind(), false)
})

test('host service invocation tracks in-flight callbacks across atomic unload', async () => {
  const registry = createRuntimePluginRegistry()
  let releaseReview
  let reviewStarted
  const started = new Promise((resolve) => { reviewStarted = resolve })
  await registry.registerPlugin(manifest('service-invocation-plugin', {
    contributes: ['service:review-guard'],
  }), (ctx) => {
    ctx.services.provide('review-guard', {
      async review(scope) {
        reviewStarted()
        await new Promise((resolve) => { releaseReview = resolve })
        return { accepted: scope.id }
      },
    })
  })

  const invocation = registry.invokeService('review-guard', 'review', [{ id: 'review-1' }])
  await started
  const unloading = registry.unregisterPlugin('service-invocation-plugin')
  assert.equal(registry.getService('review-guard'), undefined)
  assert.deepEqual(await registry.invokeService('review-guard', 'review', []), {
    found: false,
    pluginId: null,
    value: undefined,
  })
  let unloaded = false
  unloading.then(() => { unloaded = true })
  await Promise.resolve()
  assert.equal(unloaded, false)

  releaseReview()
  assert.deepEqual(await invocation, {
    found: true,
    pluginId: 'service-invocation-plugin',
    value: { accepted: 'review-1' },
  })
  assert.equal(await settleWithin(unloading), true)
})

test('setup failure rolls back active event and tool side effects before rejecting install', async () => {
  const registry = createRuntimePluginRegistry()
  const events = createLoopEvents()
  const observed = []
  const unbind = registry.bindLoopEvents(events)

  await assert.rejects(registry.registerPlugin(manifest('failed-plugin'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_failed',
      spec: { ...TOOL_SPEC, function: { ...TOOL_SPEC.function, name: 'plugin_failed' } },
      exec: async () => ({ ok: true }),
    })
    ctx.events.on('pre-step', (state) => {
      observed.push('called')
      return state
    })
    ctx.lifecycle.onDispose(() => observed.push('rolled-back'))
    throw new Error('setup exploded')
  }), /setup exploded/)

  assert.equal(registry.getPlugin('failed-plugin'), null)
  assert.equal(getDynamicTool('plugin_failed'), null)
  await events.waterfall('pre-step', {}, {})
  assert.deepEqual(observed, ['rolled-back'])
  unbind()
})

test('undeclared runtime contributions fail closed before producing side effects', async () => {
  const cases = [
    {
      id: 'undeclared-tool-plugin',
      declaration: 'tool:plugin_echo',
      setup: (ctx) => ctx.tools.register({
        name: 'plugin_echo',
        spec: TOOL_SPEC,
        exec: async () => ({ ok: true }),
      }),
    },
    {
      id: 'undeclared-event-plugin',
      declaration: 'event:request',
      setup: (ctx) => ctx.events.on('request', (request) => request),
    },
    {
      id: 'undeclared-service-plugin',
      declaration: 'service:undeclared-service',
      setup: (ctx) => ctx.services.provide('undeclared-service', true),
    },
    {
      id: 'undeclared-provider-plugin',
      declaration: 'model-provider:undeclared-provider',
      setup: (ctx) => ctx.models.providers.register('undeclared-provider', {}),
    },
    {
      id: 'undeclared-prompt-plugin',
      declaration: 'prompt:undeclared-context',
      setup: (ctx) => ctx.prompts.register({
        id: 'undeclared-context',
        render: () => 'must not be registered',
      }),
    },
  ]

  for (const item of cases) {
    const registry = createRuntimePluginRegistry()
    await assert.rejects(
      registry.registerPlugin(manifest(item.id, { contributes: [] }), item.setup),
      (error) => {
        assert.equal(error?.code, 'PLUGIN_CONTRIBUTION_UNDECLARED')
        assert.equal(error?.retryable, false)
        assert.match(error?.message || '', new RegExp(item.declaration))
        return true
      },
    )
    assert.equal(registry.getPlugin(item.id), null)
    assert.deepEqual(registry.listPlugins(), [])
  }
  assert.equal(getDynamicTool('plugin_echo'), null)
})

test('runtime prompt contributions are bounded, synchronous, deterministic, and fail open', async () => {
  const audit = []
  const registry = createRuntimePluginRegistry({ audit: (event) => audit.push(event) })
  const definitions = [
    ['first-context', () => 'first'],
    ['invalid-context', () => ({ text: 'not accepted' })],
    ['oversized-context', () => 'x'.repeat((16 * 1024) + 1)],
    ['async-context', async () => 'not accepted'],
    ['second-context', () => 'second'],
  ]
  await registry.registerPlugin(manifest('prompt-bounds-plugin', {
    contributes: definitions.map(([id]) => `prompt:${id}`),
  }), (ctx) => {
    for (const [id, render] of definitions) ctx.prompts.register({ id, render })
  })

  const rendered = registry.renderPromptBlocks({
    userId: 'bounded-user',
    sessionId: 'bounded-session',
    skillIds: Array.from({ length: 40 }, (_, index) => `skill-${index}`),
  })
  assert.deepEqual(rendered.blocks.map(({ id, text }) => [id, text]), [
    ['first-context', 'first'],
    ['second-context', 'second'],
  ])
  assert.deepEqual(rendered.errors.map(({ id, code }) => [id, code]), [
    ['invalid-context', 'PLUGIN_PROMPT_RESULT_INVALID'],
    ['oversized-context', 'PLUGIN_PROMPT_BLOCK_TOO_LARGE'],
    ['async-context', 'PLUGIN_PROMPT_ASYNC_UNSUPPORTED'],
  ])
  assert.deepEqual(
    audit.filter(({ event }) => event === 'plugin.prompt_failed').map(({ promptId, code }) => [promptId, code]),
    rendered.errors.map(({ id, code }) => [id, code]),
  )
  assert.equal(await registry.unregisterPlugin('prompt-bounds-plugin'), true)
})

test('runtime prompt contribution count and total byte budgets fail open', async () => {
  const countRegistry = createRuntimePluginRegistry()
  const countIds = Array.from({ length: 17 }, (_, index) => `count-context-${index}`)
  await countRegistry.registerPlugin(manifest('prompt-count-plugin', {
    contributes: countIds.map((id) => `prompt:${id}`),
  }), (ctx) => {
    for (const id of countIds) ctx.prompts.register({ id, render: () => id })
  })
  const countResult = countRegistry.renderPromptBlocks()
  assert.equal(countResult.blocks.length, 16)
  assert.deepEqual(countResult.errors, [{
    id: 'count-context-16',
    pluginId: 'prompt-count-plugin',
    code: 'PLUGIN_PROMPT_BLOCK_LIMIT',
  }])
  assert.equal(await countRegistry.unregisterPlugin('prompt-count-plugin'), true)

  const totalRegistry = createRuntimePluginRegistry()
  const totalIds = Array.from({ length: 5 }, (_, index) => `total-context-${index}`)
  await totalRegistry.registerPlugin(manifest('prompt-total-plugin', {
    contributes: totalIds.map((id) => `prompt:${id}`),
  }), (ctx) => {
    for (const id of totalIds) ctx.prompts.register({ id, render: () => 'x'.repeat(15 * 1024) })
  })
  const totalResult = totalRegistry.renderPromptBlocks()
  assert.equal(totalResult.blocks.length, 4)
  assert.deepEqual(totalResult.errors, [{
    id: 'total-context-4',
    pluginId: 'prompt-total-plugin',
    code: 'PLUGIN_PROMPT_TOTAL_TOO_LARGE',
  }])
  assert.equal(await totalRegistry.unregisterPlugin('prompt-total-plugin'), true)
})

test('dependency guard prevents unloading a service required by an active plugin', async () => {
  const registry = createRuntimePluginRegistry()
  await registry.registerPlugin(manifest('base-plugin'), (ctx) => {
    ctx.services.provide('base-service', { ready: true })
  })
  await registry.registerPlugin(manifest('dependent-plugin', {
    requires: ['base-plugin'],
  }), (ctx) => {
    assert.equal(ctx.services.get('base-service').ready, true)
  })

  await assert.rejects(
    registry.unregisterPlugin('base-plugin'),
    /required by active plugins: dependent-plugin/,
  )
  assert.equal(await registry.unregisterPlugin('dependent-plugin'), true)
  assert.equal(await registry.unregisterPlugin('base-plugin'), true)
})

test('plugin setup cannot mutate manifest arrays to bypass the dependency guard', async () => {
  const registry = createRuntimePluginRegistry()
  await registry.registerPlugin(manifest('immutable-base'), (ctx) => {
    ctx.services.provide('immutable-base-service', { ready: true })
  })
  await registry.registerPlugin(manifest('immutable-dependent', {
    requires: ['immutable-base'],
    contributes: ['service:immutable-dependent'],
  }), (ctx) => {
    assert.equal(Object.isFrozen(ctx.plugin.requires), true)
    assert.equal(Object.isFrozen(ctx.plugin.contributes), true)
    assert.throws(() => ctx.plugin.requires.splice(0), TypeError)
    assert.throws(() => ctx.plugin.contributes.push('tool:forged'), TypeError)
    assert.equal(ctx.services.get('immutable-base-service').ready, true)
  })

  assert.deepEqual(registry.getPlugin('immutable-dependent')?.requires, ['immutable-base'])
  await assert.rejects(
    registry.unregisterPlugin('immutable-base'),
    /required by active plugins: immutable-dependent/,
  )
  assert.equal(await registry.unregisterPlugin('immutable-dependent'), true)
  assert.equal(await registry.unregisterPlugin('immutable-base'), true)
})

test('tool disposer restores the registration shadowed by a plugin', async () => {
  const baseSpec = { ...TOOL_SPEC, function: { ...TOOL_SPEC.function, name: 'plugin_restore' } }
  const disposeBase = registerDynamicTool({
    name: 'plugin_restore',
    origin: 'test',
    source: 'base-owner',
    spec: baseSpec,
  })
  const registry = createRuntimePluginRegistry()
  await registry.registerPlugin(manifest('shadow-plugin'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_restore',
      source: 'shadow-owner',
      spec: baseSpec,
      exec: async () => ({ ok: true }),
    })
  })

  assert.equal(getDynamicTool('plugin_restore')?.source, 'shadow-plugin')
  await registry.unregisterPlugin('shadow-plugin')
  assert.equal(getDynamicTool('plugin_restore')?.source, 'base-owner')
  assert.equal(disposeBase(), true)
  assert.equal(getDynamicTool('plugin_restore'), null)
})

test('unloading an older shadowed owner cannot resurrect it after the newer owner unloads', async () => {
  const spec = { ...TOOL_SPEC, function: { ...TOOL_SPEC.function, name: 'plugin_restore' } }
  const registry = createRuntimePluginRegistry()
  await registry.registerPlugin(manifest('old-owner'), (ctx) => {
    ctx.tools.register({ name: 'plugin_restore', source: 'old-owner', spec, exec: async () => ({ ok: true }) })
  })
  await registry.registerPlugin(manifest('new-owner'), (ctx) => {
    ctx.tools.register({ name: 'plugin_restore', source: 'new-owner', spec, exec: async () => ({ ok: true }) })
  })

  assert.equal(getDynamicTool('plugin_restore')?.source, 'new-owner')
  assert.equal(await registry.unregisterPlugin('old-owner'), true)
  assert.equal(getDynamicTool('plugin_restore')?.source, 'new-owner')
  assert.equal(await registry.unregisterPlugin('new-owner'), true)
  assert.equal(getDynamicTool('plugin_restore'), null)
})

test('escaped setup context is sealed before uninstall starts', async () => {
  const registry = createRuntimePluginRegistry()
  let escapedContext
  await registry.registerPlugin(manifest('sealed-context'), (ctx) => {
    escapedContext = ctx
  })
  await registry.unregisterPlugin('sealed-context')

  assert.throws(() => escapedContext.tools.register({
    name: 'plugin_restore',
    spec: { ...TOOL_SPEC, function: { ...TOOL_SPEC.function, name: 'plugin_restore' } },
  }), /lifecycle is closed/)
  assert.throws(
    () => escapedContext.events.on('request', () => {}),
    /lifecycle is closed/,
  )
  assert.throws(
    () => escapedContext.services.provide('late-service', true),
    /lifecycle is closed/,
  )
  assert.throws(
    () => escapedContext.lifecycle.onDispose(() => {}),
    /lifecycle is closed/,
  )
  assert.equal(getDynamicTool('plugin_restore'), null)
  assert.equal(registry.getService('late-service'), undefined)
})

test('plugin tool trust metadata is host-owned and fails closed', async () => {
  const registry = createRuntimePluginRegistry()
  await registry.registerPlugin(manifest('spoofed-trust-plugin'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_restore',
      origin: 'builtin',
      source: 'trusted-core',
      metadata: {
        riskClass: 'read',
        riskLevel: 'low',
        requiresApproval: false,
        isReadOnly: true,
      },
      spec: { ...TOOL_SPEC, function: { ...TOOL_SPEC.function, name: 'plugin_restore' } },
      exec: async () => ({ ok: true }),
    })
  })

  const registered = getDynamicTool('plugin_restore')
  assert.equal(registered.origin, 'plugin')
  assert.equal(registered.source, 'spoofed-trust-plugin')
  assert.equal(registered.metadata.riskClass, 'external')
  assert.equal(registered.metadata.riskLevel, 'high')
  assert.equal(registered.metadata.requiresApproval, true)
  assert.equal(registered.metadata.isReadOnly, false)
  assert.equal(classifyToolRisk('plugin_restore', {}, {
    metadata: registered.metadata,
    mode: 'unattended',
  }).needsApproval, true)
  await registry.unregisterPlugin('spoofed-trust-plugin')
})

test('unload during async setup cancels install and waits for complete rollback', async () => {
  const registry = createRuntimePluginRegistry()
  let releaseSetup
  const setupGate = new Promise((resolve) => { releaseSetup = resolve })
  const install = registry.registerPlugin(manifest('slow-plugin'), async (ctx) => {
    ctx.tools.register({
      name: 'plugin_restore',
      spec: { ...TOOL_SPEC, function: { ...TOOL_SPEC.function, name: 'plugin_restore' } },
      exec: async () => ({ ok: true }),
    })
    await setupGate
    return () => {}
  })

  assert.equal(registry.getPlugin('slow-plugin')?.state, 'installing')
  const unload = registry.unregisterPlugin('slow-plugin')
  assert.equal(registry.getPlugin('slow-plugin')?.state, 'cancelling')
  releaseSetup()

  await assert.rejects(install, (error) => error?.code === 'PLUGIN_INSTALL_CANCELLED')
  assert.equal(await unload, true)
  assert.equal(registry.getPlugin('slow-plugin'), null)
  assert.equal(getDynamicTool('plugin_restore'), null)
  await registry.shutdown()
  assert.equal(getDynamicTool('plugin_restore'), null)
})

test('concurrent shutdown coalesces, cancels installing plugins, and fences new registration', async () => {
  const registry = createRuntimePluginRegistry()
  let releaseSetup
  let markSetupStarted
  const setupGate = new Promise((resolve) => { releaseSetup = resolve })
  const setupStarted = new Promise((resolve) => { markSetupStarted = resolve })
  let cleanupCalls = 0

  const installing = registry.registerPlugin(manifest('shutdown-installing'), async (ctx) => {
    ctx.services.provide('shutdown-installing-service', { ready: true })
    ctx.lifecycle.onDispose(() => { cleanupCalls += 1 })
    markSetupStarted()
    await setupGate
  })
  const installRejected = assert.rejects(
    installing,
    (error) => error?.code === 'PLUGIN_INSTALL_CANCELLED',
  )
  await setupStarted

  const firstShutdown = registry.shutdown()
  const duplicateShutdown = registry.shutdown()
  assert.equal(duplicateShutdown, firstShutdown)
  assert.equal(registry.getPlugin('shutdown-installing')?.state, 'cancelling')
  assert.equal(registry.getService('shutdown-installing-service'), undefined)
  await assert.rejects(
    registry.registerPlugin(manifest('shutdown-racing-install'), () => {}),
    (error) => error?.code === 'PLUGIN_REGISTRY_SHUTTING_DOWN',
  )
  assert.equal(registry.getPlugin('shutdown-racing-install'), null)

  releaseSetup()
  await installRejected
  await firstShutdown
  assert.equal(cleanupCalls, 1)
  assert.deepEqual(registry.listPlugins(), [])

  const reinstalled = await registry.registerPlugin(manifest('post-shutdown-install'), () => {})
  assert.equal(reinstalled.state, 'active')
  await registry.shutdown()
  assert.deepEqual(registry.listPlugins(), [])
})

test('installing dependent blocks base unload and revalidates the dependency before activation', async () => {
  const registry = createRuntimePluginRegistry()
  let releaseSetup
  const setupGate = new Promise((resolve) => { releaseSetup = resolve })
  await registry.registerPlugin(manifest('async-base'), (ctx) => {
    ctx.services.provide('async-base-service', { ready: true })
  })
  const dependentInstall = registry.registerPlugin(manifest('async-dependent', {
    requires: ['async-base'],
  }), async (ctx) => {
    assert.equal(ctx.services.get('async-base-service').ready, true)
    await setupGate
  })

  assert.equal(registry.getPlugin('async-dependent')?.state, 'installing')
  await assert.rejects(
    registry.unregisterPlugin('async-base'),
    /required by active plugins: async-dependent/,
  )
  releaseSetup()
  assert.equal((await dependentInstall).state, 'active')
  assert.equal(await registry.unregisterPlugin('async-dependent'), true)
  assert.equal(await registry.unregisterPlugin('async-base'), true)
})

test('dependent cleanup blocks base unload until the dependent record is removed', async () => {
  const registry = createRuntimePluginRegistry()
  let releaseCleanup
  let markCleanupStarted
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve })
  const cleanupStarted = new Promise((resolve) => { markCleanupStarted = resolve })
  let baseDisposed = false

  await registry.registerPlugin(manifest('cleanup-base'), (ctx) => {
    ctx.services.provide('cleanup-base-service', { ready: true })
    ctx.lifecycle.onDispose(() => { baseDisposed = true })
  })
  await registry.registerPlugin(manifest('cleanup-dependent', {
    requires: ['cleanup-base'],
  }), (ctx) => {
    ctx.lifecycle.onDispose(async () => {
      markCleanupStarted()
      assert.equal(ctx.services.get('cleanup-base-service').ready, true)
      await cleanupGate
      assert.equal(ctx.services.get('cleanup-base-service').ready, true)
    })
  })

  const dependentUnload = registry.unregisterPlugin('cleanup-dependent')
  await cleanupStarted
  assert.equal(registry.getPlugin('cleanup-dependent')?.state, 'uninstalling')
  await assert.rejects(
    registry.unregisterPlugin('cleanup-base'),
    /required by active plugins: cleanup-dependent/,
  )
  assert.equal(baseDisposed, false)
  releaseCleanup()
  assert.equal(await dependentUnload, true)
  assert.equal(await registry.unregisterPlugin('cleanup-base'), true)
  assert.equal(baseDisposed, true)
})

test('failed dependent rollback blocks base unload until rollback removes the record', async () => {
  const registry = createRuntimePluginRegistry()
  let releaseRollback
  let markRollbackStarted
  const rollbackGate = new Promise((resolve) => { releaseRollback = resolve })
  const rollbackStarted = new Promise((resolve) => { markRollbackStarted = resolve })

  await registry.registerPlugin(manifest('rollback-base'), (ctx) => {
    ctx.services.provide('rollback-base-service', { ready: true })
  })
  const install = registry.registerPlugin(manifest('rollback-dependent', {
    requires: ['rollback-base'],
  }), (ctx) => {
    ctx.lifecycle.onDispose(async () => {
      markRollbackStarted()
      assert.equal(ctx.services.get('rollback-base-service').ready, true)
      await rollbackGate
      assert.equal(ctx.services.get('rollback-base-service').ready, true)
    })
    throw new Error('dependent setup exploded')
  })
  const installRejected = assert.rejects(install, /dependent setup exploded/)

  await rollbackStarted
  assert.equal(registry.getPlugin('rollback-dependent')?.state, 'failed')
  await assert.rejects(
    registry.unregisterPlugin('rollback-base'),
    /required by active plugins: rollback-dependent/,
  )
  releaseRollback()
  await installRejected
  assert.equal(registry.getPlugin('rollback-dependent'), null)
  assert.equal(await registry.unregisterPlugin('rollback-base'), true)
})

test('public Agent Loop binds active runtime plugin events for each run', async () => {
  let requests = 0
  await registerPlugin(manifest('loop-request-plugin'), (ctx) => {
    ctx.events.on('request', (request) => ({ ...request, runtimePluginMarker: 'active' }))
    ctx.services.provide('loop-marker', 'active')
  })
  assert.equal(getPluginService('loop-marker'), 'active')

  const result = await runToolLoop({
    job: { id: 'plugin-loop-job', origin: 'chat', prompt: 'answer once' },
    step: { id: 'plugin-loop-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'answer once' }],
    toolSpecs: [],
    enableToolHooks: false,
    maxIters: 1,
    runModel: async (request) => {
      requests += 1
      assert.equal(request.runtimePluginMarker, 'active')
      return { content: 'plugin event observed', toolCalls: [] }
    },
  })

  assert.equal(result.text, 'plugin event observed')
  assert.equal(requests, 1)
  assert.equal(await unregisterPlugin('loop-request-plugin'), true)
  assert.equal(getPluginService('loop-marker'), undefined)
})

test('public Agent Loop executes a plugin tool once and feeds its result back to the model', async () => {
  let executions = 0
  let modelCalls = 0
  await registerPlugin(manifest('loop-tool-plugin'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_echo',
      spec: TOOL_SPEC,
      exec: async (args, executionContext) => {
        executions += 1
        assert.deepEqual(args, { value: 'from-model' })
        assert.equal(executionContext.userId, 'plugin-loop-user')
        assert.equal(executionContext.toolCallId, 'plugin-echo-call')
        assert.equal(executionContext.origin, 'plugin')
        assert.equal(executionContext.source, 'loop-tool-plugin')
        return { echoed: args.value }
      },
    })
  })

  const result = await runToolLoop({
    job: {
      id: 'plugin-tool-loop-job',
      userId: 'plugin-loop-user',
      origin: 'chat',
      prompt: 'Use plugin_echo and report the result.',
    },
    step: { id: 'plugin-tool-loop-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Use plugin_echo and report the result.' }],
    toolSpecs: [getDynamicTool('plugin_echo').spec],
    enableToolHooks: false,
    maxIters: 3,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'plugin-echo-call',
            type: 'function',
            function: { name: 'plugin_echo', arguments: '{"value":"from-model"}' },
          }],
        }
      }
      assert.match(JSON.stringify(messages), /from-model/)
      return { content: 'plugin result received', toolCalls: [] }
    },
  })

  assert.equal(result.text, 'plugin result received')
  assert.equal(executions, 1)
  assert.equal(modelCalls, 2)
  assert.equal(await unregisterPlugin('loop-tool-plugin'), true)
  assert.deepEqual(await executeServerTool({
    name: 'plugin_echo',
    args: { value: 'after-unload' },
    job: { userId: 'plugin-loop-user' },
  }), { ok: false, error: 'unknown tool: plugin_echo' })
})

test('approval awaiting for plugin A cannot authorize same-name plugin B', async () => {
  let executionsA = 0
  let executionsB = 0
  let signalApprovalPending
  let resolveApproval
  const approvalPending = new Promise((resolve) => { signalApprovalPending = resolve })
  const approvalDecision = new Promise((resolve) => { resolveApproval = resolve })

  const disposeA = registerDynamicTool({
    name: 'plugin_echo',
    origin: 'plugin',
    source: 'generation-a',
    spec: TOOL_SPEC,
    exec: async () => {
      executionsA += 1
      return { ok: true, generation: 'a' }
    },
  })
  const schemaA = getDynamicTool('plugin_echo').spec
  let observedResult = null
  let modelCalls = 0
  let disposeB = null

  try {
    const running = runToolLoop({
      job: {
        id: 'plugin-approval-generation-job',
        userId: 'plugin-approval-generation-user',
        origin: 'chat',
        prompt: 'Call plugin_echo once.',
      },
      step: { id: 'plugin-approval-generation-step', kind: 'chat' },
      messages: [{ role: 'user', content: 'Call plugin_echo once.' }],
      toolSpecs: [schemaA],
      enableToolHooks: false,
      maxIters: 3,
      requestToolApproval: async ({ args, onPending }) => {
        await onPending?.({ id: 'approval-for-generation-a', args })
        signalApprovalPending()
        return approvalDecision
      },
      runModel: async ({ messages }) => {
        modelCalls += 1
        if (modelCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'plugin-approval-generation-call',
              type: 'function',
              function: { name: 'plugin_echo', arguments: '{"value":"approved-for-a"}' },
            }],
          }
        }
        const message = messages.find((item) => (
          item.role === 'tool' && item.tool_call_id === 'plugin-approval-generation-call'
        ))
        observedResult = JSON.parse(message.content)
        return { content: 'stale approval rejected', toolCalls: [] }
      },
    })

    await approvalPending
    disposeA()
    disposeB = registerDynamicTool({
      name: 'plugin_echo',
      origin: 'plugin',
      source: 'generation-b',
      spec: TOOL_SPEC,
      exec: async () => {
        executionsB += 1
        return { ok: true, generation: 'b' }
      },
    })
    resolveApproval({
      proceed: true,
      args: { value: 'approved-for-a' },
      approvalId: 'approval-for-generation-a',
    })

    const result = await running
    assert.equal(result.text, 'stale approval rejected')
    assert.equal(executionsA, 0)
    assert.equal(executionsB, 0)
    assert.equal(observedResult.code, 'dynamic_tool_registration_changed')
    assert.equal(observedResult.retryable, false)
    assert.equal(observedResult.refreshToolCatalog, true)
  } finally {
    disposeB?.()
    disposeA()
  }
})

test('restored plugin A checkpoint cannot execute same-name plugin B', async () => {
  let executionsB = 0
  const disposeA = registerDynamicTool({
    name: 'plugin_echo',
    origin: 'plugin',
    source: 'checkpoint-generation-a',
    spec: TOOL_SPEC,
    exec: async () => ({ ok: true, generation: 'a' }),
  })
  const registrationA = getDynamicTool('plugin_echo').registrationId
  disposeA()
  const disposeB = registerDynamicTool({
    name: 'plugin_echo',
    origin: 'plugin',
    source: 'checkpoint-generation-b',
    spec: TOOL_SPEC,
    exec: async () => {
      executionsB += 1
      return { ok: true, generation: 'b' }
    },
  })
  const schemaB = getDynamicTool('plugin_echo').spec
  const args = { value: 'checkpoint-for-a' }
  const checkpoint = {
    messages: [
      { role: 'user', content: 'Call plugin_echo once.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'plugin-checkpoint-generation-call',
          type: 'function',
          function: { name: 'plugin_echo', arguments: JSON.stringify(args) },
        }],
      },
    ],
    toolCalls: [{
      id: 'plugin-checkpoint-generation-call',
      name: 'plugin_echo',
      args,
      argumentsText: JSON.stringify(args),
      parseError: null,
      dynamicToolRegistrationId: registrationA,
      checkpointStatus: 'pending',
      checkpointApprovalId: null,
    }],
    artifactIds: [],
    iterations: 0,
  }
  let observedResult = null
  let approvalCalls = 0

  try {
    const result = await runToolLoop({
      job: {
        id: 'plugin-checkpoint-generation-job',
        userId: 'plugin-checkpoint-generation-user',
        origin: 'chat',
        prompt: 'Call plugin_echo once.',
      },
      step: { id: 'plugin-checkpoint-generation-step', kind: 'chat' },
      messages: [],
      toolSpecs: [schemaB],
      enableToolHooks: false,
      maxIters: 2,
      loadCheckpoint: async () => ({ state: checkpoint }),
      requestToolApproval: async ({ args: approvalArgs }) => {
        approvalCalls += 1
        return { proceed: true, args: approvalArgs }
      },
      runModel: async ({ messages }) => {
        const message = messages.find((item) => (
          item.role === 'tool' && item.tool_call_id === 'plugin-checkpoint-generation-call'
        ))
        observedResult = JSON.parse(message.content)
        return { content: 'stale checkpoint rejected', toolCalls: [] }
      },
    })

    assert.equal(result.text, 'stale checkpoint rejected')
    assert.equal(approvalCalls, 0)
    assert.equal(executionsB, 0)
    assert.equal(observedResult.code, 'dynamic_tool_registration_changed')
    assert.equal(observedResult.retryable, false)
    assert.equal(observedResult.refreshToolCatalog, true)
  } finally {
    disposeB()
  }
})

test('invalid manifests and event names fail before leaving registry state', async () => {
  const registry = createRuntimePluginRegistry()
  await assert.rejects(
    registry.registerPlugin(manifest('Bad ID'), () => {}),
    /plugin id/,
  )
  await assert.rejects(
    registry.registerPlugin(manifest('bad-event-plugin'), (ctx) => {
      ctx.events.on('not-a-loop-event', () => {})
    }),
    /Unknown loop event/,
  )
  assert.deepEqual(registry.listPlugins(), [])
})

test('plugin tool schema identity is validated before registration', async () => {
  const registry = createRuntimePluginRegistry()
  await assert.rejects(registry.registerPlugin(manifest('mismatched-tool'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_echo',
      spec: { ...TOOL_SPEC, function: { ...TOOL_SPEC.function, name: 'different_name' } },
      exec: async () => ({ ok: true }),
    })
  }), /must match spec\.function\.name/)
  assert.equal(getDynamicTool('plugin_echo'), null)
})

test('plugin tool schemas reject provider-unsafe names and non-object parameters', async () => {
  const registry = createRuntimePluginRegistry()
  await assert.rejects(registry.registerPlugin(manifest('unsafe-tool-name'), (ctx) => {
    ctx.tools.register({
      name: 'plugin.echo',
      spec: { ...TOOL_SPEC, function: { ...TOOL_SPEC.function, name: 'plugin.echo' } },
      exec: async () => ({ ok: true }),
    })
  }), /tool name must match/)
  await assert.rejects(registry.registerPlugin(manifest('array-tool-parameters'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_array_parameters',
      spec: {
        ...TOOL_SPEC,
        function: {
          ...TOOL_SPEC.function,
          name: 'plugin_array_parameters',
          parameters: { type: 'array', items: { type: 'string' } },
        },
      },
      exec: async () => ({ ok: true }),
    })
  }), /parameters\.type must be object/)
  assert.deepEqual(registry.listPlugins(), [])
  assert.equal(getDynamicTool('plugin.echo'), null)
  assert.equal(getDynamicTool('plugin_array_parameters'), null)
})

test('plugin schema snapshots reject enumerable __proto__ inheritance forgeries', async () => {
  const registry = createRuntimePluginRegistry()
  const withEnumerableProto = (value) => {
    const target = {}
    Object.defineProperty(target, '__proto__', {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
    return target
  }
  const validFunction = (name) => ({
    name,
    description: 'forged through __proto__',
    parameters: { type: 'object', properties: {} },
  })
  const cases = [
    [
      'forged-top-level-schema',
      'plugin_forged_top',
      withEnumerableProto({ type: 'function', function: validFunction('plugin_forged_top') }),
    ],
    [
      'forged-function-schema',
      'plugin_forged_function',
      {
        type: 'function',
        function: withEnumerableProto(validFunction('plugin_forged_function')),
      },
    ],
    [
      'forged-parameters-schema',
      'plugin_forged_parameters',
      {
        type: 'function',
        function: {
          name: 'plugin_forged_parameters',
          description: 'forged parameters type',
          parameters: withEnumerableProto({ type: 'object', properties: {} }),
        },
      },
    ],
  ]

  for (const [pluginId, name, spec] of cases) {
    await assert.rejects(registry.registerPlugin(manifest(pluginId), (ctx) => {
      ctx.tools.register({ name, spec, exec: async () => ({ ok: true }) })
    }), /function schema|parameters\.type must be object/)
    assert.equal(getDynamicTool(name), null)
  }
  assert.deepEqual(registry.listPlugins(), [])
})

test('plugin schemas are immutable host snapshots and cyclic schemas fail closed', async () => {
  const registry = createRuntimePluginRegistry()
  const mutableSpec = {
    ...TOOL_SPEC,
    function: {
      ...TOOL_SPEC.function,
      name: 'plugin_mutable_probe',
      description: 'Original schema',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        additionalProperties: false,
      },
    },
  }
  await registry.registerPlugin(manifest('mutable-schema-plugin'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_mutable_probe',
      spec: mutableSpec,
      exec: async () => ({ ok: true }),
    })
  })
  mutableSpec.function.name = 'browser_state'
  mutableSpec.function.description = 'MUTATED TO RESERVED AFTER VALIDATION'
  mutableSpec.function.parameters.properties.value.type = 'number'
  const stored = getDynamicTool('plugin_mutable_probe')?.spec
  assert.equal(stored?.function?.name, 'plugin_mutable_probe')
  assert.equal(stored?.function?.description, 'Original schema')
  assert.equal(stored?.function?.parameters?.properties?.value?.type, 'string')
  assert.equal(Object.isFrozen(stored?.function?.parameters), true)
  assert.equal(await registry.unregisterPlugin('mutable-schema-plugin'), true)

  const cyclicRegistry = createRuntimePluginRegistry()
  const parameters = { type: 'object', properties: {} }
  parameters.self = parameters
  await assert.rejects(cyclicRegistry.registerPlugin(manifest('cyclic-schema-plugin'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_cyclic_probe',
      spec: {
        type: 'function',
        function: { name: 'plugin_cyclic_probe', description: 'cyclic', parameters },
      },
      exec: async () => ({ ok: true }),
    })
  }), /must not contain cycles/)
  assert.equal(getDynamicTool('plugin_cyclic_probe'), null)
  assert.deepEqual(cyclicRegistry.listPlugins(), [])
})

test('plugin call stays bound to the schema owner across shadow and restore races', async () => {
  const runRace = async ({ name, visibleOwner, changeOwner }) => {
    const pluginStem = name.replaceAll('_', '-')
    let visibleExecutions = 0
    let changedExecutions = 0
    const spec = {
      type: 'function',
      function: {
        name,
        description: visibleOwner,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    }
    await registerPlugin(manifest(`${visibleOwner}-plugin`), (ctx) => {
      ctx.tools.register({
        name,
        spec,
        exec: async () => { visibleExecutions += 1; return { ok: true, owner: visibleOwner } },
      })
    })
    if (changeOwner === 'restore') {
      await registerPlugin(manifest(`${pluginStem}-shadow-plugin`), (ctx) => {
        ctx.tools.register({
          name,
          spec,
          exec: async () => { changedExecutions += 1; return { ok: true, owner: 'shadow' } },
        })
      })
    }
    const visibleSchema = getDynamicTool(name).spec
    let releaseModel
    let markModelStarted
    const modelGate = new Promise((resolve) => { releaseModel = resolve })
    const modelStarted = new Promise((resolve) => { markModelStarted = resolve })
    let modelCalls = 0
    let observedMessages = null
    let observedToolNames = null
    const running = runToolLoop({
      job: { id: `${name}-job`, userId: `${name}-user`, origin: 'chat', prompt: 'run it' },
      step: { id: `${name}-step`, kind: 'chat' },
      messages: [{ role: 'user', content: 'run it' }],
      toolSpecs: [visibleSchema],
      enableToolHooks: false,
      requestToolApproval: async ({ args }) => ({ proceed: true, args }),
      maxIters: 3,
      runModel: async ({ messages, tools }) => {
        modelCalls += 1
        if (modelCalls === 1) {
          markModelStarted()
          await modelGate
          return {
            content: '',
            toolCalls: [{ id: `${name}-call`, type: 'function', function: { name, arguments: '{}' } }],
          }
        }
        observedMessages = messages
        observedToolNames = (Array.isArray(tools) ? tools : [])
          .map((tool) => tool?.function?.name)
          .filter(Boolean)
        return { content: 'stale call rejected', toolCalls: [] }
      },
    })
    await modelStarted
    if (changeOwner === 'shadow') {
      await registerPlugin(manifest(`${pluginStem}-changed-plugin`), (ctx) => {
        ctx.tools.register({
          name,
          spec,
          exec: async () => { changedExecutions += 1; return { ok: true, owner: 'changed' } },
        })
      })
    } else {
      assert.equal(await unregisterPlugin(`${pluginStem}-shadow-plugin`), true)
    }
    releaseModel()
    await running
    assert.equal(visibleExecutions, 0)
    assert.equal(changedExecutions, 0)
    assert.match(JSON.stringify(observedMessages), /dynamic_tool_registration_changed/)
    assert.equal(observedToolNames.includes(name), false)
  }

  await runRace({
    name: 'plugin_registration_shadow_race',
    visibleOwner: 'registration-shadow-base',
    changeOwner: 'shadow',
  })
  await _resetRuntimePluginsForTests()
  await runRace({
    name: 'plugin_registration_restore_race',
    visibleOwner: 'registration-restore-base',
    changeOwner: 'restore',
  })
})

test('plugin tools cannot shadow server-routed schemas or executors', async () => {
  const cases = [
    ['builtin-shadow', 'reflect', /cannot shadow builtin tool: reflect/],
    ['connector-shadow', 'connected_app_list', /cannot shadow connector tool: connected_app_list/],
    ['mcp-shadow', 'mcp__example__read', /cannot shadow MCP tool: mcp__example__read/],
    ['browser-shadow', 'browser_plugin_probe', /cannot shadow browser tool: browser_plugin_probe/],
  ]
  for (const [pluginId, name, expected] of cases) {
    const registry = createRuntimePluginRegistry()
    await assert.rejects(registry.registerPlugin(manifest(pluginId), (ctx) => {
      ctx.tools.register({
        name,
        spec: { ...TOOL_SPEC, function: { ...TOOL_SPEC.function, name } },
        exec: async () => ({ ok: true, spoofed: true }),
      })
    }), expected)
    assert.equal(registry.getPlugin(pluginId), null)
    assert.equal(getDynamicTool(name), null)
  }
})

test('uninstall atomically revokes visibility while allowing an in-flight tool call to finish', async () => {
  const registry = createRuntimePluginRegistry()
  const events = createLoopEvents()
  const unbind = registry.bindLoopEvents(events)
  let releaseTool
  let releaseCleanup
  let markToolStarted
  let markCleanupStarted
  const toolGate = new Promise((resolve) => { releaseTool = resolve })
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve })
  const toolStarted = new Promise((resolve) => { markToolStarted = resolve })
  const cleanupStarted = new Promise((resolve) => { markCleanupStarted = resolve })
  let cleanupCalls = 0
  const order = []

  await registry.registerPlugin(manifest('atomic-unload'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_echo',
      spec: TOOL_SPEC,
      exec: async ({ value }) => {
        order.push('tool:start')
        markToolStarted()
        await toolGate
        order.push('tool:end')
        return { ok: true, value }
      },
    })
    ctx.events.on('request', (request) => ({ ...request, pluginActive: true }))
    ctx.services.provide('atomic-service', { ready: true })
    ctx.lifecycle.onDispose(async () => {
      cleanupCalls += 1
      order.push('cleanup:start')
      markCleanupStarted()
      await cleanupGate
      order.push('cleanup:end')
    })
  })

  const inFlight = executeServerTool({
    name: 'plugin_echo',
    args: { value: 'started-before-unload' },
  })
  await toolStarted
  const unloading = registry.unregisterPlugin('atomic-unload')
  const duplicateUnloading = registry.unregisterPlugin('atomic-unload')

  assert.equal(registry.getPlugin('atomic-unload')?.state, 'uninstalling')
  assert.equal(getDynamicTool('plugin_echo'), null)
  assert.equal(registry.getService('atomic-service'), undefined)
  assert.deepEqual(
    await events.waterfall('request', { model: 'test' }, {}),
    { model: 'test' },
  )
  assert.deepEqual(await executeServerTool({
    name: 'plugin_echo',
    args: { value: 'started-after-unload' },
  }), { ok: false, error: 'unknown tool: plugin_echo' })
  assert.equal(cleanupCalls, 0)

  releaseTool()
  assert.deepEqual(await inFlight, { ok: true, value: 'started-before-unload' })
  await cleanupStarted
  assert.equal(cleanupCalls, 1)
  assert.deepEqual(order, ['tool:start', 'tool:end', 'cleanup:start'])
  releaseCleanup()
  assert.equal(await unloading, true)
  assert.equal(await duplicateUnloading, true)
  assert.equal(cleanupCalls, 1)
  assert.deepEqual(order, ['tool:start', 'tool:end', 'cleanup:start', 'cleanup:end'])
  assert.equal(registry.getPlugin('atomic-unload'), null)
  unbind()
})

test('uninstall waits for an in-flight plugin event listener before disposing resources', async () => {
  const registry = createRuntimePluginRegistry()
  const events = createLoopEvents()
  const unbind = registry.bindLoopEvents(events)
  let releaseEvent
  let markEventStarted
  const eventGate = new Promise((resolve) => { releaseEvent = resolve })
  const eventStarted = new Promise((resolve) => { markEventStarted = resolve })
  const order = []

  await registry.registerPlugin(manifest('event-drain'), (ctx) => {
    ctx.events.on('request', async (request) => {
      order.push('event:start')
      markEventStarted()
      await eventGate
      order.push('event:end')
      return { ...request, pluginEventFinished: true }
    })
    ctx.lifecycle.onDispose(() => { order.push('cleanup') })
  })

  const inFlight = events.waterfall('request', { id: 'before-unload' }, {})
  await eventStarted
  const unloading = registry.unregisterPlugin('event-drain')

  assert.equal(registry.getPlugin('event-drain')?.state, 'uninstalling')
  assert.deepEqual(
    await events.waterfall('request', { id: 'after-unload' }, {}),
    { id: 'after-unload' },
  )
  assert.deepEqual(order, ['event:start'])

  releaseEvent()
  assert.deepEqual(await inFlight, {
    id: 'before-unload',
    pluginEventFinished: true,
  })
  assert.equal(await unloading, true)
  assert.deepEqual(order, ['event:start', 'event:end', 'cleanup'])
  unbind()
})

test('plugin tool self-unregister fails fast instead of deadlocking callback drain', async () => {
  const registry = createRuntimePluginRegistry()
  await registry.registerPlugin(manifest('tool-self-unregister'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_echo',
      spec: TOOL_SPEC,
      exec: async () => registry.unregisterPlugin('tool-self-unregister'),
    })
  })

  await assert.rejects(
    settleWithin(getDynamicTool('plugin_echo').exec({ value: 'self-unregister' })),
    (error) => {
      assert.equal(error?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
      assert.match(error?.message || '', /would deadlock callback drain/)
      return true
    },
  )
  assert.equal(registry.getPlugin('tool-self-unregister')?.state, 'active')
  assert.equal(await settleWithin(registry.unregisterPlugin('tool-self-unregister')), true)
})

test('plugin event self-unregister fails fast instead of deadlocking callback drain', async () => {
  const registry = createRuntimePluginRegistry()
  const events = createLoopEvents()
  const unbind = registry.bindLoopEvents(events)
  await registry.registerPlugin(manifest('event-self-unregister'), (ctx) => {
    ctx.events.on('request', async () => registry.unregisterPlugin('event-self-unregister'))
  })

  await assert.rejects(
    settleWithin(events.waterfall('request', { id: 'self-unregister' }, {})),
    (error) => {
      assert.equal(error?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
      assert.match(error?.message || '', /would deadlock callback drain/)
      return true
    },
  )
  assert.equal(registry.getPlugin('event-self-unregister')?.state, 'active')
  assert.equal(await settleWithin(registry.unregisterPlugin('event-self-unregister')), true)
  unbind()
})

test('plugin callback shutdown fails fast instead of awaiting its own callback drain', async () => {
  const registry = createRuntimePluginRegistry()
  await registry.registerPlugin(manifest('callback-shutdown'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_restore',
      spec: { ...TOOL_SPEC, function: { ...TOOL_SPEC.function, name: 'plugin_restore' } },
      exec: async () => registry.shutdown(),
    })
  })

  await assert.rejects(
    settleWithin(getDynamicTool('plugin_restore').exec({ value: 'shutdown' })),
    (error) => {
      assert.equal(error?.code, 'PLUGIN_CALLBACK_SHUTDOWN_DEADLOCK')
      assert.match(error?.message || '', /would deadlock callback drain/)
      return true
    },
  )
  assert.equal(registry.getPlugin('callback-shutdown')?.state, 'active')
  await settleWithin(registry.shutdown())
  assert.deepEqual(registry.listPlugins(), [])
})
