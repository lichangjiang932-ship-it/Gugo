import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BUILTIN_TOOL_LOOP_ADAPTER_ID,
  TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
} from '../server/core/toolLoopAdapter.js'
import { createRuntimePluginRegistry } from '../server/plugins/runtimePluginRegistry.js'
import {
  attachRuntimePluginBeginRevoke,
  createRuntimePluginRevokeReceipt,
} from '../server/plugins/runtimePluginContributionLifecycle.js'
import {
  assertRuntimePluginConfigSourceSnapshot,
  readRuntimePluginConfigLayerSources,
  readRuntimePluginConfigSourceSnapshot,
  validateRuntimePluginConfigDocument,
} from '../server/plugins/runtimePluginConfigFile.js'

function manifest(id, configSchema) {
  return {
    id,
    name: id,
    version: '1.0.0',
    requires: [],
    contributes: [],
    ...(configSchema ? { configSchema } : {}),
  }
}

function v2Disposer(dispose, beginRevoke = null) {
  return attachRuntimePluginBeginRevoke(dispose, beginRevoke || (() => {
    dispose()
    return createRuntimePluginRevokeReceipt('revoked')
  }))
}

test('plugin config layers merge deterministically per plugin and remain deeply frozen', async () => {
  const registry = createRuntimePluginRegistry({
    config: { hostOnly: true, nested: { fromHost: true }, entries: ['host'] },
    configLayers: [
      {
        id: 'installation-local',
        kind: 'installation',
        priority: 300,
        plugins: { 'plugin-a': { nested: { winner: 'installation' } } },
      },
      {
        id: 'profile-local',
        kind: 'profile',
        priority: 100,
        plugins: {
          'plugin-a': { nested: { winner: 'profile', profileOnly: true }, entries: ['profile'] },
          'plugin-b': { isolated: 'b' },
        },
      },
      {
        id: 'bundle-tools',
        kind: 'bundle',
        priority: 200,
        plugins: { 'plugin-a': { nested: { bundleOnly: true } } },
      },
    ],
  })
  let configA
  let configB
  await registry.registerPlugin(manifest('plugin-a'), (context) => { configA = context.config })
  await registry.registerPlugin(manifest('plugin-b'), (context) => { configB = context.config })

  assert.deepEqual(configA, {
    hostOnly: true,
    nested: {
      fromHost: true,
      winner: 'installation',
      profileOnly: true,
      bundleOnly: true,
    },
    entries: ['profile'],
  })
  assert.deepEqual(configB, {
    hostOnly: true,
    nested: { fromHost: true },
    entries: ['host'],
    isolated: 'b',
  })
  assert.equal(Object.isFrozen(configA), true)
  assert.equal(Object.isFrozen(configA.nested), true)
  assert.equal(Object.isFrozen(configA.entries), true)
  assert.throws(() => { configA.nested.winner = 'forged' }, TypeError)

  const views = registry.listEffectiveConfigs()
  const view = views.find((entry) => entry.pluginId === 'plugin-a')
  assert.deepEqual(view.layers.map((layer) => layer.id), [
    'legacy-host-config',
    'profile-local',
    'bundle-tools',
    'installation-local',
  ])
  assert.equal(view.provenance.find((entry) => entry.path === '/nested/winner').id, 'installation-local')
  assert.equal(Object.isFrozen(views), true)
  assert.equal(Object.isFrozen(view), true)
  assert.equal(Object.isFrozen(view.config), true)
  assert.equal(Object.isFrozen(view.config.nested), true)
  assert.equal(Object.isFrozen(view.layers), true)
  assert.equal(Object.isFrozen(view.layers[0]), true)
  assert.equal(Object.isFrozen(view.provenance), true)
  assert.equal(Object.isFrozen(view.provenance[0]), true)
  assert.throws(() => { view.config.nested.winner = 'forged-public-view' }, TypeError)
  assert.throws(() => { view.layers.push({ id: 'forged-layer' }) }, TypeError)
  assert.equal(
    registry.listEffectiveConfigs()
      .find((entry) => entry.pluginId === 'plugin-a')
      .config.nested.winner,
    'installation',
  )
  await registry.shutdown()
})

