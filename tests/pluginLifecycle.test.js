import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  _resetRuntimePluginsForTests,
  hasPluginService,
  registerPlugin,
  unregisterPlugin,
} from '../server/plugins/pluginRegistry.js'
import { createRuntimePluginRegistry } from '../server/plugins/runtimePluginRegistry.js'
import {
  attachRuntimePluginBeginRevoke,
  createRuntimePluginRevokeReceipt,
} from '../server/plugins/runtimePluginContributionLifecycle.js'
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

test('runtime registry host options reject accessors without invoking them', () => {
  const values = {
    config: {},
    registerTool: () => () => {},
    registerModelProvider: () => () => {},
    registerHttpCapability: () => () => {},
    audit: () => {},
  }
  for (const field of Object.keys(values)) {
    let getterCalls = 0
    const options = {}
    Object.defineProperty(options, field, {
      enumerable: true,
      get() {
        getterCalls += 1
        return values[field]
      },
    })
    assert.throws(
      () => createRuntimePluginRegistry(options),
      (error) => error?.code === 'PLUGIN_HOST_ADAPTER_INVALID'
        && error?.retryable === false
        && new RegExp(`option ${field}`).test(error?.message || ''),
    )
    assert.equal(getterCalls, 0)
  }
})

test('runtime registry host options ignore prototype adapters', async () => {
  let inheritedAuditCalls = 0
  const options = Object.create({
    audit() {
      inheritedAuditCalls += 1
    },
  })
  const registry = createRuntimePluginRegistry(options)
  await registry.registerPlugin(manifest('prototype-host-options'), () => {})
  assert.equal(inheritedAuditCalls, 0)
  assert.equal(await registry.unregisterPlugin('prototype-host-options'), true)
})

test('runtime plugins fail compatibility checks before setup executes', async () => {
  const registry = createRuntimePluginRegistry()
  let setupCalls = 0
  for (const [id, overrides, expectedCode] of [
    ['incompatible-api', { apiVersion: '2.0.0' }, 'PLUGIN_API_VERSION_INCOMPATIBLE'],
    ['incompatible-host', { hostVersion: '>=2.0.0' }, 'PLUGIN_HOST_VERSION_INCOMPATIBLE'],
    [
      'missing-versioned-dependency',
      { requires: ['absent-plugin'], dependencyVersions: { 'absent-plugin': '^1.0.0' } },
      'PLUGIN_DEPENDENCY_UNAVAILABLE',
    ],
  ]) {
    await assert.rejects(
      registry.registerPlugin(manifest(id, overrides), () => {
        setupCalls += 1
      }),
      (error) => error?.code === expectedCode && error?.retryable === false,
    )
    assert.equal(registry.getPlugin(id), null)
  }
  assert.equal(setupCalls, 0)
})

test('runtime dependency semver is enforced against the active immutable manifest', async () => {
  const registry = createRuntimePluginRegistry()
  await registry.registerPlugin(manifest('versioned-base', {
    version: '2.4.1',
    contributes: [],
  }), () => {})

  let rejectedSetupCalls = 0
  await assert.rejects(
    registry.registerPlugin(manifest('wrong-version-consumer', {
      requires: ['versioned-base'],
      dependencyVersions: { 'versioned-base': '^1.0.0' },
      contributes: [],
    }), () => {
      rejectedSetupCalls += 1
    }),
    (error) => error?.code === 'PLUGIN_DEPENDENCY_VERSION_INCOMPATIBLE'
      && error?.dependencyId === 'versioned-base'
      && error?.actualVersion === '2.4.1',
  )
  assert.equal(rejectedSetupCalls, 0)

  const installed = await registry.registerPlugin(manifest('compatible-consumer', {
    apiVersion: '1.0.0',
    hostVersion: '>=0.11.0 <1.0.0',
    requires: ['versioned-base'],
    dependencyVersions: { 'versioned-base': '^2.0.0' },
    contributes: [],
  }), () => {})
  assert.equal(installed.state, 'active')
  assert.equal(installed.apiVersion, '1.0.0')
  assert.equal(installed.hostVersion, '>=0.11.0 <1.0.0')
  assert.deepEqual(installed.dependencyVersions, { 'versioned-base': '^2.0.0' })
  assert.equal(Object.isFrozen(installed.dependencyVersions), true)
})

test('runtime registry host adapters are constructor-time descriptor snapshots', async () => {
  const calls = {
    tool: 0,
    provider: 0,
    audit: 0,
    mutatedTool: 0,
    mutatedProvider: 0,
    mutatedAudit: 0,
    toolDispose: 0,
    providerDispose: 0,
  }
  const options = {
    registerTool(definition) {
      calls.tool += 1
      assert.equal(definition.name, 'plugin_echo')
      return v2Disposer(() => { calls.toolDispose += 1 })
    },
    registerModelProvider(kind) {
      calls.provider += 1
      assert.equal(kind, 'host-snapshot')
      return v2Disposer(() => { calls.providerDispose += 1 })
    },
    audit() {
      calls.audit += 1
    },
  }
  const registry = createRuntimePluginRegistry(options)
  options.registerTool = () => {
    calls.mutatedTool += 1
    return () => {}
  }
  options.registerModelProvider = () => {
    calls.mutatedProvider += 1
    return () => {}
  }
  options.audit = () => { calls.mutatedAudit += 1 }

  await registry.registerPlugin(manifest('host-adapter-snapshot', {
    contributes: ['tool:plugin_echo', 'model-provider:host-snapshot'],
  }), (ctx) => {
    ctx.tools.register({
      name: 'plugin_echo',
      spec: TOOL_SPEC,
      exec: async () => ({ ok: true }),
    })
    ctx.models.providers.register('host-snapshot', {
      buildRequest: () => ({}),
      parseResponse: () => ({}),
    })
  })
  assert.equal(calls.tool, 1)
  assert.equal(calls.provider, 1)
  assert.ok(calls.audit >= 2)
  assert.equal(calls.mutatedTool, 0)
  assert.equal(calls.mutatedProvider, 0)
  assert.equal(calls.mutatedAudit, 0)

  assert.equal(await registry.unregisterPlugin('host-adapter-snapshot'), true)
  assert.equal(calls.toolDispose, 1)
  assert.equal(calls.providerDispose, 1)
  assert.equal(calls.mutatedAudit, 0)
})

test('runtime model-provider definitions fail before custom host registration', async () => {
  let hostRegistrationCalls = 0
  let getterCalls = 0
  const requiredAccessor = {
    parseResponse() { return {} },
  }
  Object.defineProperty(requiredAccessor, 'buildRequest', {
    get() {
      getterCalls += 1
      return () => ({})
    },
  })
  const validMethods = {
    buildRequest() { return {} },
    parseResponse() { return {} },
  }
  const cases = [
    ['provider-missing-required', { buildRequest() { return {} } }, /parseResponse/],
    ['provider-inherited-required', Object.create(validMethods), /buildRequest/],
    ['provider-accessor-required', requiredAccessor, /buildRequest/],
    [
      'provider-partial-stream',
      { ...validMethods, createStreamState() { return {} } },
      /streaming adapter must define/,
    ],
    [
      'provider-descriptor-trap',
      new Proxy(validMethods, {
        getOwnPropertyDescriptor() {
          throw new Error('descriptor trap must stay detached')
        },
      }),
      /cannot be inspected safely/,
    ],
  ]

  for (const [pluginId, adapter, message] of cases) {
    const kind = pluginId.replace('provider-', '')
    const registry = createRuntimePluginRegistry({
      registerModelProvider() {
        hostRegistrationCalls += 1
        return () => {}
      },
    })
    await assert.rejects(
      registry.registerPlugin(manifest(pluginId, {
        contributes: [`model-provider:${kind}`],
      }), (ctx) => {
        ctx.models.providers.register(kind, adapter)
      }),
      (error) => error?.code === 'PLUGIN_MODEL_PROVIDER_DEFINITION_INVALID'
        && error?.retryable === false
        && message.test(error?.message || ''),
    )
    assert.equal(registry.getPlugin(pluginId), null)
    assert.deepEqual(registry.listPlugins(), [])
  }
  assert.equal(hostRegistrationCalls, 0)
  assert.equal(getterCalls, 0)
})

