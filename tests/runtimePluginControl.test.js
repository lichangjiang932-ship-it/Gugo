import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-runtime-plugin-control-'))
const pluginRoot = path.join(tempDir, 'plugins')
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

function writePlugin(dirName, manifest, source) {
  const dir = path.join(pluginRoot, dirName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(dir, manifest.entry), source)
}

writePlugin('test-transformer', {
  id: 'test-transformer',
  name: 'Test Transformer',
  version: '1.0.0',
  type: 'transformer',
  entry: 'entry.js',
}, "function transform(input) { return typeof input === 'string' ? input.toUpperCase() : input }")

writePlugin('test-prompt', {
  id: 'test-prompt',
  name: 'Test Prompt',
  version: '1.0.0',
  type: 'prompt-template',
  entry: 'prompt.md',
}, 'Test prompt')

const { bootstrapAuth } = await import('../server/adapters/authAccount.js')
const { closeDb, getDb } = await import('../server/db.js')
const {
  _resetForTests,
  _resetRuntimePluginsForTests,
  initPlugins,
  registerPlugin,
} = await import('../server/plugins/pluginRegistry.js')
const { handlePluginRequest } = await import('../server/routes/pluginRoutes.js')
const {
  restoreEnabledRuntimePlugins,
  runtimeTransformerToolName,
} = await import('../server/services/runtimePluginControlService.js')
const {
  getRuntimePluginState,
  listRuntimePluginStates,
  recordRuntimePluginError,
  setRuntimePluginState,
} = await import('../server/services/runtimePluginStateStore.js')
const { getDynamicTool } = await import('../server/utils/toolSchemaCatalog.js')

function createReq({ url, token = '', method = 'GET', remoteAddress = '127.0.0.1' }) {
  return {
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    socket: { remoteAddress },
  }
}

function createRes() {
  return {
    statusCode: 200,
    body: '',
    writeHead(statusCode) { this.statusCode = statusCode },
    end(chunk = '') { this.body += chunk },
  }
}

async function requestRuntime({
  url = '/api/plugins/runtime',
  token = '',
  method = 'GET',
  remoteAddress = '127.0.0.1',
  env = { AUTH_MODE: 'local' },
} = {}) {
  const res = createRes()
  await handlePluginRequest(createReq({ url, token, method, remoteAddress }), res, { env })
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

function localOwner() {
  return bootstrapAuth({ env: { AUTH_MODE: 'local' } })
}

test.beforeEach(async () => {
  await _resetRuntimePluginsForTests()
  _resetForTests()
  const db = getDb()
  db.prepare('DELETE FROM runtime_plugin_states').run()
  db.prepare('DELETE FROM sessions').run()
  db.prepare('DELETE FROM login_codes').run()
  db.prepare('DELETE FROM users').run()
  db.prepare("DELETE FROM meta WHERE key = 'local_auth_owner_user_id'").run()
  const loaded = initPlugins({ rootDir: pluginRoot, silent: true })
  assert.equal(loaded.errors.length, 0)
})

test.afterEach(async () => {
  await _resetRuntimePluginsForTests()
})

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('runtime plugin state store persists, updates, lists, and validates states', () => {
  assert.deepEqual(listRuntimePluginStates(), [])

  assert.deepEqual(setRuntimePluginState({
    pluginId: 'test-transformer',
    enabled: true,
    lastError: ' first failure ',
    now: 10,
  }), {
    pluginId: 'test-transformer',
    enabled: true,
    lastError: 'first failure',
    updatedAt: 10,
  })
  assert.deepEqual(getRuntimePluginState('test-transformer'), {
    pluginId: 'test-transformer',
    enabled: true,
    lastError: 'first failure',
    updatedAt: 10,
  })

  const updated = recordRuntimePluginError({
    pluginId: 'test-transformer',
    error: 'second failure',
    now: 11,
  })
  assert.equal(updated.enabled, true)
  assert.equal(updated.lastError, 'second failure')
  assert.deepEqual(listRuntimePluginStates(), [updated])

  assert.throws(
    () => setRuntimePluginState({ pluginId: '../escape', enabled: true }),
    /pluginId must match/,
  )
  assert.throws(
    () => setRuntimePluginState({ pluginId: 'valid-id', enabled: true, now: -1 }),
    /now must be a non-negative safe integer/,
  )
})

test('runtime inventory requires authentication', async () => {
  const response = await requestRuntime()
  assert.equal(response.status, 401)
  assert.equal(response.body.error.code, 'UNAUTHORIZED')
})

test('runtime inventory rejects authenticated non-loopback requests', async () => {
  const owner = localOwner()
  const response = await requestRuntime({ token: owner.token, remoteAddress: '192.0.2.10' })
  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'LOCAL_OWNER_ONLY')
})