test('effective config snapshots redact secret keys, schema-marked values, and URL credentials', async () => {
  const secrets = {
    apiKey: 'raw-api-key-value',
    license: 'schema-secret-value',
    endpoint: 'https://alice:private-password@example.test/v1?token=query-secret&mode=safe',
    nested: { authorization: 'Bearer hidden-token' },
  }
  const registry = createRuntimePluginRegistry({
    configLayers: [{
      id: 'installation-secrets',
      kind: 'installation',
      priority: 100,
      plugins: { 'secret-plugin': secrets },
    }],
  })
  const schema = {
    type: 'object',
    properties: {
      apiKey: { type: 'string' },
      license: { type: 'string', writeOnly: true },
      endpoint: { type: 'string' },
      nested: { type: 'object' },
    },
    additionalProperties: false,
  }
  let runtimeConfig
  await registry.registerPlugin(manifest('secret-plugin', schema), (context) => {
    runtimeConfig = context.config
  })
  assert.equal(runtimeConfig.apiKey, secrets.apiKey)
  assert.equal(runtimeConfig.license, secrets.license)

  const publicJson = JSON.stringify(registry.listEffectiveConfigs())
  for (const rawSecret of [
    secrets.apiKey,
    secrets.license,
    'private-password',
    'query-secret',
    'Bearer hidden-token',
  ]) {
    assert.equal(publicJson.includes(rawSecret), false, rawSecret)
  }
  assert.match(publicJson, /REDACTED/)
  await registry.shutdown()
})

test('configSchema validates effective config before setup without exposing configured values', async () => {
  const registry = createRuntimePluginRegistry({
    configLayers: [{
      id: 'invalid-profile',
      kind: 'profile',
      priority: 10,
      plugins: { 'schema-plugin': { apiKey: 'must-never-appear', retries: 'many' } },
    }],
  })
  let setupCalls = 0
  await assert.rejects(
    registry.registerPlugin(manifest('schema-plugin', {
      type: 'object',
      required: ['apiKey', 'retries'],
      properties: {
        apiKey: { type: 'string' },
        retries: { type: 'integer' },
      },
      additionalProperties: false,
    }), () => { setupCalls += 1 }),
    (error) => error?.code === 'PLUGIN_CONFIG_VALIDATION_FAILED'
      && !error.message.includes('must-never-appear'),
  )
  assert.equal(setupCalls, 0)
  assert.deepEqual(registry.listPlugins(), [])
})

test('plugin config boundaries reject accessors, Proxies, and forbidden prototype keys without reads', () => {
  let getterCalls = 0
  const accessorConfig = {}
  Object.defineProperty(accessorConfig, 'apiKey', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'unreachable'
    },
  })
  assert.throws(
    () => createRuntimePluginRegistry({
      configLayers: [{
        id: 'bad-accessor',
        kind: 'installation',
        priority: 1,
        plugins: { 'safe-plugin': accessorConfig },
      }],
    }),
    (error) => error?.code === 'PLUGIN_CONFIG_LAYERS_INVALID',
  )
  assert.equal(getterCalls, 0)

  let proxyReads = 0
  const proxied = new Proxy({ enabled: true }, {
    get(target, key, receiver) {
      proxyReads += 1
      return Reflect.get(target, key, receiver)
    },
  })
  assert.throws(
    () => createRuntimePluginRegistry({
      configLayers: [{
        id: 'bad-proxy',
        kind: 'installation',
        priority: 1,
        plugins: { 'safe-plugin': proxied },
      }],
    }),
    (error) => error?.code === 'PLUGIN_CONFIG_LAYERS_INVALID',
  )
  assert.equal(proxyReads, 0)

  const polluted = JSON.parse('{"__proto__":{"polluted":true}}')
  assert.throws(
    () => createRuntimePluginRegistry({ configLayers: polluted }),
    (error) => error?.code === 'PLUGIN_CONFIG_LAYERS_INVALID',
  )
  assert.equal({}.polluted, undefined)
})

