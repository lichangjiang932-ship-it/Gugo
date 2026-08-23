import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  getModelProviderAdapter,
  registerModelProviderAdapter,
} from '../server/adapters/modelProviderRegistry.js'
import { createHttpCapabilityRegistry } from '../server/core/httpCapabilityRegistry.js'
import {
  getBoundRuntimeTool,
  getRuntimeCapabilitySnapshot,
  listRuntimeCapabilityAuditEvents,
  listRuntimeCapabilityContributions,
  prepareRuntimeCapabilitySnapshot,
  registerRuntimeCapabilityContribution,
} from '../server/core/runtimeCapabilityHost.js'
import { createRuntimeCapabilityRegistry } from '../server/core/runtimeCapabilityRegistry.js'
import {
  compatibilityRuntimeCapabilityHost,
  snapshotRuntimePluginHostOptions,
} from '../server/plugins/runtimePluginHostOptions.js'
import { createRuntimePluginContributionLifecycle } from '../server/plugins/runtimePluginContributionLifecycle.js'
import { createLoopEvents } from '../server/services/loop/events.js'
import {
  getDynamicTool,
  registerDynamicTool,
} from '../server/utils/toolSchemaCatalog.js'

function assertRevocationHandle(dispose) {
  assert.equal(typeof dispose, 'function')
  const descriptor = Object.getOwnPropertyDescriptor(dispose, 'beginRevoke')
  assert.equal(typeof descriptor?.value, 'function')
  assert.equal(descriptor.enumerable, false)
  assert.equal(descriptor.writable, false)
  assert.equal(descriptor.configurable, false)
  return descriptor.value
}

function assertReceipt(receipt, visibility) {
  assert.deepEqual(receipt, { visibility, cleanup: null })
  assert.equal(Object.isFrozen(receipt), true)
}

