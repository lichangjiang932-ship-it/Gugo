import assert from 'node:assert/strict'
import test from 'node:test'

import { createAppServer } from '../server/appServer.js'
import { createHttpCapabilityRegistry } from '../server/core/httpCapabilityRegistry.js'
import {
  bindRuntimePluginHttpCapabilities,
  listRuntimePluginHttpCapabilities,
  registerPlugin,
  unregisterPlugin,
} from '../server/plugins/pluginRegistry.js'
import { createRuntimePluginRegistry } from '../server/plugins/runtimePluginRegistry.js'

function manifest(id, capabilityId) {
  return {
    id,
    name: id,
    version: '1.0.0',
    contributes: [`http-capability:${capabilityId}`],
  }
}

function builtinStatusCapability(handle = () => 'builtin') {
  return {
    id: 'builtin.test.status',
    owner: 'builtin',
    priority: 100,
    apiPrefixes: ['/api/test/status'],
    match: (req) => req.url?.startsWith('/api/test/status'),
    handle,
  }
}

function replacement(handle, overrides = {}) {
  return {
    id: 'plugin.test.status',
    priority: 200,
    replaces: 'builtin.test.status',
    apiPrefixes: ['/api/test/status'],
    handle,
    ...overrides,
  }
}

test('runtime HTTP capability activation is staged, explicit, reversible, and audited', async () => {
  const capabilityAudit = []
  const pluginAudit = []
  const capabilities = createHttpCapabilityRegistry({
    audit: (entry) => capabilityAudit.push(entry),
  })
  capabilities.register(builtinStatusCapability())
  const runtime = createRuntimePluginRegistry({
    registerHttpCapability: (definition) => capabilities.register(definition),
    audit: (entry) => pluginAudit.push(entry),
  })

  let releaseSetup
  let setupRegistered
  const setupRegisteredPromise = new Promise((resolve) => { setupRegistered = resolve })
  const setupBarrier = new Promise((resolve) => { releaseSetup = resolve })
  const installation = runtime.registerPlugin(
    manifest('http-replacement', 'plugin.test.status'),
    async (context) => {
      context.http.register(replacement(() => 'plugin'))
      setupRegistered()
      await setupBarrier
    },
  )

  await setupRegisteredPromise
  assert.equal(capabilities.has('builtin.test.status'), true)
  assert.equal(capabilities.has('plugin.test.status'), false)

  releaseSetup()
  await installation
  assert.deepEqual(capabilities.get('plugin.test.status'), {
    id: 'plugin.test.status',
    owner: 'http-replacement',
    priority: 200,
    replaces: 'builtin.test.status',
    apiPrefixes: ['/api/test/status'],
    sequence: 2,
  })
  assert.equal(
    await capabilities.dispatch({ url: '/api/test/status' }, {}).result,
    'plugin',
  )

  assert.equal(await runtime.unregisterPlugin('http-replacement'), true)
  assert.equal(capabilities.has('plugin.test.status'), false)
  assert.equal(capabilities.has('builtin.test.status'), true)
  assert.equal(capabilities.dispatch({ url: '/api/test/status' }, {}).result, 'builtin')
  assert.ok(capabilityAudit.some((entry) => (
    entry.event === 'http_capability.replaced'
    && entry.owner === 'http-replacement'
    && entry.replacedCapabilityId === 'builtin.test.status'
  )))
  assert.ok(pluginAudit.some((entry) => (
    entry.event === 'plugin.http_capability_registered'
    && entry.pluginId === 'http-replacement'
    && entry.priority === 200
  )))
  assert.ok(pluginAudit.some((entry) => (
    entry.event === 'plugin.http_capability_unregistered'
    && entry.restoredCapabilityId === 'builtin.test.status'
  )))
})

test('runtime HTTP capability failures leave the builtin route authoritative', async () => {
  const capabilities = createHttpCapabilityRegistry()
  capabilities.register(builtinStatusCapability())
  const runtime = createRuntimePluginRegistry({
    registerHttpCapability: (definition) => capabilities.register(definition),
  })

  await assert.rejects(
    runtime.registerPlugin(
      manifest('low-priority-replacement', 'plugin.test.status'),
      (context) => context.http.register(replacement(() => 'plugin', { priority: 100 })),
    ),
    (error) => error?.code === 'HTTP_CAPABILITY_PRIORITY_CONFLICT'
      && error?.retryable === false,
  )
  assert.equal(runtime.getPlugin('low-priority-replacement'), null)
  assert.equal(capabilities.has('plugin.test.status'), false)
  assert.equal(capabilities.dispatch({ url: '/api/test/status' }, {}).result, 'builtin')

  await assert.rejects(
    runtime.registerPlugin({
      ...manifest('undeclared-http-capability', 'different.capability'),
      contributes: [],
    }, (context) => context.http.register(replacement(() => 'plugin'))),
    (error) => error?.code === 'PLUGIN_CONTRIBUTION_UNDECLARED',
  )
  assert.equal(capabilities.has('plugin.test.status'), false)
})