test('runtime model providers cannot replace reserved kinds through custom host adapters', async () => {
  let hostRegistrationCalls = 0
  let descriptorCalls = 0
  const adapter = new Proxy({
    buildRequest() { return {} },
    parseResponse() { return {} },
  }, {
    getOwnPropertyDescriptor(target, key) {
      descriptorCalls += 1
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  const registry = createRuntimePluginRegistry({
    registerModelProvider() {
      hostRegistrationCalls += 1
      return v2Disposer(() => {})
    },
  })

  await assert.rejects(
    registry.registerPlugin(manifest('provider-reserved-kind', {
      contributes: ['model-provider:gemini'],
    }), (ctx) => {
      ctx.models.providers.register('gemini', adapter)
    }),
    (error) => error?.code === 'PLUGIN_MODEL_PROVIDER_KIND_RESERVED'
      && error?.retryable === false
      && /gemini/.test(error?.message || ''),
  )
  assert.equal(hostRegistrationCalls, 0)
  assert.equal(descriptorCalls, 0)
  assert.equal(registry.getPlugin('provider-reserved-kind'), null)
})

test('runtime provider thenable rejection never assimilates plugin code', async () => {
  let wrappedAdapter = null
  let thenCalls = 0
  const registry = createRuntimePluginRegistry({
    registerModelProvider(_kind, adapter) {
      wrappedAdapter = adapter
      return v2Disposer(() => {})
    },
  })
  await registry.registerPlugin(manifest('provider-thenable-boundary', {
    contributes: ['model-provider:thenable-boundary'],
  }), (ctx) => {
    ctx.models.providers.register('thenable-boundary', {
      buildRequest() {
        return {
          then() {
            thenCalls += 1
          },
        }
      },
      parseResponse() { return {} },
    })
  })

  assert.throws(
    () => wrappedAdapter.buildRequest({}),
    (error) => error?.code === 'PLUGIN_MODEL_PROVIDER_ASYNC_UNSUPPORTED'
      && error?.retryable === false,
  )
  await Promise.resolve()
  assert.equal(thenCalls, 0)
  assert.equal(await registry.unregisterPlugin('provider-thenable-boundary'), true)
})

test('plugin context config is a detached deeply frozen plain-data snapshot', async () => {
  const source = {
    mode: 'original',
    nested: { enabled: true },
    entries: ['first'],
  }
  const registry = createRuntimePluginRegistry({ config: source })
  source.mode = 'mutated'
  source.nested.enabled = false
  source.entries[0] = 'mutated'

  await registry.registerPlugin(manifest('context-config-snapshot'), (ctx) => {
    assert.deepEqual(ctx.config, {
      mode: 'original',
      nested: { enabled: true },
      entries: ['first'],
    })
    assert.notEqual(ctx.config, source)
    assert.notEqual(ctx.config.nested, source.nested)
    assert.equal(Object.isFrozen(ctx.config), true)
    assert.equal(Object.isFrozen(ctx.config.nested), true)
    assert.equal(Object.isFrozen(ctx.config.entries), true)
    assert.throws(() => { ctx.config.nested.enabled = false }, TypeError)
    assert.throws(() => { ctx.config.entries.push('forged') }, TypeError)
  })
  assert.equal(await registry.unregisterPlugin('context-config-snapshot'), true)
})

test('plugin context config rejects accessors and capabilities without invoking them', () => {
  let getterCalls = 0
  const accessorConfig = {}
  Object.defineProperty(accessorConfig, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'not-readable'
    },
  })
  assert.throws(
    () => createRuntimePluginRegistry({ config: accessorConfig }),
    (error) => error?.code === 'PLUGIN_CONTEXT_CONFIG_INVALID'
      && error?.retryable === false,
  )
  assert.equal(getterCalls, 0)
  assert.throws(
    () => createRuntimePluginRegistry({ config: { callback() {} } }),
    (error) => error?.code === 'PLUGIN_CONTEXT_CONFIG_INVALID'
      && error?.retryable === false,
  )
})

test('plugin plain-data array snapshots do not execute Proxy property reads', async () => {
  let propertyReads = 0
  const sourceEntries = ['original']
  const entries = new Proxy(sourceEntries, {
    get(target, key, receiver) {
      propertyReads += 1
      return Reflect.get(target, key, receiver)
    },
  })
  const registry = createRuntimePluginRegistry({ config: { entries } })
  assert.equal(propertyReads, 0)
  sourceEntries[0] = 'mutated'

  await registry.registerPlugin(manifest('context-array-descriptor-snapshot'), (ctx) => {
    assert.deepEqual(ctx.config.entries, ['original'])
    assert.equal(Object.isFrozen(ctx.config.entries), true)
  })
  assert.equal(propertyReads, 0)
  assert.equal(await registry.unregisterPlugin('context-array-descriptor-snapshot'), true)
})

test('plugin audit emits detached immutable plain data and rejects capabilities', async () => {
  const audit = []
  const registry = createRuntimePluginRegistry({ audit: (entry) => audit.push(entry) })
  let detailGetterCalls = 0
  let eventCoercionCalls = 0
  await registry.registerPlugin(manifest('context-audit-boundary'), (ctx) => {
    const details = {
      status: 'original',
      nested: { count: 1 },
    }
    ctx.audit.emit('plugin.custom-event', details)
    details.status = 'mutated'
    details.nested.count = 2

    const accessorDetails = {}
    Object.defineProperty(accessorDetails, 'secret', {
      enumerable: true,
      get() {
        detailGetterCalls += 1
        return 'not-readable'
      },
    })
    assert.throws(
      () => ctx.audit.emit('plugin.invalid-details', accessorDetails),
      (error) => error?.code === 'PLUGIN_AUDIT_DATA_INVALID'
        && error?.retryable === false,
    )
    assert.throws(
      () => ctx.audit.emit('plugin.invalid-capability', { callback() {} }),
      (error) => error?.code === 'PLUGIN_AUDIT_DATA_INVALID'
        && error?.retryable === false,
    )
    assert.throws(
      () => ctx.audit.emit({
        [Symbol.toPrimitive]() {
          eventCoercionCalls += 1
          return 'plugin.forged'
        },
      }, {}),
      (error) => error?.code === 'PLUGIN_AUDIT_EVENT_INVALID'
        && error?.retryable === false,
    )
  })

  const custom = audit.find((entry) => entry.event === 'plugin.custom-event')
  assert.ok(custom)
  assert.deepEqual(custom.details, {
    status: 'original',
    nested: { count: 1 },
  })
  assert.equal(Object.isFrozen(custom), true)
  assert.equal(Object.isFrozen(custom.details), true)
  assert.equal(Object.isFrozen(custom.details.nested), true)
  assert.equal(detailGetterCalls, 0)
  assert.equal(eventCoercionCalls, 0)
  assert.equal(audit.some((entry) => entry.event === 'plugin.invalid-details'), false)
  assert.equal(audit.some((entry) => entry.event === 'plugin.invalid-capability'), false)
  assert.equal(await registry.unregisterPlugin('context-audit-boundary'), true)
})

test('runtime loop binding ignores obsolete host context without traversing it', () => {
  const registry = createRuntimePluginRegistry()
  const events = createLoopEvents()
  let getterCalls = 0
  const context = {}
  Object.defineProperty(context, 'job', {
    enumerable: true,
    get() {
      getterCalls += 1
      return { capability() {} }
    },
  })

  const unbind = registry.bindLoopEvents(events, context)
  assert.equal(getterCalls, 0)
  assert.equal(unbind(), true)
})

test('runtime loop event bus rejects accessors and inherited methods without invoking them', () => {
  const registry = createRuntimePluginRegistry()
  let getterCalls = 0
  const accessorBus = {
    off() {},
  }
  Object.defineProperty(accessorBus, 'on', {
    enumerable: true,
    get() {
      getterCalls += 1
      return () => () => {}
    },
  })
  assert.throws(
    () => registry.bindLoopEvents(accessorBus),
    (error) => error?.code === 'PLUGIN_LOOP_EVENT_BUS_INVALID'
      && error?.retryable === false
      && /event bus\.on/.test(error?.message || ''),
  )
  assert.equal(getterCalls, 0)

  const inheritedBus = Object.create({
    on() { return () => {} },
    off() {},
  })
  assert.throws(
    () => registry.bindLoopEvents(inheritedBus),
    (error) => error?.code === 'PLUGIN_LOOP_EVENT_BUS_INVALID'
      && /event bus\.on/.test(error?.message || ''),
  )
})

test('runtime loop event bus methods are registration-time descriptor snapshots', async () => {
  const registry = createRuntimePluginRegistry()
  const listeners = new Set()
  let originalOnCalls = 0
  let mutatedOnCalls = 0
  let propertyReads = 0
  let descriptorReads = 0
  const target = {
    on(event, listener) {
      originalOnCalls += 1
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    off(event, listener) {
      return listeners.delete(listener)
    },
  }
  const bus = new Proxy(target, {
    get(object, key, receiver) {
      propertyReads += 1
      return Reflect.get(object, key, receiver)
    },
    getOwnPropertyDescriptor(object, key) {
      descriptorReads += 1
      return Reflect.getOwnPropertyDescriptor(object, key)
    },
  })

  const unbind = registry.bindLoopEvents(bus)
  const registrationDescriptorReads = descriptorReads
  target.on = () => {
    mutatedOnCalls += 1
    return () => {}
  }
  target.off = () => false
  await registry.registerPlugin(manifest('event-bus-snapshot', {
    contributes: ['event:request'],
  }), (ctx) => {
    ctx.events.on('request', (request) => request)
  })

  assert.equal(originalOnCalls, 1)
  assert.equal(mutatedOnCalls, 0)
  assert.equal(propertyReads, 0)
  assert.equal(descriptorReads, registrationDescriptorReads)
  assert.equal(listeners.size, 1)
  assert.equal(unbind(), true)
  assert.equal(listeners.size, 0)
  assert.equal(await registry.unregisterPlugin('event-bus-snapshot'), true)
})

test('runtime plugin inventory returns deeply frozen detached snapshots', async () => {
  const registry = createRuntimePluginRegistry()
  const installed = await registry.registerPlugin(manifest('frozen-inventory', {
    requires: [],
    contributes: ['service:frozen-inventory-service'],
  }), (ctx) => {
    ctx.services.provide('frozen-inventory-service', { ready: true })
  })
  const listed = registry.listPlugins()
  const fetched = registry.getPlugin('frozen-inventory')

  for (const snapshot of [installed, listed[0], fetched]) {
    assert.equal(Object.isFrozen(snapshot), true)
    assert.equal(Object.isFrozen(snapshot.requires), true)
    assert.equal(Object.isFrozen(snapshot.contributes), true)
    assert.throws(() => { snapshot.state = 'forged' }, TypeError)
    assert.throws(() => { snapshot.contributes.push('tool:forged') }, TypeError)
  }
  assert.equal(Object.isFrozen(listed), true)
  assert.throws(() => listed.push({ id: 'forged' }), TypeError)
  assert.equal(registry.getPlugin('frozen-inventory').state, 'active')
  assert.equal(await registry.unregisterPlugin('frozen-inventory'), true)
})

test('runtime registry queries reject object coercion without executing it', async () => {
  const registry = createRuntimePluginRegistry()
  await registry.registerPlugin(manifest('query-coercion-boundary', {
    contributes: ['service:query-coercion-service'],
  }), (ctx) => {
    ctx.services.provide('query-coercion-service', {
      review: () => ({ ok: true }),
    })
  })
  let coercionCalls = 0
  const coercive = {
    toString() {
      coercionCalls += 1
      return 'query-coercion-boundary'
    },
    [Symbol.toPrimitive]() {
      coercionCalls += 1
      return 'query-coercion-boundary'
    },
  }

  assert.equal(registry.getPlugin(coercive), null)
  assert.equal(registry.hasService(coercive), false)
  assert.deepEqual(await registry.invokeService(coercive, coercive, []), {
    found: false,
    pluginId: null,
    value: undefined,
  })
  await assert.rejects(
    registry.invokeService('query-coercion-service', coercive, []),
    (error) => error?.code === 'PLUGIN_SERVICE_METHOD_INVALID'
      && error?.retryable === false,
  )
  assert.equal(await registry.unregisterPlugin(coercive), false)
  assert.equal(coercionCalls, 0)
  assert.equal(registry.getPlugin('query-coercion-boundary')?.state, 'active')
  assert.equal(await registry.unregisterPlugin('query-coercion-boundary'), true)
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
  assert.equal(registry.hasService('echo'), true)
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
  assert.equal(registry.hasService('echo'), false)
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
  assert.equal(registry.hasService('review-guard'), false)
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

test('plugin service consumers require declared providers and receive isolated data only', async () => {
  const registry = createRuntimePluginRegistry()
  let observedArgument = null
  let dependentServices = null
  let providerCalls = 0

  await registry.registerPlugin(manifest('bounded-service-provider', {
    contributes: ['service:bounded-service'],
  }), (ctx) => {
    ctx.services.provide('bounded-service', {
      async review(argument) {
        providerCalls += 1
        observedArgument = argument
        assert.equal(Object.isFrozen(argument), true)
        assert.equal(Object.isFrozen(argument.nested), true)
        assert.throws(() => { argument.nested.value = 'forged' }, TypeError)
        return { accepted: argument.id, nested: { value: 'provider-result' } }
      },
    })
  })

  await registry.registerPlugin(manifest('undeclared-service-consumer', {
    contributes: [],
  }), async (ctx) => {
    assert.equal(ctx.services.has('bounded-service'), false)
    assert.equal(ctx.services.get, undefined)
    await assert.rejects(
      ctx.services.invoke('bounded-service', 'review', [{ id: 'forbidden' }]),
      (error) => error?.code === 'PLUGIN_SERVICE_DEPENDENCY_UNDECLARED'
        && error?.providerPluginId === 'bounded-service-provider',
    )
  })

  await registry.registerPlugin(manifest('declared-service-consumer', {
    requires: ['bounded-service-provider'],
    contributes: [],
  }), (ctx) => {
    dependentServices = ctx.services
    assert.equal(ctx.services.has('bounded-service'), true)
  })

  const argument = { id: 'review-1', nested: { value: 'host-value' } }
  const invoked = await dependentServices.invoke('bounded-service', 'review', [argument])
  assert.deepEqual(invoked, {
    found: true,
    pluginId: 'bounded-service-provider',
    value: { accepted: 'review-1', nested: { value: 'provider-result' } },
  })
  assert.notEqual(observedArgument, argument)
  assert.deepEqual(argument, { id: 'review-1', nested: { value: 'host-value' } })
  assert.equal(Object.isFrozen(invoked), true)
  assert.equal(Object.isFrozen(invoked.value), true)
  assert.equal(Object.isFrozen(invoked.value.nested), true)
  assert.throws(() => { invoked.value.nested.value = 'forged' }, TypeError)
  assert.equal(providerCalls, 1)

  assert.equal(await registry.unregisterPlugin('undeclared-service-consumer'), true)
  assert.equal(await registry.unregisterPlugin('declared-service-consumer'), true)
  await assert.rejects(
    dependentServices.invoke('bounded-service', 'review', [{ id: 'stale' }]),
    (error) => error?.code === 'PLUGIN_SERVICE_CONSUMER_INACTIVE',
  )
  assert.equal(providerCalls, 1)
  assert.equal(await registry.unregisterPlugin('bounded-service-provider'), true)
})

test('plugin services reject accessor arguments, inherited methods, and capability results', async () => {
  const registry = createRuntimePluginRegistry()
  let calls = 0
  await registry.registerPlugin(manifest('invalid-service-data-plugin', {
    contributes: ['service:invalid-service-data'],
  }), (ctx) => {
    const inherited = Object.create({ inherited() { return { ok: true } } })
    inherited.review = () => {
      calls += 1
      return { leaked: () => 'capability' }
    }
    ctx.services.provide('invalid-service-data', inherited)
  })

  const accessorArgument = {}
  Object.defineProperty(accessorArgument, 'secret', { enumerable: true, get: () => 'leaked' })
  await assert.rejects(
    registry.invokeService('invalid-service-data', 'review', [accessorArgument]),
    (error) => error?.code === 'PLUGIN_SERVICE_ARGUMENT_INVALID',
  )
  assert.equal(calls, 0)

  let propertyReads = 0
  let iteratorGetterCalls = 0
  let coercionCalls = 0
  const nonArrayTarget = {
    toString() {
      coercionCalls += 1
      return 'forged'
    },
    [Symbol.toPrimitive]() {
      coercionCalls += 1
      return 'forged'
    },
  }
  Object.defineProperty(nonArrayTarget, Symbol.iterator, {
    get() {
      iteratorGetterCalls += 1
      return function* forgedArguments() {
        yield { id: 'forged' }
      }
    },
  })
  const nonArrayArgs = new Proxy(nonArrayTarget, {
    get(target, key, receiver) {
      propertyReads += 1
      return Reflect.get(target, key, receiver)
    },
  })
  await assert.rejects(
    registry.invokeService('invalid-service-data', 'review', nonArrayArgs),
    (error) => error?.code === 'PLUGIN_SERVICE_ARGUMENT_INVALID'
      && error?.retryable === false
      && /arguments must be a plain data array/.test(error?.message || ''),
  )
  assert.equal(propertyReads, 0)
  assert.equal(iteratorGetterCalls, 0)
  assert.equal(coercionCalls, 0)
  assert.equal(calls, 0)

  await assert.rejects(
    registry.invokeService('invalid-service-data', 'inherited', []),
    (error) => error?.code === 'PLUGIN_SERVICE_METHOD_INVALID',
  )
  assert.equal(calls, 0)

  await assert.rejects(
    registry.invokeService('invalid-service-data', 'review', []),
    (error) => error?.code === 'PLUGIN_SERVICE_RESULT_INVALID',
  )
  assert.equal(calls, 1)
  assert.equal(await registry.unregisterPlugin('invalid-service-data-plugin'), true)
})

test('plugin service methods are registration snapshots without invocation-time reflection', async () => {
  const registry = createRuntimePluginRegistry()
  let descriptorCalls = 0
  let getterCalls = 0
  let originalCalls = 0
  let replacementCalls = 0
  const target = {
    review() {
      originalCalls += 1
      return { owner: 'original' }
    },
  }
  Object.defineProperty(target, 'accessorMethod', {
    configurable: true,
    get() {
      getterCalls += 1
      return () => ({ owner: 'accessor' })
    },
  })
  const service = new Proxy(target, {
    getOwnPropertyDescriptor(object, key) {
      descriptorCalls += 1
      return Reflect.getOwnPropertyDescriptor(object, key)
    },
  })

  await registry.registerPlugin(manifest('service-method-snapshot-plugin', {
    contributes: ['service:method-snapshot'],
  }), (ctx) => ctx.services.provide('method-snapshot', service))
  const descriptorsAfterRegistration = descriptorCalls
  target.review = () => {
    replacementCalls += 1
    return { owner: 'replacement' }
  }

  assert.deepEqual(await registry.invokeService('method-snapshot', 'review', []), {
    found: true,
    pluginId: 'service-method-snapshot-plugin',
    value: { owner: 'original' },
  })
  assert.equal(originalCalls, 1)
  assert.equal(replacementCalls, 0)
  assert.equal(descriptorCalls, descriptorsAfterRegistration)
  await assert.rejects(
    registry.invokeService('method-snapshot', 'accessorMethod', []),
    (error) => error?.code === 'PLUGIN_SERVICE_METHOD_INVALID'
      && error?.retryable === false,
  )
  assert.equal(getterCalls, 0)
  assert.equal(await registry.unregisterPlugin('service-method-snapshot-plugin'), true)
})

test('plugin service definition failures do not execute or retain thrown accessors', async () => {
  const registry = createRuntimePluginRegistry()
  let messageGetterCalls = 0
  const thrown = {}
  Object.defineProperty(thrown, 'message', {
    get() {
      messageGetterCalls += 1
      return 'getter must not execute'
    },
  })
  const service = new Proxy({}, {
    ownKeys() { throw thrown },
  })

  await assert.rejects(
    registry.registerPlugin(manifest('invalid-service-definition-plugin', {
      contributes: ['service:invalid-definition'],
    }), (ctx) => ctx.services.provide('invalid-definition', service)),
    (error) => {
      assert.equal(error?.code, 'PLUGIN_SERVICE_DEFINITION_INVALID')
      assert.equal(error?.retryable, false)
      assert.equal(error?.message, 'plugin service definition cannot be inspected safely')
      assert.equal(Object.hasOwn(error, 'cause'), false)
      return true
    },
  )
  assert.equal(messageGetterCalls, 0)
  assert.equal(registry.getPlugin('invalid-service-definition-plugin'), null)
  assert.equal(registry.hasService('invalid-definition'), false)
})

test('plugin service result traversal remains inside provider callback accounting', async () => {
  const registry = createRuntimePluginRegistry()
  let unregisterAttempt = null
  await registry.registerPlugin(manifest('service-result-accounting-plugin', {
    contributes: ['service:result-accounting'],
  }), (ctx) => {
    ctx.services.provide('result-accounting', {
      async review() {
        return new Proxy({ value: 'accounted-result' }, {
          getPrototypeOf(target) {
            if (!unregisterAttempt) {
              unregisterAttempt = registry.unregisterPlugin('service-result-accounting-plugin').then(
                (value) => ({ value }),
                (error) => ({ error }),
              )
            }
            return Reflect.getPrototypeOf(target)
          },
        })
      },
    })
  })

  assert.deepEqual(await registry.invokeService('result-accounting', 'review', []), {
    found: true,
    pluginId: 'service-result-accounting-plugin',
    value: { value: 'accounted-result' },
  })
  const attempted = await settleWithin(unregisterAttempt)
  assert.equal(attempted.value, undefined)
  assert.equal(attempted.error?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(registry.getPlugin('service-result-accounting-plugin')?.state, 'active')
  assert.equal(await registry.unregisterPlugin('service-result-accounting-plugin'), true)
})

test('plugin service thrown values cross the boundary as detached data-only errors', async () => {
  const registry = createRuntimePluginRegistry()
  let unregisterAttempt = null
  let messageGetterCalls = 0
  const thrown = {}
  Object.defineProperties(thrown, {
    message: {
      configurable: true,
      get() {
        messageGetterCalls += 1
        return 'getter must not execute'
      },
    },
    code: { value: 'PLUGIN_CUSTOM_SERVICE_FAILURE' },
    retryable: { value: true },
    cause: { value: { providerCapability: true } },
  })
  const trappedError = new Proxy(thrown, {
    getOwnPropertyDescriptor(target, key) {
      if (!unregisterAttempt) {
        unregisterAttempt = registry.unregisterPlugin('service-error-accounting-plugin').then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
      }
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })

  await registry.registerPlugin(manifest('service-error-accounting-plugin', {
    contributes: ['service:error-accounting'],
  }), (ctx) => {
    ctx.services.provide('error-accounting', {
      async review() { throw trappedError },
    })
  })

  await assert.rejects(
    registry.invokeService('error-accounting', 'review', []),
    (error) => {
      assert.notEqual(error, trappedError)
      assert.equal(error?.code, 'PLUGIN_CUSTOM_SERVICE_FAILURE')
      assert.equal(error?.retryable, false)
      assert.equal(error?.message, 'plugin service call failed: error-accounting')
      assert.equal(error?.pluginId, 'service-error-accounting-plugin')
      assert.equal(error?.serviceName, 'error-accounting')
      assert.equal(Object.hasOwn(error, 'cause'), false)
      return true
    },
  )
  assert.equal(messageGetterCalls, 0)
  const attempted = await settleWithin(unregisterAttempt)
  assert.equal(attempted.value, undefined)
  assert.equal(attempted.error?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(registry.getPlugin('service-error-accounting-plugin')?.state, 'active')
  assert.equal(await registry.unregisterPlugin('service-error-accounting-plugin'), true)
})

test('runtime request events hide and restore host-owned request capabilities', async () => {
  const registry = createRuntimePluginRegistry()
  const events = createLoopEvents()
  const unbind = registry.bindLoopEvents(events)
  let observedRequest = null
  const hostSignal = new AbortController().signal
  const onTextDelta = async () => {}

  await registry.registerPlugin(manifest('request-capability-boundary-plugin', {
    contributes: ['event:request'],
  }), (ctx) => {
    ctx.events.on('request', (request, eventContext) => {
      observedRequest = request
      assert.equal(Object.isFrozen(request), true)
      assert.equal(Object.isFrozen(request.messages), true)
      assert.equal(Object.isFrozen(eventContext), true)
      assert.equal(Object.hasOwn(request, 'signal'), false)
      assert.equal(Object.hasOwn(request, 'onTextDelta'), false)
      return {
        ...request,
        signal: 'forged-signal',
        onTextDelta: 'forged-callback',
        pluginMarker: 'accepted-data',
      }
    })
  })

  const prepared = await events.waterfall('request', {
    messages: [{ role: 'user', content: 'request-data' }],
    tools: [],
    signal: hostSignal,
    onTextDelta,
  }, { phase: 'model-request' })

  assert.equal(prepared.signal, hostSignal)
  assert.equal(prepared.onTextDelta, onTextDelta)
  assert.equal(prepared.pluginMarker, 'accepted-data')
  assert.notEqual(prepared, observedRequest)
  assert.notEqual(prepared.messages, observedRequest.messages)
  assert.equal(await registry.unregisterPlugin('request-capability-boundary-plugin'), true)
  unbind()
})

test('runtime request-error events receive metadata only and restore retry request capabilities', async () => {
  const registry = createRuntimePluginRegistry()
  const events = createLoopEvents()
  const unbind = registry.bindLoopEvents(events)
  const hostSignal = new AbortController().signal
  const onReasoningDelta = async () => {}
  const modelError = new Error('provider unavailable', { cause: { secret: true } })
  modelError.code = 'MODEL_PROVIDER_UNAVAILABLE'
  modelError.statusCode = 503
  modelError.retryable = true
  let observedError = null

  await registry.registerPlugin(manifest('request-error-boundary-plugin', {
    contributes: ['event:request-error'],
  }), (ctx) => {
    ctx.events.on('request-error', (payload) => {
      observedError = payload.error
      assert.equal(Object.isFrozen(payload), true)
      assert.equal(Object.isFrozen(payload.error), true)
      assert.equal(Object.isFrozen(payload.request), true)
      assert.equal(Object.hasOwn(payload.error, 'cause'), false)
      assert.equal(Object.hasOwn(payload.error, 'stack'), false)
      assert.equal(Object.hasOwn(payload.request, 'signal'), false)
      assert.equal(Object.hasOwn(payload.request, 'onReasoningDelta'), false)
      return {
        kind: 'retry',
        request: {
          ...payload.request,
          signal: 'forged-signal',
          onReasoningDelta: 'forged-callback',
          retriedByPlugin: true,
        },
      }
    })
  })

  const decision = await events.waterfall('request-error', {
    kind: 'error',
    error: modelError,
    request: {
      messages: [{ role: 'user', content: 'retry-data' }],
      signal: hostSignal,
      onReasoningDelta,
    },
    attempt: 1,
  }, { phase: 'model-request', attempt: 1 })

  assert.deepEqual(observedError, {
    name: 'Error',
    message: 'provider unavailable',
    code: 'MODEL_PROVIDER_UNAVAILABLE',
    statusCode: 503,
    retryable: true,
  })
  assert.equal(decision.kind, 'retry')
  assert.equal(decision.request.signal, hostSignal)
  assert.equal(decision.request.onReasoningDelta, onReasoningDelta)
  assert.equal(decision.request.retriedByPlugin, true)
  assert.equal(await registry.unregisterPlugin('request-error-boundary-plugin'), true)
  unbind()
})

test('runtime event completion traversal remains inside callback accounting', async () => {
  const registry = createRuntimePluginRegistry()
  const events = createLoopEvents()
  const unbind = registry.bindLoopEvents(events)
  let unregisterAttempt = null
  await registry.registerPlugin(manifest('event-result-accounting-plugin', {
    contributes: ['event:request'],
  }), (ctx) => {
    ctx.events.on('request', (request) => new Proxy({ ...request, accounted: true }, {
      getPrototypeOf(target) {
        if (!unregisterAttempt) {
          unregisterAttempt = registry.unregisterPlugin('event-result-accounting-plugin').then(
            (value) => ({ value }),
            (error) => ({ error }),
          )
        }
        return Reflect.getPrototypeOf(target)
      },
    }))
  })

  assert.deepEqual(await events.waterfall('request', { model: 'test' }, {}), {
    model: 'test',
    accounted: true,
  })
  const attempted = await settleWithin(unregisterAttempt)
  assert.equal(attempted.value, undefined)
  assert.equal(attempted.error?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(registry.getPlugin('event-result-accounting-plugin')?.state, 'active')
  assert.equal(await registry.unregisterPlugin('event-result-accounting-plugin'), true)
  unbind()
})

test('runtime event thrown values are detached and observer results are discarded', async () => {
  const registry = createRuntimePluginRegistry()
  const events = createLoopEvents()
  const unbind = registry.bindLoopEvents(events)
  let unregisterAttempt = null
  let messageGetterCalls = 0
  let observerResultTrapCalls = 0
  const thrown = {}
  Object.defineProperties(thrown, {
    message: {
      get() {
        messageGetterCalls += 1
        return 'getter must not execute'
      },
    },
    code: { value: 'PLUGIN_CUSTOM_EVENT_FAILURE' },
    retryable: { value: true },
    cause: { value: { eventCapability: true } },
  })
  const trappedError = new Proxy(thrown, {
    getOwnPropertyDescriptor(target, key) {
      if (!unregisterAttempt) {
        unregisterAttempt = registry.unregisterPlugin('event-error-accounting-plugin').then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
      }
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })

  await registry.registerPlugin(manifest('event-error-accounting-plugin', {
    contributes: ['event:request', 'event:pre-step'],
  }), (ctx) => {
    ctx.events.on('request', async () => { throw trappedError })
    ctx.events.on('pre-step', async () => new Proxy({ capability() {} }, {
      getPrototypeOf(target) {
        observerResultTrapCalls += 1
        return Reflect.getPrototypeOf(target)
      },
    }))
  })

  await assert.rejects(
    events.waterfall('request', { model: 'test' }, {}),
    (error) => {
      assert.notEqual(error, trappedError)
      assert.equal(error?.code, 'PLUGIN_CUSTOM_EVENT_FAILURE')
      assert.equal(error?.retryable, false)
      assert.equal(error?.message, 'plugin event listener failed: request')
      assert.equal(error?.pluginId, 'event-error-accounting-plugin')
      assert.equal(error?.event, 'request')
      assert.equal(Object.hasOwn(error, 'cause'), false)
      return true
    },
  )
  assert.equal(messageGetterCalls, 0)
  const attempted = await settleWithin(unregisterAttempt)
  assert.equal(attempted.value, undefined)
  assert.equal(attempted.error?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(registry.getPlugin('event-error-accounting-plugin')?.state, 'active')

  const observerResults = await events.observe('pre-step', { iteration: 1 }, {})
  assert.deepEqual(observerResults, [{ ok: true, value: undefined }])
  assert.equal(observerResultTrapCalls, 0)
  assert.equal(await registry.unregisterPlugin('event-error-accounting-plugin'), true)
  unbind()
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

test('event registration rollback retains failed bindings until a later exact-handle retry succeeds', async () => {
  const registry = createRuntimePluginRegistry()
  const createBus = ({ attachFails = false, disposeFailures = 0 } = {}) => {
    const listeners = new Set()
    let disposeCalls = 0
    let remainingDisposeFailures = disposeFailures
    return {
      listeners,
      get disposeCalls() { return disposeCalls },
      events: {
        on(event, listener) {
          if (attachFails) throw new Error('loop binding attach failed')
          listeners.add(listener)
          return () => {
            disposeCalls += 1
            listeners.delete(listener)
            if (remainingDisposeFailures > 0) {
              remainingDisposeFailures -= 1
              throw new Error('loop binding dispose failed')
            }
          }
        },
        off(event, listener) {
          return listeners.delete(listener)
        },
      },
    }
  }
  const first = createBus({ disposeFailures: 1 })
  const second = createBus()
  const failing = createBus({ attachFails: true })
  const unbind = [
    registry.bindLoopEvents(first.events),
    registry.bindLoopEvents(second.events),
    registry.bindLoopEvents(failing.events),
  ]

  try {
    await assert.rejects(
      registry.registerPlugin(manifest('event-registration-rollback'), (ctx) => {
        ctx.events.on('request', () => undefined)
      }),
      (error) => error instanceof AggregateError
        && /plugin setup failed: event-registration-rollback/.test(error?.message || ''),
    )
    assert.equal(first.listeners.size, 0)
    assert.equal(second.listeners.size, 0)
    assert.equal(failing.listeners.size, 0)
    assert.equal(first.disposeCalls, 1)
    assert.equal(second.disposeCalls, 1)
    assert.equal(failing.disposeCalls, 0)
    assert.equal(registry.getPlugin('event-registration-rollback')?.state, 'rollback_failed')

    assert.equal(await registry.unregisterPlugin('event-registration-rollback'), true)
    assert.equal(first.disposeCalls, 2)
    assert.equal(second.disposeCalls, 1)
    assert.equal(registry.getPlugin('event-registration-rollback'), null)
  } finally {
    for (const dispose of unbind.reverse()) dispose()
  }
})

test('loop event attachment compensates on failures before a disposer is tracked', async () => {
  for (const mode of ['throw', 'invalid-disposer']) {
    const registry = createRuntimePluginRegistry()
    const listeners = new Set()
    let offCalls = 0
    const unbind = registry.bindLoopEvents({
      on(event, listener) {
        listeners.add(listener)
        if (mode === 'throw') throw new Error('loop event attach failed after mutation')
        return { invalid: true }
      },
      off(event, listener) {
        offCalls += 1
        return listeners.delete(listener)
      },
    })
    const pluginId = `event-attach-compensation-${mode}`
    try {
      await assert.rejects(
        registry.registerPlugin(manifest(pluginId), (ctx) => {
          ctx.events.on('request', () => undefined)
        }),
        (error) => error?.code === 'PLUGIN_SETUP_FAILED'
          && error?.retryable === false,
      )
      assert.equal(listeners.size, 0)
      assert.equal(offCalls, 1)
      assert.equal(registry.getPlugin(pluginId), null)
    } finally {
      unbind()
    }
  }
})

test('loop event cleanup rejects async and Proxy completions without assimilation', async () => {
  for (const mode of ['promise', 'thenable', 'proxy']) {
    const registry = createRuntimePluginRegistry()
    const listeners = new Set()
    let cleanupCalls = 0
    let thenCalls = 0
    let descriptorCalls = 0
    const events = {
      on(event, listener) {
        listeners.add(listener)
        return () => {
          cleanupCalls += 1
          listeners.delete(listener)
          if (mode === 'promise') return Promise.reject(new Error('async cleanup failed'))
          if (mode === 'thenable') {
            return { then() { thenCalls += 1 } }
          }
          return new Proxy({}, {
            getOwnPropertyDescriptor(target, key) {
              descriptorCalls += 1
              return Reflect.getOwnPropertyDescriptor(target, key)
            },
          })
        }
      },
      off(event, listener) {
        return listeners.delete(listener)
      },
    }
    const unbind = registry.bindLoopEvents(events)
    const pluginId = `event-cleanup-completion-${mode}`
    try {
      await registry.registerPlugin(manifest(pluginId), (ctx) => {
        ctx.events.on('request', () => undefined)
      })
      await assert.rejects(
        registry.unregisterPlugin(pluginId),
        (error) => error instanceof AggregateError
          && error.errors.length === 1
          && error.errors[0]?.code === 'PLUGIN_REVOKE_VISIBILITY_INDETERMINATE'
          && error.errors[0]?.retryable === false,
      )
      await Promise.resolve()
      assert.equal(cleanupCalls, 1)
      assert.equal(listeners.size, 0)
      assert.equal(thenCalls, 0)
      assert.equal(descriptorCalls, 0)
      assert.equal(registry.getPlugin(pluginId)?.state, 'visibility_indeterminate')
    } finally {
      unbind()
    }
  }
})

test('loop event cleanup retains its attachment handle until a later retry confirms removal', async () => {
  const registry = createRuntimePluginRegistry()
  const listeners = new Set()
  let cleanupCalls = 0
  const unbind = registry.bindLoopEvents({
    on(event, listener) {
      listeners.add(listener)
      return () => {
        cleanupCalls += 1
        if (cleanupCalls === 1) return Promise.resolve(false)
        return listeners.delete(listener)
      }
    },
    off(event, listener) {
      return listeners.delete(listener)
    },
  })
  await registry.registerPlugin(manifest('event-cleanup-retry'), (ctx) => {
    ctx.events.on('request', () => undefined)
  })

  await assert.rejects(
    registry.unregisterPlugin('event-cleanup-retry'),
    (error) => error?.code === 'PLUGIN_UNINSTALL_INCOMPLETE',
  )
  assert.equal(cleanupCalls, 1)
  assert.equal(listeners.size, 1)
  assert.equal(registry.getPlugin('event-cleanup-retry')?.state, 'visibility_indeterminate')

  assert.equal(await registry.unregisterPlugin('event-cleanup-retry'), true)
  assert.equal(cleanupCalls, 2)
  assert.equal(listeners.size, 0)
  assert.equal(registry.getPlugin('event-cleanup-retry'), null)
  assert.equal(unbind(), true)
})

test('loop event cleanup consumes per-binding v2 receipts and retries only retained bindings', async () => {
  const registry = createRuntimePluginRegistry()
  const createBus = ({ retainOnce = false } = {}) => {
    const listeners = new Set()
    let beginCalls = 0
    let directCalls = 0
    return {
      listeners,
      get beginCalls() { return beginCalls },
      get directCalls() { return directCalls },
      events: {
        on(event, listener) {
          listeners.add(listener)
          const dispose = () => {
            directCalls += 1
            throw new Error('v2 event attachment must use beginRevoke')
          }
          return v2Disposer(dispose, () => {
            beginCalls += 1
            if (retainOnce && beginCalls === 1) {
              return createRuntimePluginRevokeReceipt('retained', Promise.resolve(true))
            }
            listeners.delete(listener)
            return createRuntimePluginRevokeReceipt('revoked', Promise.resolve(true))
          })
        },
        off(event, listener) {
          return listeners.delete(listener)
        },
      },
    }
  }
  const revoked = createBus()
  const retained = createBus({ retainOnce: true })
  const unbindRevoked = registry.bindLoopEvents(revoked.events)
  const unbindRetained = registry.bindLoopEvents(retained.events)
  await registry.registerPlugin(manifest('event-v2-multi-binding'), (ctx) => {
    ctx.events.on('request', () => undefined)
  })

  await assert.rejects(
    registry.unregisterPlugin('event-v2-multi-binding'),
    (error) => error?.code === 'PLUGIN_UNINSTALL_INCOMPLETE',
  )
  assert.equal(revoked.beginCalls, 1)
  assert.equal(revoked.directCalls, 0)
  assert.equal(revoked.listeners.size, 0)
  assert.equal(retained.beginCalls, 1)
  assert.equal(retained.directCalls, 0)
  assert.equal(retained.listeners.size, 1)

  assert.equal(await registry.unregisterPlugin('event-v2-multi-binding'), true)
  assert.equal(revoked.beginCalls, 1)
  assert.equal(retained.beginCalls, 2)
  assert.equal(retained.listeners.size, 0)
  assert.equal(unbindRevoked(), true)
  assert.equal(unbindRetained(), true)
})

test('runtime tool and prompt definitions reject accessors without invoking them', async () => {
  const toolCases = [
    ['name', { spec: TOOL_SPEC, exec: async () => ({ ok: true }) }],
    ['spec', { name: 'plugin_echo', exec: async () => ({ ok: true }) }],
    ['exec', { name: 'plugin_echo', spec: TOOL_SPEC }],
  ]
  for (const [field, values] of toolCases) {
    const registry = createRuntimePluginRegistry()
    let getterCalls = 0
    const definition = { ...values }
    Object.defineProperty(definition, field, {
      enumerable: true,
      get() {
        getterCalls += 1
        return field === 'name'
          ? 'plugin_echo'
          : field === 'spec'
            ? TOOL_SPEC
            : async () => ({ ok: true })
      },
    })
    await assert.rejects(
      registry.registerPlugin(manifest(`accessor-tool-${field}`), (ctx) => {
        ctx.tools.register(definition)
      }),
      (error) => error?.code === 'PLUGIN_CONTRIBUTION_DEFINITION_INVALID'
        && error?.retryable === false
        && new RegExp(`definition\\.${field}`).test(error?.message || ''),
    )
    assert.equal(getterCalls, 0)
    assert.equal(registry.getPlugin(`accessor-tool-${field}`), null)
    assert.equal(getDynamicTool('plugin_echo'), null)
  }

  const promptCases = [
    ['id', { render: () => 'prompt' }],
    ['render', { id: 'lifecycle-context' }],
  ]
  for (const [field, values] of promptCases) {
    const registry = createRuntimePluginRegistry()
    let getterCalls = 0
    const definition = { ...values }
    Object.defineProperty(definition, field, {
      enumerable: true,
      get() {
        getterCalls += 1
        return field === 'id' ? 'lifecycle-context' : () => 'prompt'
      },
    })
    await assert.rejects(
      registry.registerPlugin(manifest(`accessor-prompt-${field}`), (ctx) => {
        ctx.prompts.register(definition)
      }),
      (error) => error?.code === 'PLUGIN_CONTRIBUTION_DEFINITION_INVALID'
        && error?.retryable === false
        && new RegExp(`definition\\.${field}`).test(error?.message || ''),
    )
    assert.equal(getterCalls, 0)
    assert.equal(registry.getPlugin(`accessor-prompt-${field}`), null)
  }
})

test('runtime tool and prompt definitions reject inherited contribution fields', async () => {
  const toolRegistry = createRuntimePluginRegistry()
  const inheritedTool = Object.create({
    name: 'plugin_echo',
    spec: TOOL_SPEC,
    exec: async () => ({ ok: true }),
  })
  await assert.rejects(
    toolRegistry.registerPlugin(manifest('inherited-tool-definition'), (ctx) => {
      ctx.tools.register(inheritedTool)
    }),
    (error) => error?.code === 'PLUGIN_CONTRIBUTION_DEFINITION_INVALID'
      && /definition\.name/.test(error?.message || ''),
  )
  assert.equal(toolRegistry.getPlugin('inherited-tool-definition'), null)
  assert.equal(getDynamicTool('plugin_echo'), null)

  const promptRegistry = createRuntimePluginRegistry()
  const inheritedPrompt = Object.create({
    id: 'lifecycle-context',
    render: () => 'prompt',
  })
  await assert.rejects(
    promptRegistry.registerPlugin(manifest('inherited-prompt-definition'), (ctx) => {
      ctx.prompts.register(inheritedPrompt)
    }),
    (error) => error?.code === 'PLUGIN_CONTRIBUTION_DEFINITION_INVALID'
      && /definition\.id/.test(error?.message || ''),
  )
  assert.equal(promptRegistry.getPlugin('inherited-prompt-definition'), null)
})

test('runtime tool and prompt definitions are registration-time descriptor snapshots', async () => {
  const registry = createRuntimePluginRegistry()
  let propertyReads = 0
  let descriptorReads = 0
  const toolTarget = {
    name: 'plugin_echo',
    spec: {
      ...TOOL_SPEC,
      function: { ...TOOL_SPEC.function, description: 'original definition' },
    },
    exec: async ({ value }) => ({ ok: true, value, owner: 'original' }),
  }
  const promptTarget = {
    id: 'lifecycle-context',
    render: () => 'original prompt',
  }
  const proxy = (target) => new Proxy(target, {
    get(object, key, receiver) {
      propertyReads += 1
      return Reflect.get(object, key, receiver)
    },
    getOwnPropertyDescriptor(object, key) {
      descriptorReads += 1
      return Reflect.getOwnPropertyDescriptor(object, key)
    },
  })

  await registry.registerPlugin(manifest('definition-snapshot-plugin', {
    contributes: ['tool:plugin_echo', 'prompt:lifecycle-context'],
  }), (ctx) => {
    ctx.tools.register(proxy(toolTarget))
    ctx.prompts.register(proxy(promptTarget))
  })
  const registrationDescriptorReads = descriptorReads
  toolTarget.name = 'mutated_name'
  toolTarget.spec.function.description = 'mutated definition'
  toolTarget.exec = async () => ({ ok: true, owner: 'mutated' })
  promptTarget.id = 'mutated-context'
  promptTarget.render = () => 'mutated prompt'

  assert.equal(propertyReads, 0)
  assert.equal(getDynamicTool('plugin_echo')?.spec?.function?.description, 'original definition')
  assert.deepEqual(await getDynamicTool('plugin_echo').exec({ value: 'snapshot' }), {
    ok: true,
    value: 'snapshot',
    owner: 'original',
  })
  assert.deepEqual(registry.renderPromptBlocks(), {
    blocks: [{
      id: 'lifecycle-context',
      pluginId: 'definition-snapshot-plugin',
      text: 'original prompt',
    }],
    errors: [],
  })
  assert.equal(propertyReads, 0)
  assert.equal(descriptorReads, registrationDescriptorReads)
  assert.equal(await registry.unregisterPlugin('definition-snapshot-plugin'), true)
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

test('runtime prompt scope is an own-data snapshot without getter or coercion execution', async () => {
  const registry = createRuntimePluginRegistry()
  const scopes = []
  await registry.registerPlugin(manifest('prompt-scope-boundary', {
    contributes: ['prompt:scope-boundary'],
  }), (ctx) => {
    ctx.prompts.register({
      id: 'scope-boundary',
      render: (scope) => {
        scopes.push(scope)
        return 'scope'
      },
    })
  })

  registry.renderPromptBlocks({
    userId: ' user ',
    sessionId: 'session',
    agentId: 'agent',
    skillIds: [' skill-a ', 'skill-a', 'skill-b'],
  })
  assert.deepEqual(scopes[0], {
    userId: 'user',
    sessionId: 'session',
    agentId: 'agent',
    skillIds: ['skill-a', 'skill-b'],
  })
  assert.equal(Object.isFrozen(scopes[0]), true)
  assert.equal(Object.isFrozen(scopes[0].skillIds), true)

  let getterCalls = 0
  const accessorInput = {}
  Object.defineProperty(accessorInput, 'userId', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'forged'
    },
  })
  assert.throws(
    () => registry.renderPromptBlocks(accessorInput),
    (error) => error?.code === 'PLUGIN_PROMPT_SCOPE_INVALID'
      && error?.retryable === false,
  )
  assert.equal(getterCalls, 0)

  const inheritedInput = Object.create({
    userId: 'forged-user',
    skillIds: ['forged-skill'],
  })
  registry.renderPromptBlocks(inheritedInput)
  assert.deepEqual(scopes[1], {
    userId: null,
    sessionId: null,
    agentId: null,
    skillIds: [],
  })

  let coercionCalls = 0
  const coercive = {
    [Symbol.toPrimitive]() {
      coercionCalls += 1
      return 'forged'
    },
  }
  assert.throws(
    () => registry.renderPromptBlocks({ userId: coercive }),
    (error) => error?.code === 'PLUGIN_PROMPT_SCOPE_INVALID',
  )
  assert.equal(coercionCalls, 0)

  const accessorSkills = []
  Object.defineProperty(accessorSkills, 0, {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'forged-skill'
    },
  })
  assert.throws(
    () => registry.renderPromptBlocks({ skillIds: accessorSkills }),
    (error) => error?.code === 'PLUGIN_PROMPT_SCOPE_INVALID'
      && /skillIds\[0\]/.test(error?.message || ''),
  )
  assert.equal(getterCalls, 0)

  const sparseSkills = []
  sparseSkills.length = 1
  const inheritedSkills = Object.create(Array.prototype)
  inheritedSkills[0] = 'forged-skill'
  Object.setPrototypeOf(sparseSkills, inheritedSkills)
  assert.throws(
    () => registry.renderPromptBlocks({ skillIds: sparseSkills }),
    (error) => error?.code === 'PLUGIN_PROMPT_SCOPE_INVALID'
      && /skillIds\[0\]/.test(error?.message || ''),
  )

  let proxyInputDescriptorCalls = 0
  const proxyInput = new Proxy({ userId: 'forged-user' }, {
    getOwnPropertyDescriptor(target, key) {
      proxyInputDescriptorCalls += 1
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  assert.throws(
    () => registry.renderPromptBlocks(proxyInput),
    (error) => error?.code === 'PLUGIN_PROMPT_SCOPE_INVALID'
      && error?.retryable === false
      && /scope\.input/.test(error?.message || ''),
  )
  assert.equal(proxyInputDescriptorCalls, 0)

  let proxySkillsDescriptorCalls = 0
  const proxySkills = new Proxy(['forged-skill'], {
    getOwnPropertyDescriptor(target, key) {
      proxySkillsDescriptorCalls += 1
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  assert.throws(
    () => registry.renderPromptBlocks({ skillIds: proxySkills }),
    (error) => error?.code === 'PLUGIN_PROMPT_SCOPE_INVALID'
      && error?.retryable === false
      && /scope\.skillIds/.test(error?.message || ''),
  )
  assert.equal(proxySkillsDescriptorCalls, 0)
  assert.equal(scopes.length, 2)
  assert.equal(await registry.unregisterPlugin('prompt-scope-boundary'), true)
})

test('runtime prompt contributions are bounded, synchronous, deterministic, and fail open', async () => {
  const audit = []
  let thenCalls = 0
  const registry = createRuntimePluginRegistry({ audit: (event) => audit.push(event) })
  const definitions = [
    ['first-context', () => 'first'],
    ['invalid-context', () => ({ text: 'not accepted' })],
    ['oversized-context', () => 'x'.repeat((16 * 1024) + 1)],
    ['async-context', async () => 'not accepted'],
    ['thenable-context', () => ({ then() { thenCalls += 1 } })],
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
    ['thenable-context', 'PLUGIN_PROMPT_ASYNC_UNSUPPORTED'],
  ])
  await Promise.resolve()
  assert.equal(thenCalls, 0)
  assert.deepEqual(
    audit.filter(({ event }) => event === 'plugin.prompt_failed').map(({ promptId, code }) => [promptId, code]),
    rendered.errors.map(({ id, code }) => [id, code]),
  )
  assert.equal(await registry.unregisterPlugin('prompt-bounds-plugin'), true)
})

test('runtime prompt completion remains inside synchronous callback accounting', async () => {
  const registry = createRuntimePluginRegistry()
  let unregisterAttempt = null
  await registry.registerPlugin(manifest('prompt-result-accounting-plugin', {
    contributes: ['prompt:result-accounting'],
  }), (ctx) => {
    ctx.prompts.register({
      id: 'result-accounting',
      render: () => new Proxy({ text: 'not accepted' }, {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'then' && !unregisterAttempt) {
            unregisterAttempt = registry.unregisterPlugin('prompt-result-accounting-plugin').then(
              (value) => ({ value }),
              (error) => ({ error }),
            )
          }
          return Reflect.getOwnPropertyDescriptor(target, key)
        },
      }),
    })
  })

  assert.deepEqual(registry.renderPromptBlocks(), {
    blocks: [],
    errors: [{
      id: 'result-accounting',
      pluginId: 'prompt-result-accounting-plugin',
      code: 'PLUGIN_PROMPT_RESULT_INVALID',
    }],
  })
  const attempted = await settleWithin(unregisterAttempt)
  assert.equal(attempted.value, undefined)
  assert.equal(attempted.error?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(registry.getPlugin('prompt-result-accounting-plugin')?.state, 'active')
  assert.equal(await registry.unregisterPlugin('prompt-result-accounting-plugin'), true)
})

test('runtime prompt thrown values are sanitized before callback accounting ends', async () => {
  const registry = createRuntimePluginRegistry()
  let unregisterAttempt = null
  let messageGetterCalls = 0
  const thrown = {}
  Object.defineProperties(thrown, {
    message: {
      get() {
        messageGetterCalls += 1
        return 'getter must not execute'
      },
    },
    code: { value: 'PLUGIN_CUSTOM_PROMPT_FAILURE' },
    retryable: { value: true },
    cause: { value: { promptCapability: true } },
  })
  const trappedError = new Proxy(thrown, {
    getOwnPropertyDescriptor(target, key) {
      if (!unregisterAttempt) {
        unregisterAttempt = registry.unregisterPlugin('prompt-error-accounting-plugin').then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
      }
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  await registry.registerPlugin(manifest('prompt-error-accounting-plugin', {
    contributes: ['prompt:error-accounting'],
  }), (ctx) => {
    ctx.prompts.register({
      id: 'error-accounting',
      render: () => { throw trappedError },
    })
  })

  assert.deepEqual(registry.renderPromptBlocks(), {
    blocks: [],
    errors: [{
      id: 'error-accounting',
      pluginId: 'prompt-error-accounting-plugin',
      code: 'PLUGIN_CUSTOM_PROMPT_FAILURE',
    }],
  })
  assert.equal(messageGetterCalls, 0)
  const attempted = await settleWithin(unregisterAttempt)
  assert.equal(attempted.value, undefined)
  assert.equal(attempted.error?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(registry.getPlugin('prompt-error-accounting-plugin')?.state, 'active')
  assert.equal(await registry.unregisterPlugin('prompt-error-accounting-plugin'), true)
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
    assert.equal(ctx.services.has('base-service'), true)
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
    assert.equal(ctx.services.has('immutable-base-service'), true)
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
  assert.equal(registry.hasService('late-service'), false)
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

test('plugin setup self-unregister fails fast instead of awaiting install settlement', async () => {
  const registry = createRuntimePluginRegistry()
  let observedError = null
  const installed = await settleWithin(registry.registerPlugin(manifest('setup-self-unregister'), async () => {
    try {
      await registry.unregisterPlugin('setup-self-unregister')
    } catch (error) {
      observedError = error
    }
  }))

  assert.equal(installed.state, 'active')
  assert.equal(observedError?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(observedError?.retryable, false)
  assert.match(observedError?.message || '', /would deadlock callback drain/)
  assert.equal(await registry.unregisterPlugin('setup-self-unregister'), true)
})

test('plugin setup shutdown fails fast instead of awaiting its own installation', async () => {
  const registry = createRuntimePluginRegistry()
  let observedError = null
  const installed = await settleWithin(registry.registerPlugin(manifest('setup-shutdown'), async () => {
    try {
      await registry.shutdown()
    } catch (error) {
      observedError = error
    }
  }))

  assert.equal(installed.state, 'active')
  assert.equal(observedError?.code, 'PLUGIN_CALLBACK_SHUTDOWN_DEADLOCK')
  assert.equal(observedError?.retryable, false)
  assert.match(observedError?.message || '', /would deadlock callback drain/)
  assert.equal(await registry.unregisterPlugin('setup-shutdown'), true)
})

test('plugin setup return-effect traversal remains inside installation accounting', async () => {
  const registry = createRuntimePluginRegistry()
  let unregisterAttempt = null
  let cleanupCalls = 0
  const effect = new Proxy({
    dispose() {
      cleanupCalls += 1
    },
  }, {
    getOwnPropertyDescriptor(target, key) {
      if (!unregisterAttempt) {
        unregisterAttempt = registry.unregisterPlugin('setup-return-effect-accounting').then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
      }
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })

  const installed = await registry.registerPlugin(
    manifest('setup-return-effect-accounting'),
    () => effect,
  )
  assert.equal(installed.state, 'active')
  const attempted = await settleWithin(unregisterAttempt)
  assert.equal(attempted.value, undefined)
  assert.equal(attempted.error?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(cleanupCalls, 0)
  assert.equal(await registry.unregisterPlugin('setup-return-effect-accounting'), true)
  assert.equal(cleanupCalls, 1)
})

test('plugin effect arrays use dense own descriptor snapshots without iterator access', async () => {
  const registry = createRuntimePluginRegistry()
  const calls = []
  let propertyReads = 0
  let iteratorGetterCalls = 0
  const original = () => calls.push('original')
  const source = [original]
  Object.defineProperty(source, Symbol.iterator, {
    configurable: true,
    get() {
      iteratorGetterCalls += 1
      return Array.prototype[Symbol.iterator]
    },
  })
  const effects = new Proxy(source, {
    get(target, key, receiver) {
      propertyReads += 1
      return Reflect.get(target, key, receiver)
    },
  })

  await registry.registerPlugin(manifest('effect-array-descriptor-snapshot'), (ctx) => {
    ctx.lifecycle.onDispose(effects)
  })
  source[0] = () => calls.push('mutated')
  assert.equal(propertyReads, 0)
  assert.equal(iteratorGetterCalls, 0)
  assert.equal(await registry.unregisterPlugin('effect-array-descriptor-snapshot'), true)
  assert.deepEqual(calls, ['original'])
})

test('plugin effect arrays reject accessors, sparse entries, and inherited entries', async () => {
  let getterCalls = 0
  const accessorEffects = []
  Object.defineProperty(accessorEffects, 0, {
    get() {
      getterCalls += 1
      return () => {}
    },
  })
  const sparseEffects = new Array(1)
  const inheritedEffects = new Array(1)
  Object.setPrototypeOf(inheritedEffects, { 0: () => {} })

  for (const [pluginId, effects] of [
    ['accessor-effect-array', accessorEffects],
    ['sparse-effect-array', sparseEffects],
    ['inherited-effect-array', inheritedEffects],
  ]) {
    const registry = createRuntimePluginRegistry()
    await assert.rejects(
      registry.registerPlugin(manifest(pluginId), () => effects),
      (error) => error?.code === 'PLUGIN_DISPOSER_DEFINITION_INVALID'
        && error?.retryable === false
        && /array\[0\] must be an own data property/.test(error?.message || ''),
    )
    assert.equal(registry.getPlugin(pluginId), null)
  }
  assert.equal(getterCalls, 0)
})

test('plugin effect batches commit atomically after every disposer validates', async () => {
  const registry = createRuntimePluginRegistry()
  let rejectedPrefixCleanupCalls = 0
  let committedCleanupCalls = 0
  let observedError = null

  await registry.registerPlugin(manifest('effect-batch-atomicity'), (ctx) => {
    try {
      ctx.lifecycle.onDispose([
        () => { rejectedPrefixCleanupCalls += 1 },
        {},
      ])
    } catch (error) {
      observedError = error
    }
    ctx.lifecycle.onDispose(() => { committedCleanupCalls += 1 })
  })

  assert.equal(observedError?.code, 'PLUGIN_DISPOSER_DEFINITION_INVALID')
  assert.equal(observedError?.retryable, false)
  assert.match(observedError?.message || '', /must provide a disposer/)
  assert.equal(rejectedPrefixCleanupCalls, 0)
  assert.equal(committedCleanupCalls, 0)
  assert.equal(await registry.unregisterPlugin('effect-batch-atomicity'), true)
  assert.equal(rejectedPrefixCleanupCalls, 0)
  assert.equal(committedCleanupCalls, 1)
})

test('plugin effect collections reject excessive depth, nodes, and disposer counts', async () => {
  let tooDeep = () => {}
  for (let depth = 0; depth < 34; depth += 1) tooDeep = [tooDeep]
  const cases = [
    ['effect-collection-too-deep', tooDeep, /too deep/],
    ['effect-collection-too-many-nodes', new Array(8_193), /too many nodes/],
    [
      'effect-collection-too-many-disposers',
      Array.from({ length: 4_097 }, () => () => {}),
      /too many disposers/,
    ],
  ]

  for (const [pluginId, effects, message] of cases) {
    const registry = createRuntimePluginRegistry()
    await assert.rejects(
      registry.registerPlugin(manifest(pluginId), () => effects),
      (error) => error?.code === 'PLUGIN_DISPOSER_DEFINITION_INVALID'
        && error?.retryable === false
        && message.test(error?.message || ''),
    )
    assert.equal(registry.getPlugin(pluginId), null)
    assert.deepEqual(registry.listPlugins(), [])
  }
})

test('plugin effect Sets ignore overridden iterators and snapshot cleanup callbacks', async () => {
  const registry = createRuntimePluginRegistry()
  const calls = []
  let iteratorGetterCalls = 0
  const original = () => calls.push('original')
  const effects = new Set([original])
  Object.defineProperty(effects, Symbol.iterator, {
    configurable: true,
    get() {
      iteratorGetterCalls += 1
      return function* forgedIterator() {
        yield () => calls.push('forged')
      }
    },
  })

  await registry.registerPlugin(manifest('effect-set-intrinsic-iterator'), () => effects)
  effects.delete(original)
  effects.add(() => calls.push('mutated'))
  assert.equal(iteratorGetterCalls, 0)
  assert.equal(await registry.unregisterPlugin('effect-set-intrinsic-iterator'), true)
  assert.deepEqual(calls, ['original'])
})

test('plugin effect Set brand checks do not execute Proxy traps', async () => {
  const registry = createRuntimePluginRegistry()
  let propertyReads = 0
  let prototypeReads = 0
  const effects = new Proxy(new Set([() => {}]), {
    get(target, key, receiver) {
      propertyReads += 1
      return Reflect.get(target, key, receiver)
    },
    getPrototypeOf(target) {
      prototypeReads += 1
      return Reflect.getPrototypeOf(target)
    },
  })

  await assert.rejects(
    registry.registerPlugin(manifest('effect-set-proxy-brand'), (ctx) => {
      ctx.lifecycle.onDispose(effects)
    }),
    (error) => error?.code === 'PLUGIN_DISPOSER_DEFINITION_INVALID'
      && error?.retryable === false
      && /must provide a disposer/.test(error?.message || ''),
  )
  assert.equal(propertyReads, 0)
  assert.equal(prototypeReads, 0)
  assert.equal(registry.getPlugin('effect-set-proxy-brand'), null)
})

test('plugin setup thrown values cross as detached non-retryable errors', async () => {
  const registry = createRuntimePluginRegistry()
  let unregisterAttempt = null
  let messageGetterCalls = 0
  const thrown = {}
  Object.defineProperties(thrown, {
    message: {
      get() {
        messageGetterCalls += 1
        return 'getter must not execute'
      },
    },
    code: { value: 'PLUGIN_CUSTOM_SETUP_FAILURE' },
    retryable: { value: true },
    cause: { value: { setupCapability: true } },
  })
  const trappedError = new Proxy(thrown, {
    getOwnPropertyDescriptor(target, key) {
      if (!unregisterAttempt) {
        unregisterAttempt = registry.unregisterPlugin('setup-error-boundary').then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
      }
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })

  await assert.rejects(
    settleWithin(registry.registerPlugin(manifest('setup-error-boundary'), () => {
      throw trappedError
    })),
    (error) => {
      assert.notEqual(error, trappedError)
      assert.equal(error?.code, 'PLUGIN_CUSTOM_SETUP_FAILURE')
      assert.equal(error?.retryable, false)
      assert.equal(error?.message, 'plugin setup failed: setup-error-boundary')
      assert.equal(error?.pluginId, 'setup-error-boundary')
      assert.equal(error?.phase, 'setup')
      assert.equal(Object.hasOwn(error, 'cause'), false)
      return true
    },
  )
  assert.equal(messageGetterCalls, 0)
  const attempted = await settleWithin(unregisterAttempt)
  assert.equal(attempted.value, undefined)
  assert.equal(attempted.error?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(registry.getPlugin('setup-error-boundary'), null)
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
  assert.equal(registry.hasService('shutdown-installing-service'), false)
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
    assert.equal(ctx.services.has('async-base-service'), true)
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
      assert.equal(ctx.services.has('cleanup-base-service'), true)
      await cleanupGate
      assert.equal(ctx.services.has('cleanup-base-service'), true)
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
      assert.equal(ctx.services.has('rollback-base-service'), true)
      await rollbackGate
      assert.equal(ctx.services.has('rollback-base-service'), true)
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
  assert.equal(hasPluginService('loop-marker'), true)

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
  assert.equal(hasPluginService('loop-marker'), false)
})

test('public Agent Loop executes a plugin tool once and feeds its result back to the model', async () => {
  const jobId = `plugin-tool-loop-job-${randomUUID()}`
  let executions = 0
  let modelCalls = 0
  await registerPlugin(manifest('loop-tool-plugin'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_echo',
      spec: TOOL_SPEC,
      exec: async (args, executionContext) => {
        executions += 1
        assert.deepEqual(args, { value: 'from-model' })
        assert.equal(Object.isFrozen(args), true)
        assert.equal(Object.isFrozen(executionContext), true)
        assert.equal(executionContext.name, 'plugin_echo')
        assert.equal(executionContext.userId, 'plugin-loop-user')
        assert.equal(executionContext.jobId, jobId)
        assert.equal(executionContext.stepId, 'plugin-tool-loop-step')
        assert.equal(executionContext.toolCallId, 'plugin-echo-call')
        assert.equal(executionContext.origin, 'plugin')
        assert.equal(executionContext.source, 'loop-tool-plugin')
        assert.equal(executionContext.signal instanceof AbortSignal, true)
        assert.equal(Object.hasOwn(executionContext, 'job'), false)
        assert.equal(Object.hasOwn(executionContext, 'step'), false)
        assert.equal(Object.hasOwn(executionContext, 'budget'), false)
        assert.equal(Object.hasOwn(executionContext, 'approvalContext'), false)
        return { echoed: args.value }
      },
    })
  })

  const result = await runToolLoop({
    job: {
      id: jobId,
      userId: 'plugin-loop-user',
      origin: 'chat',
      prompt: 'Use plugin_echo and report the result.',
    },
    step: { id: 'plugin-tool-loop-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Use plugin_echo and report the result.' }],
    toolSpecs: [getDynamicTool('plugin_echo').spec],
    enableToolHooks: false,
    maxIters: 3,
    requestToolApproval: async ({ args }) => ({
      proceed: true,
      args,
      approvalId: 'plugin-loop-tool-approved',
    }),
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

test('plugin tool invocation isolates data, host context, and callback-scoped cancellation', async () => {
  const registry = createRuntimePluginRegistry()
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  const receivedArgs = []
  const receivedScopes = []
  let pluginResult = null

  await registry.registerPlugin(manifest('tool-boundary-plugin'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_echo',
      spec: TOOL_SPEC,
      exec: async (args, scope) => {
        receivedArgs.push(args)
        receivedScopes.push(scope)
        assert.equal(Object.isFrozen(args), true)
        assert.equal(Object.isFrozen(args.nested), true)
        assert.equal(Object.isFrozen(scope), true)
        if (args.value === 'wait') {
          markStarted()
          await new Promise((resolve) => {
            if (scope.signal.aborted) resolve()
            else scope.signal.addEventListener('abort', resolve, { once: true })
          })
        }
        pluginResult = {
          value: args.value,
          nested: { aborted: scope.signal.aborted },
        }
        return pluginResult
      },
    })
  })

  const tool = getDynamicTool('plugin_echo')
  const hostController = new AbortController()
  const hostContext = {
    name: 'forged-name',
    userId: 'tool-user',
    job: { id: 'tool-job', secret: 'host-job-secret' },
    step: { id: 'tool-step', secret: 'host-step-secret' },
    signal: hostController.signal,
    budget: { consume() {} },
    approvalContext: { approve() {} },
    skillId: 'tool-skill',
    toolCallId: 'tool-call',
    idempotencyKey: 'tool-idempotency',
    origin: 'forged-origin',
    source: 'forged-source',
  }
  const input = { value: 'wait', nested: { hostMutable: true } }
  const inFlight = tool.exec(input, hostContext)
  await started

  const scope = receivedScopes[0]
  assert.notEqual(scope.signal, hostController.signal)
  assert.deepEqual({
    name: scope.name,
    userId: scope.userId,
    jobId: scope.jobId,
    stepId: scope.stepId,
    skillId: scope.skillId,
    toolCallId: scope.toolCallId,
    idempotencyKey: scope.idempotencyKey,
    origin: scope.origin,
    source: scope.source,
  }, {
    name: 'plugin_echo',
    userId: 'tool-user',
    jobId: 'tool-job',
    stepId: 'tool-step',
    skillId: 'tool-skill',
    toolCallId: 'tool-call',
    idempotencyKey: 'tool-idempotency',
    origin: 'plugin',
    source: 'tool-boundary-plugin',
  })
  for (const key of ['job', 'step', 'budget', 'approvalContext']) {
    assert.equal(Object.hasOwn(scope, key), false)
  }

  input.nested.hostMutable = false
  assert.equal(receivedArgs[0].nested.hostMutable, true)
  hostController.abort()
  const result = await inFlight
  assert.equal(scope.signal.aborted, true)
  assert.deepEqual(result, { value: 'wait', nested: { aborted: true } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.nested), true)
  pluginResult.nested.aborted = false
  assert.equal(result.nested.aborted, true)

  const detachedController = new AbortController()
  const immediate = await tool.exec(
    { value: 'immediate', nested: { hostMutable: true } },
    { signal: detachedController.signal },
  )
  const detachedSignal = receivedScopes[1].signal
  assert.deepEqual(immediate, { value: 'immediate', nested: { aborted: false } })
  detachedController.abort()
  assert.equal(detachedSignal.aborted, false)

  let proxySignalReads = 0
  const proxyController = new AbortController()
  const proxySignal = new Proxy(proxyController.signal, {
    get(target, key, receiver) {
      proxySignalReads += 1
      return Reflect.get(target, key, receiver)
    },
  })
  const proxySignalResult = await tool.exec(
    { value: 'proxy-signal', nested: { hostMutable: true } },
    { signal: proxySignal },
  )
  const isolatedProxySignal = receivedScopes[2].signal
  assert.deepEqual(proxySignalResult, { value: 'proxy-signal', nested: { aborted: false } })
  assert.equal(proxySignalReads, 0)
  proxyController.abort()
  assert.equal(isolatedProxySignal.aborted, false)

  let forgedSignalCalls = 0
  const forgedSignal = Object.create(AbortSignal.prototype)
  Object.defineProperties(forgedSignal, {
    aborted: {
      get() {
        forgedSignalCalls += 1
        return false
      },
    },
    addEventListener: {
      value() {
        forgedSignalCalls += 1
      },
    },
    removeEventListener: {
      value() {
        forgedSignalCalls += 1
      },
    },
  })
  const forgedSignalResult = await tool.exec(
    { value: 'forged-signal', nested: { hostMutable: true } },
    { signal: forgedSignal },
  )
  assert.deepEqual(forgedSignalResult, { value: 'forged-signal', nested: { aborted: false } })
  assert.equal(forgedSignalCalls, 0)

  let contextDescriptorCalls = 0
  const proxyContext = new Proxy({
    userId: 'hidden-user',
    job: { id: 'hidden-job' },
    step: { id: 'hidden-step' },
  }, {
    getOwnPropertyDescriptor(target, key) {
      contextDescriptorCalls += 1
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  await tool.exec(
    { value: 'proxy-context', nested: { hostMutable: true } },
    proxyContext,
  )
  const isolatedProxyContext = receivedScopes[4]
  assert.deepEqual({
    userId: isolatedProxyContext.userId,
    jobId: isolatedProxyContext.jobId,
    stepId: isolatedProxyContext.stepId,
    skillId: isolatedProxyContext.skillId,
    toolCallId: isolatedProxyContext.toolCallId,
    idempotencyKey: isolatedProxyContext.idempotencyKey,
  }, {
    userId: null,
    jobId: null,
    stepId: null,
    skillId: null,
    toolCallId: null,
    idempotencyKey: null,
  })
  assert.equal(contextDescriptorCalls, 0)

  let nestedContextDescriptorCalls = 0
  const nestedContextProxy = (id) => new Proxy({ id }, {
    getOwnPropertyDescriptor(target, key) {
      nestedContextDescriptorCalls += 1
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  await tool.exec(
    { value: 'proxy-nested-context', nested: { hostMutable: true } },
    {
      userId: 'visible-user',
      job: nestedContextProxy('hidden-job'),
      step: nestedContextProxy('hidden-step'),
    },
  )
  const isolatedNestedContext = receivedScopes[5]
  assert.equal(isolatedNestedContext.userId, 'visible-user')
  assert.equal(isolatedNestedContext.jobId, null)
  assert.equal(isolatedNestedContext.stepId, null)
  assert.equal(nestedContextDescriptorCalls, 0)

  assert.equal(await registry.unregisterPlugin('tool-boundary-plugin'), true)
})

test('plugin tool invocation rejects accessor arguments and capability results', async () => {
  const registry = createRuntimePluginRegistry()
  let executions = 0
  let returnCapability = false
  await registry.registerPlugin(manifest('tool-data-rejection-plugin'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_echo',
      spec: TOOL_SPEC,
      exec: async ({ value }) => {
        executions += 1
        if (returnCapability) return { value, capability() {} }
        return { value }
      },
    })
  })

  const tool = getDynamicTool('plugin_echo')
  let getterCalls = 0
  const accessorArgs = { value: 'blocked' }
  Object.defineProperty(accessorArgs, 'trap', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'not data'
    },
  })
  await assert.rejects(
    tool.exec(accessorArgs),
    (error) => error?.code === 'PLUGIN_TOOL_ARGUMENT_INVALID'
      && error?.retryable === false,
  )
  assert.equal(getterCalls, 0)
  assert.equal(executions, 0)

  returnCapability = true
  await assert.rejects(
    tool.exec({ value: 'blocked-result' }),
    (error) => error?.code === 'PLUGIN_TOOL_RESULT_INVALID'
      && error?.retryable === false,
  )
  assert.equal(executions, 1)
  assert.equal(await registry.unregisterPlugin('tool-data-rejection-plugin'), true)
})

test('plugin tool result traversal remains inside lifecycle callback accounting', async () => {
  const registry = createRuntimePluginRegistry()
  let unregisterAttempt = null
  await registry.registerPlugin(manifest('tool-result-accounting-plugin'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_echo',
      spec: TOOL_SPEC,
      exec: async () => new Proxy({ value: 'accounted-result' }, {
        getPrototypeOf(target) {
          if (!unregisterAttempt) {
            unregisterAttempt = registry.unregisterPlugin('tool-result-accounting-plugin').then(
              (value) => ({ value }),
              (error) => ({ error }),
            )
          }
          return Reflect.getPrototypeOf(target)
        },
      }),
    })
  })

  const result = await getDynamicTool('plugin_echo').exec({ value: 'probe' })
  assert.deepEqual(result, { value: 'accounted-result' })
  assert.equal(Object.isFrozen(result), true)
  const attempted = await settleWithin(unregisterAttempt)
  assert.equal(attempted.value, undefined)
  assert.equal(attempted.error?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(registry.getPlugin('tool-result-accounting-plugin')?.state, 'active')
  assert.equal(await registry.unregisterPlugin('tool-result-accounting-plugin'), true)
})

test('plugin tool thrown values cross the boundary as detached data-only errors', async () => {
  const registry = createRuntimePluginRegistry()
  let unregisterAttempt = null
  let messageGetterCalls = 0
  const thrown = {}
  Object.defineProperties(thrown, {
    message: {
      configurable: true,
      get() {
        messageGetterCalls += 1
        return 'getter must not execute'
      },
    },
    code: { value: 'PLUGIN_CUSTOM_FAILURE' },
    retryable: { value: true },
    cause: { value: { hostCapability: true } },
  })
  const trappedError = new Proxy(thrown, {
    getOwnPropertyDescriptor(target, key) {
      if (!unregisterAttempt) {
        unregisterAttempt = registry.unregisterPlugin('tool-error-accounting-plugin').then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
      }
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })

  await registry.registerPlugin(manifest('tool-error-accounting-plugin'), (ctx) => {
    ctx.tools.register({
      name: 'plugin_echo',
      spec: TOOL_SPEC,
      exec: async () => { throw trappedError },
    })
  })

  await assert.rejects(
    getDynamicTool('plugin_echo').exec({ value: 'probe' }),
    (error) => {
      assert.notEqual(error, trappedError)
      assert.equal(error?.code, 'PLUGIN_CUSTOM_FAILURE')
      assert.equal(error?.retryable, false)
      assert.equal(error?.message, 'plugin tool plugin_echo execution failed')
      assert.equal(Object.hasOwn(error, 'cause'), false)
      return true
    },
  )
  assert.equal(messageGetterCalls, 0)
  const attempted = await settleWithin(unregisterAttempt)
  assert.equal(attempted.value, undefined)
  assert.equal(attempted.error?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(registry.getPlugin('tool-error-accounting-plugin')?.state, 'active')
  assert.equal(await registry.unregisterPlugin('tool-error-accounting-plugin'), true)
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

test('plugin tool schema arrays use descriptor snapshots without property reads', async () => {
  const registry = createRuntimePluginRegistry()
  let propertyReads = 0
  const requiredSource = ['value']
  const required = new Proxy(requiredSource, {
    get(target, key, receiver) {
      propertyReads += 1
      return Reflect.get(target, key, receiver)
    },
  })
  await registry.registerPlugin(manifest('schema-array-descriptor-snapshot', {
    contributes: ['tool:plugin_descriptor_array'],
  }), (ctx) => {
    ctx.tools.register({
      name: 'plugin_descriptor_array',
      spec: {
        type: 'function',
        function: {
          name: 'plugin_descriptor_array',
          description: 'Descriptor array snapshot probe.',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required,
            additionalProperties: false,
          },
        },
      },
      exec: async () => ({ ok: true }),
    })
  })
  requiredSource[0] = 'mutated'

  const stored = getDynamicTool('plugin_descriptor_array')?.spec
  assert.deepEqual(stored?.function?.parameters?.required, ['value'])
  assert.equal(Object.isFrozen(stored?.function?.parameters?.required), true)
  assert.equal(propertyReads, 0)
  assert.equal(await registry.unregisterPlugin('schema-array-descriptor-snapshot'), true)
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
    // This race exercises the legacy dynamic-registration compatibility layer.
    // The production registry has an authoritative capability host and rejects
    // same-slot plugin conflicts before they can shadow one another.
    const registry = createRuntimePluginRegistry()
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
    await registry.registerPlugin(manifest(`${visibleOwner}-plugin`), (ctx) => {
      ctx.tools.register({
        name,
        spec,
        exec: async () => { visibleExecutions += 1; return { ok: true, owner: visibleOwner } },
      })
    })
    if (changeOwner === 'restore') {
      await registry.registerPlugin(manifest(`${pluginStem}-shadow-plugin`), (ctx) => {
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
      await registry.registerPlugin(manifest(`${pluginStem}-changed-plugin`), (ctx) => {
        ctx.tools.register({
          name,
          spec,
          exec: async () => { changedExecutions += 1; return { ok: true, owner: 'changed' } },
        })
      })
    } else {
      assert.equal(await registry.unregisterPlugin(`${pluginStem}-shadow-plugin`), true)
    }
    releaseModel()
    await running
    assert.equal(visibleExecutions, 0)
    assert.equal(changedExecutions, 0)
    assert.match(JSON.stringify(observedMessages), /dynamic_tool_registration_changed/)
    assert.equal(observedToolNames.includes(name), false)
    await registry.shutdown()
  }

  await runRace({
    name: 'plugin_registration_shadow_race',
    visibleOwner: 'registration-shadow-base',
    changeOwner: 'shadow',
  })
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

  const staleExecutor = getDynamicTool('plugin_echo')
  const inFlight = executeServerTool({
    name: 'plugin_echo',
    args: { value: 'started-before-unload' },
  })
  await toolStarted
  const unloading = registry.unregisterPlugin('atomic-unload')
  const duplicateUnloading = registry.unregisterPlugin('atomic-unload')

  assert.equal(registry.getPlugin('atomic-unload')?.state, 'uninstalling')
  assert.equal(getDynamicTool('plugin_echo'), null)
  let staleGetterCalls = 0
  const staleArgs = {}
  Object.defineProperty(staleArgs, 'value', {
    enumerable: true,
    get() {
      staleGetterCalls += 1
      return 'must-not-be-read'
    },
  })
  await assert.rejects(
    staleExecutor.exec(staleArgs),
    (error) => error?.code === 'PLUGIN_TOOL_UNAVAILABLE'
      && error?.retryable === false,
  )
  assert.equal(staleGetterCalls, 0)
  assert.equal(registry.hasService('atomic-service'), false)
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

test('plugin disposer self-unregister fails fast instead of awaiting its own uninstall', async () => {
  const registry = createRuntimePluginRegistry()
  let observedError = null
  await registry.registerPlugin(manifest('disposer-self-unregister'), (ctx) => {
    ctx.lifecycle.onDispose(async () => {
      try {
        await registry.unregisterPlugin('disposer-self-unregister')
      } catch (error) {
        observedError = error
      }
    })
  })

  assert.equal(await settleWithin(registry.unregisterPlugin('disposer-self-unregister')), true)
  assert.equal(observedError?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(observedError?.retryable, false)
  assert.match(observedError?.message || '', /would deadlock callback drain/)
  assert.equal(registry.getPlugin('disposer-self-unregister'), null)
})

test('plugin disposer shutdown fails fast instead of awaiting the active cleanup chain', async () => {
  const registry = createRuntimePluginRegistry()
  let observedError = null
  await registry.registerPlugin(manifest('disposer-shutdown'), (ctx) => {
    ctx.lifecycle.onDispose(async () => {
      try {
        await registry.shutdown()
      } catch (error) {
        observedError = error
      }
    })
  })

  assert.equal(await settleWithin(registry.unregisterPlugin('disposer-shutdown')), true)
  assert.equal(observedError?.code, 'PLUGIN_CALLBACK_SHUTDOWN_DEADLOCK')
  assert.equal(observedError?.retryable, false)
  assert.match(observedError?.message || '', /would deadlock callback drain/)
  assert.deepEqual(registry.listPlugins(), [])
})

test('plugin rollback disposer cannot await unregister before install settles', async () => {
  const registry = createRuntimePluginRegistry()
  let observedError = null
  await assert.rejects(
    settleWithin(registry.registerPlugin(manifest('rollback-disposer-self-unregister'), (ctx) => {
      ctx.lifecycle.onDispose(async () => {
        try {
          await registry.unregisterPlugin('rollback-disposer-self-unregister')
        } catch (error) {
          observedError = error
        }
      })
      throw new Error('setup failed after registering disposer')
    })),
    /setup failed after registering disposer/,
  )

  assert.equal(observedError?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(observedError?.retryable, false)
  assert.equal(registry.getPlugin('rollback-disposer-self-unregister'), null)
})

test('plugin disposer objects use registration-time own-method snapshots', async () => {
  const registry = createRuntimePluginRegistry()
  const calls = []
  let getCalls = 0
  let descriptorCalls = 0
  const target = {
    dispose() {
      calls.push('original')
    },
  }
  const effect = new Proxy(target, {
    get(object, key, receiver) {
      getCalls += 1
      return Reflect.get(object, key, receiver)
    },
    getOwnPropertyDescriptor(object, key) {
      descriptorCalls += 1
      return Reflect.getOwnPropertyDescriptor(object, key)
    },
  })
  await registry.registerPlugin(manifest('disposer-method-snapshot'), (ctx) => {
    ctx.lifecycle.onDispose(effect)
  })
  const registrationDescriptorCalls = descriptorCalls
  target.dispose = () => calls.push('mutated')

  assert.equal(await registry.unregisterPlugin('disposer-method-snapshot'), true)
  assert.deepEqual(calls, ['original'])
  assert.equal(getCalls, 0)
  assert.equal(descriptorCalls, registrationDescriptorCalls)
})

test('plugin disposer definitions reject accessors and inherited methods without invoking them', async () => {
  let getterCalls = 0
  const accessorRegistry = createRuntimePluginRegistry()
  const accessorEffect = {}
  Object.defineProperty(accessorEffect, 'dispose', {
    get() {
      getterCalls += 1
      return () => {}
    },
  })
  await assert.rejects(
    accessorRegistry.registerPlugin(manifest('accessor-disposer-definition'), (ctx) => {
      ctx.lifecycle.onDispose(accessorEffect)
    }),
    /dispose must be an own function property/,
  )
  assert.equal(getterCalls, 0)
  assert.equal(accessorRegistry.getPlugin('accessor-disposer-definition'), null)

  const inheritedRegistry = createRuntimePluginRegistry()
  const inheritedEffect = Object.create({ dispose() {} })
  await assert.rejects(
    inheritedRegistry.registerPlugin(manifest('inherited-disposer-definition'), (ctx) => {
      ctx.lifecycle.onDispose(inheritedEffect)
    }),
    /plugin side effect must provide a disposer/,
  )
  assert.equal(inheritedRegistry.getPlugin('inherited-disposer-definition'), null)
})

test('async visible contribution revocation cannot await self-unregister', async () => {
  let registry = null
  let selfUnregisterError = null
  registry = createRuntimePluginRegistry({
    registerTool() {
      const dispose = async () => {
        await Promise.resolve()
        try {
          await registry.unregisterPlugin('visible-revocation-self-unregister')
        } catch (error) {
          selfUnregisterError = error
        }
      }
      return v2Disposer(dispose, () => createRuntimePluginRevokeReceipt(
        'revoked',
        dispose(),
      ))
    },
  })
  await registry.registerPlugin(manifest('visible-revocation-self-unregister', {
    contributes: ['tool:visible_revocation_self_unregister'],
  }), (ctx) => {
    ctx.tools.register({
      name: 'visible_revocation_self_unregister',
      spec: {
        ...TOOL_SPEC,
        function: { ...TOOL_SPEC.function, name: 'visible_revocation_self_unregister' },
      },
      exec: async () => ({ ok: true }),
    })
  })

  assert.equal(
    await settleWithin(registry.unregisterPlugin('visible-revocation-self-unregister')),
    true,
  )
  assert.equal(selfUnregisterError?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(selfUnregisterError?.retryable, false)
  assert.equal(registry.getPlugin('visible-revocation-self-unregister'), null)
})

test('visible contribution async completion is consumed and aggregated once', async () => {
  let disposerCalls = 0
  let cleanupExecutors = 0
  const thrown = Object.assign(new Error('visible async revocation failed'), {
    code: 'PLUGIN_VISIBLE_ASYNC_REVOCATION_FAILURE',
  })
  const registry = createRuntimePluginRegistry({
    registerTool() {
      const dispose = () => {
        disposerCalls += 1
      }
      return v2Disposer(dispose, () => {
        dispose()
        const cleanup = new Promise((_resolve, reject) => {
          cleanupExecutors += 1
          reject(thrown)
        })
        return createRuntimePluginRevokeReceipt('revoked', cleanup)
      })
    },
  })
  await registry.registerPlugin(manifest('visible-revocation-completion-once', {
    contributes: ['tool:visible_revocation_completion_once'],
  }), (ctx) => {
    ctx.tools.register({
      name: 'visible_revocation_completion_once',
      spec: {
        ...TOOL_SPEC,
        function: { ...TOOL_SPEC.function, name: 'visible_revocation_completion_once' },
      },
      exec: async () => ({ ok: true }),
    })
  })

  await assert.rejects(
    registry.unregisterPlugin('visible-revocation-completion-once'),
    (error) => error instanceof AggregateError
      && error.errors.length === 1
      && error.errors[0]?.code === 'PLUGIN_REVOKE_CLEANUP_FAILED'
      && error.errors[0]?.retryable === false,
  )
  assert.equal(disposerCalls, 1)
  assert.equal(cleanupExecutors, 1)
  assert.equal(
    registry.getPlugin('visible-revocation-completion-once')?.state,
    'inactive_cleanup_failed',
  )
})

test('visible contribution revocation errors are detached before aggregation', async () => {
  let messageGetterCalls = 0
  const thrown = {}
  Object.defineProperties(thrown, {
    message: {
      get() {
        messageGetterCalls += 1
        return 'getter must not execute'
      },
    },
    code: { value: 'PLUGIN_VISIBLE_REVOCATION_FAILURE' },
    retryable: { value: true },
    cause: { value: { hostCapability: true } },
  })
  const registry = createRuntimePluginRegistry({
    registerTool() {
      const dispose = () => {}
      return v2Disposer(dispose, () => createRuntimePluginRevokeReceipt(
        'retained',
        new Promise((_resolve, reject) => reject(thrown)),
      ))
    },
  })
  await registry.registerPlugin(manifest('visible-revocation-error-boundary', {
    contributes: ['tool:visible_revocation_error'],
  }), (ctx) => {
    ctx.tools.register({
      name: 'visible_revocation_error',
      spec: {
        ...TOOL_SPEC,
        function: { ...TOOL_SPEC.function, name: 'visible_revocation_error' },
      },
      exec: async () => ({ ok: true }),
    })
  })

  await assert.rejects(
    registry.unregisterPlugin('visible-revocation-error-boundary'),
    (error) => {
      assert.equal(error instanceof AggregateError, true)
      assert.equal(error.errors.length, 1)
      const detached = error.errors[0]
      assert.notEqual(detached, thrown)
      assert.equal(detached?.code, 'PLUGIN_REVOKE_CLEANUP_FAILED')
      assert.equal(detached?.retryable, false)
      assert.equal(
        detached?.message,
        'plugin contribution cleanup failed: tool:visible_revocation_error:implementation',
      )
      assert.equal(detached?.pluginId, 'visible-revocation-error-boundary')
      assert.equal(detached?.phase, 'dispose')
      assert.equal(Object.hasOwn(detached, 'cause'), false)
      return true
    },
  )
  assert.equal(messageGetterCalls, 0)
  assert.equal(
    registry.getPlugin('visible-revocation-error-boundary')?.state,
    'visibility_indeterminate',
  )
})

test('plugin disposer thrown values are detached before cleanup accounting ends', async () => {
  const registry = createRuntimePluginRegistry()
  let unregisterAttempt = null
  let messageGetterCalls = 0
  const thrown = {}
  Object.defineProperties(thrown, {
    message: {
      get() {
        messageGetterCalls += 1
        return 'getter must not execute'
      },
    },
    code: { value: 'PLUGIN_CUSTOM_DISPOSER_FAILURE' },
    retryable: { value: true },
    cause: { value: { disposerCapability: true } },
  })
  const trappedError = new Proxy(thrown, {
    getOwnPropertyDescriptor(target, key) {
      if (!unregisterAttempt) {
        unregisterAttempt = registry.unregisterPlugin('disposer-error-boundary').then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
      }
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  await registry.registerPlugin(manifest('disposer-error-boundary'), (ctx) => {
    ctx.lifecycle.onDispose(() => { throw trappedError })
  })

  await assert.rejects(
    settleWithin(registry.unregisterPlugin('disposer-error-boundary')),
    (error) => {
      assert.equal(error instanceof AggregateError, true)
      assert.equal(error.errors.length, 1)
      const detached = error.errors[0]
      assert.notEqual(detached, trappedError)
      assert.equal(detached?.code, 'PLUGIN_CUSTOM_DISPOSER_FAILURE')
      assert.equal(detached?.retryable, false)
      assert.equal(detached?.message, 'plugin disposer failed: disposer-error-boundary')
      assert.equal(detached?.pluginId, 'disposer-error-boundary')
      assert.equal(detached?.phase, 'dispose')
      assert.equal(Object.hasOwn(detached, 'cause'), false)
      return true
    },
  )
  assert.equal(messageGetterCalls, 0)
  const attempted = await settleWithin(unregisterAttempt)
  assert.equal(attempted.value, undefined)
  assert.equal(attempted.error?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(registry.getPlugin('disposer-error-boundary')?.state, 'inactive_cleanup_failed')
})

test('failed plugin disposer remains tracked until a later uninstall retry succeeds', async () => {
  const registry = createRuntimePluginRegistry()
  let disposerCalls = 0
  await registry.registerPlugin(manifest('disposer-retry-boundary'), (ctx) => {
    ctx.lifecycle.onDispose(() => {
      disposerCalls += 1
      if (disposerCalls === 1) throw new Error('first cleanup attempt failed')
    })
  })

  await assert.rejects(
    registry.unregisterPlugin('disposer-retry-boundary'),
    (error) => error instanceof AggregateError
      && error.errors.length === 1
      && error.errors[0]?.pluginId === 'disposer-retry-boundary',
  )
  assert.equal(disposerCalls, 1)
  assert.equal(registry.getPlugin('disposer-retry-boundary')?.state, 'inactive_cleanup_failed')

  assert.equal(await registry.unregisterPlugin('disposer-retry-boundary'), true)
  assert.equal(disposerCalls, 2)
  assert.equal(registry.getPlugin('disposer-retry-boundary'), null)
})

test('config reload setup and old disposer self-unregister attempts fail fast across record generations', async () => {
  const registry = createRuntimePluginRegistry({
    configLayers: [{
      id: 'host-default',
      kind: 'defaults',
      priority: 0,
      plugins: { 'reload-self-unregister': { revision: 1 } },
    }],
  })
  const setupErrors = []
  const disposerErrors = []
  let setupRevision = 0
  const setup = async (ctx) => {
    const revision = ++setupRevision
    if (revision > 1) {
      try {
        await registry.unregisterPlugin('reload-self-unregister')
      } catch (error) {
        setupErrors.push(error)
      }
    }
    ctx.lifecycle.onDispose(async () => {
      try {
        await registry.unregisterPlugin('reload-self-unregister')
      } catch (error) {
        disposerErrors.push(error)
      }
    })
  }
  await registry.registerPlugin(manifest('reload-self-unregister', {
    contributes: [],
  }), setup)

  const reloaded = await settleWithin(registry.reloadPluginConfig('reload-self-unregister', {
    expectedRevision: 1,
    configLayerSources: [{
      source: 'user_config',
      layers: [{
        id: 'user-installation',
        kind: 'installation',
        priority: 100,
        plugins: { 'reload-self-unregister': { revision: 2 } },
      }],
    }],
  }))
  assert.equal(reloaded.configRevision, 2)
  assert.equal(setupErrors.length, 1)
  assert.equal(setupErrors[0]?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(disposerErrors.length, 1)
  assert.equal(disposerErrors[0]?.code, 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK')
  assert.equal(registry.getPlugin('reload-self-unregister')?.configRevision, 2)
  await registry.shutdown()
  assert.equal(disposerErrors.length, 2)
})

test('cross-plugin callback unload and reload cycles fail fast instead of forming wait graphs', async () => {
  const registry = createRuntimePluginRegistry()
  const installPeer = async (id, peerId) => {
    await registry.registerPlugin(manifest(id, {
      contributes: [`service:${id}-lifecycle`],
    }), (ctx) => {
      ctx.services.provide(`${id}-lifecycle`, {
        unregisterPeer: () => registry.unregisterPlugin(peerId),
        reloadPeer: () => registry.reloadPluginConfig(peerId, {
          expectedRevision: 1,
          configLayerSources: [],
        }),
      })
    })
  }
  await installPeer('wait-graph-a', 'wait-graph-b')
  await installPeer('wait-graph-b', 'wait-graph-a')

  const unloadResults = await Promise.allSettled([
    settleWithin(registry.invokeService('wait-graph-a-lifecycle', 'unregisterPeer')),
    settleWithin(registry.invokeService('wait-graph-b-lifecycle', 'unregisterPeer')),
  ])
  assert.deepEqual(
    unloadResults.map((result) => result.status === 'rejected' ? result.reason?.code : null),
    ['PLUGIN_CALLBACK_UNREGISTER_DEADLOCK', 'PLUGIN_CALLBACK_UNREGISTER_DEADLOCK'],
  )
  assert.equal(registry.getPlugin('wait-graph-a')?.state, 'active')
  assert.equal(registry.getPlugin('wait-graph-b')?.state, 'active')

  const reloadResults = await Promise.allSettled([
    settleWithin(registry.invokeService('wait-graph-a-lifecycle', 'reloadPeer')),
    settleWithin(registry.invokeService('wait-graph-b-lifecycle', 'reloadPeer')),
  ])
  assert.deepEqual(
    reloadResults.map((result) => result.status === 'rejected' ? result.reason?.code : null),
    ['PLUGIN_CONFIG_RELOAD_CALLBACK_DEADLOCK', 'PLUGIN_CONFIG_RELOAD_CALLBACK_DEADLOCK'],
  )
  assert.equal(registry.getPlugin('wait-graph-a')?.configRevision, 1)
  assert.equal(registry.getPlugin('wait-graph-b')?.configRevision, 1)
  await registry.shutdown()
})

test('lifecycle guards span registry instances during setup and cleanup', async () => {
  const registryA = createRuntimePluginRegistry()
  const registryB = createRuntimePluginRegistry()
  const setupErrors = []
  const cleanupErrors = []
  let arrivals = 0
  let releaseSetups
  const setupGate = new Promise((resolve) => { releaseSetups = resolve })
  const install = (registry, peerRegistry, id, peerId) => registry.registerPlugin(manifest(id, {
    contributes: [],
  }), async (ctx) => {
    ctx.lifecycle.onDispose(async () => {
      try {
        await peerRegistry.unregisterPlugin(peerId)
      } catch (error) {
        cleanupErrors.push(error)
      }
    })
    arrivals += 1
    if (arrivals === 2) releaseSetups()
    await setupGate
    try {
      await peerRegistry.unregisterPlugin(peerId)
    } catch (error) {
      setupErrors.push(error)
    }
  })

  await Promise.all([
    install(registryA, registryB, 'cross-registry-setup-a', 'cross-registry-setup-b'),
    install(registryB, registryA, 'cross-registry-setup-b', 'cross-registry-setup-a'),
  ])
  assert.deepEqual(setupErrors.map((error) => error?.code), [
    'PLUGIN_CALLBACK_UNREGISTER_DEADLOCK',
    'PLUGIN_CALLBACK_UNREGISTER_DEADLOCK',
  ])
  assert.equal(setupErrors.every((error) => error?.phase === 'setup'), true)
  assert.equal(setupErrors.every((error) => error?.crossRegistry === true), true)
  assert.equal(registryA.getPlugin('cross-registry-setup-a')?.state, 'active')
  assert.equal(registryB.getPlugin('cross-registry-setup-b')?.state, 'active')

  assert.deepEqual(await Promise.all([
    settleWithin(registryA.unregisterPlugin('cross-registry-setup-a')),
    settleWithin(registryB.unregisterPlugin('cross-registry-setup-b')),
  ]), [true, true])
  assert.deepEqual(cleanupErrors.map((error) => error?.code), [
    'PLUGIN_CALLBACK_UNREGISTER_DEADLOCK',
    'PLUGIN_CALLBACK_UNREGISTER_DEADLOCK',
  ])
  assert.equal(cleanupErrors.every((error) => error?.phase === 'dispose'), true)
  assert.equal(cleanupErrors.every((error) => error?.crossRegistry === true), true)
})

test('cross-registry service callbacks reject mutual unload and reload wait graphs', async () => {
  const registryA = createRuntimePluginRegistry()
  const registryB = createRuntimePluginRegistry()
  const install = (registry, peerRegistry, id, peerId) => registry.registerPlugin(manifest(id, {
    contributes: [`service:${id}-lifecycle`],
  }), (ctx) => {
    ctx.services.provide(`${id}-lifecycle`, {
      unregisterPeer: () => peerRegistry.unregisterPlugin(peerId),
      reloadPeer: () => peerRegistry.reloadPluginConfig(peerId, {
        expectedRevision: 1,
        configLayerSources: [],
      }),
    })
  })
  await install(registryA, registryB, 'cross-registry-service-a', 'cross-registry-service-b')
  await install(registryB, registryA, 'cross-registry-service-b', 'cross-registry-service-a')

  const unloads = await Promise.allSettled([
    settleWithin(registryA.invokeService('cross-registry-service-a-lifecycle', 'unregisterPeer')),
    settleWithin(registryB.invokeService('cross-registry-service-b-lifecycle', 'unregisterPeer')),
  ])
  assert.deepEqual(unloads.map((result) => result.status === 'rejected' ? result.reason?.code : null), [
    'PLUGIN_CALLBACK_UNREGISTER_DEADLOCK',
    'PLUGIN_CALLBACK_UNREGISTER_DEADLOCK',
  ])

  const reloads = await Promise.allSettled([
    settleWithin(registryA.invokeService('cross-registry-service-a-lifecycle', 'reloadPeer')),
    settleWithin(registryB.invokeService('cross-registry-service-b-lifecycle', 'reloadPeer')),
  ])
  assert.deepEqual(reloads.map((result) => result.status === 'rejected' ? result.reason?.code : null), [
    'PLUGIN_CONFIG_RELOAD_CALLBACK_DEADLOCK',
    'PLUGIN_CONFIG_RELOAD_CALLBACK_DEADLOCK',
  ])
  assert.equal(registryA.getPlugin('cross-registry-service-a')?.configRevision, 1)
  assert.equal(registryB.getPlugin('cross-registry-service-b')?.configRevision, 1)
  await Promise.all([registryA.shutdown(), registryB.shutdown()])
})

test('nested cross-registry lifecycle errors identify the innermost plugin frame', async () => {
  const outerRegistry = createRuntimePluginRegistry()
  const innerRegistry = createRuntimePluginRegistry()
  let observedError = null
  await outerRegistry.registerPlugin(manifest('outer-registry-source', {
    contributes: ['service:install-inner-registry-plugin'],
  }), (ctx) => {
    ctx.services.provide('install-inner-registry-plugin', {
      run: async () => {
        await innerRegistry.registerPlugin(manifest('inner-registry-source', {
          contributes: [],
        }), async () => {
          try {
            await outerRegistry.unregisterPlugin('outer-registry-source')
          } catch (error) {
            observedError = error
          }
        })
        return { ok: true }
      },
    })
  })

  assert.deepEqual(await outerRegistry.invokeService('install-inner-registry-plugin', 'run'), {
    found: true,
    pluginId: 'outer-registry-source',
    value: { ok: true },
  })
  assert.equal(observedError?.code, 'PLUGIN_CALLBACK_UNREGISTER_DEADLOCK')
  assert.equal(observedError?.pluginId, 'inner-registry-source')
  assert.equal(observedError?.targetPluginId, 'outer-registry-source')
  assert.equal(observedError?.phase, 'setup')
  assert.equal(observedError?.crossRegistry, true)
  await Promise.all([outerRegistry.shutdown(), innerRegistry.shutdown()])
})

test('shared lifecycle scope does not block an unrelated asynchronous chain', async () => {
  const callbackRegistry = createRuntimePluginRegistry()
  const unrelatedRegistry = createRuntimePluginRegistry()
  let markEntered
  let releaseCallback
  const entered = new Promise((resolve) => { markEntered = resolve })
  const callbackGate = new Promise((resolve) => { releaseCallback = resolve })
  await callbackRegistry.registerPlugin(manifest('held-callback-plugin', {
    contributes: ['service:held-callback'],
  }), (ctx) => {
    ctx.services.provide('held-callback', {
      run: async () => {
        markEntered()
        await callbackGate
        return { ok: true }
      },
    })
  })
  await unrelatedRegistry.registerPlugin(manifest('unrelated-plugin', {
    contributes: [],
  }), () => {})

  const callback = callbackRegistry.invokeService('held-callback', 'run')
  await entered
  assert.equal(await unrelatedRegistry.unregisterPlugin('unrelated-plugin'), true)
  releaseCallback()
  assert.deepEqual(await callback, {
    found: true,
    pluginId: 'held-callback-plugin',
    value: { ok: true },
  })
  await callbackRegistry.shutdown()
})

test('discarded lifecycle guard rejections are prehandled without changing callback results', async () => {
  const registry = createRuntimePluginRegistry()
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  try {
    await registry.registerPlugin(manifest('discarded-lifecycle-guard', {
      contributes: [
        'prompt:discarded-lifecycle-guard',
        'service:discarded-lifecycle-guard',
      ],
    }), (ctx) => {
      const discardLifecycleCalls = () => {
        void registry.unregisterPlugin('discarded-lifecycle-guard')
        void registry.reloadPluginConfig('discarded-lifecycle-guard', {
          expectedRevision: 1,
          configLayerSources: [],
        })
        void registry.shutdown()
      }
      ctx.prompts.register({
        id: 'discarded-lifecycle-guard',
        render: () => {
          discardLifecycleCalls()
          return 'prompt completed'
        },
      })
      ctx.services.provide('discarded-lifecycle-guard', {
        run: async () => {
          discardLifecycleCalls()
          return { ok: true }
        },
      })
    })

    assert.deepEqual(registry.renderPromptBlocks(), {
      blocks: [{
        id: 'discarded-lifecycle-guard',
        pluginId: 'discarded-lifecycle-guard',
        text: 'prompt completed',
      }],
      errors: [],
    })
    assert.deepEqual(await registry.invokeService('discarded-lifecycle-guard', 'run'), {
      found: true,
      pluginId: 'discarded-lifecycle-guard',
      value: { ok: true },
    })
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
    assert.equal(registry.getPlugin('discarded-lifecycle-guard')?.state, 'active')
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await registry.shutdown()
  }
})

const CROSS_REGISTRY_LIFECYCLE_CASES = Object.freeze([
  Object.freeze({ label: 'U/U', left: 'unregister', right: 'unregister' }),
  Object.freeze({ label: 'R/R', left: 'reload', right: 'reload' }),
  Object.freeze({ label: 'U/R', left: 'unregister', right: 'reload' }),
])

function createLifecycleBarrier() {
  let arrivals = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  return async () => {
    arrivals += 1
    if (arrivals === 2) release()
    await gate
  }
}

function v2Disposer(dispose, beginRevoke = null) {
  return attachRuntimePluginBeginRevoke(dispose, beginRevoke || (() => {
    dispose()
    return createRuntimePluginRevokeReceipt('revoked')
  }))
}

function guardedReloadOptions() {
  return {
    expectedRevision: 1,
    configLayerSources: [],
  }
}

function committedReloadOptions(pluginId) {
  return {
    expectedRevision: 1,
    configLayerSources: [{
      source: 'user_config',
      layers: [{
        id: `matrix-revision-${pluginId}`,
        kind: 'installation',
        priority: 100,
        plugins: { [pluginId]: { revision: 2 } },
      }],
    }],
  }
}

function createConfiguredLifecycleRegistry(pluginId) {
  return createRuntimePluginRegistry({
    configLayers: [{
      id: `matrix-default-${pluginId}`,
      kind: 'defaults',
      priority: 0,
      plugins: { [pluginId]: { revision: 1 } },
    }],
  })
}

async function captureLifecycleGuard({
  errors,
  operation,
  sourceId,
  targetId,
  targetRegistry,
}) {
  try {
    if (operation === 'unregister') {
      await targetRegistry.unregisterPlugin(targetId)
    } else {
      await targetRegistry.reloadPluginConfig(targetId, guardedReloadOptions())
    }
    errors.set(sourceId, null)
  } catch (error) {
    errors.set(sourceId, error)
  }
}

function assertLifecycleGuardMatrix({
  errors,
  label,
  leftId,
  leftOperation,
  phase,
  rightId,
  rightOperation,
}) {
  for (const [sourceId, targetId, operation] of [
    [leftId, rightId, leftOperation],
    [rightId, leftId, rightOperation],
  ]) {
    const error = errors.get(sourceId)
    assert.ok(error, `${label}: ${sourceId} must receive a lifecycle guard rejection`)
    assert.equal(
      error.code,
      operation === 'reload'
        ? 'PLUGIN_CONFIG_RELOAD_CALLBACK_DEADLOCK'
        : 'PLUGIN_CALLBACK_UNREGISTER_DEADLOCK',
      label,
    )
    assert.equal(error.retryable, false, label)
    assert.equal(error.pluginId, sourceId, label)
    assert.equal(error.phase, phase, label)
    assert.equal(error.operation, operation, label)
    assert.equal(error.crossRegistry, true, label)
    assert.equal(error.targetPluginId, targetId, label)
    assert.equal(error.statusCode, operation === 'reload' ? 409 : undefined, label)
  }
}

async function runInitialSetupLifecycleMatrix(entry, suffix) {
  const leftId = `mx-is-${suffix}-a`
  const rightId = `mx-is-${suffix}-b`
  const leftRegistry = createRuntimePluginRegistry()
  const rightRegistry = createRuntimePluginRegistry()
  const errors = new Map()
  const arrive = createLifecycleBarrier()
  const setup = (sourceId, targetId, targetRegistry, operation) => async () => {
    await arrive()
    await captureLifecycleGuard({ errors, operation, sourceId, targetId, targetRegistry })
  }

  await settleWithin(Promise.all([
    leftRegistry.registerPlugin(
      manifest(leftId, { contributes: [] }),
      setup(leftId, rightId, rightRegistry, entry.left),
    ),
    rightRegistry.registerPlugin(
      manifest(rightId, { contributes: [] }),
      setup(rightId, leftId, leftRegistry, entry.right),
    ),
  ]), 2_000)
  assertLifecycleGuardMatrix({
    errors,
    label: `initial setup ${entry.label}`,
    leftId,
    leftOperation: entry.left,
    phase: 'setup',
    rightId,
    rightOperation: entry.right,
  })
  assert.equal(leftRegistry.getPlugin(leftId)?.state, 'active')
  assert.equal(rightRegistry.getPlugin(rightId)?.state, 'active')
  await settleWithin(Promise.all([leftRegistry.shutdown(), rightRegistry.shutdown()]), 2_000)
}

async function runCandidateSetupLifecycleMatrix(entry, suffix) {
  const leftId = `mx-cs-${suffix}-a`
  const rightId = `mx-cs-${suffix}-b`
  const leftRegistry = createConfiguredLifecycleRegistry(leftId)
  const rightRegistry = createConfiguredLifecycleRegistry(rightId)
  const generations = new Map()
  const errors = new Map()
  const arrive = createLifecycleBarrier()
  const setup = (sourceId, targetId, targetRegistry, operation) => async () => {
    const generation = (generations.get(sourceId) || 0) + 1
    generations.set(sourceId, generation)
    if (generation !== 2) return
    await arrive()
    await captureLifecycleGuard({ errors, operation, sourceId, targetId, targetRegistry })
  }

  await leftRegistry.registerPlugin(
    manifest(leftId, { contributes: [] }),
    setup(leftId, rightId, rightRegistry, entry.left),
  )
  await rightRegistry.registerPlugin(
    manifest(rightId, { contributes: [] }),
    setup(rightId, leftId, leftRegistry, entry.right),
  )
  const revisions = await settleWithin(Promise.all([
    leftRegistry.reloadPluginConfig(leftId, committedReloadOptions(leftId)),
    rightRegistry.reloadPluginConfig(rightId, committedReloadOptions(rightId)),
  ]), 2_000)
  assert.deepEqual(revisions.map((item) => item.configRevision), [2, 2])
  assertLifecycleGuardMatrix({
    errors,
    label: `candidate setup ${entry.label}`,
    leftId,
    leftOperation: entry.left,
    phase: 'setup',
    rightId,
    rightOperation: entry.right,
  })
  await settleWithin(Promise.all([leftRegistry.shutdown(), rightRegistry.shutdown()]), 2_000)
}

async function runCallbackLifecycleMatrix(entry, suffix) {
  const leftId = `mx-cb-${suffix}-a`
  const rightId = `mx-cb-${suffix}-b`
  const leftService = `${leftId}-service`
  const rightService = `${rightId}-service`
  const leftRegistry = createRuntimePluginRegistry()
  const rightRegistry = createRuntimePluginRegistry()
  const errors = new Map()
  const arrive = createLifecycleBarrier()
  const setup = (sourceId, targetId, targetRegistry, operation, serviceName) => (ctx) => {
    ctx.services.provide(serviceName, {
      run: async () => {
        await arrive()
        await captureLifecycleGuard({ errors, operation, sourceId, targetId, targetRegistry })
        return { guarded: true }
      },
    })
  }

  await leftRegistry.registerPlugin(
    manifest(leftId, { contributes: [`service:${leftService}`] }),
    setup(leftId, rightId, rightRegistry, entry.left, leftService),
  )
  await rightRegistry.registerPlugin(
    manifest(rightId, { contributes: [`service:${rightService}`] }),
    setup(rightId, leftId, leftRegistry, entry.right, rightService),
  )
  const results = await settleWithin(Promise.all([
    leftRegistry.invokeService(leftService, 'run'),
    rightRegistry.invokeService(rightService, 'run'),
  ]), 2_000)
  assert.deepEqual(results.map((item) => item.value), [{ guarded: true }, { guarded: true }])
  assertLifecycleGuardMatrix({
    errors,
    label: `callback ${entry.label}`,
    leftId,
    leftOperation: entry.left,
    phase: 'service',
    rightId,
    rightOperation: entry.right,
  })
  await settleWithin(Promise.all([leftRegistry.shutdown(), rightRegistry.shutdown()]), 2_000)
}

async function runUnloadCleanupLifecycleMatrix(entry, suffix) {
  const leftId = `mx-uc-${suffix}-a`
  const rightId = `mx-uc-${suffix}-b`
  const leftRegistry = createRuntimePluginRegistry()
  const rightRegistry = createRuntimePluginRegistry()
  const errors = new Map()
  const arrive = createLifecycleBarrier()
  const setup = (sourceId, targetId, targetRegistry, operation) => (ctx) => {
    ctx.lifecycle.onDispose(async () => {
      await arrive()
      await captureLifecycleGuard({ errors, operation, sourceId, targetId, targetRegistry })
    })
  }

  await leftRegistry.registerPlugin(
    manifest(leftId, { contributes: [] }),
    setup(leftId, rightId, rightRegistry, entry.left),
  )
  await rightRegistry.registerPlugin(
    manifest(rightId, { contributes: [] }),
    setup(rightId, leftId, leftRegistry, entry.right),
  )
  assert.deepEqual(await settleWithin(Promise.all([
    leftRegistry.unregisterPlugin(leftId),
    rightRegistry.unregisterPlugin(rightId),
  ]), 2_000), [true, true])
  assertLifecycleGuardMatrix({
    errors,
    label: `unload cleanup ${entry.label}`,
    leftId,
    leftOperation: entry.left,
    phase: 'dispose',
    rightId,
    rightOperation: entry.right,
  })
}

async function runReloadCleanupLifecycleMatrix(entry, suffix) {
  const leftId = `mx-rc-${suffix}-a`
  const rightId = `mx-rc-${suffix}-b`
  const leftRegistry = createConfiguredLifecycleRegistry(leftId)
  const rightRegistry = createConfiguredLifecycleRegistry(rightId)
  const generations = new Map()
  const errors = new Map()
  const arrive = createLifecycleBarrier()
  const setup = (sourceId, targetId, targetRegistry, operation) => (ctx) => {
    const generation = (generations.get(sourceId) || 0) + 1
    generations.set(sourceId, generation)
    if (generation !== 1) return
    ctx.lifecycle.onDispose(async () => {
      await arrive()
      await captureLifecycleGuard({ errors, operation, sourceId, targetId, targetRegistry })
    })
  }

  await leftRegistry.registerPlugin(
    manifest(leftId, { contributes: [] }),
    setup(leftId, rightId, rightRegistry, entry.left),
  )
  await rightRegistry.registerPlugin(
    manifest(rightId, { contributes: [] }),
    setup(rightId, leftId, leftRegistry, entry.right),
  )
  const revisions = await settleWithin(Promise.all([
    leftRegistry.reloadPluginConfig(leftId, committedReloadOptions(leftId)),
    rightRegistry.reloadPluginConfig(rightId, committedReloadOptions(rightId)),
  ]), 2_000)
  assert.deepEqual(revisions.map((item) => item.configRevision), [2, 2])
  assertLifecycleGuardMatrix({
    errors,
    label: `reload cleanup ${entry.label}`,
    leftId,
    leftOperation: entry.left,
    phase: 'dispose',
    rightId,
    rightOperation: entry.right,
  })
  await settleWithin(Promise.all([leftRegistry.shutdown(), rightRegistry.shutdown()]), 2_000)
}

test('cross-registry lifecycle wait-graph matrix fails fast with stable attribution', async (t) => {
  const stages = [
    ['initial setup', runInitialSetupLifecycleMatrix],
    ['candidate setup', runCandidateSetupLifecycleMatrix],
    ['callback', runCallbackLifecycleMatrix],
    ['unload cleanup', runUnloadCleanupLifecycleMatrix],
    ['reload cleanup', runReloadCleanupLifecycleMatrix],
  ]
  for (const [stage, runStage] of stages) {
    for (const [index, entry] of CROSS_REGISTRY_LIFECYCLE_CASES.entries()) {
      await t.test(`${stage} ${entry.label}`, async () => {
        await runStage(entry, `${index + 1}`)
      })
    }
  }
})