function toolSpec(name) {
  return {
    type: 'function',
    function: {
      name,
      description: 'v2 revoke fixture',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  }
}

function providerAdapter() {
  return {
    buildRequest() { return { url: 'https://example.test', init: {} } },
    parseResponse() { return { content: '', toolCalls: [], usage: null, finishReason: 'stop' } },
  }
}

function capability(type, id, overrides = {}) {
  return {
    id,
    type,
    owner: id.startsWith('builtin.') ? 'builtin' : 'fixture-plugin',
    version: '1.0.0',
    priority: id.startsWith('builtin.') ? 0 : 10,
    implementation: Object.freeze({ id }),
    ...overrides,
  }
}

test('dynamic tools and model provider adapters expose callable v2 revoke handles', () => {
  const toolName = 'plugin_leaf_v2_tool'
  const disposeTool = registerDynamicTool({
    name: toolName,
    origin: 'test',
    spec: toolSpec(toolName),
  })
  assert.ok(getDynamicTool(toolName))
  assertReceipt(assertRevocationHandle(disposeTool)(), 'revoked')
  assert.equal(getDynamicTool(toolName), null)
  assert.equal(disposeTool(), false)

  const providerKind = 'plugin-leaf-v2-provider'
  const disposeProvider = registerModelProviderAdapter(providerKind, providerAdapter())
  assert.ok(getModelProviderAdapter(providerKind))
  assertReceipt(assertRevocationHandle(disposeProvider)(), 'revoked')
  assert.equal(getModelProviderAdapter(providerKind), null)
  assert.equal(disposeProvider(), false)
})

test('leaf revoke receipts do not trust a mutable same-realm Object.freeze', () => {
  const toolName = 'plugin_leaf_v2_freeze_tamper'
  const dispose = registerDynamicTool({
    name: toolName,
    origin: 'test',
    spec: toolSpec(toolName),
  })
  const beginRevoke = assertRevocationHandle(dispose)
  const originalFreeze = Object.freeze
  let intercepted = false
  Object.freeze = (value) => {
    intercepted = true
    return value
  }
  try {
    const receipt = beginRevoke()
    assertReceipt(receipt, 'revoked')
    assert.equal(intercepted, false)
    assert.equal(getDynamicTool(toolName), null)
  } finally {
    Object.freeze = originalFreeze
    dispose()
  }
})

test('default compatibility hosts produce a fully revocable v2 contribution set', async () => {
  const options = snapshotRuntimePluginHostOptions({})
  assert.equal(options.registerRuntimeCapability, compatibilityRuntimeCapabilityHost)

  const toolName = 'plugin_leaf_v2_compat_tool'
  const providerKind = 'plugin-leaf-v2-compat-provider'
  const lifecycle = createRuntimePluginContributionLifecycle([
    {
      id: 'tool',
      handle: options.registerTool({
        name: toolName,
        origin: 'test',
        spec: toolSpec(toolName),
      }),
    },
    {
      id: 'provider',
      handle: options.registerModelProvider(providerKind, providerAdapter()),
    },
    {
      id: 'runtime-capability',
      handle: options.registerRuntimeCapability(capability(
        'tool',
        'plugin.leaf-v2-compat-capability',
      )),
    },
  ])

  const receipt = lifecycle.beginRevoke()
  assert.equal(receipt.visibility, 'revoked')
  await receipt.cleanup
  assert.equal(lifecycle.retire(), true)
  assert.equal(getDynamicTool(toolName), null)
  assert.equal(getModelProviderAdapter(providerKind), null)

  const standalone = compatibilityRuntimeCapabilityHost()
  assertReceipt(assertRevocationHandle(standalone)(), 'revoked')
  assert.equal(standalone(), false)
})

test('explicit capability binding retains removal atomically and the same handle can retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-leaf-v2-binding-'))
  const configPath = path.join(root, 'runtime.json')
  const dataDir = path.join(root, 'data')
  const slot = 'plugin_leaf_v2_explicit_tool'
  const capabilityId = 'plugin.leaf-v2-explicit-tool'
  const implementation = Object.freeze({ id: capabilityId })
  const runtimeOptions = {
    cwd: root,
    env: {
      APP_CONFIG_PATH: configPath,
      APP_DATA_DIR: dataDir,
      GUGO_LOAD_DOTENV: '0',
    },
  }
  let disposeCapability = null

  try {
    disposeCapability = registerRuntimeCapabilityContribution(capability('tool', capabilityId, {
      slot,
      implementation,
    }))
    fs.writeFileSync(configPath, JSON.stringify({
      env: {},
      capabilityBindings: { tool: { [slot]: capabilityId } },
    }))
    await prepareRuntimeCapabilitySnapshot(runtimeOptions)

    const snapshotBefore = getRuntimeCapabilitySnapshot()
    const generationBefore = snapshotBefore.generation
    const unregistersBefore = listRuntimeCapabilityAuditEvents().filter((entry) => (
      entry.event === 'runtime_capability.unregistered' && entry.capabilityId === capabilityId
    )).length
    assert.equal(getBoundRuntimeTool(slot), implementation)

    assertReceipt(assertRevocationHandle(disposeCapability)(), 'retained')
    assert.equal(getRuntimeCapabilitySnapshot(), snapshotBefore)
    assert.equal(getRuntimeCapabilitySnapshot().generation, generationBefore)
    assert.equal(getBoundRuntimeTool(slot), implementation)
    assert.equal(listRuntimeCapabilityContributions().some((entry) => entry.id === capabilityId), true)

    assert.throws(
      () => disposeCapability(),
      (error) => error?.code === 'RUNTIME_CAPABILITY_BINDING_IN_USE'
        && error?.retryable === true
        && error?.capabilityId === capabilityId
        && error?.binding === `tool:${slot}`,
    )
    assert.equal(getRuntimeCapabilitySnapshot(), snapshotBefore)
    assert.equal(listRuntimeCapabilityAuditEvents().filter((entry) => (
      entry.event === 'runtime_capability.unregistered' && entry.capabilityId === capabilityId
    )).length, unregistersBefore)

    fs.writeFileSync(configPath, JSON.stringify({ env: {} }))
    await prepareRuntimeCapabilitySnapshot(runtimeOptions)
    assert.equal(getBoundRuntimeTool(slot), implementation)
    assertReceipt(assertRevocationHandle(disposeCapability)(), 'revoked')
    assert.equal(getBoundRuntimeTool(slot), null)
    assert.equal(listRuntimeCapabilityContributions().some((entry) => entry.id === capabilityId), false)
    assert.equal(listRuntimeCapabilityAuditEvents().filter((entry) => (
      entry.event === 'runtime_capability.unregistered' && entry.capabilityId === capabilityId
    )).length, unregistersBefore + 1)
    assert.equal(disposeCapability(), false)
  } finally {
    fs.writeFileSync(configPath, JSON.stringify({ env: {} }))
    await prepareRuntimeCapabilitySnapshot(runtimeOptions)
    try { disposeCapability?.() } catch { /* best-effort fixture cleanup */ }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('snapshot preparation rejects a selection invalidated during an async health check', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-leaf-v2-snapshot-race-'))
  const configPath = path.join(root, 'runtime.json')
  const slot = 'plugin_leaf_v2_snapshot_race'
  const capabilityId = 'plugin.leaf-v2-snapshot-race'
  const implementation = Object.freeze({ marker: 'stale-plugin' })
  let enterHealthCheck
  let releaseHealthCheck
  const healthCheckEntered = new Promise((resolve) => { enterHealthCheck = resolve })
  const healthCheckGate = new Promise((resolve) => { releaseHealthCheck = resolve })
  const runtimeOptions = {
    cwd: root,
    env: {
      APP_CONFIG_PATH: configPath,
      APP_DATA_DIR: path.join(root, 'data'),
      GUGO_LOAD_DOTENV: '0',
    },
  }
  let disposeCapability = null

  try {
    disposeCapability = registerRuntimeCapabilityContribution(capability('tool', capabilityId, {
      slot,
      implementation,
      healthCheck: async () => {
        enterHealthCheck()
        await healthCheckGate
        return true
      },
    }))
    fs.writeFileSync(configPath, JSON.stringify({
      env: {},
      capabilityBindings: { tool: { [slot]: capabilityId } },
    }))

    const preparation = prepareRuntimeCapabilitySnapshot(runtimeOptions)
    await healthCheckEntered
    assertReceipt(assertRevocationHandle(disposeCapability)(), 'revoked')
    releaseHealthCheck()
    await assert.rejects(
      preparation,
      (error) => error?.code === 'RUNTIME_CAPABILITY_SNAPSHOT_STALE'
        && error?.retryable === true
        && error?.actualRevision > error?.expectedRevision,
    )
    assert.equal(listRuntimeCapabilityContributions().some((entry) => entry.id === capabilityId), false)
    assert.notEqual(getBoundRuntimeTool(slot), implementation)
  } finally {
    releaseHealthCheck?.()
    fs.writeFileSync(configPath, JSON.stringify({ env: {} }))
    await prepareRuntimeCapabilitySnapshot(runtimeOptions)
    try { disposeCapability?.() } catch { /* best-effort fixture cleanup */ }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a newer snapshot preparation cannot be overwritten by an older late health check', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-leaf-v2-prepare-order-'))
  const configPath = path.join(root, 'runtime.json')
  const slot = 'plugin_leaf_v2_prepare_order'
  const olderId = 'plugin.leaf-v2-prepare-order-old'
  const newerId = 'plugin.leaf-v2-prepare-order-new'
  const olderImplementation = Object.freeze({ marker: 'older' })
  const newerImplementation = Object.freeze({ marker: 'newer' })
  let enterOlder
  let releaseOlder
  let enterNewer
  let releaseNewer
  const olderEntered = new Promise((resolve) => { enterOlder = resolve })
  const olderGate = new Promise((resolve) => { releaseOlder = resolve })
  const newerEntered = new Promise((resolve) => { enterNewer = resolve })
  const newerGate = new Promise((resolve) => { releaseNewer = resolve })
  const runtimeOptions = {
    cwd: root,
    env: {
      APP_CONFIG_PATH: configPath,
      APP_DATA_DIR: path.join(root, 'data'),
      GUGO_LOAD_DOTENV: '0',
    },
  }
  let disposeOlder = null
  let disposeNewer = null

  try {
    disposeOlder = registerRuntimeCapabilityContribution(capability('tool', olderId, {
      slot,
      implementation: olderImplementation,
      healthCheck: async () => {
        enterOlder()
        await olderGate
        return true
      },
    }))
    disposeNewer = registerRuntimeCapabilityContribution(capability('tool', newerId, {
      slot,
      implementation: newerImplementation,
      priority: 20,
      replaces: olderId,
      healthCheck: async () => {
        enterNewer()
        await newerGate
        return true
      },
    }))

    fs.writeFileSync(configPath, JSON.stringify({
      env: {},
      capabilityBindings: { tool: { [slot]: olderId } },
    }))
    const olderPreparation = prepareRuntimeCapabilitySnapshot(runtimeOptions)
    await olderEntered

    fs.writeFileSync(configPath, JSON.stringify({
      env: {},
      capabilityBindings: { tool: { [slot]: newerId } },
    }))
    const newerPreparation = prepareRuntimeCapabilitySnapshot(runtimeOptions)
    await newerEntered
    releaseNewer()
    await newerPreparation
    assert.equal(getBoundRuntimeTool(slot), newerImplementation)

    releaseOlder()
    await assert.rejects(
      olderPreparation,
      (error) => error?.code === 'RUNTIME_CAPABILITY_SNAPSHOT_STALE'
        && error?.retryable === true
        && error?.actualPreparationRevision > error?.expectedPreparationRevision,
    )
    assert.equal(getBoundRuntimeTool(slot), newerImplementation)
  } finally {
    releaseOlder?.()
    releaseNewer?.()
    fs.writeFileSync(configPath, JSON.stringify({ env: {} }))
    await prepareRuntimeCapabilitySnapshot(runtimeOptions)
    try { disposeNewer?.() } catch { /* best-effort fixture cleanup */ }
    try { disposeOlder?.() } catch { /* best-effort fixture cleanup */ }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('reentrant registration captures the outer capability for explicit binding preflight', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-leaf-v2-reentrant-'))
  const configPath = path.join(root, 'runtime.json')
  const outerSlot = 'zzz_plugin_leaf_v2_outer'
  const outerId = 'plugin.leaf-v2-reentrant-outer'
  const innerId = 'plugin.leaf-v2-reentrant-inner'
  const outerImplementation = Object.freeze({ marker: 'outer' })
  const runtimeOptions = {
    cwd: root,
    env: {
      APP_CONFIG_PATH: configPath,
      APP_DATA_DIR: path.join(root, 'data'),
      GUGO_LOAD_DOTENV: '0',
    },
  }
  let disposeInner = null
  let disposeOuter = null
  let reentered = false
  const outerDefinition = new Proxy(capability('tool', outerId, {
    slot: outerSlot,
    implementation: outerImplementation,
  }), {
    getOwnPropertyDescriptor(target, property) {
      if (!reentered) {
        reentered = true
        disposeInner = registerRuntimeCapabilityContribution(capability(
          'tool',
          innerId,
          { slot: 'aaa_plugin_leaf_v2_inner' },
        ))
      }
      return Reflect.getOwnPropertyDescriptor(target, property)
    },
  })

  try {
    disposeOuter = registerRuntimeCapabilityContribution(outerDefinition)
    fs.writeFileSync(configPath, JSON.stringify({
      env: {},
      capabilityBindings: { tool: { [outerSlot]: outerId } },
    }))
    await prepareRuntimeCapabilitySnapshot(runtimeOptions)
    assert.equal(getBoundRuntimeTool(outerSlot), outerImplementation)

    assertReceipt(assertRevocationHandle(disposeOuter)(), 'retained')
    assert.equal(getBoundRuntimeTool(outerSlot), outerImplementation)
    assert.equal(listRuntimeCapabilityContributions().some((entry) => entry.id === outerId), true)
    assert.equal(listRuntimeCapabilityContributions().some((entry) => entry.id === innerId), true)

    fs.writeFileSync(configPath, JSON.stringify({ env: {} }))
    await prepareRuntimeCapabilitySnapshot(runtimeOptions)
    assertReceipt(assertRevocationHandle(disposeOuter)(), 'revoked')
    assert.equal(getBoundRuntimeTool(outerSlot), null)
  } finally {
    fs.writeFileSync(configPath, JSON.stringify({ env: {} }))
    await prepareRuntimeCapabilitySnapshot(runtimeOptions)
    try { disposeOuter?.() } catch { /* best-effort fixture cleanup */ }
    try { disposeInner?.() } catch { /* best-effort fixture cleanup */ }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runtime capability and HTTP hosts report retained before a replacement releases them', () => {
  const runtimeRegistry = createRuntimeCapabilityRegistry()
  const disposeRuntimeBase = runtimeRegistry.register(capability('loop', 'builtin.leaf-v2-loop'))
  const disposeRuntimeReplacement = runtimeRegistry.register(capability('loop', 'plugin.leaf-v2-loop', {
    replaces: 'builtin.leaf-v2-loop',
  }))
  assert.throws(
    () => disposeRuntimeBase(),
    (error) => error?.code === 'RUNTIME_CAPABILITY_IN_USE',
  )
  assert.equal(disposeRuntimeReplacement(), true)
  assert.equal(disposeRuntimeBase(), true)

  const httpRegistry = createHttpCapabilityRegistry()
  const route = (id, priority, replaces = undefined) => ({
    id,
    priority,
    ...(replaces ? { replaces } : {}),
    match: () => true,
    handle: () => id,
  })
  const disposeHttpBase = httpRegistry.register(route('builtin.leaf-v2-http', 1))
  const disposeHttpReplacement = httpRegistry.register(route(
    'plugin.leaf-v2-http',
    2,
    'builtin.leaf-v2-http',
  ))
  assertReceipt(assertRevocationHandle(disposeHttpBase)(), 'retained')
  assert.equal(httpRegistry.has('builtin.leaf-v2-http'), false)
  assert.equal(httpRegistry.has('plugin.leaf-v2-http'), true)
  assertReceipt(assertRevocationHandle(disposeHttpReplacement)(), 'revoked')
  assertReceipt(assertRevocationHandle(disposeHttpBase)(), 'revoked')
  assert.equal(httpRegistry.has('builtin.leaf-v2-http'), false)

  const disposeHttpBatch = httpRegistry.registerAll([
    route('plugin.leaf-v2-http-batch-a', 3),
    route('plugin.leaf-v2-http-batch-b', 4),
  ])
  assertReceipt(assertRevocationHandle(disposeHttpBatch)(), 'revoked')
  assert.equal(httpRegistry.has('plugin.leaf-v2-http-batch-a'), false)
  assert.equal(httpRegistry.has('plugin.leaf-v2-http-batch-b'), false)
})

test('default runtime capability host and production loop events expose v2 revoke receipts', async () => {
  const capabilityId = 'plugin.leaf-v2-host-base-tool'
  const disposeCapability = registerRuntimeCapabilityContribution(capability('tool', capabilityId, {
    slot: 'plugin_leaf_v2_host_tool',
  }))
  const disposeReplacement = registerRuntimeCapabilityContribution(capability(
    'tool',
    'plugin.leaf-v2-host-replacement-tool',
    {
      slot: 'plugin_leaf_v2_host_tool',
      priority: 20,
      replaces: capabilityId,
    },
  ))
  assertReceipt(assertRevocationHandle(disposeCapability)(), 'retained')
  assertReceipt(assertRevocationHandle(disposeReplacement)(), 'revoked')
  assertReceipt(assertRevocationHandle(disposeCapability)(), 'revoked')
  assert.equal(disposeCapability(), false)

  const events = createLoopEvents()
  let calls = 0
  const disposeListener = events.on('pre-step', () => { calls += 1 })
  assertReceipt(assertRevocationHandle(disposeListener)(), 'revoked')
  await events.emit('pre-step', {})
  assert.equal(calls, 0)
  assert.equal(disposeListener(), false)
})