test('runtime plugin config reader keeps file sources separate from env precedence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-config-'))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(path.join(root, '.gugo'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({
    env: {},
    pluginConfig: {
      layers: [{
        id: 'local-installation',
        kind: 'installation',
        priority: 300,
        plugins: { 'plugin-a': { enabled: true } },
      }],
    },
  }))
  fs.writeFileSync(path.join(root, '.gugo', 'runtime.json'), JSON.stringify({
    env: {},
    pluginConfig: {
      layers: [{
        id: 'project-profile',
        kind: 'profile',
        priority: 100,
        plugins: { 'plugin-a': { label: 'project' } },
      }],
    },
  }))
  try {
    assert.deepEqual(readRuntimePluginConfigLayerSources({
      cwd: root,
      env: { APP_DATA_DIR: dataDir, GUGO_LOAD_DOTENV: '0' },
    }).map((entry) => ({ source: entry.source, ids: entry.layers.map((layer) => layer.id) })), [
      { source: 'user_config', ids: ['local-installation'] },
      { source: 'project_config', ids: ['project-profile'] },
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runtime plugin config file validation attributes deep layer errors to their source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-config-invalid-layer-'))
  const dataDir = path.join(root, 'data')
  const configPath = path.join(dataDir, 'runtime.json')
  fs.mkdirSync(dataDir, { recursive: true })
  const document = { env: {}, pluginConfig: { layers: [{}] } }
  fs.writeFileSync(configPath, JSON.stringify(document))
  try {
    assert.throws(
      () => readRuntimePluginConfigLayerSources({
        cwd: root,
        env: { APP_DATA_DIR: dataDir, GUGO_LOAD_DOTENV: '0' },
      }),
      (error) => error?.code === 'PLUGIN_CONFIG_FILE_INVALID'
        && error.sourcePath === configPath
        && error.cause?.code === 'PLUGIN_CONFIG_LAYERS_INVALID',
    )
    assert.throws(
      () => validateRuntimePluginConfigDocument(document, { sourcePath: configPath }),
      (error) => error?.code === 'PLUGIN_CONFIG_FILE_INVALID'
        && error.sourcePath === configPath,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('config reload atomically switches services and drains callbacks on the old instance', async () => {
  let blockOld = false
  let oldStartedResolve
  let releaseOldResolve
  const oldStarted = new Promise((resolve) => { oldStartedResolve = resolve })
  const releaseOld = new Promise((resolve) => { releaseOldResolve = resolve })
  const pluginManifest = {
    ...manifest('hot-config', {
      type: 'object',
      required: ['value', 'apiKey'],
      properties: { value: { type: 'string' }, apiKey: { type: 'string' } },
      additionalProperties: false,
    }),
    contributes: ['service:hot-config-value'],
  }
  const registry = createRuntimePluginRegistry({
    configLayers: [{
      id: 'host-default',
      kind: 'defaults',
      priority: 0,
      plugins: { 'hot-config': { value: 'old', apiKey: 'old-secret-value' } },
    }],
  })
  const setup = (context) => {
    const { value } = context.config
    context.lifecycle.onConfigHealthCheck(() => value !== 'unhealthy')
    context.services.provide('hot-config-value', {
      async read() {
        if (value === 'old' && blockOld) {
          oldStartedResolve()
          await releaseOld
        }
        return { value }
      },
    })
  }
  await registry.registerPlugin(pluginManifest, setup)
  blockOld = true
  const oldCall = registry.invokeService('hot-config-value', 'read')
  await oldStarted

  const reload = registry.reloadPluginConfig('hot-config', {
    expectedRevision: 1,
    configLayerSources: [{
      source: 'user_config',
      layers: [{
        id: 'user-installation',
        kind: 'installation',
        priority: 100,
        plugins: { 'hot-config': { value: 'new', apiKey: 'new-secret-value' } },
      }],
    }],
  })
  for (let attempts = 0; attempts < 20 && registry.getPlugin('hot-config').configRevision < 2; attempts += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(registry.getPlugin('hot-config').configRevision, 2)
  const newCall = await registry.invokeService('hot-config-value', 'read')
  assert.deepEqual(newCall.value, { value: 'new' })
  let reloadSettled = false
  reload.finally(() => { reloadSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reloadSettled, false)

  releaseOldResolve()
  assert.deepEqual((await oldCall).value, { value: 'old' })
  assert.equal((await reload).configRevision, 2)
  const effective = registry.listEffectiveConfigs()[0]
  assert.equal(effective.revision, 2)
  assert.equal(effective.config.apiKey, '[REDACTED]')
  const auditJson = JSON.stringify(registry.listConfigReloadAudit())
  assert.equal(auditJson.includes('old-secret-value'), false)
  assert.equal(auditJson.includes('new-secret-value'), false)
  await registry.shutdown()
})

test('config reload schema and health failures preserve the active revision and contribution', async () => {
  const registry = createRuntimePluginRegistry({
    configLayers: [{
      id: 'host-default',
      kind: 'defaults',
      priority: 0,
      plugins: { 'guarded-config': { value: 'old' } },
    }],
  })
  const pluginManifest = {
    ...manifest('guarded-config', {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'string' } },
      additionalProperties: false,
    }),
    contributes: ['service:guarded-value'],
  }
  await registry.registerPlugin(pluginManifest, (context) => {
    const { value } = context.config
    context.lifecycle.onConfigHealthCheck(() => value !== 'unhealthy')
    context.services.provide('guarded-value', { read: () => ({ value }) })
  })
  const layerSources = (value) => [{
    source: 'user_config',
    layers: [{
      id: 'user-installation',
      kind: 'installation',
      priority: 100,
      plugins: { 'guarded-config': { value } },
    }],
  }]
  await assert.rejects(
    registry.reloadPluginConfig('guarded-config', {
      expectedRevision: 1,
      configLayerSources: layerSources(42),
    }),
    (error) => error?.code === 'PLUGIN_CONFIG_VALIDATION_FAILED',
  )
  await assert.rejects(
    registry.reloadPluginConfig('guarded-config', {
      expectedRevision: 1,
      configLayerSources: layerSources('unhealthy'),
    }),
    (error) => error?.code === 'PLUGIN_CONFIG_HEALTH_CHECK_FAILED',
  )
  assert.equal(registry.getPlugin('guarded-config').configRevision, 1)
  assert.deepEqual((await registry.invokeService('guarded-value', 'read')).value, { value: 'old' })
  await registry.shutdown()
})

test('config reload activation failure restores the old managed contribution', async () => {
  let registrationCalls = 0
  let activeRegistration = null
  let initialRegistration = null
  const registry = createRuntimePluginRegistry({
    configLayers: [{
      id: 'host-default',
      kind: 'defaults',
      priority: 0,
      plugins: { 'activation-config': { value: 'old' } },
    }],
    registerTool(registration) {
      registrationCalls += 1
      if (registrationCalls === 2) throw new Error('candidate activation rejected')
      activeRegistration = registration
      if (!initialRegistration) initialRegistration = registration
      const dispose = () => {
        if (activeRegistration === registration) activeRegistration = null
      }
      return v2Disposer(dispose)
    },
  })
  await registry.registerPlugin({
    ...manifest('activation-config'),
    contributes: ['tool:activation_config_tool'],
  }, (context) => {
    context.tools.register({
      name: 'activation_config_tool',
      spec: {
        type: 'function',
        function: {
          name: 'activation_config_tool',
          description: 'returns the active config',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      exec: async () => ({ value: context.config.value }),
    })
  })
  await assert.rejects(
    registry.reloadPluginConfig('activation-config', {
      expectedRevision: 1,
      configLayerSources: [{
        source: 'user_config',
        layers: [{
          id: 'user-installation',
          kind: 'installation',
          priority: 100,
          plugins: { 'activation-config': { value: 'new' } },
        }],
      }],
    }),
    (error) => error?.code === 'PLUGIN_CONFIG_ACTIVATION_FAILED',
  )
  assert.equal(registrationCalls, 3)
  assert.equal(activeRegistration, initialRegistration)
  assert.equal(registry.getPlugin('activation-config').configRevision, 1)
  await registry.shutdown()
})

test('failed config candidate remains inventoried and shutdown retries its retained contribution', async () => {
  const activeRegistrations = new Set()
  const activeCapabilities = new Set()
  let candidateRevokeAttempts = 0
  const registry = createRuntimePluginRegistry({
    configLayers: [{
      id: 'host-default',
      kind: 'defaults',
      priority: 0,
      plugins: { 'candidate-tombstone-config': { value: 'old' } },
    }],
    registerRuntimeCapability(definition) {
      activeCapabilities.add(definition)
      return v2Disposer(() => activeCapabilities.delete(definition))
    },
    registerTool(registration) {
      const value = registration.spec.function.description
      const suffix = registration.name.endsWith('_a') ? 'a' : 'b'
      if (value === 'new' && suffix === 'b') {
        throw new Error('second candidate tool activation rejected')
      }
      const entry = { label: `${value}:${suffix}`, registration }
      activeRegistrations.add(entry)
      const dispose = () => activeRegistrations.delete(entry)
      if (value !== 'new') return v2Disposer(dispose)
      return v2Disposer(dispose, () => {
        candidateRevokeAttempts += 1
        if (candidateRevokeAttempts < 3) {
          return createRuntimePluginRevokeReceipt('retained')
        }
        dispose()
        return createRuntimePluginRevokeReceipt('revoked')
      })
    },
  })
  const toolDefinition = (name, value) => ({
    name,
    spec: {
      type: 'function',
      function: {
        name,
        description: value,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    exec: async () => ({ value }),
  })
  await registry.registerPlugin({
    ...manifest('candidate-tombstone-config'),
    contributes: ['tool:candidate_tombstone_a', 'tool:candidate_tombstone_b'],
  }, (context) => {
    context.tools.register(toolDefinition('candidate_tombstone_a', context.config.value))
    context.tools.register(toolDefinition('candidate_tombstone_b', context.config.value))
  })

  await assert.rejects(
    registry.reloadPluginConfig('candidate-tombstone-config', {
      expectedRevision: 1,
      configLayerSources: [{
        source: 'user_config',
        layers: [{
          id: 'user-installation',
          kind: 'installation',
          priority: 100,
          plugins: { 'candidate-tombstone-config': { value: 'new' } },
        }],
      }],
    }),
    (error) => error?.code === 'PLUGIN_CONFIG_ROLLBACK_FAILED',
  )

  assert.equal(candidateRevokeAttempts, 2)
  assert.equal(registry.getPlugin('candidate-tombstone-config')?.configRevision, 1)
  assert.deepEqual(
    registry.listPlugins()
      .filter((plugin) => plugin.id === 'candidate-tombstone-config')
      .map((plugin) => ({ revision: plugin.configRevision, state: plugin.state })),
    [
      { revision: 1, state: 'active' },
      { revision: 2, state: 'candidate_cleanup_failed' },
    ],
  )
  assert.deepEqual(
    [...activeRegistrations].map((entry) => entry.label).sort(),
    ['new:a', 'old:a', 'old:b'],
  )
  assert.equal(
    registry.listConfigReloadAudit().filter((entry) => (
      entry.event === 'plugin.config_reload_candidate_cleanup_failed'
    )).length,
    1,
  )

  await registry.shutdown()
  assert.equal(candidateRevokeAttempts, 3)
  assert.equal(activeRegistrations.size, 0)
  assert.equal(activeCapabilities.size, 0)
  assert.deepEqual(registry.listPlugins(), [])
})

test('concurrent config reloads use revision CAS so only one candidate commits', async () => {
  const registry = createRuntimePluginRegistry({
    configLayers: [{
      id: 'host-default',
      kind: 'defaults',
      priority: 0,
      plugins: { 'cas-config': { value: 'old' } },
    }],
  })
  await registry.registerPlugin(manifest('cas-config'), () => {})
  const options = {
    expectedRevision: 1,
    configLayerSources: [{
      source: 'user_config',
      layers: [{
        id: 'user-installation',
        kind: 'installation',
        priority: 100,
        plugins: { 'cas-config': { value: 'new' } },
      }],
    }],
  }
  const results = await Promise.allSettled([
    registry.reloadPluginConfig('cas-config', options),
    registry.reloadPluginConfig('cas-config', options),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const rejected = results.find((result) => result.status === 'rejected')
  assert.equal(rejected.reason.code, 'PLUGIN_CONFIG_REVISION_CONFLICT')
  assert.equal(registry.getPlugin('cas-config').configRevision, 2)
  await registry.shutdown()
})

test('config cutover waits for async old cleanup before exposing the new contribution set', async () => {
  const slots = new Map()
  let cleanupResolve
  const cleanup = new Promise((resolve) => { cleanupResolve = resolve })
  const generations = new Map()
  const registry = createRuntimePluginRegistry({
    configLayers: [{
      id: 'host-default',
      kind: 'defaults',
      priority: 0,
      plugins: { 'atomic-config': { value: 'old' } },
    }],
    registerTool(registration) {
      const generation = (generations.get(registration.name) || 0) + 1
      generations.set(registration.name, generation)
      if (slots.has(registration.name)) throw new Error('tool slot is still occupied')
      const slot = { generation, registration }
      slots.set(registration.name, slot)
      const dispose = () => {
        if (slots.get(registration.name) === slot) slots.delete(registration.name)
        return generation === 1 ? cleanup : undefined
      }
      return v2Disposer(dispose, () => {
        const cleanupResult = dispose()
        return createRuntimePluginRevokeReceipt(
          'revoked',
          cleanupResult instanceof Promise ? cleanupResult : null,
        )
      })
    },
  })
  const toolDefinition = (name, value) => ({
    name,
    spec: {
      type: 'function',
      function: {
        name,
        description: `config ${value}`,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    exec: async () => ({ value }),
  })
  await registry.registerPlugin({
    ...manifest('atomic-config'),
    contributes: ['tool:atomic_config_a', 'tool:atomic_config_b'],
  }, (context) => {
    context.tools.register(toolDefinition('atomic_config_a', context.config.value))
    context.tools.register(toolDefinition('atomic_config_b', context.config.value))
  })
  const reload = registry.reloadPluginConfig('atomic-config', {
    expectedRevision: 1,
    configLayerSources: [{
      source: 'user_config',
      layers: [{
        id: 'user-installation',
        kind: 'installation',
        priority: 100,
        plugins: { 'atomic-config': { value: 'new' } },
      }],
    }],
  })
  let settled = false
  reload.finally(() => { settled = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(registry.getPlugin('atomic-config').configRevision, 1)
  assert.deepEqual([...slots.values()], [])
  cleanupResolve()
  await reload
  assert.equal(registry.getPlugin('atomic-config').configRevision, 2)
  assert.deepEqual([...slots.values()].map((slot) => slot.generation), [2, 2])
  await registry.shutdown()
})

test('config cutover never publishes a candidate when async old cleanup rejects', async () => {
  const activeRegistrations = new Set()
  let oldDisposeAttempts = 0
  const registry = createRuntimePluginRegistry({
    configLayers: [{
      id: 'host-default',
      kind: 'defaults',
      priority: 0,
      plugins: { 'rejecting-cleanup-config': { value: 'old' } },
    }],
    registerTool(registration) {
      const entry = {
        registration,
        value: registration.spec.function.description,
      }
      activeRegistrations.add(entry)
      const dispose = () => {
        if (entry.value === 'old' && oldDisposeAttempts++ === 0) {
          return Promise.reject(new Error('old cleanup rejected'))
        }
        activeRegistrations.delete(entry)
      }
      return v2Disposer(dispose, () => {
        const cleanupResult = dispose()
        if (cleanupResult instanceof Promise) {
          return createRuntimePluginRevokeReceipt('retained', cleanupResult)
        }
        return createRuntimePluginRevokeReceipt('revoked')
      })
    },
  })
  await registry.registerPlugin({
    ...manifest('rejecting-cleanup-config'),
    contributes: ['tool:rejecting_cleanup_tool'],
  }, (context) => {
    context.tools.register({
      name: 'rejecting_cleanup_tool',
      spec: {
        type: 'function',
        function: {
          name: 'rejecting_cleanup_tool',
          description: context.config.value,
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      exec: async () => ({ value: context.config.value }),
    })
  })

  await assert.rejects(
    registry.reloadPluginConfig('rejecting-cleanup-config', {
      expectedRevision: 1,
      configLayerSources: [{
        source: 'user_config',
        layers: [{
          id: 'user-installation',
          kind: 'installation',
          priority: 100,
          plugins: { 'rejecting-cleanup-config': { value: 'new' } },
        }],
      }],
    }),
    (error) => error?.code === 'PLUGIN_CONFIG_ROLLBACK_FAILED',
  )
  assert.equal(registry.getPlugin('rejecting-cleanup-config').configRevision, 1)
  assert.deepEqual([...activeRegistrations].map((entry) => entry.value), ['old'])
  assert.equal(oldDisposeAttempts, 1)
  await registry.shutdown()
  assert.equal(activeRegistrations.size, 0)
})

test('config cutover rechecks a Loop deactivation guard after async verification', async () => {
  let inUse = false
  const activeCapabilities = new Set()
  const loopId = 'plugin.reload-guard.loop'
  const registry = createRuntimePluginRegistry({
    configLayers: [{
      id: 'host-default',
      kind: 'defaults',
      priority: 0,
      plugins: { 'reload-guard-config': { value: 'old' } },
    }],
    registerRuntimeCapability(definition) {
      activeCapabilities.add(definition)
      return v2Disposer(() => activeCapabilities.delete(definition))
    },
    isRuntimeCapabilityInUse: () => inUse,
    isRuntimeCapabilitySlotActive: () => false,
  })
  await registry.registerPlugin({
    ...manifest('reload-guard-config'),
    contributes: [`loop:${loopId}`],
  }, (context) => {
    context.loops.register({
      id: loopId,
      contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
      run: async () => ({ text: context.config.value }),
    }, {
      replaces: BUILTIN_TOOL_LOOP_ADAPTER_ID,
      priority: 100,
    })
  })

  await assert.rejects(
    registry.reloadPluginConfig('reload-guard-config', {
      expectedRevision: 1,
      configLayerSources: [{
        source: 'user_config',
        layers: [{
          id: 'user-installation',
          kind: 'installation',
          priority: 100,
          plugins: { 'reload-guard-config': { value: 'new' } },
        }],
      }],
      verifyBeforeCommit() {
        inUse = true
      },
    }),
    (error) => error?.code === 'PLUGIN_LOOP_CAPABILITY_IN_USE',
  )
  assert.equal(registry.getPlugin('reload-guard-config').configRevision, 1)
  assert.equal(registry.getPlugin('reload-guard-config').state, 'active')
  assert.equal(activeCapabilities.size, 1)
  inUse = false
  await registry.shutdown()
})

test('hostile reload errors cannot bypass staged candidate cleanup', async () => {
  const disposedRevisions = []
  let setupRevision = 0
  let statusDescriptorTraps = 0
  const registry = createRuntimePluginRegistry({
    configLayers: [{
      id: 'host-default',
      kind: 'defaults',
      priority: 0,
      plugins: { 'hostile-error-config': { value: 'old' } },
    }],
  })
  await registry.registerPlugin(manifest('hostile-error-config'), (context) => {
    const revision = ++setupRevision
    context.lifecycle.onDispose(() => disposedRevisions.push(revision))
  })
  const hostileError = new Proxy(
    Object.assign(new Error('hostile verifier error'), { code: 'PLUGIN_HOSTILE_VERIFY_FAILED' }),
    {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'statusCode') {
          statusDescriptorTraps += 1
          throw new Error('statusCode descriptor trap')
        }
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    },
  )

  await assert.rejects(
    registry.reloadPluginConfig('hostile-error-config', {
      expectedRevision: 1,
      configLayerSources: [{
        source: 'user_config',
        layers: [{
          id: 'user-installation',
          kind: 'installation',
          priority: 100,
          plugins: { 'hostile-error-config': { value: 'new' } },
        }],
      }],
      verifyBeforeCommit() {
        throw hostileError
      },
    }),
    (error) => error?.code === 'PLUGIN_HOSTILE_VERIFY_FAILED' && error?.statusCode === 500,
  )
  assert.deepEqual(disposedRevisions, [2])
  assert.equal(statusDescriptorTraps > 0, true)
  assert.equal(registry.getPlugin('hostile-error-config').configRevision, 1)
  await registry.shutdown()
  assert.deepEqual(disposedRevisions, [2, 1])
})

test('runtime plugin config source snapshots detect changes without exposing file contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-config-source-'))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const runtimePath = path.join(dataDir, 'runtime.json')
  const options = { cwd: root, env: { APP_DATA_DIR: dataDir, GUGO_LOAD_DOTENV: '0' } }
  fs.writeFileSync(runtimePath, JSON.stringify({
    env: {},
    pluginConfig: { layers: [] },
    marker: 'first-private-value',
  }))
  try {
    const snapshot = readRuntimePluginConfigSourceSnapshot(options)
    assert.equal(Object.hasOwn(snapshot, 'content'), false)
    assert.equal(assertRuntimePluginConfigSourceSnapshot(snapshot, options), true)
    fs.writeFileSync(runtimePath, JSON.stringify({
      env: {},
      pluginConfig: { layers: [] },
      marker: 'second-private-value',
    }))
    assert.throws(
      () => assertRuntimePluginConfigSourceSnapshot(snapshot, options),
      (error) => error?.code === 'PLUGIN_CONFIG_SOURCE_CHANGED',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runtime plugin config initialization owns startup cwd across idempotent checks and reloads', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-config-startup-cwd-'))
  let runtime = null
  try {
    const configPath = path.join(cwd, '.gugo', 'runtime.json')
    const runtimeEnv = { GUGO_LOAD_DOTENV: '0', APP_DATA_DIR: path.join(cwd, 'data') }
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    const writeConfig = (marker) => fs.writeFileSync(configPath, JSON.stringify({
      env: {},
      pluginConfig: {
        layers: [{
          id: 'custom-cwd-profile',
          kind: 'profile',
          priority: 100,
          plugins: { 'startup-config-probe': { marker } },
        }],
      },
    }), 'utf8')
    writeConfig('custom-cwd')
    runtime = await import(`../server/plugins/pluginRegistry.js?startup-cwd=${Date.now()}`)
    runtime.initializeRuntimePluginConfig({
      cwd,
      env: runtimeEnv,
    })
    const observedConfigs = []
    await runtime.registerPlugin(manifest('startup-config-probe'), (context) => {
      observedConfigs.push(context.config)
    })

    assert.deepEqual(observedConfigs, [{ marker: 'custom-cwd' }])
    assert.equal(
      runtime.listRuntimePluginEffectiveConfigs()[0].layers.at(-1).source,
      'project_config',
    )

    assert.equal(runtime.initializeRuntimePluginConfig({ cwd, env: runtimeEnv }), true)
    writeConfig('updated-custom-cwd')
    assert.throws(
      () => runtime.initializeRuntimePluginConfig({ cwd, env: runtimeEnv }),
      (error) => error?.code === 'PLUGIN_CONFIG_INITIALIZATION_CONFLICT'
        && error.retryable === false,
    )
    const reloaded = await runtime.reloadRuntimePluginConfig('startup-config-probe', {
      expectedRevision: 1,
      env: runtimeEnv,
    })
    assert.equal(reloaded.configRevision, 2)
    assert.deepEqual(observedConfigs, [
      { marker: 'custom-cwd' },
      { marker: 'updated-custom-cwd' },
    ])

    assert.equal(await runtime.unregisterPlugin('startup-config-probe'), true)
    await runtime.shutdownRuntimePlugins()
  } finally {
    await runtime?.shutdownRuntimePlugins().catch(() => {})
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('runtime plugin config reload preserves sparse startup env and rejects source relocation', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-config-startup-env-'))
  const dataDir = path.join(cwd, 'custom-data')
  const relocatedDataDir = path.join(cwd, 'other-data')
  const runtimeEnv = { GUGO_LOAD_DOTENV: '0', APP_DATA_DIR: dataDir }
  let runtime = null
  try {
    const configPath = path.join(dataDir, 'runtime.json')
    fs.mkdirSync(dataDir, { recursive: true })
    const writeConfig = (marker) => fs.writeFileSync(configPath, JSON.stringify({
      env: {},
      pluginConfig: {
        layers: [{
          id: 'startup-user-profile',
          kind: 'profile',
          priority: 100,
          plugins: { 'startup-user-probe': { marker } },
        }],
      },
    }), 'utf8')
    writeConfig('initial-user')
    runtime = await import(`../server/plugins/pluginRegistry.js?startup-env=${Date.now()}`)
    runtime.initializeRuntimePluginConfig({ cwd, env: runtimeEnv })
    const observedConfigs = []
    await runtime.registerPlugin(manifest('startup-user-probe'), (context) => {
      observedConfigs.push(context.config)
    })
    writeConfig('updated-user')

    assert.throws(
      () => runtime.reloadRuntimePluginConfig('startup-user-probe', {
        expectedRevision: 1,
        env: { GUGO_LOAD_DOTENV: '0', APP_DATA_DIR: relocatedDataDir },
      }),
      (error) => error?.code === 'PLUGIN_CONFIG_SOURCE_IDENTITY_CHANGED'
        && error.statusCode === 409
        && error.retryable === false,
    )
    assert.equal(runtime.getRuntimePlugin('startup-user-probe').configRevision, 1)

    const reloaded = await runtime.reloadRuntimePluginConfig('startup-user-probe', {
      expectedRevision: 1,
      env: { GUGO_LOAD_DOTENV: '0' },
    })
    assert.equal(reloaded.configRevision, 2)
    assert.deepEqual(observedConfigs, [
      { marker: 'initial-user' },
      { marker: 'updated-user' },
    ])
    await runtime.shutdownRuntimePlugins()
  } finally {
    await runtime?.shutdownRuntimePlugins().catch(() => {})
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('runtime plugin registry rejects config source changes after installation begins', async () => {
  const registry = createRuntimePluginRegistry()
  registry.initializeConfigLayerSources([{
    source: 'project_config',
    layers: [{
      id: 'initial-profile',
      kind: 'profile',
      priority: 100,
      plugins: { 'sealed-config': { marker: 'initial' } },
    }],
  }])
  let observedConfig = null
  await registry.registerPlugin(manifest('sealed-config'), (context) => {
    observedConfig = context.config
  })
  assert.deepEqual(observedConfig, { marker: 'initial' })
  assert.throws(
    () => registry.initializeConfigLayerSources([]),
    (error) => error?.code === 'PLUGIN_CONFIG_INITIALIZATION_TOO_LATE'
      && error.retryable === false,
  )
  await registry.shutdown()
})
