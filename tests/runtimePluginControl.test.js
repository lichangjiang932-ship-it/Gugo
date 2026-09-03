import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

const INITIAL_TRANSFORMER_SOURCE = "function transform(input) { return typeof input === 'string' ? input.toUpperCase() : input }"
const INTEGRITY_TRANSFORMER_SOURCE = "function transform(input) { return 'verified:' + input }"
const INTEGRITY_TRANSFORMER_DIGEST = createHash('sha256').update(INTEGRITY_TRANSFORMER_SOURCE).digest('hex')

writePlugin('test-transformer', {
  id: 'test-transformer',
  name: 'Test Transformer',
  version: '1.0.0',
  type: 'transformer',
  entry: 'entry.js',
}, INITIAL_TRANSFORMER_SOURCE)

writePlugin('test-prompt', {
  id: 'test-prompt',
  name: 'Test Prompt',
  version: '1.0.0',
  type: 'prompt-template',
  entry: 'prompt.md',
}, 'Test prompt')

writePlugin('integrity-transformer', {
  id: 'integrity-transformer',
  name: 'Integrity Transformer',
  version: '1.0.0',
  type: 'transformer',
  entry: 'entry.js',
  integrity: `sha256-${INTEGRITY_TRANSFORMER_DIGEST}`,
}, INTEGRITY_TRANSFORMER_SOURCE)

const { bootstrapAuth } = await import('../server/adapters/authAccount.js')
const { closeDb, createUser, getDb } = await import('../server/db.js')
const { migrateToV75 } = await import('../server/migrations/v75RuntimePluginReleaseRevision.js')
const {
  _resetForTests,
  _resetRuntimePluginsForTests,
  bindRuntimePluginHttpCapabilities,
  getPlugin,
  getRuntimePlugin,
  initPlugins,
  refreshPlugins,
  registerPlugin,
  unregisterPlugin,
} = await import('../server/plugins/pluginRegistry.js')
const {
  buildRuntimePluginPermissionRequest,
} = await import('../server/plugins/runtimePluginPermissions.js')
const { createHttpCapabilityRegistry } = await import('../server/core/httpCapabilityRegistry.js')
const { handlePluginRequest } = await import('../server/routes/pluginRoutes.js')
const {
  restoreEnabledRuntimePlugins,
  runtimeTransformerToolName,
} = await import('../server/services/runtimePluginControlService.js')
const {
  getRuntimePluginPermissionGrant,
  grantRuntimePluginPermissions,
  hasRuntimePluginPermissionGrant,
  revokeRuntimePluginPermissionGrant,
} = await import('../server/services/runtimePluginPermissionGrantStore.js')
const {
  activateRuntimePluginRelease,
  countRuntimePluginReleases,
  createRuntimePluginRelease,
  getLatestRuntimePluginRelease,
  getRuntimePluginRelease,
  getRuntimePluginState,
  listRuntimePluginStates,
  recordRuntimePluginError,
  recordRuntimePluginRollback,
  setRuntimePluginState,
} = await import('../server/services/runtimePluginStateStore.js')
const { getDynamicTool } = await import('../server/utils/toolSchemaCatalog.js')

function createReq({
  url,
  token = '',
  method = 'GET',
  remoteAddress = '127.0.0.1',
  headers = {},
}) {
  return {
    method,
    url,
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    socket: { remoteAddress },
  }
}

function createRes() {
  return {
    statusCode: 200,
    body: '',
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
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
  headers = {},
  autoApprove = true,
} = {}) {
  const request = async (requestHeaders) => {
    const res = createRes()
    await handlePluginRequest(createReq({
      url,
      token,
      method,
      remoteAddress,
      headers: requestHeaders,
    }), res, { env })
    return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers }
  }

  const response = await request(headers)
  const approval = response.body?.error?.details?.permissionApproval
  if (autoApprove
    && response.status === 409
    && response.body?.error?.code === 'PLUGIN_PERMISSION_APPROVAL_REQUIRED'
    && approval?.approvalDigest) {
    return request({
      ...headers,
      'x-gugo-plugin-permission-approval': approval.approvalDigest,
    })
  }
  return response
}

function sourceDigest(source) {
  return `sha256-${createHash('sha256').update(source).digest('hex')}`
}

function grantPermissionForPlugin(pluginId) {
  localOwner()
  const plugin = getPlugin(pluginId)
  assert.ok(plugin, `plugin ${pluginId} must be loaded before granting permissions`)
  const source = fs.readFileSync(plugin.entryPath)
  return grantRuntimePluginPermissions({
    request: buildRuntimePluginPermissionRequest({
      plugin,
      sourceDigest: sourceDigest(source),
    }),
  })
}

function grantPermissionForRelease(pluginId, releaseId) {
  localOwner()
  const release = getRuntimePluginRelease(pluginId, releaseId)
  return grantRuntimePluginPermissions({
    request: buildRuntimePluginPermissionRequest({
      plugin: JSON.parse(release.pluginSnapshotJson),
      sourceDigest: release.sourceDigest,
    }),
  })
}

function localOwner() {
  return bootstrapAuth({ env: { AUTH_MODE: 'local' } })
}