test('runtime inventory accepts the full IPv4 loopback range and IPv6 loopback forms', async () => {
  const owner = localOwner()
  for (const remoteAddress of [
    '127.12.4.9',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.12.4.9',
  ]) {
    const response = await requestRuntime({ token: owner.token, remoteAddress })
    assert.equal(response.status, 200, remoteAddress)
  }
  const mappedRemote = await requestRuntime({
    token: owner.token,
    remoteAddress: '::ffff:192.0.2.10',
  })
  assert.equal(mappedRemote.status, 403)
})

test('runtime inventory rejects valid sessions in multi-user mode', async () => {
  const owner = localOwner()
  const response = await requestRuntime({
    token: owner.token,
    env: { AUTH_MODE: 'multi_user' },
  })
  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'LOCAL_OWNER_ONLY')
})

test('local installation owner can list runtime transformer inventory', async () => {
  const owner = localOwner()
  const response = await requestRuntime({ token: owner.token })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.schemaVersion, 1)
  assert.deepEqual(response.body.plugins.map((plugin) => plugin.id), ['test-transformer'])
  const transformer = response.body.plugins[0]
  const toolName = runtimeTransformerToolName('test-transformer')
  assert.equal(transformer.active, false)
  assert.equal(transformer.source, 'installed-transformer')
  assert.equal(transformer.controllable, true)
  assert.deepEqual(transformer.manifest, {
    id: 'test-transformer',
    name: 'Test Transformer',
    version: '1.0.0',
    requires: [],
    contributes: [`tool:${toolName}`],
  })
})