test('runtime HTTP capability unload restores routing before draining an in-flight handler', async () => {
  const capabilities = createHttpCapabilityRegistry()
  capabilities.register(builtinStatusCapability())
  const runtime = createRuntimePluginRegistry({
    registerHttpCapability: (definition) => capabilities.register(definition),
  })
  let releaseHandler
  let handlerStarted
  const handlerStartedPromise = new Promise((resolve) => { handlerStarted = resolve })
  const handlerBarrier = new Promise((resolve) => { releaseHandler = resolve })
  await runtime.registerPlugin(
    manifest('draining-http-capability', 'plugin.test.status'),
    (context) => context.http.register(replacement(async () => {
      handlerStarted()
      await handlerBarrier
      return 'plugin-finished'
    })),
  )

  const inFlight = capabilities.dispatch({ url: '/api/test/status' }, {}).result
  await handlerStartedPromise
  let uninstallSettled = false
  const uninstall = runtime.unregisterPlugin('draining-http-capability')
    .then((value) => {
      uninstallSettled = true
      return value
    })
  await Promise.resolve()
  assert.equal(capabilities.has('plugin.test.status'), false)
  assert.equal(capabilities.has('builtin.test.status'), true)
  assert.equal(uninstallSettled, false)

  releaseHandler()
  assert.equal(await inFlight, 'plugin-finished')
  assert.equal(await uninstall, true)
})

test('runtime HTTP capability definitions and failures stay behind a detached boundary', async () => {
  const capabilities = createHttpCapabilityRegistry()
  capabilities.register(builtinStatusCapability())
  let hostRegistrationCalls = 0
  const runtime = createRuntimePluginRegistry({
    registerHttpCapability(definition) {
      hostRegistrationCalls += 1
      return capabilities.register(definition)
    },
  })
  let getterCalls = 0
  const invalidDefinition = replacement(() => 'unreachable')
  Object.defineProperty(invalidDefinition, 'handle', {
    enumerable: true,
    get() {
      getterCalls += 1
      return () => 'forged'
    },
  })
  await assert.rejects(
    runtime.registerPlugin(
      manifest('invalid-http-definition', 'plugin.test.status'),
      (context) => context.http.register(invalidDefinition),
    ),
    (error) => error?.code === 'PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID'
      && error?.retryable === false,
  )
  assert.equal(getterCalls, 0)
  assert.equal(hostRegistrationCalls, 0)

  const thrown = {}
  Object.defineProperty(thrown, 'message', {
    get() {
      getterCalls += 1
      return 'secret getter'
    },
  })
  await runtime.registerPlugin(
    manifest('isolated-http-failure', 'plugin.test.status'),
    (context) => context.http.register(replacement(async () => { throw thrown })),
  )
  await assert.rejects(
    capabilities.dispatch({ url: '/api/test/status' }, {}).result,
    (error) => error !== thrown
      && error?.code === 'PLUGIN_HTTP_CAPABILITY_EXECUTION_FAILED'
      && error?.retryable === false
      && error?.pluginId === 'isolated-http-failure'
      && error?.capabilityId === 'plugin.test.status'
      && !Object.hasOwn(error, 'cause'),
  )
  assert.equal(getterCalls, 0)
  assert.equal(await runtime.unregisterPlugin('isolated-http-failure'), true)
})

test('runtime HTTP capability serves a real app request and restores the builtin on unload', async (t) => {
  const server = createAppServer({ getEnv: () => ({ AUTH_MODE: 'local' }) })
  const unbind = bindRuntimePluginHttpCapabilities(server.httpCapabilities)
  t.after(async () => {
    await unregisterPlugin('real-http-replacement')
    unbind()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
  })
  await registerPlugin({
    id: 'real-http-replacement',
    name: 'real-http-replacement',
    version: '1.0.0',
    contributes: ['http-capability:plugin.model.status'],
  }, (context) => context.http.register({
    id: 'plugin.model.status',
    priority: 20_000,
    replaces: 'builtin.model.status',
    apiPrefixes: ['/api/model/status'],
    handle: async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ source: 'runtime-plugin' }))
    },
  }))

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const replaced = await fetch(`${baseUrl}/api/model/status`)
  assert.equal(replaced.status, 200)
  assert.deepEqual(await replaced.json(), { source: 'runtime-plugin' })
  const activeCapability = listRuntimePluginHttpCapabilities()
    .find((entry) => entry.id === 'plugin.model.status')
  assert.equal(activeCapability?.owner, 'real-http-replacement')
  assert.equal(activeCapability?.priority, 20_000)
  assert.equal(activeCapability?.replaces, 'builtin.model.status')
  assert.deepEqual(activeCapability?.apiPrefixes, ['/api/model/status'])
  assert.ok(Number.isSafeInteger(activeCapability?.sequence))

  assert.equal(await unregisterPlugin('real-http-replacement'), true)
  assert.equal(
    listRuntimePluginHttpCapabilities().some((entry) => entry.id === 'plugin.model.status'),
    false,
  )
  const restored = await fetch(`${baseUrl}/api/model/status`)
  assert.equal(restored.status, 401)
  assert.notEqual((await restored.json()).source, 'runtime-plugin')
})