function installReleaseUpdateProtection(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_releases_immutable
      BEFORE UPDATE ON runtime_plugin_releases
      BEGIN
        SELECT RAISE(ABORT, 'runtime plugin releases are immutable');
      END;
  `)
}

function tamperReleaseCapabilities(releaseId, capabilities = ['log']) {
  const db = getDb()
  const row = db.prepare(`
    SELECT plugin_snapshot_json
    FROM runtime_plugin_releases
    WHERE release_id = ?
  `).get(releaseId)
  const snapshot = JSON.parse(row.plugin_snapshot_json)
  snapshot.capabilities = capabilities
  db.exec('DROP TRIGGER IF EXISTS trg_runtime_plugin_releases_immutable')
  try {
    db.prepare(`
      UPDATE runtime_plugin_releases
      SET plugin_snapshot_json = ?
      WHERE release_id = ?
    `).run(JSON.stringify(snapshot), releaseId)
  } finally {
    installReleaseUpdateProtection(db)
  }
}

test.beforeEach(async () => {
  await _resetRuntimePluginsForTests()
  _resetForTests()
  fs.writeFileSync(path.join(pluginRoot, 'test-transformer', 'entry.js'), INITIAL_TRANSFORMER_SOURCE)
  fs.writeFileSync(path.join(pluginRoot, 'integrity-transformer', 'entry.js'), INTEGRITY_TRANSFORMER_SOURCE)
  const db = getDb()
  db.exec('DROP TRIGGER IF EXISTS trg_runtime_plugin_releases_immutable_delete')
  db.prepare('DELETE FROM runtime_plugin_states').run()
  db.prepare('DELETE FROM runtime_plugin_releases').run()
  migrateToV75(db)
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
    activeReleaseId: null,
    previousReleaseId: null,
    releaseRevision: 0,
    lastRollback: null,
  })
  assert.deepEqual(getRuntimePluginState('test-transformer'), {
    pluginId: 'test-transformer',
    enabled: true,
    lastError: 'first failure',
    updatedAt: 10,
    activeReleaseId: null,
    previousReleaseId: null,
    releaseRevision: 0,
    lastRollback: null,
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
  assert.equal(response.body.schemaVersion, 8)
  assert.deepEqual(response.body.effectiveConfigs, [])
  assert.equal(response.headers['cache-control'], 'private, no-store')
  assert.deepEqual(response.body.httpCapabilities, [])
  assert.deepEqual(response.body.httpCapabilityAudit, [])
  assert.deepEqual(response.body.plugins.map((plugin) => plugin.id), ['integrity-transformer', 'test-transformer'])
  const transformer = response.body.plugins.find((plugin) => plugin.id === 'test-transformer')
  const toolName = runtimeTransformerToolName('test-transformer')
  assert.equal(transformer.active, false)
  assert.equal(transformer.source, 'local-directory-development')
  assert.deepEqual(transformer.distribution, {
    sourceKind: 'local-directory-development',
    mutable: true,
    verifiedPackage: false,
    hasInstallReceipt: false,
  })
  assert.equal(transformer.controllable, true)
  assert.deepEqual(transformer.manifest, {
    id: 'test-transformer',
    name: 'Test Transformer',
    version: '1.0.0',
    requires: [],
    contributes: [`tool:${toolName}`],
  })
})

test('inactive inventory derives declared and effective contributions before first publication', async () => {
  const pluginId = 'inactive-definition-transformer'
  writePlugin(pluginId, {
    id: pluginId,
    name: 'Inactive Definition Transformer',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
    requires: ['test-transformer'],
    contributes: ['service:inactive-definition'],
    dependencyVersions: { 'test-transformer': '^1.0.0' },
  }, "function transform(input) { return 'inactive:' + input }")
  try {
    refreshPlugins()
    const owner = localOwner()
    const response = await requestRuntime({ token: owner.token })
    assert.equal(response.status, 200)
    const plugin = response.body.plugins.find((entry) => entry.id === pluginId)
    assert.equal(plugin.active, false)
    assert.equal(plugin.activeRelease, null)
    assert.equal(plugin.previousRelease, null)
    assert.deepEqual(plugin.manifest, {
      id: pluginId,
      name: 'Inactive Definition Transformer',
      version: '1.0.0',
      requires: ['test-transformer'],
      contributes: [
        'service:inactive-definition',
        `tool:${runtimeTransformerToolName(pluginId)}`,
      ],
    })
  } finally {
    fs.rmSync(path.join(pluginRoot, pluginId), { recursive: true, force: true })
    refreshPlugins()
  }
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
    canRevokePermissions: false,
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
    activeRelease: null,
    previousRelease: null,
    latestRelease: null,
    releaseCount: 0,
    lastRollback: null,
    permissionGrant: null,
  })
  assert.match(observer.installedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(JSON.stringify(response.body).includes('DO_NOT_SERIALIZE'), false)
  assert.doesNotThrow(() => structuredClone(response.body))
})

test('same-id host runtime cannot inherit a distributed transformer control surface', async () => {
  const pluginId = 'host-transformer-id-collision'
  writePlugin(pluginId, {
    id: pluginId,
    name: 'Disk Transformer',
    version: '9.0.0',
    type: 'transformer',
    entry: 'entry.js',
    contributes: ['service:disk-transformer'],
  }, "function transform(input) { return 'disk:' + input }")
  try {
    refreshPlugins()
    const owner = localOwner()
    const enabled = await requestRuntime({
      url: `/api/plugins/runtime/${pluginId}/enable`,
      token: owner.token,
      method: 'POST',
    })
    assert.equal(enabled.status, 200)
    const releaseId = enabled.body.plugin.activeRelease.id
    const transformerDisabled = await requestRuntime({
      url: `/api/plugins/runtime/${pluginId}/disable`,
      token: owner.token,
      method: 'POST',
    })
    assert.equal(transformerDisabled.status, 200)
    assert.equal(transformerDisabled.body.plugin.previousRelease.id, releaseId)

    await registerPlugin({
      id: pluginId,
      name: 'Host Runtime',
      version: '1.0.0',
      requires: [],
      contributes: ['service:host-runtime'],
    }, () => {})

    const response = await requestRuntime({ token: owner.token })
    assert.equal(response.status, 200)
    const plugin = response.body.plugins.find((entry) => entry.id === pluginId)
    assert.equal(plugin.name, 'Host Runtime')
    assert.equal(plugin.version, '1.0.0')
    assert.equal(plugin.type, 'runtime')
    assert.equal(plugin.source, 'host-runtime')
    assert.equal(plugin.controllable, false)
    assert.equal(plugin.toolName, null)
    assert.equal(plugin.permissionGrant, null)
    assert.equal(plugin.lastError, null)
    assert.equal(plugin.updatedAt, null)
    assert.equal(plugin.activeRelease, null)
    assert.equal(plugin.previousRelease, null)
    assert.equal(plugin.latestRelease, null)
    assert.equal(plugin.releaseCount, 0)
    assert.equal(plugin.lastRollback, null)
    assert.equal(Object.hasOwn(plugin, 'distribution'), false)
    assert.deepEqual(plugin.manifest, {
      id: pluginId,
      name: 'Host Runtime',
      version: '1.0.0',
      requires: [],
      contributes: ['service:host-runtime'],
    })
    assert.equal(
      plugin.manifest.contributes.includes(`tool:${runtimeTransformerToolName(pluginId)}`),
      false,
    )

    const hostDisable = await requestRuntime({
      url: `/api/plugins/runtime/${pluginId}/disable`,
      token: owner.token,
      method: 'POST',
    })
    assert.equal(hostDisable.status, 400)
    assert.equal(hostDisable.body.error.code, 'PLUGIN_RUNTIME_TYPE_UNSUPPORTED')
    assert.equal(getRuntimePlugin(pluginId)?.state, 'active')
  } finally {
    if (getRuntimePlugin(pluginId)) await unregisterPlugin(pluginId)
    fs.rmSync(path.join(pluginRoot, pluginId), { recursive: true, force: true })
    refreshPlugins()
  }
})

test('runtime enable requires exact local-owner permission approval before activation', async () => {
  const owner = localOwner()
  const challenged = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
    autoApprove: false,
  })

  assert.equal(challenged.status, 409)
  assert.equal(challenged.body.error.code, 'PLUGIN_PERMISSION_APPROVAL_REQUIRED')
  const approval = challenged.body.error.details.permissionApproval
  assert.equal(approval.pluginId, 'test-transformer')
  assert.equal(approval.pluginVersion, '1.0.0')
  assert.deepEqual(approval.permissions, ['runtime:tool'])
  assert.match(approval.sourceDigest, /^sha256-[a-f0-9]{64}$/)
  assert.match(approval.approvalDigest, /^sha256-[a-f0-9]{64}$/)
  assert.equal(getRuntimePluginPermissionGrant('test-transformer'), null)
  assert.equal(getDynamicTool(runtimeTransformerToolName('test-transformer')), null)
  assert.equal(getRuntimePluginState('test-transformer').enabled, false)

  const wrongDigest = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
    headers: { 'x-gugo-plugin-permission-approval': `sha256-${'0'.repeat(64)}` },
    autoApprove: false,
  })
  assert.equal(wrongDigest.status, 409)
  assert.equal(wrongDigest.body.error.code, 'PLUGIN_PERMISSION_APPROVAL_REQUIRED')
  assert.equal(
    wrongDigest.body.error.details.permissionApproval.approvalDigest,
    approval.approvalDigest,
  )
  assert.equal(getRuntimePluginPermissionGrant('test-transformer'), null)
  assert.equal(getRuntimePluginState('test-transformer').enabled, false)

  const approved = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
    headers: { 'x-gugo-plugin-permission-approval': approval.approvalDigest },
    autoApprove: false,
  })
  assert.equal(approved.status, 200)
  assert.equal(approved.body.plugin.active, true)
  const grant = getRuntimePluginPermissionGrant('test-transformer')
  assert.equal(grant.approvalDigest, approval.approvalDigest)
  assert.equal(grant.sourceDigest, approval.sourceDigest)
  assert.deepEqual(grant.permissions, ['runtime:tool'])
})

test('runtime permission grants are bound to the fixed local installation owner', () => {
  setRuntimePluginState({ pluginId: 'test-transformer', enabled: false })
  const originalOwner = localOwner()
  const grant = grantPermissionForPlugin('test-transformer')
  assert.equal(grant.ownerId, originalOwner.user.id)
  assert.ok(getRuntimePluginPermissionGrant('test-transformer'))

  createUser({
    id: 'replacement-local-owner',
    email: 'replacement-local-owner@example.com',
  })
  getDb().prepare(`
    UPDATE meta SET value = ? WHERE key = 'local_auth_owner_user_id'
  `).run('replacement-local-owner')

  assert.equal(getRuntimePluginPermissionGrant('test-transformer'), null)
  assert.equal(
    grantPermissionForPlugin('test-transformer').ownerId,
    'replacement-local-owner',
  )
})

test('installation-scoped revocation remains visible after owner replacement', async () => {
  setRuntimePluginState({ pluginId: 'test-transformer', enabled: false })
  const originalOwner = localOwner()
  grantPermissionForPlugin('test-transformer')
  assert.equal(hasRuntimePluginPermissionGrant('test-transformer'), true)

  createUser({
    id: 'replacement-local-owner',
    email: 'replacement-local-owner@example.com',
  })
  const setOwner = getDb().prepare(`
    UPDATE meta SET value = ? WHERE key = 'local_auth_owner_user_id'
  `)
  setOwner.run('replacement-local-owner')
  assert.equal(getRuntimePluginPermissionGrant('test-transformer'), null)
  assert.equal(hasRuntimePluginPermissionGrant('test-transformer'), true)

  const replacementOwner = localOwner()
  const inventory = await requestRuntime({ token: replacementOwner.token })
  assert.equal(inventory.status, 200)
  const transformer = inventory.body.plugins.find((plugin) => plugin.id === 'test-transformer')
  assert.equal(transformer.canRevokePermissions, true)

  const revoked = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/revoke-permissions',
    token: replacementOwner.token,
    method: 'POST',
  })
  assert.equal(revoked.status, 200)
  assert.equal(revoked.body.plugin.canRevokePermissions, false)
  assert.equal(hasRuntimePluginPermissionGrant('test-transformer'), false)

  setOwner.run(originalOwner.user.id)
  assert.equal(getRuntimePluginPermissionGrant('test-transformer'), null)
})

test('runtime permission grant store replaces changed consent and supports explicit revocation', () => {
  setRuntimePluginState({ pluginId: 'test-transformer', enabled: false })
  const initial = grantPermissionForPlugin('test-transformer')
  const replacementRequest = buildRuntimePluginPermissionRequest({
    plugin: { ...getPlugin('test-transformer'), permissions: ['network:loopback'] },
    sourceDigest: initial.sourceDigest,
  })
  const replacement = grantRuntimePluginPermissions({
    request: replacementRequest,
    now: initial.updatedAt + 1,
  })

  assert.notEqual(replacement.approvalDigest, initial.approvalDigest)
  assert.deepEqual(replacement.permissions, ['network:loopback', 'runtime:tool'])
  assert.equal(replacement.grantedAt, initial.updatedAt + 1)
  assert.equal(revokeRuntimePluginPermissionGrant('test-transformer'), true)
  assert.equal(revokeRuntimePluginPermissionGrant('test-transformer'), false)
  assert.equal(getRuntimePluginPermissionGrant('test-transformer'), null)
})

test('permission revocation rejects dormant runtime state without a grant', async () => {
  const before = setRuntimePluginState({
    pluginId: 'test-transformer',
    enabled: false,
    now: 31,
  })
  const owner = localOwner()
  assert.equal(hasRuntimePluginPermissionGrant('test-transformer'), false)

  const response = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/revoke-permissions',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(response.status, 404)
  assert.equal(response.body.error.code, 'PLUGIN_PERMISSION_GRANT_NOT_FOUND')
  assert.deepEqual(getRuntimePluginState('test-transformer'), before)
  assert.equal(getRuntimePlugin('test-transformer'), null)
  assert.equal(hasRuntimePluginPermissionGrant('test-transformer'), false)
})

test('runtime inventory exposes the effective HTTP capability owner and priority', async () => {
  const capabilities = createHttpCapabilityRegistry()
  capabilities.register({
    id: 'builtin.test.inventory',
    owner: 'builtin',
    priority: 100,
    apiPrefixes: ['/api/test/inventory'],
    match: (req) => req.url?.startsWith('/api/test/inventory'),
    handle: () => 'builtin',
  })
  const unbind = bindRuntimePluginHttpCapabilities(capabilities)
  try {
    await registerPlugin({
      id: 'host-http-inventory',
      name: 'Host HTTP Inventory',
      version: '1.0.0',
      contributes: ['http-capability:builtin.test.inventory'],
    }, (context) => context.http.register({
      id: 'builtin.test.inventory',
      priority: 200,
      replaces: 'builtin.test.inventory',
      apiPrefixes: ['/api/test/inventory'],
      handle: () => 'plugin',
    }))

    const owner = localOwner()
    const response = await requestRuntime({ token: owner.token })
    assert.equal(response.status, 200)
    assert.equal(response.body.schemaVersion, 8)
    const capability = response.body.httpCapabilities
      .find((entry) => entry.id === 'builtin.test.inventory')
    assert.deepEqual(capability, {
      id: 'builtin.test.inventory',
      owner: 'host-http-inventory',
      priority: 200,
      replaces: 'builtin.test.inventory',
      apiPrefixes: ['/api/test/inventory'],
      sequence: 2,
    })
    assert.ok(response.body.httpCapabilityAudit.some((entry) => (
      entry.event === 'http_capability.replaced'
      && entry.capabilityId === 'builtin.test.inventory'
      && entry.owner === 'host-http-inventory'
      && entry.priority === 200
      && entry.replacedCapabilityId === 'builtin.test.inventory'
      && entry.replacedOwner === 'builtin'
    )))
    assert.equal(JSON.stringify(response.body).includes('handle'), false)
  } finally {
    await unregisterPlugin('host-http-inventory')
    unbind()
  }
})

test('transformer control endpoint cannot disable a host runtime plugin', async () => {
  await registerPlugin({
    id: 'host-control-boundary',
    name: 'Host Control Boundary',
    version: '1.0.0',
    requires: [],
    contributes: [],
  }, () => {})
  const owner = localOwner()
  const response = await requestRuntime({
    url: '/api/plugins/runtime/host-control-boundary/disable',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, 'PLUGIN_RUNTIME_TYPE_UNSUPPORTED')
  const inventory = await requestRuntime({ token: owner.token })
  assert.equal(
    inventory.body.plugins.find((plugin) => plugin.id === 'host-control-boundary')?.active,
    true,
  )
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
  assert.match(enabled.body.plugin.activeRelease.id, /^rel-/)
  assert.match(enabled.body.plugin.activeRelease.sourceDigest, /^sha256-[a-f0-9]{64}$/)
  assert.match(enabled.body.plugin.activeRelease.contentDigest, /^sha256-[a-f0-9]{64}$/)
  assert.equal(enabled.body.plugin.activeRelease.digestVersion, 1)
  assert.equal(enabled.body.plugin.activeRelease.validationStatus, 'passed')
  assert.equal(enabled.body.plugin.activeRelease.healthStatus, 'passed')
  assert.deepEqual(enabled.body.plugin.latestRelease, enabled.body.plugin.activeRelease)
  assert.equal(enabled.body.plugin.previousRelease, null)
  assert.equal(enabled.body.plugin.releaseCount, 1)
  const [strictState] = listRuntimePluginStates({ verifyActiveReleases: true })
  assert.equal(strictState.activeReleaseId, enabled.body.plugin.activeRelease.id)
  assert.equal(strictState.activeReleaseContentDigest, enabled.body.plugin.activeRelease.contentDigest)
  assert.equal(strictState.activeReleaseDigestVersion, 1)

  const toolName = runtimeTransformerToolName('test-transformer')
  assert.deepEqual(enabled.body.plugin.manifest.contributes, [`tool:${toolName}`])
  const tool = getDynamicTool(toolName)
  assert.ok(tool)
  const result = await tool.exec({ input: 'hello' })
  assert.equal(result.ok, true)
  assert.equal(result.output, 'HELLO')
  assert.ok(result.durationMs > 0)
  const permissionBeforeDisable = getRuntimePluginPermissionGrant('test-transformer')

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
  assert.deepEqual(
    getRuntimePluginPermissionGrant('test-transformer'),
    permissionBeforeDisable,
  )
  assert.equal((await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
    autoApprove: false,
  })).status, 200)
})

test('disabled inventory keeps the previous release identity after a disk definition refresh', async () => {
  const pluginId = 'disabled-refresh-transformer'
  writePlugin(pluginId, {
    id: pluginId,
    name: 'Disabled Release v1',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
    contributes: ['service:release-v1'],
  }, "function transform(input) { return 'v1:' + input }")
  try {
    refreshPlugins()
    const owner = localOwner()
    const enabled = await requestRuntime({
      url: `/api/plugins/runtime/${pluginId}/enable`,
      token: owner.token,
      method: 'POST',
    })
    assert.equal(enabled.status, 200)
    const releaseId = enabled.body.plugin.activeRelease.id

    const disabled = await requestRuntime({
      url: `/api/plugins/runtime/${pluginId}/disable`,
      token: owner.token,
      method: 'POST',
    })
    assert.equal(disabled.status, 200)
    assert.equal(disabled.body.plugin.activeRelease, null)
    assert.equal(disabled.body.plugin.previousRelease.id, releaseId)

    writePlugin(pluginId, {
      id: pluginId,
      name: 'Disabled Disk v2',
      version: '2.0.0',
      type: 'transformer',
      entry: 'entry.js',
      contributes: ['service:disk-v2'],
    }, "function transform(input) { return 'v2:' + input }")
    refreshPlugins()

    const inventory = await requestRuntime({ token: owner.token })
    assert.equal(inventory.status, 200)
    const plugin = inventory.body.plugins.find((entry) => entry.id === pluginId)
    assert.equal(plugin.active, false)
    assert.equal(plugin.activeRelease, null)
    assert.equal(plugin.previousRelease.id, releaseId)
    assert.deepEqual(plugin.manifest, {
      id: pluginId,
      name: 'Disabled Disk v2',
      version: '2.0.0',
      requires: [],
      contributes: [
        'service:disk-v2',
        `tool:${runtimeTransformerToolName(pluginId)}`,
      ],
    })
  } finally {
    await _resetRuntimePluginsForTests()
    fs.rmSync(path.join(pluginRoot, pluginId), { recursive: true, force: true })
    refreshPlugins()
  }
})

test('inventory separates the current disk candidate from an active release before runtime restore', async () => {
  const pluginId = 'pending-restore-transformer'
  writePlugin(pluginId, {
    id: pluginId,
    name: 'Published Release v1',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
    contributes: ['service:published-v1'],
  }, "function transform(input) { return 'published-v1:' + input }")
  try {
    refreshPlugins()
    const owner = localOwner()
    const enabled = await requestRuntime({
      url: `/api/plugins/runtime/${pluginId}/enable`,
      token: owner.token,
      method: 'POST',
    })
    assert.equal(enabled.status, 200)
    const releaseId = enabled.body.plugin.activeRelease.id

    await _resetRuntimePluginsForTests()
    assert.equal(getRuntimePlugin(pluginId), null)
    assert.equal(getDynamicTool(runtimeTransformerToolName(pluginId)), null)

    writePlugin(pluginId, {
      id: pluginId,
      name: 'Unpublished Disk v2',
      version: '2.0.0',
      type: 'transformer',
      entry: 'entry.js',
      contributes: ['service:disk-v2'],
    }, "function transform(input) { return 'disk-v2:' + input }")
    refreshPlugins()

    const inventory = await requestRuntime({ token: owner.token })
    assert.equal(inventory.status, 200)
    const plugin = inventory.body.plugins.find((entry) => entry.id === pluginId)
    assert.equal(plugin.enabled, true)
    assert.equal(plugin.active, false)
    assert.equal(plugin.runtimeState, 'inactive')
    assert.equal(plugin.name, 'Unpublished Disk v2')
    assert.equal(plugin.version, '2.0.0')
    assert.equal(plugin.activeRelease.id, releaseId)
    assert.equal(plugin.previousRelease, null)
    assert.deepEqual(plugin.manifest, {
      id: pluginId,
      name: 'Unpublished Disk v2',
      version: '2.0.0',
      requires: [],
      contributes: [
        'service:disk-v2',
        `tool:${runtimeTransformerToolName(pluginId)}`,
      ],
    })
    assert.equal(plugin.permissionGrant.granted, true)
    assert.equal(plugin.canRevokePermissions, true)
  } finally {
    await _resetRuntimePluginsForTests()
    fs.rmSync(path.join(pluginRoot, pluginId), { recursive: true, force: true })
    refreshPlugins()
  }
})

test('active inventory and disable control stay bound to the running release after disk drift', async () => {
  const pluginId = 'active-disk-drift-transformer'
  writePlugin(pluginId, {
    id: pluginId,
    name: 'Active Release Identity',
    version: '1.2.3',
    type: 'transformer',
    entry: 'entry.js',
    contributes: ['service:active-release-only'],
  }, "function transform(input) { return 'active-release:' + input }")
  try {
    refreshPlugins()
    const owner = localOwner()
    const enabled = await requestRuntime({
      url: `/api/plugins/runtime/${pluginId}/enable`,
      token: owner.token,
      method: 'POST',
    })
    assert.equal(enabled.status, 200)
    const expected = enabled.body.plugin
    const toolName = runtimeTransformerToolName(pluginId)

    const assertRunningRelease = (plugin) => {
      assert.equal(plugin.name, 'Active Release Identity')
      assert.equal(plugin.version, '1.2.3')
      assert.equal(plugin.type, 'transformer')
      assert.equal(plugin.source, 'local-directory-development')
      assert.equal(plugin.available, true)
      assert.equal(plugin.controllable, true)
      assert.equal(plugin.enabled, true)
      assert.equal(plugin.active, true)
      assert.equal(plugin.toolName, toolName)
      assert.deepEqual(plugin.activeRelease, expected.activeRelease)
      assert.deepEqual(plugin.permissionGrant, expected.permissionGrant)
      assert.deepEqual(plugin.distribution, expected.distribution)
      assert.deepEqual(plugin.manifest, {
        id: pluginId,
        name: 'Active Release Identity',
        version: '1.2.3',
        requires: [],
        contributes: [
          'service:active-release-only',
          `tool:${toolName}`,
        ],
      })
    }

    fs.rmSync(path.join(pluginRoot, pluginId), { recursive: true, force: true })
    refreshPlugins()
    assert.equal(getPlugin(pluginId), null)
    const missingInventory = await requestRuntime({ token: owner.token })
    assert.equal(missingInventory.status, 200)
    assertRunningRelease(
      missingInventory.body.plugins.find((entry) => entry.id === pluginId),
    )

    writePlugin(pluginId, {
      id: pluginId,
      name: 'Conflicting Disk Resource',
      version: '9.0.0',
      type: 'prompt-template',
      entry: 'prompt.md',
    }, 'must not replace the running Release')
    refreshPlugins()
    assert.equal(getPlugin(pluginId).type, 'prompt-template')
    const changedTypeInventory = await requestRuntime({ token: owner.token })
    assert.equal(changedTypeInventory.status, 200)
    assertRunningRelease(
      changedTypeInventory.body.plugins.find((entry) => entry.id === pluginId),
    )

    const disabled = await requestRuntime({
      url: `/api/plugins/runtime/${pluginId}/disable`,
      token: owner.token,
      method: 'POST',
    })
    assert.equal(disabled.status, 200)
    assert.equal(getRuntimePlugin(pluginId), null)
    assert.equal(getDynamicTool(toolName), null)
    assert.equal(getRuntimePluginState(pluginId).activeReleaseId, null)
    assert.equal(
      getRuntimePluginState(pluginId).previousReleaseId,
      expected.activeRelease.id,
    )
  } finally {
    await _resetRuntimePluginsForTests()
    fs.rmSync(path.join(pluginRoot, pluginId), { recursive: true, force: true })
    refreshPlugins()
  }
})

for (const drift of [
  { name: 'the disk definition is deleted', kind: 'deleted' },
  { name: 'the disk definition changes type', kind: 'changed-type' },
]) {
  test(`persisted transformer permissions remain revocable after ${drift.name}`, async () => {
    const pluginId = `revocable-${drift.kind}-transformer`
    writePlugin(pluginId, {
      id: pluginId,
      name: 'Revocable Transformer',
      version: '1.0.0',
      type: 'transformer',
      entry: 'entry.js',
    }, "function transform(input) { return 'revocable:' + input }")
    try {
      refreshPlugins()
      const owner = localOwner()
      assert.equal((await requestRuntime({
        url: `/api/plugins/runtime/${pluginId}/enable`,
        token: owner.token,
        method: 'POST',
      })).status, 200)
      assert.equal((await requestRuntime({
        url: `/api/plugins/runtime/${pluginId}/disable`,
        token: owner.token,
        method: 'POST',
      })).status, 200)
      assert.ok(getRuntimePluginPermissionGrant(pluginId))

      if (drift.kind === 'deleted') {
        fs.rmSync(path.join(pluginRoot, pluginId), { recursive: true, force: true })
      } else {
        writePlugin(pluginId, {
          id: pluginId,
          name: 'Unrelated Prompt Template',
          version: '2.0.0',
          type: 'prompt-template',
          entry: 'prompt.md',
        }, 'must not own the transformer permission grant')
      }
      refreshPlugins()

      const inventory = await requestRuntime({ token: owner.token })
      assert.equal(inventory.status, 200)
      const stale = inventory.body.plugins.find((entry) => entry.id === pluginId)
      assert.equal(stale.controllable, false)
      assert.equal(stale.canRevokePermissions, true)
      assert.ok(stale.permissionGrant.grantedAt)

      const revoked = await requestRuntime({
        url: `/api/plugins/runtime/${pluginId}/revoke-permissions`,
        token: owner.token,
        method: 'POST',
      })
      assert.equal(revoked.status, 200)
      assert.equal(revoked.body.plugin.controllable, false)
      assert.equal(revoked.body.plugin.canRevokePermissions, false)
      assert.equal(getRuntimePluginPermissionGrant(pluginId), null)
      assert.equal(getRuntimePlugin(pluginId), null)
      assert.equal(getRuntimePluginState(pluginId).enabled, false)
      assert.equal(getRuntimePluginState(pluginId).activeReleaseId, null)
      if (drift.kind === 'changed-type') {
        assert.equal(getPlugin(pluginId).type, 'prompt-template')
      }
    } finally {
      await _resetRuntimePluginsForTests()
      fs.rmSync(path.join(pluginRoot, pluginId), { recursive: true, force: true })
      refreshPlugins()
    }
  })
}

test('active runtime tools fail closed when their persisted permission grant is revoked', async () => {
  const owner = localOwner()
  assert.equal((await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })).status, 200)
  const tool = getDynamicTool(runtimeTransformerToolName('test-transformer'))

  assert.equal(revokeRuntimePluginPermissionGrant('test-transformer'), true)
  await assert.rejects(
    () => tool.exec({ input: 'must-not-run' }),
    (error) => error?.code === 'PLUGIN_PERMISSION_APPROVAL_REQUIRED'
      && /需要本机所有者明确授权/u.test(error.message),
  )
  assert.equal(getRuntimePlugin('test-transformer').state, 'active')
})

test('revoking runtime permissions disables the plugin and requires fresh approval', async () => {
  const owner = localOwner()
  const enabled = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(enabled.status, 200)
  assert.ok(getRuntimePluginPermissionGrant('test-transformer'))

  const revoked = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/revoke-permissions',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(revoked.status, 200)
  assert.equal(revoked.body.plugin.enabled, false)
  assert.equal(revoked.body.plugin.active, false)
  assert.equal(getRuntimePluginPermissionGrant('test-transformer'), null)
  assert.equal(getDynamicTool(runtimeTransformerToolName('test-transformer')), null)

  const challenged = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
    autoApprove: false,
  })
  assert.equal(challenged.status, 409)
  assert.equal(challenged.body.error.code, 'PLUGIN_PERMISSION_APPROVAL_REQUIRED')
})

test('reload atomically switches validated transformer source and preserves the tool registration', async () => {
  const owner = localOwner()
  await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  const toolName = runtimeTransformerToolName('test-transformer')
  const originalTool = getDynamicTool(toolName)
  const initialReleaseId = getRuntimePluginState('test-transformer').activeReleaseId

  fs.writeFileSync(
    path.join(pluginRoot, 'test-transformer', 'entry.js'),
    "function transform(input) { return typeof input === 'string' ? input.toLowerCase() : input }",
  )
  const reloaded = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/reload',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(reloaded.status, 200)
  assert.equal(reloaded.body.plugin.active, true)
  assert.notEqual(reloaded.body.plugin.activeRelease.id, initialReleaseId)
  assert.equal(reloaded.body.plugin.previousRelease.id, initialReleaseId)
  assert.equal(reloaded.body.plugin.releaseCount, 2)
  assert.equal(getDynamicTool(toolName), originalTool)
  assert.equal((await originalTool.exec({ input: 'HELLO' })).output, 'hello')

  fs.writeFileSync(path.join(pluginRoot, 'test-transformer', 'entry.js'), 'function transform( {')
  const rejected = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/reload',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.error.code, 'PLUGIN_RELOAD_VALIDATION_FAILED')
  assert.equal(getDynamicTool(toolName), originalTool)
  assert.equal((await originalTool.exec({ input: 'STILL-OLD' })).output, 'still-old')
  assert.match(getRuntimePluginState('test-transformer').lastError, /PLUGIN_RELOAD_VALIDATION_FAILED/)
  assert.equal(getRuntimePluginState('test-transformer').activeReleaseId, reloaded.body.plugin.activeRelease.id)
  assert.equal(countRuntimePluginReleases('test-transformer'), 3)
  assert.equal(getLatestRuntimePluginRelease('test-transformer').validationStatus, 'failed')
})

test('reload health-checks an actual invocation before cutover and keeps the active release on failure', async () => {
  const owner = localOwner()
  await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  const before = getRuntimePluginState('test-transformer')
  const tool = getDynamicTool(runtimeTransformerToolName('test-transformer'))
  fs.writeFileSync(path.join(pluginRoot, 'test-transformer', 'entry.js'), `
    function transform(input) {
      if (input === null) throw new Error('health probe failed')
      return 'candidate:' + input
    }
  `)

  const rejected = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/reload',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.error.code, 'PLUGIN_RELEASE_HEALTH_CHECK_FAILED')
  assert.equal(getRuntimePluginState('test-transformer').activeReleaseId, before.activeReleaseId)
  assert.equal((await tool.exec({ input: 'still-old' })).output, 'STILL-OLD')
  assert.equal(countRuntimePluginReleases('test-transformer'), 2)
  const failed = getLatestRuntimePluginRelease('test-transformer')
  assert.equal(failed.validationStatus, 'passed')
  assert.equal(failed.healthStatus, 'failed')
  assert.match(failed.failure, /PLUGIN_RELEASE_HEALTH_CHECK_FAILED/)
})

test('reload automatically rolls back runtime and authoritative state when post-cutover activation fails', async () => {
  const owner = localOwner()
  await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  const before = getRuntimePluginState('test-transformer')
  const permissionBefore = getRuntimePluginPermissionGrant('test-transformer')
  const tool = getDynamicTool(runtimeTransformerToolName('test-transformer'))
  fs.writeFileSync(
    path.join(pluginRoot, 'test-transformer', 'entry.js'),
    "function transform(input) { return 'candidate:' + input }",
  )
  const db = getDb()
  db.exec(`
    CREATE TEMP TRIGGER fail_runtime_release_activation
    BEFORE UPDATE OF active_release_id ON runtime_plugin_states
    WHEN NEW.plugin_id = 'test-transformer'
      AND NEW.active_release_id <> OLD.active_release_id
    BEGIN
      SELECT RAISE(ABORT, 'forced activation failure');
    END;
  `)
  let rejected
  try {
    rejected = await requestRuntime({
      url: '/api/plugins/runtime/test-transformer/reload',
      token: owner.token,
      method: 'POST',
    })
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_runtime_release_activation')
  }

  assert.equal(rejected.status, 500)
  assert.equal(rejected.body.error.code, 'PLUGIN_RELEASE_ACTIVATION_FAILED')
  const after = getRuntimePluginState('test-transformer')
  assert.equal(after.activeReleaseId, before.activeReleaseId)
  assert.equal(after.lastRollback.status, 'succeeded')
  assert.equal(after.lastRollback.toReleaseId, before.activeReleaseId)
  assert.notEqual(after.lastRollback.fromReleaseId, before.activeReleaseId)
  assert.equal((await tool.exec({ input: 'still-old' })).output, 'STILL-OLD')
  const permissionAfter = getRuntimePluginPermissionGrant('test-transformer')
  assert.equal(permissionAfter.approvalDigest, permissionBefore.approvalDigest)
  assert.equal(permissionAfter.sourceDigest, permissionBefore.sourceDigest)
  assert.deepEqual(permissionAfter.permissions, permissionBefore.permissions)

  const inventory = await requestRuntime({ token: owner.token })
  const transformer = inventory.body.plugins.find((entry) => entry.id === 'test-transformer')
  assert.equal(transformer.activeRelease.id, before.activeReleaseId)
  assert.equal(transformer.latestRelease.id, after.lastRollback.fromReleaseId)
  assert.deepEqual(transformer.lastRollback, after.lastRollback)
})

test('reload preserves the local release and authoritative pointer on a cross-process CAS conflict', async () => {
  const owner = localOwner()
  await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  const before = getRuntimePluginState('test-transformer')
  const permissionBefore = getRuntimePluginPermissionGrant('test-transformer')
  const tool = getDynamicTool(runtimeTransformerToolName('test-transformer'))
  fs.writeFileSync(
    path.join(pluginRoot, 'test-transformer', 'entry.js'),
    "function transform(input) { return 'candidate:' + input }",
  )
  const db = getDb()
  db.exec(`
    CREATE TEMP TRIGGER bump_runtime_release_revision
    AFTER INSERT ON runtime_plugin_releases
    WHEN NEW.plugin_id = 'test-transformer'
    BEGIN
      UPDATE runtime_plugin_states
      SET release_revision = release_revision + 1
      WHERE plugin_id = NEW.plugin_id;
    END;
  `)
  let rejected
  try {
    rejected = await requestRuntime({
      url: '/api/plugins/runtime/test-transformer/reload',
      token: owner.token,
      method: 'POST',
    })
  } finally {
    db.exec('DROP TRIGGER IF EXISTS bump_runtime_release_revision')
  }

  assert.equal(rejected.status, 409)
  assert.equal(rejected.body.error.code, 'PLUGIN_RELEASE_STATE_CONFLICT')
  const after = getRuntimePluginState('test-transformer')
  assert.equal(after.activeReleaseId, before.activeReleaseId)
  assert.equal(after.releaseRevision, before.releaseRevision + 1)
  assert.equal((await tool.exec({ input: 'still-old' })).output, 'STILL-OLD')
  const permissionAfter = getRuntimePluginPermissionGrant('test-transformer')
  assert.equal(permissionAfter.approvalDigest, permissionBefore.approvalDigest)
  assert.equal(permissionAfter.sourceDigest, permissionBefore.sourceDigest)
  assert.deepEqual(permissionAfter.permissions, permissionBefore.permissions)
})

test('integrity is rechecked on enable and reload without replacing the last verified source', async () => {
  const owner = localOwner()
  const entryPath = path.join(pluginRoot, 'integrity-transformer', 'entry.js')
  const toolName = runtimeTransformerToolName('integrity-transformer')

  fs.writeFileSync(entryPath, "function transform(input) { return 'tampered:' + input }")
  const rejectedEnable = await requestRuntime({
    url: '/api/plugins/runtime/integrity-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(rejectedEnable.status, 400)
  assert.equal(rejectedEnable.body.error.code, 'PLUGIN_INTEGRITY_MISMATCH')
  assert.equal(getDynamicTool(toolName), null)
  assert.match(getRuntimePluginState('integrity-transformer').lastError, /PLUGIN_INTEGRITY_MISMATCH/)

  fs.writeFileSync(entryPath, INTEGRITY_TRANSFORMER_SOURCE)
  const enabled = await requestRuntime({
    url: '/api/plugins/runtime/integrity-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(enabled.status, 200)
  const verifiedTool = getDynamicTool(toolName)
  assert.equal((await verifiedTool.exec({ input: 'before' })).output, 'verified:before')

  fs.writeFileSync(entryPath, "function transform(input) { return 'tampered:' + input }")
  const rejectedReload = await requestRuntime({
    url: '/api/plugins/runtime/integrity-transformer/reload',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(rejectedReload.status, 400)
  assert.equal(rejectedReload.body.error.code, 'PLUGIN_INTEGRITY_MISMATCH')
  assert.equal(getDynamicTool(toolName), verifiedTool)
  assert.equal((await verifiedTool.exec({ input: 'after' })).output, 'verified:after')
})

test('reload rejects a plugin directory replaced by a junction and keeps the active release', async (t) => {
  const owner = localOwner()
  assert.equal((await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })).status, 200)
  const tool = getDynamicTool(runtimeTransformerToolName('test-transformer'))
  const pluginDir = path.join(pluginRoot, 'test-transformer')
  const parkedDir = path.join(pluginRoot, 'test-transformer-parked')
  const outsideDir = path.join(tempDir, 'outside-transformer')
  fs.mkdirSync(outsideDir)
  fs.writeFileSync(path.join(outsideDir, 'entry.js'), "function transform() { return 'escaped' }")
  fs.renameSync(pluginDir, parkedDir)
  try {
    fs.symlinkSync(outsideDir, pluginDir, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    fs.renameSync(parkedDir, pluginDir)
    fs.rmSync(outsideDir, { recursive: true, force: true })
    t.skip(`symlink unavailable: ${error.code}`)
    return
  }
  try {
    const rejected = await requestRuntime({
      url: '/api/plugins/runtime/test-transformer/reload',
      token: owner.token,
      method: 'POST',
    })
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body.error.code, 'PLUGIN_ENTRY_SCOPE_INVALID')
    assert.equal((await tool.exec({ input: 'safe' })).output, 'SAFE')
  } finally {
    fs.rmSync(pluginDir, { recursive: true, force: true })
    fs.renameSync(parkedDir, pluginDir)
    fs.rmSync(outsideDir, { recursive: true, force: true })
  }
})

test('reload isolates in-flight calls on the old source while new calls use the replacement', async () => {
  const owner = localOwner()
  await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  const tool = getDynamicTool(runtimeTransformerToolName('test-transformer'))
  const entryPath = path.join(pluginRoot, 'test-transformer', 'entry.js')

  fs.writeFileSync(entryPath, `
    function transform(input) {
      const startedAt = Date.now()
      while (Date.now() - startedAt < 150) {}
      return 'old:' + input
    }
  `)
  assert.equal((await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/reload',
    token: owner.token,
    method: 'POST',
  })).status, 200)

  const inFlight = tool.exec({ input: 'call' })
  fs.writeFileSync(entryPath, "function transform(input) { return 'new:' + input }")
  assert.equal((await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/reload',
    token: owner.token,
    method: 'POST',
  })).status, 200)

  assert.equal((await inFlight).output, 'old:call')
  assert.equal((await tool.exec({ input: 'call' })).output, 'new:call')
})

test('reload rejects inactive transformers without changing desired state', async () => {
  const owner = localOwner()
  const response = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/reload',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(response.status, 409)
  assert.equal(response.body.error.code, 'PLUGIN_RUNTIME_NOT_ACTIVE')
  assert.equal(getRuntimePluginState('test-transformer'), null)
})

test('startup restore fails closed until the exact plugin source is preauthorized', async () => {
  setRuntimePluginState({ pluginId: 'test-transformer', enabled: true })

  const denied = await restoreEnabledRuntimePlugins()
  assert.equal(denied.length, 1)
  assert.equal(denied[0].pluginId, 'test-transformer')
  assert.equal(denied[0].ok, false)
  assert.equal(denied[0].error.code, 'PLUGIN_PERMISSION_APPROVAL_REQUIRED')
  assert.equal(denied[0].error.permissionApproval.pluginId, 'test-transformer')
  assert.equal(countRuntimePluginReleases('test-transformer'), 0)
  assert.equal(getDynamicTool(runtimeTransformerToolName('test-transformer')), null)

  grantPermissionForPlugin('test-transformer')
  assert.deepEqual(await restoreEnabledRuntimePlugins(), [
    { pluginId: 'test-transformer', ok: true },
  ])
  assert.ok(getDynamicTool(runtimeTransformerToolName('test-transformer')))
})

test('enabled transformer state restores from SQLite after runtime registry reset', async () => {
  const owner = localOwner()
  await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  const toolName = runtimeTransformerToolName('test-transformer')
  const persistedState = getRuntimePluginState('test-transformer')
  const persistedReleaseId = persistedState.activeReleaseId
  fs.writeFileSync(
    path.join(pluginRoot, 'test-transformer', 'entry.js'),
    "function transform(input) { return 'unpublished-disk-change:' + input }",
  )
  await _resetRuntimePluginsForTests()
  recordRuntimePluginError({
    pluginId: 'test-transformer',
    error: 'STALE_RESTORE_ERROR: injected before idempotent restore',
  })
  assert.equal(getDynamicTool(toolName), null)

  assert.deepEqual(await restoreEnabledRuntimePlugins(), [
    { pluginId: 'test-transformer', ok: true },
  ])
  const restored = getDynamicTool(toolName)
  assert.ok(restored)
  const result = await restored.exec({ input: 'restored' })
  assert.equal(result.ok, true)
  assert.equal(result.output, 'RESTORED')
  const firstRestoreState = getRuntimePluginState('test-transformer')
  assert.equal(firstRestoreState.activeReleaseId, persistedReleaseId)
  assert.equal(firstRestoreState.releaseRevision, persistedState.releaseRevision)
  assert.equal(firstRestoreState.lastError, null)

  assert.deepEqual(await restoreEnabledRuntimePlugins(), [
    { pluginId: 'test-transformer', ok: true },
  ])
  assert.equal(
    getRuntimePluginState('test-transformer').releaseRevision,
    persistedState.releaseRevision,
  )
})

test('startup restore rejects a same-id plugin discovered through a different source', async () => {
  const owner = localOwner()
  assert.equal((await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })).status, 200)
  const persistedState = getRuntimePluginState('test-transformer')
  const replacementPlugin = getPlugin('test-transformer')

  await _resetRuntimePluginsForTests()
  _resetForTests()
  const replacementSource = Object.freeze({
    discover: () => ({
      candidates: [{
        plugin: replacementPlugin,
        sourceKind: 'replacement-local-source',
        mutable: true,
        verifiedPackage: false,
        installReceipt: null,
      }],
      errors: [],
    }),
  })
  assert.equal(initPlugins({
    rootDir: pluginRoot,
    silent: true,
    distributionPort: replacementSource,
  }).errors.length, 0)

  const results = await restoreEnabledRuntimePlugins()
  assert.equal(results.length, 1)
  assert.equal(results[0].pluginId, 'test-transformer')
  assert.equal(results[0].ok, false)
  assert.equal(results[0].error.code, 'PLUGIN_RELEASE_DISTRIBUTION_CONFLICT')
  assert.equal(getDynamicTool(runtimeTransformerToolName('test-transformer')), null)
  const rejectedState = getRuntimePluginState('test-transformer')
  assert.equal(rejectedState.activeReleaseId, persistedState.activeReleaseId)
  assert.equal(rejectedState.releaseRevision, persistedState.releaseRevision)
})

test('startup restore rejects publisher trust changes without rolling back or registering code', async () => {
  const pluginId = 'test-transformer'
  const diskPlugin = getPlugin(pluginId)
  const packageReceipt = ({ signed, packageDigest, publicationDigest = null }) => ({
    schemaVersion: signed ? 2 : 1,
    pluginId,
    pluginVersion: diskPlugin.version,
    packageDigest,
    fileCount: 2,
    totalBytes: 128,
    installedAt: 100,
    publisherVerified: signed,
    sourceKind: signed ? 'local-marketplace' : 'local-directory',
    ...(signed
      ? {
          marketplace: { name: 'local-marketplace', displayName: 'Local Marketplace' },
          publisher: {
            id: 'publisher-a',
            displayName: 'Publisher A',
            keyId: `sha256-${'a'.repeat(64)}`,
          },
          publicationDigest,
        }
      : {}),
  })
  const distributionPort = (installReceipt) => Object.freeze({
    discover: () => ({
      candidates: [{
        plugin: diskPlugin,
        sourceKind: 'managed-user-directory',
        mutable: false,
        verifiedPackage: true,
        installReceipt,
      }],
      errors: [],
    }),
  })

  await _resetRuntimePluginsForTests()
  _resetForTests()
  assert.equal(initPlugins({
    rootDir: pluginRoot,
    silent: true,
    distributionPort: distributionPort(packageReceipt({
      signed: true,
      packageDigest: `sha256-${'b'.repeat(64)}`,
      publicationDigest: `sha256-${'c'.repeat(64)}`,
    })),
  }).errors.length, 0)
  const owner = localOwner()
  assert.equal((await requestRuntime({
    url: `/api/plugins/runtime/${pluginId}/enable`,
    token: owner.token,
    method: 'POST',
  })).status, 200)
  const previousReleaseId = getRuntimePluginState(pluginId).activeReleaseId
  fs.writeFileSync(
    path.join(pluginRoot, pluginId, 'entry.js'),
    "function transform(input) { return 'publisher-a:' + input }",
  )
  assert.equal((await requestRuntime({
    url: `/api/plugins/runtime/${pluginId}/reload`,
    token: owner.token,
    method: 'POST',
  })).status, 200)
  const persistedState = getRuntimePluginState(pluginId)
  assert.notEqual(persistedState.activeReleaseId, previousReleaseId)
  assert.equal(persistedState.previousReleaseId, previousReleaseId)

  await _resetRuntimePluginsForTests()
  _resetForTests()
  assert.equal(initPlugins({
    rootDir: pluginRoot,
    silent: true,
    distributionPort: distributionPort(packageReceipt({
      signed: false,
      packageDigest: `sha256-${'d'.repeat(64)}`,
    })),
  }).errors.length, 0)

  const results = await restoreEnabledRuntimePlugins()
  assert.equal(results.length, 1)
  assert.equal(results[0].pluginId, pluginId)
  assert.equal(results[0].ok, false)
  assert.equal(results[0].error.code, 'PLUGIN_RELEASE_DISTRIBUTION_CONFLICT')
  assert.equal(results[0].error.attemptedReleaseId, persistedState.activeReleaseId)
  assert.equal(results[0].error.restoredReleaseId, null)
  assert.equal(getDynamicTool(runtimeTransformerToolName(pluginId)), null)
  const rejectedState = getRuntimePluginState(pluginId)
  assert.equal(rejectedState.enabled, true)
  assert.equal(rejectedState.activeReleaseId, persistedState.activeReleaseId)
  assert.equal(rejectedState.previousReleaseId, persistedState.previousReleaseId)
  assert.equal(rejectedState.releaseRevision, persistedState.releaseRevision)
  assert.deepEqual(rejectedState.lastRollback, persistedState.lastRollback)
  assert.match(rejectedState.lastError, /^PLUGIN_RELEASE_DISTRIBUTION_CONFLICT:/)
})

test('startup restore activates enabled runtime plugin dependencies before consumers', async () => {
  const dynamicPluginIds = ['a-consumer', 'z-provider']
  writePlugin('z-provider', {
    id: 'z-provider',
    name: 'Z Provider',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
  }, "function transform(input) { return 'provider:' + input }")
  writePlugin('a-consumer', {
    id: 'a-consumer',
    name: 'A Consumer',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
    requires: ['z-provider'],
    dependencyVersions: { 'z-provider': '^1.0.0' },
  }, "function transform(input) { return 'consumer:' + input }")

  await _resetRuntimePluginsForTests()
  _resetForTests()
  const loaded = initPlugins({ rootDir: pluginRoot, silent: true })
  assert.equal(loaded.errors.length, 0)
  try {
    setRuntimePluginState({ pluginId: 'a-consumer', enabled: true, now: 10 })
    setRuntimePluginState({ pluginId: 'z-provider', enabled: true, now: 11 })
    grantPermissionForPlugin('a-consumer')
    grantPermissionForPlugin('z-provider')

    assert.deepEqual(await restoreEnabledRuntimePlugins(), [
      { pluginId: 'z-provider', ok: true },
      { pluginId: 'a-consumer', ok: true },
    ])
    assert.ok(getDynamicTool(runtimeTransformerToolName('z-provider')))
    assert.ok(getDynamicTool(runtimeTransformerToolName('a-consumer')))
  } finally {
    await _resetRuntimePluginsForTests()
    for (const pluginId of dynamicPluginIds) {
      fs.rmSync(path.join(pluginRoot, pluginId), { recursive: true, force: true })
    }
    _resetForTests()
    assert.equal(initPlugins({ rootDir: pluginRoot, silent: true }).errors.length, 0)
  }
})

test('release content identity rejects capability corruption during load and startup restore', async () => {
  const owner = localOwner()
  await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  const state = getRuntimePluginState('test-transformer')
  const toolName = runtimeTransformerToolName('test-transformer')
  await _resetRuntimePluginsForTests()

  tamperReleaseCapabilities(state.activeReleaseId)

  assert.throws(
    () => getRuntimePluginRelease('test-transformer', state.activeReleaseId),
    (error) => error?.code === 'PLUGIN_RELEASE_CORRUPT'
      && /完整内容摘要不匹配/.test(error.message),
  )
  assert.throws(
    () => listRuntimePluginStates({ verifyActiveReleases: true }),
    (error) => error?.code === 'PLUGIN_RELEASE_CORRUPT',
  )
  const restored = await restoreEnabledRuntimePlugins()
  assert.deepEqual(restored.map(({ pluginId, ok }) => ({ pluginId, ok })), [
    { pluginId: 'test-transformer', ok: false },
  ])
  assert.match(getRuntimePluginState('test-transformer').lastError, /PLUGIN_RELEASE_CORRUPT/)
  assert.equal(getDynamicTool(toolName), null)
})

test('authoritative release switch rejects a same-id row with corrupted capabilities', async () => {
  const owner = localOwner()
  await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  const before = getRuntimePluginState('test-transformer')
  const active = getRuntimePluginRelease('test-transformer', before.activeReleaseId)
  const candidateId = 'rel-capability-corrupt-candidate'
  createRuntimePluginRelease({
    pluginId: active.pluginId,
    releaseId: candidateId,
    sourceDigest: active.sourceDigest,
    source: active.source,
    pluginSnapshotJson: active.pluginSnapshotJson,
    validationStatus: 'passed',
    healthStatus: 'passed',
    now: active.createdAt + 1,
  })
  tamperReleaseCapabilities(candidateId)

  assert.throws(
    () => activateRuntimePluginRelease({
      pluginId: 'test-transformer',
      releaseId: candidateId,
      previousReleaseId: before.activeReleaseId,
      expectedActiveReleaseId: before.activeReleaseId,
      expectedReleaseRevision: before.releaseRevision,
    }),
    (error) => error?.code === 'PLUGIN_RELEASE_CORRUPT',
  )
  const after = getRuntimePluginState('test-transformer')
  assert.equal(after.activeReleaseId, before.activeReleaseId)
  assert.equal(after.releaseRevision, before.releaseRevision)
})

test('release state rejects missing and cross-plugin rollback references atomically', async () => {
  const owner = localOwner()
  await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  const before = getRuntimePluginState('test-transformer')
  const active = getRuntimePluginRelease('test-transformer', before.activeReleaseId)
  const otherReleaseId = 'rel-other-plugin-reference'
  createRuntimePluginRelease({
    pluginId: 'other-transformer',
    releaseId: otherReleaseId,
    sourceDigest: active.sourceDigest,
    source: active.source,
    pluginSnapshotJson: JSON.stringify({
      ...JSON.parse(active.pluginSnapshotJson),
      id: 'other-transformer',
      name: 'Other Transformer',
    }),
    validationStatus: 'passed',
    healthStatus: 'passed',
    now: active.createdAt + 1,
  })

  for (const previousReleaseId of ['rel-missing-previous', otherReleaseId]) {
    assert.throws(
      () => activateRuntimePluginRelease({
        pluginId: 'test-transformer',
        releaseId: before.activeReleaseId,
        previousReleaseId,
        expectedActiveReleaseId: before.activeReleaseId,
        expectedReleaseRevision: before.releaseRevision,
      }),
      (error) => error?.code === 'PLUGIN_RELEASE_REFERENCE_INVALID'
        && /previousReleaseId/.test(error.message),
    )
    assert.deepEqual(getRuntimePluginState('test-transformer'), before)
  }

  for (const fromReleaseId of ['rel-missing-rollback-from', otherReleaseId]) {
    assert.throws(
      () => recordRuntimePluginRollback({
        pluginId: 'test-transformer',
        fromReleaseId,
        toReleaseId: before.activeReleaseId,
        status: 'failed',
        reason: 'reference validation test',
      }),
      (error) => error?.code === 'PLUGIN_RELEASE_REFERENCE_INVALID'
        && /fromReleaseId/.test(error.message),
    )
    assert.deepEqual(getRuntimePluginState('test-transformer'), before)
  }
})

test('startup restore falls back to a healthy previous release when the active release is unhealthy', async () => {
  const owner = localOwner()
  await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  const previousReleaseId = getRuntimePluginState('test-transformer').activeReleaseId
  fs.writeFileSync(
    path.join(pluginRoot, 'test-transformer', 'entry.js'),
    "function transform(input) { return 'new:' + input }",
  )
  await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/reload',
    token: owner.token,
    method: 'POST',
  })
  await _resetRuntimePluginsForTests()

  const previousRelease = getRuntimePluginRelease('test-transformer', previousReleaseId)
  const unhealthyReleaseId = 'rel-unhealthy-active'
  createRuntimePluginRelease({
    pluginId: previousRelease.pluginId,
    releaseId: unhealthyReleaseId,
    sourceDigest: previousRelease.sourceDigest,
    source: previousRelease.source,
    pluginSnapshotJson: previousRelease.pluginSnapshotJson,
    validationStatus: 'failed',
    healthStatus: 'not_run',
    failure: 'injected unhealthy release',
    now: previousRelease.createdAt + 1,
  })
  getDb().prepare(`
    UPDATE runtime_plugin_states
    SET active_release_id = ?, previous_release_id = ?, release_revision = release_revision + 1
    WHERE plugin_id = ?
  `).run(unhealthyReleaseId, previousReleaseId, 'test-transformer')
  grantPermissionForRelease('test-transformer', previousReleaseId)

  assert.deepEqual(await restoreEnabledRuntimePlugins(), [{
    pluginId: 'test-transformer',
    ok: true,
    attemptedReleaseId: unhealthyReleaseId,
    restoredReleaseId: previousReleaseId,
    rolledBack: true,
  }])
  const state = getRuntimePluginState('test-transformer')
  assert.equal(state.activeReleaseId, previousReleaseId)
  assert.equal(state.previousReleaseId, null)
  assert.equal(state.lastRollback.status, 'succeeded')
  assert.equal(state.lastRollback.fromReleaseId, unhealthyReleaseId)
  assert.equal(state.lastRollback.toReleaseId, previousReleaseId)
  const tool = getDynamicTool(runtimeTransformerToolName('test-transformer'))
  assert.equal((await tool.exec({ input: 'restored' })).output, 'RESTORED')
})

test('startup rollback keeps Release pointers atomic when the rollback receipt cannot be written', async () => {
  const owner = localOwner()
  await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })
  const previousReleaseId = getRuntimePluginState('test-transformer').activeReleaseId
  fs.writeFileSync(
    path.join(pluginRoot, 'test-transformer', 'entry.js'),
    "function transform(input) { return 'new:' + input }",
  )
  await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/reload',
    token: owner.token,
    method: 'POST',
  })
  await _resetRuntimePluginsForTests()

  const previousRelease = getRuntimePluginRelease('test-transformer', previousReleaseId)
  const unhealthyReleaseId = 'rel-unhealthy-atomic-rollback'
  createRuntimePluginRelease({
    pluginId: previousRelease.pluginId,
    releaseId: unhealthyReleaseId,
    sourceDigest: previousRelease.sourceDigest,
    source: previousRelease.source,
    pluginSnapshotJson: previousRelease.pluginSnapshotJson,
    validationStatus: 'failed',
    healthStatus: 'not_run',
    failure: 'injected unhealthy release',
    now: previousRelease.createdAt + 1,
  })
  getDb().prepare(`
    UPDATE runtime_plugin_states
    SET active_release_id = ?, previous_release_id = ?, release_revision = release_revision + 1
    WHERE plugin_id = ?
  `).run(unhealthyReleaseId, previousReleaseId, 'test-transformer')
  grantPermissionForRelease('test-transformer', previousReleaseId)
  const before = getRuntimePluginState('test-transformer')

  const db = getDb()
  db.exec(`
    CREATE TEMP TRIGGER fail_runtime_plugin_rollback_receipt
    BEFORE UPDATE OF last_rollback_status ON runtime_plugin_states
    WHEN NEW.plugin_id = 'test-transformer'
    BEGIN
      SELECT RAISE(ABORT, 'injected rollback receipt failure');
    END
  `)
  let result
  try {
    result = await restoreEnabledRuntimePlugins()
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_runtime_plugin_rollback_receipt')
  }

  assert.equal(result.length, 1)
  assert.equal(result[0].pluginId, 'test-transformer')
  assert.equal(result[0].ok, false)
  assert.equal(result[0].error.restoredReleaseId, null)
  const after = getRuntimePluginState('test-transformer')
  assert.equal(after.activeReleaseId, before.activeReleaseId)
  assert.equal(after.previousReleaseId, before.previousReleaseId)
  assert.equal(after.releaseRevision, before.releaseRevision)
  assert.deepEqual(after.lastRollback, before.lastRollback)
  assert.equal(getRuntimePlugin('test-transformer'), null)
  assert.equal(getDynamicTool(runtimeTransformerToolName('test-transformer')), null)
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

test('dependent plugins make disable atomic and disabled providers block startup restore', async () => {
  const providerId = 'z-disable-provider'
  const consumerId = 'a-disable-consumer'
  const dynamicPluginIds = [consumerId, providerId]
  writePlugin(providerId, {
    id: providerId,
    name: 'Disable Provider',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
  }, "function transform(input) { return 'provider:' + input }")
  writePlugin(consumerId, {
    id: consumerId,
    name: 'Disable Consumer',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
    requires: [providerId],
  }, "function transform(input) { return 'consumer:' + input }")

  await _resetRuntimePluginsForTests()
  _resetForTests()
  assert.equal(initPlugins({ rootDir: pluginRoot, silent: true }).errors.length, 0)
  try {
    const owner = localOwner()
    for (const pluginId of [providerId, consumerId]) {
      assert.equal((await requestRuntime({
        url: `/api/plugins/runtime/${pluginId}/enable`,
        token: owner.token,
        method: 'POST',
      })).status, 200)
    }
    const consumerBefore = getRuntimePluginState(consumerId)
    const rejected = await requestRuntime({
      url: `/api/plugins/runtime/${providerId}/disable`,
      token: owner.token,
      method: 'POST',
    })
    assert.equal(rejected.status, 409)
    assert.equal(rejected.body.error.code, 'PLUGIN_DEPENDENTS_ACTIVE')
    assert.equal(getRuntimePluginState(providerId).enabled, true)
    assert.equal(getRuntimePlugin(providerId).state, 'active')
    assert.equal(getRuntimePlugin(consumerId).state, 'active')

    await _resetRuntimePluginsForTests()
    setRuntimePluginState({ pluginId: providerId, enabled: false })
    const restored = await restoreEnabledRuntimePlugins()
    assert.equal(restored.length, 1)
    assert.equal(restored[0].pluginId, consumerId)
    assert.equal(restored[0].ok, false)
    assert.equal(restored[0].error.code, 'PLUGIN_DEPENDENCY_DISABLED')
    assert.equal(restored[0].error.dependencyId, providerId)
    assert.equal(getRuntimePluginState(consumerId).activeReleaseId, consumerBefore.activeReleaseId)
    assert.equal(getRuntimePluginState(consumerId).releaseRevision, consumerBefore.releaseRevision)
    assert.equal(getDynamicTool(runtimeTransformerToolName(consumerId)), null)
  } finally {
    await _resetRuntimePluginsForTests()
    for (const pluginId of dynamicPluginIds) {
      fs.rmSync(path.join(pluginRoot, pluginId), { recursive: true, force: true })
    }
    _resetForTests()
    assert.equal(initPlugins({ rootDir: pluginRoot, silent: true }).errors.length, 0)
  }
})

test('startup restore orders by persisted release dependencies when the disk manifest changed', async () => {
  const providerId = 'z-release-provider'
  const consumerId = 'a-release-consumer'
  const dynamicPluginIds = [consumerId, providerId]
  writePlugin(providerId, {
    id: providerId,
    name: 'Release Provider',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
  }, "function transform(input) { return 'provider:' + input }")
  writePlugin(consumerId, {
    id: consumerId,
    name: 'Release Consumer v1',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
    requires: [providerId],
    contributes: ['service:release-snapshot-only'],
    dependencyVersions: { [providerId]: '^1.0.0' },
  }, "function transform(input) { return 'consumer:' + input }")

  await _resetRuntimePluginsForTests()
  _resetForTests()
  assert.equal(initPlugins({ rootDir: pluginRoot, silent: true }).errors.length, 0)
  try {
    const owner = localOwner()
    for (const pluginId of [providerId, consumerId]) {
      assert.equal((await requestRuntime({
        url: `/api/plugins/runtime/${pluginId}/enable`,
        token: owner.token,
        method: 'POST',
      })).status, 200)
    }
    const revisions = new Map(dynamicPluginIds.map((pluginId) => [
      pluginId,
      getRuntimePluginState(pluginId).releaseRevision,
    ]))

    await _resetRuntimePluginsForTests()
    writePlugin(consumerId, {
      id: consumerId,
      name: 'Disk Consumer v2',
      version: '2.0.0',
      type: 'transformer',
      entry: 'entry.js',
      contributes: ['service:disk-manifest-only'],
    }, "function transform(input) { return 'unpublished:' + input }")
    _resetForTests()
    assert.equal(initPlugins({ rootDir: pluginRoot, silent: true }).errors.length, 0)

    assert.deepEqual(await restoreEnabledRuntimePlugins(), [
      { pluginId: providerId, ok: true },
      { pluginId: consumerId, ok: true },
    ])
    for (const pluginId of dynamicPluginIds) {
      assert.equal(getRuntimePluginState(pluginId).releaseRevision, revisions.get(pluginId))
      assert.ok(getDynamicTool(runtimeTransformerToolName(pluginId)))
    }
    const restoredConsumer = getRuntimePlugin(consumerId)
    assert.equal(restoredConsumer.name, 'Release Consumer v1')
    assert.equal(restoredConsumer.version, '1.0.0')
    assert.deepEqual(restoredConsumer.requires, [providerId])
    assert.deepEqual(restoredConsumer.contributes, [
      'service:release-snapshot-only',
      `tool:${runtimeTransformerToolName(consumerId)}`,
    ])
    const inventory = await requestRuntime({ token: owner.token })
    const restoredInventory = inventory.body.plugins.find((entry) => entry.id === consumerId)
    assert.equal(restoredInventory.name, 'Release Consumer v1')
    assert.equal(restoredInventory.version, '1.0.0')
    assert.deepEqual(restoredInventory.manifest, {
      id: consumerId,
      name: 'Release Consumer v1',
      version: '1.0.0',
      requires: [providerId],
      contributes: [
        'service:release-snapshot-only',
        `tool:${runtimeTransformerToolName(consumerId)}`,
      ],
    })
  } finally {
    await _resetRuntimePluginsForTests()
    for (const pluginId of dynamicPluginIds) {
      fs.rmSync(path.join(pluginRoot, pluginId), { recursive: true, force: true })
    }
    _resetForTests()
    assert.equal(initPlugins({ rootDir: pluginRoot, silent: true }).errors.length, 0)
  }
})

test('startup restore ignores previous release dependencies when planning the active release graph', async () => {
  const pluginAId = 'a-cross-version-a'
  const pluginBId = 'z-cross-version-b'
  const dynamicPluginIds = [pluginAId, pluginBId]
  writePlugin(pluginAId, {
    id: pluginAId,
    name: 'Cross Version A v1',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
    requires: [pluginBId],
  }, "function transform(input) { return 'a-v1:' + input }")
  writePlugin(pluginBId, {
    id: pluginBId,
    name: 'Cross Version B v1',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
  }, "function transform(input) { return 'b-v1:' + input }")

  await _resetRuntimePluginsForTests()
  _resetForTests()
  assert.equal(initPlugins({ rootDir: pluginRoot, silent: true }).errors.length, 0)
  try {
    const owner = localOwner()
    for (const pluginId of [pluginBId, pluginAId]) {
      assert.equal((await requestRuntime({
        url: `/api/plugins/runtime/${pluginId}/enable`,
        token: owner.token,
        method: 'POST',
      })).status, 200)
    }

    writePlugin(pluginAId, {
      id: pluginAId,
      name: 'Cross Version A v2',
      version: '2.0.0',
      type: 'transformer',
      entry: 'entry.js',
    }, "function transform(input) { return 'a-v2:' + input }")
    _resetForTests()
    assert.equal(initPlugins({ rootDir: pluginRoot, silent: true }).errors.length, 0)
    assert.equal((await requestRuntime({
      url: `/api/plugins/runtime/${pluginAId}/reload`,
      token: owner.token,
      method: 'POST',
    })).status, 200)

    writePlugin(pluginBId, {
      id: pluginBId,
      name: 'Cross Version B v2',
      version: '2.0.0',
      type: 'transformer',
      entry: 'entry.js',
      requires: [pluginAId],
    }, "function transform(input) { return 'b-v2:' + input }")
    _resetForTests()
    assert.equal(initPlugins({ rootDir: pluginRoot, silent: true }).errors.length, 0)
    assert.equal((await requestRuntime({
      url: `/api/plugins/runtime/${pluginBId}/reload`,
      token: owner.token,
      method: 'POST',
    })).status, 200)

    const publishedStates = new Map(dynamicPluginIds.map((pluginId) => [
      pluginId,
      getRuntimePluginState(pluginId),
    ]))
    for (const state of publishedStates.values()) {
      assert.ok(state.activeReleaseId)
      assert.ok(state.previousReleaseId)
      assert.notEqual(state.activeReleaseId, state.previousReleaseId)
    }

    await _resetRuntimePluginsForTests()
    assert.deepEqual(await restoreEnabledRuntimePlugins(), [
      { pluginId: pluginAId, ok: true },
      { pluginId: pluginBId, ok: true },
    ])
    for (const pluginId of dynamicPluginIds) {
      const restoredState = getRuntimePluginState(pluginId)
      const publishedState = publishedStates.get(pluginId)
      assert.equal(restoredState.activeReleaseId, publishedState.activeReleaseId)
      assert.equal(restoredState.previousReleaseId, publishedState.previousReleaseId)
      assert.equal(restoredState.releaseRevision, publishedState.releaseRevision)
    }
    assert.equal(
      (await getDynamicTool(runtimeTransformerToolName(pluginAId)).exec({ input: 'ok' })).output,
      'a-v2:ok',
    )
    assert.equal(
      (await getDynamicTool(runtimeTransformerToolName(pluginBId)).exec({ input: 'ok' })).output,
      'b-v2:ok',
    )
  } finally {
    await _resetRuntimePluginsForTests()
    for (const pluginId of dynamicPluginIds) {
      fs.rmSync(path.join(pluginRoot, pluginId), { recursive: true, force: true })
    }
    _resetForTests()
    assert.equal(initPlugins({ rootDir: pluginRoot, silent: true }).errors.length, 0)
  }
})

test('startup restore validates dependencies for the selected release candidate only', async () => {
  const providerId = 'z-previous-only-provider'
  const consumerId = 'a-candidate-specific-consumer'
  const dynamicPluginIds = [consumerId, providerId]
  writePlugin(providerId, {
    id: providerId,
    name: 'Previous Only Provider',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
  }, "function transform(input) { return 'provider:' + input }")
  writePlugin(consumerId, {
    id: consumerId,
    name: 'Candidate Specific Consumer',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
    requires: [providerId],
    dependencyVersions: { [providerId]: '^1.0.0' },
  }, "function transform(input) { return 'previous:' + input }")

  await _resetRuntimePluginsForTests()
  _resetForTests()
  assert.equal(initPlugins({ rootDir: pluginRoot, silent: true }).errors.length, 0)
  try {
    const owner = localOwner()
    for (const pluginId of [providerId, consumerId]) {
      assert.equal((await requestRuntime({
        url: `/api/plugins/runtime/${pluginId}/enable`,
        token: owner.token,
        method: 'POST',
      })).status, 200)
    }
    const previousReleaseId = getRuntimePluginState(consumerId).activeReleaseId

    writePlugin(consumerId, {
      id: consumerId,
      name: 'Candidate Specific Consumer',
      version: '1.1.0',
      type: 'transformer',
      entry: 'entry.js',
    }, "function transform(input) { return 'active:' + input }")
    _resetForTests()
    assert.equal(initPlugins({ rootDir: pluginRoot, silent: true }).errors.length, 0)
    assert.equal((await requestRuntime({
      url: `/api/plugins/runtime/${consumerId}/reload`,
      token: owner.token,
      method: 'POST',
    })).status, 200)

    const publishedState = getRuntimePluginState(consumerId)
    const activeReleaseId = publishedState.activeReleaseId
    assert.notEqual(activeReleaseId, previousReleaseId)
    assert.equal(publishedState.previousReleaseId, previousReleaseId)

    await _resetRuntimePluginsForTests()
    setRuntimePluginState({ pluginId: providerId, enabled: false })
    assert.deepEqual(await restoreEnabledRuntimePlugins(), [
      { pluginId: consumerId, ok: true },
    ])
    assert.equal(getRuntimePlugin(providerId), null)
    assert.equal(getRuntimePluginState(consumerId).activeReleaseId, activeReleaseId)
    assert.equal(getRuntimePluginState(consumerId).releaseRevision, publishedState.releaseRevision)
    assert.equal(
      (await getDynamicTool(runtimeTransformerToolName(consumerId)).exec({ input: 'healthy' })).output,
      'active:healthy',
    )

    await _resetRuntimePluginsForTests()
    setRuntimePluginState({ pluginId: providerId, enabled: true })
    const previousRelease = getRuntimePluginRelease(consumerId, previousReleaseId)
    const unhealthyReleaseId = 'rel-candidate-specific-unhealthy'
    createRuntimePluginRelease({
      pluginId: consumerId,
      releaseId: unhealthyReleaseId,
      sourceDigest: previousRelease.sourceDigest,
      source: previousRelease.source,
      pluginSnapshotJson: previousRelease.pluginSnapshotJson,
      validationStatus: 'failed',
      healthStatus: 'not_run',
      failure: 'injected candidate-specific failure',
      now: previousRelease.createdAt + 1,
    })
    getDb().prepare(`
      UPDATE runtime_plugin_states
      SET active_release_id = ?, previous_release_id = ?, release_revision = release_revision + 1
      WHERE plugin_id = ?
    `).run(unhealthyReleaseId, previousReleaseId, consumerId)
    grantPermissionForRelease(consumerId, previousReleaseId)

    assert.deepEqual(await restoreEnabledRuntimePlugins(), [
      { pluginId: providerId, ok: true },
      {
        pluginId: consumerId,
        ok: true,
        attemptedReleaseId: unhealthyReleaseId,
        restoredReleaseId: previousReleaseId,
        rolledBack: true,
      },
    ])
    assert.equal(getRuntimePluginState(consumerId).activeReleaseId, previousReleaseId)
    assert.equal(
      (await getDynamicTool(runtimeTransformerToolName(consumerId)).exec({ input: 'rollback' })).output,
      'previous:rollback',
    )
  } finally {
    await _resetRuntimePluginsForTests()
    for (const pluginId of dynamicPluginIds) {
      fs.rmSync(path.join(pluginRoot, pluginId), { recursive: true, force: true })
    }
    _resetForTests()
    assert.equal(initPlugins({ rootDir: pluginRoot, silent: true }).errors.length, 0)
  }
})

test('provider restore failure short-circuits consumers with a structured dependency receipt', async () => {
  const providerId = 'z-failing-provider'
  const consumerId = 'a-blocked-consumer'
  const dynamicPluginIds = [consumerId, providerId]
  writePlugin(providerId, {
    id: providerId,
    name: 'Failing Provider',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
  }, "function transform() { throw new Error('injected provider failure') }")
  writePlugin(consumerId, {
    id: consumerId,
    name: 'Blocked Consumer',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
    requires: [providerId],
  }, "function transform(input) { return 'must-not-run:' + input }")

  await _resetRuntimePluginsForTests()
  _resetForTests()
  assert.equal(initPlugins({ rootDir: pluginRoot, silent: true }).errors.length, 0)
  try {
    setRuntimePluginState({ pluginId: consumerId, enabled: true })
    setRuntimePluginState({ pluginId: providerId, enabled: true })
    grantPermissionForPlugin(consumerId)
    grantPermissionForPlugin(providerId)
    const results = await restoreEnabledRuntimePlugins()

    assert.equal(results[0].pluginId, providerId)
    assert.equal(results[0].ok, false)
    assert.equal(results[0].error.code, 'PLUGIN_RELEASE_HEALTH_CHECK_FAILED')
    assert.deepEqual(results[1], {
      pluginId: consumerId,
      ok: false,
      error: {
        code: 'PLUGIN_DEPENDENCY_RESTORE_FAILED',
        message: `插件依赖恢复失败：${consumerId} requires ${providerId}`,
        retryable: false,
        dependencyId: providerId,
        blockedBy: [providerId],
        attemptedReleaseId: null,
        restoredReleaseId: null,
      },
    })
    assert.equal(countRuntimePluginReleases(consumerId), 0)
    assert.equal(getRuntimePluginState(consumerId).activeReleaseId, null)
    assert.equal(getDynamicTool(runtimeTransformerToolName(consumerId)), null)
  } finally {
    await _resetRuntimePluginsForTests()
    for (const pluginId of dynamicPluginIds) {
      fs.rmSync(path.join(pluginRoot, pluginId), { recursive: true, force: true })
    }
    _resetForTests()
    assert.equal(initPlugins({ rootDir: pluginRoot, silent: true }).errors.length, 0)
  }
})

test('startup restore rejects a same-id host runtime without unregistering it or moving release state', async () => {
  const owner = localOwner()
  assert.equal((await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/enable',
    token: owner.token,
    method: 'POST',
  })).status, 200)
  const before = getRuntimePluginState('test-transformer')
  await _resetRuntimePluginsForTests()
  await registerPlugin({
    id: 'test-transformer',
    name: 'External Same ID Host',
    version: '9.0.0',
    requires: [],
    contributes: [],
  }, () => {})

  const results = await restoreEnabledRuntimePlugins()
  assert.equal(results.length, 1)
  assert.equal(results[0].pluginId, 'test-transformer')
  assert.equal(results[0].ok, false)
  assert.equal(results[0].error.code, 'PLUGIN_RUNTIME_STATE_CONFLICT')
  assert.equal(getRuntimePlugin('test-transformer').version, '9.0.0')
  assert.equal(getRuntimePlugin('test-transformer').state, 'active')
  assert.equal(getRuntimePluginState('test-transformer').activeReleaseId, before.activeReleaseId)
  assert.equal(getRuntimePluginState('test-transformer').releaseRevision, before.releaseRevision)

  const inventory = await requestRuntime({ token: owner.token })
  assert.equal(inventory.status, 200)
  const conflict = inventory.body.plugins.find((entry) => entry.id === 'test-transformer')
  assert.equal(conflict.name, 'External Same ID Host')
  assert.equal(conflict.version, '9.0.0')
  assert.equal(conflict.type, 'runtime')
  assert.equal(conflict.source, 'host-runtime')
  assert.equal(conflict.available, true)
  assert.equal(conflict.controllable, false)
  assert.equal(conflict.enabled, true)
  assert.equal(conflict.active, true)
  assert.deepEqual(conflict.manifest, {
    id: 'test-transformer',
    name: 'External Same ID Host',
    version: '9.0.0',
    requires: [],
    contributes: [],
  })
  assert.equal(conflict.toolName, null)
  assert.equal(conflict.permissionGrant, null)
  assert.equal(conflict.canRevokePermissions, true)
  assert.equal(Object.hasOwn(conflict, 'distribution'), false)

  const rejectedDisable = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/disable',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(rejectedDisable.status, 400)
  assert.equal(rejectedDisable.body.error.code, 'PLUGIN_RUNTIME_TYPE_UNSUPPORTED')
  assert.equal(getRuntimePlugin('test-transformer').version, '9.0.0')

  const hostRuntime = getRuntimePlugin('test-transformer')
  const revoked = await requestRuntime({
    url: '/api/plugins/runtime/test-transformer/revoke-permissions',
    token: owner.token,
    method: 'POST',
  })
  assert.equal(revoked.status, 200)
  assert.equal(revoked.body.plugin.type, 'runtime')
  assert.equal(revoked.body.plugin.active, true)
  assert.equal(revoked.body.plugin.canRevokePermissions, false)
  assert.deepEqual(getRuntimePlugin('test-transformer'), hostRuntime)
  assert.equal(getRuntimePlugin('test-transformer').version, '9.0.0')
  assert.equal(getRuntimePlugin('test-transformer').state, 'active')
  assert.equal(getRuntimePluginPermissionGrant('test-transformer'), null)
  const revokedState = getRuntimePluginState('test-transformer')
  assert.equal(revokedState.enabled, false)
  assert.equal(revokedState.activeReleaseId, null)
  assert.equal(revokedState.previousReleaseId, before.activeReleaseId)
  assert.equal(await unregisterPlugin('test-transformer'), true)
})

test('restore isolates missing plugins, records the error, and continues', async () => {
  setRuntimePluginState({ pluginId: 'missing-transformer', enabled: true, now: 20 })
  setRuntimePluginState({ pluginId: 'test-transformer', enabled: true, now: 21 })
  grantPermissionForPlugin('test-transformer')

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