test('runtime inventory serializes host plugins as manifest-only JSON', async () => {
  await registerPlugin({
    id: 'host-observer',
    name: 'Host Observer',
    version: '1.2.3',
    requires: [],
    contributes: ['service:private-observer'],
  }, (context) => context.services.provide('private-observer', {
    privateValue: 'DO_NOT_SERIALIZE',
    execute() {},
  }))

  const owner = localOwner()
  const response = await requestRuntime({ token: owner.token })
  assert.equal(response.status, 200)
  const observer = response.body.plugins.find((plugin) => plugin.id === 'host-observer')
  assert.deepEqual(observer, {
    id: 'host-observer',
    name: 'Host Observer',
    version: '1.2.3',
    type: 'runtime',
    source: 'host-runtime',
    available: true,
    controllable: false,
    enabled: true,
    active: true,
    runtimeState: 'active',
    installedAt: observer.installedAt,
    manifest: {
      id: 'host-observer',
      name: 'Host Observer',
      version: '1.2.3',
      requires: [],
      contributes: ['service:private-observer'],
    },
    toolName: null,
    lastError: null,
    updatedAt: null,
  })
  assert.match(observer.installedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(JSON.stringify(response.body).includes('DO_NOT_SERIALIZE'), false)
  assert.doesNotThrow(() => structuredClone(response.body))
})

test('runtime inventory retains unavailable persisted states without inventing a manifest', async () => {
  setRuntimePluginState({
    pluginId: 'missing-transformer',
    enabled: true,
    lastError: 'PLUGIN_NOT_FOUND: 插件不存在',
    now: 25,
  })
  const owner = localOwner()
  const response = await requestRuntime({ token: owner.token })
  const missing = response.body.plugins.find((plugin) => plugin.id === 'missing-transformer')
  assert.equal(missing.source, 'persisted-state')
  assert.equal(missing.available, false)
  assert.equal(missing.controllable, false)
  assert.equal(missing.enabled, true)
  assert.equal(missing.active, false)
  assert.equal(missing.manifest, null)
  assert.equal(missing.lastError, 'PLUGIN_NOT_FOUND: 插件不存在')
  assert.equal(missing.updatedAt, 25)
})

test('enabling a transformer exposes a sandboxed tool and disabling removes it', async () => {
  const owner = localOwner()
  const enabled = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(enabled.status, 200)
  assert.equal(enabled.body.plugin.enabled, true)
  assert.equal(enabled.body.plugin.active, true)

  const toolName = runtimeTransformerToolName('test-transformer')
  assert.deepEqual(enabled.body.plugin.manifest.contributes, [`tool:${toolName}`])
  const tool = getDynamicTool(toolName)
  assert.ok(tool)
  const result = await tool.exec({ input: 'hello' })
  assert.equal(result.ok, true)
  assert.equal(result.output, 'HELLO')
  assert.ok(result.durationMs > 0)

  const disabled = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/disable',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(disabled.status, 200)
  assert.equal(disabled.body.plugin.enabled, false)
  assert.equal(disabled.body.plugin.active, false)
  assert.equal(getDynamicTool(toolName), null)
  assert.equal(getRuntimePluginState('test-transformer').enabled, false)
})

test('enabled transformer state restores from SQLite after runtime registry reset', async () => {
  const owner = localOwner()
  await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  const toolName = runtimeTransformerToolName('test-transformer')
  await _resetRuntimePluginsForTests()
  assert.equal(getDynamicTool(toolName), null)

  assert.deepEqual(await restoreEnabledRuntimePlugins(), [
    { pluginId: 'test-transformer', ok: true },
  ])
  const restored = getDynamicTool(toolName)
  assert.ok(restored)
  const result = await restored.exec({ input: 'restored' })
  assert.equal(result.ok, true)
  assert.equal(result.output, 'RESTORED')
})

test('startup restore cannot overwrite a newer queued disable request', async () => {
  const owner = localOwner()
  await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })

  const disabling = requestRuntime({
    url: '/api/plugins/runtime/test-transformer/disable',
    token: owner.token,
    method: 'POST',
  })
  const restoring = restoreEnabledRuntimePlugins()
  const [disabled, restored] = await Promise.all([disabling, restoring])

  assert.equal(disabled.status, 200)
  assert.deepEqual(restored, [
    { pluginId: 'test-transformer', ok: true, skipped: true },
  ])
  assert.equal(getRuntimePluginState('test-transformer').enabled, false)
  assert.equal(getDynamicTool(runtimeTransformerToolName('test-transformer')), null)
})

test('startup restore keeps process-global plugin tools disabled in multi-user mode', async () => {
  setRuntimePluginState({ pluginId: 'test-transformer', enabled: true })

  assert.deepEqual(await restoreEnabledRuntimePlugins({
    env: { AUTH_MODE: 'multi_user' },
  }), [{
    pluginId: 'test-transformer',
    ok: true,
    skipped: true,
    reason: 'AUTH_MODE_NOT_LOCAL',
  }])
  assert.equal(getRuntimePluginState('test-transformer').enabled, true)
  assert.equal(getDynamicTool(runtimeTransformerToolName('test-transformer')), null)
})

test('restore isolates missing plugins, records the error, and continues', async () => {
  setRuntimePluginState({ pluginId: 'missing-transformer', enabled: true, now: 20 })
  setRuntimePluginState({ pluginId: 'test-transformer', enabled: true, now: 21 })

  const results = await restoreEnabledRuntimePlugins()
  assert.deepEqual(results.map(({ pluginId, ok }) => ({ pluginId, ok })), [
    { pluginId: 'missing-transformer', ok: false },
    { pluginId: 'test-transformer', ok: true },
  ])
  assert.match(getRuntimePluginState('missing-transformer').lastError, /PLUGIN_NOT_FOUND/)
  assert.equal(getRuntimePluginState('missing-transformer').enabled, true)
  assert.ok(getDynamicTool(runtimeTransformerToolName('test-transformer')))
})

test('runtime enable rejects non-transformer plugins', async () => {
  const owner = localOwner()
  const response = await requestRuntime({
    url: '/api/plugins/runtime/test-prompt/enable',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, 'PLUGIN_RUNTIME_TYPE_UNSUPPORTED')
})
