import assert from 'node:assert/strict'
import test from 'node:test'

import {
  importLocalPluginPackageApi,
  listLocalPluginPackagesApi,
  recoverLocalPluginPackageApi,
  listRuntimePluginInventoryApi,
  runtimePluginActionApi,
  runtimePluginPermissionChallenge,
  uninstallLocalPluginPackageApi,
} from '../src/lib/pluginClient.js'

const packageRevision = `sha256-${'d'.repeat(64)}`

function packageResponse(overrides = {}) {
  return {
    ok: true,
    schemaVersion: 1,
    store: {
      schemaVersion: 1,
      revision: packageRevision,
      packages: [{
        schemaVersion: 1,
        pluginId: 'sample-plugin',
        pluginVersion: '1.0.0',
        packageDigest: `sha256-${'e'.repeat(64)}`,
        fileCount: 2,
        totalBytes: 128,
        installedAt: 1,
        publisherVerified: false,
        sourceKind: 'local-directory',
      }],
    },
    ...overrides,
  }
}

test('runtime plugin action client posts only whitelisted actions to the loopback-gated endpoint', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    await runtimePluginActionApi('demo-transformer', 'reload', {
      approvalDigest: `sha256-${'a'.repeat(64)}`,
    })
    await runtimePluginActionApi('demo-transformer', 'revoke-permissions')
    await runtimePluginActionApi('demo-transformer', 'disable', {
      approvalDigest: `sha256-${'c'.repeat(64)}`,
    })
    await assert.rejects(
      runtimePluginActionApi('demo-transformer', 'unknown-action'),
      /unsupported runtime plugin action/,
    )
    await assert.rejects(
      runtimePluginActionApi('demo-transformer', 'enable', { approvalDigest: 'not-a-digest' }),
      /invalid runtime plugin permission approval digest/,
    )
    assert.deepEqual(calls.map((call) => call.url), [
      '/api/plugins/runtime/demo-transformer/reload',
      '/api/plugins/runtime/demo-transformer/revoke-permissions',
      '/api/plugins/runtime/demo-transformer/disable',
    ])
    assert.ok(calls.every((call) => call.init.method === 'POST'))
    assert.equal(
      calls[0].init.headers['X-Gugo-Plugin-Permission-Approval'],
      `sha256-${'a'.repeat(64)}`,
    )
    assert.equal(calls[1].init.headers['X-Gugo-Plugin-Permission-Approval'], undefined)
    assert.equal(calls[2].init.headers['X-Gugo-Plugin-Permission-Approval'], undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('runtime plugin client accepts only a matching well-formed permission challenge', () => {
  const permissionApproval = {
    contractVersion: 1,
    pluginId: 'demo-transformer',
    pluginVersion: '2.0.0',
    sourceDigest: `sha256-${'b'.repeat(64)}`,
    approvalDigest: `sha256-${'a'.repeat(64)}`,
    permissions: ['runtime:tool', 'sandbox:network'],
  }
  const error = Object.assign(new Error('approval required'), {
    status: 409,
    code: 'PLUGIN_PERMISSION_APPROVAL_REQUIRED',
    details: { permissionApproval },
  })

  assert.deepEqual(runtimePluginPermissionChallenge(error, {
    pluginId: 'demo-transformer',
    action: 'enable',
  }), {
    pluginId: 'demo-transformer',
    action: 'enable',
    pluginVersion: '2.0.0',
    sourceDigest: `sha256-${'b'.repeat(64)}`,
    approvalDigest: `sha256-${'a'.repeat(64)}`,
    permissions: ['runtime:tool', 'sandbox:network'],
  })
  assert.equal(runtimePluginPermissionChallenge(error, {
    pluginId: 'other-transformer',
    action: 'enable',
  }), null)
  assert.equal(runtimePluginPermissionChallenge({ ...error, status: 400 }, {
    pluginId: 'demo-transformer',
    action: 'enable',
  }), null)
})

test('runtime plugin client rejects unknown permission contract versions and actions', () => {
  const permissionApproval = {
    contractVersion: 2,
    pluginId: 'demo-transformer',
    pluginVersion: '2.0.0',
    sourceDigest: `sha256-${'b'.repeat(64)}`,
    approvalDigest: `sha256-${'a'.repeat(64)}`,
    permissions: ['runtime:tool'],
  }
  const error = Object.assign(new Error('approval required'), {
    status: 409,
    code: 'PLUGIN_PERMISSION_APPROVAL_REQUIRED',
    details: { permissionApproval },
  })

  assert.equal(runtimePluginPermissionChallenge(error, {
    pluginId: 'demo-transformer',
    action: 'enable',
  }), null)
  permissionApproval.contractVersion = 1
  assert.equal(runtimePluginPermissionChallenge(error, {
    pluginId: 'demo-transformer',
    action: 'unknown-action',
  }), null)
  assert.equal(runtimePluginPermissionChallenge(error, {
    pluginId: 'demo-transformer',
    action: 'disable',
  }), null)
})

test('runtime plugin client reads the versioned inventory without loading plugin code', async () => {
  const originalFetch = globalThis.fetch
  let request = null
  globalThis.fetch = async (url, init = {}) => {
    request = { url, init }
    return new Response(JSON.stringify({
      ok: true,
      schemaVersion: 8,
      plugins: [{
        id: 'host-observer',
        canRevokePermissions: false,
        manifest: {
          id: 'host-observer',
          name: 'Host Observer',
          version: '1.0.0',
          requires: [],
          contributes: ['event:request'],
        },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const inventory = await listRuntimePluginInventoryApi()
    assert.equal(request.url, '/api/plugins/runtime')
    assert.deepEqual(request.init.headers, {})
    assert.equal(request.init.method, undefined)
    assert.equal(inventory.schemaVersion, 8)
    assert.equal(inventory.plugins[0].canRevokePermissions, false)
    assert.deepEqual(inventory.plugins[0].manifest.contributes, ['event:request'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('runtime plugin client rejects incompatible or malformed inventory instead of showing it as empty', async () => {
  const originalFetch = globalThis.fetch
  const responses = [
    { ok: true, schemaVersion: 7, plugins: [] },
    { ok: true, schemaVersion: 8 },
    { ok: true, schemaVersion: 8, plugins: [{ id: '../outside', canRevokePermissions: false }] },
    { ok: true, schemaVersion: 8, plugins: [{ id: 'missing-revoke-capability' }] },
    { ok: true, schemaVersion: 8, plugins: [{ id: 'invalid-revoke-capability', canRevokePermissions: 'yes' }] },
  ]
  globalThis.fetch = async () => new Response(JSON.stringify(responses.shift()), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  try {
    while (responses.length > 0) {
      await assert.rejects(
        listRuntimePluginInventoryApi(),
        /unsupported runtime plugin inventory response/,
      )
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('local plugin package client uses only the versioned local package endpoints', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const recovery = String(url).endsWith('/actions/recover')
    const mutation = (init.method === 'POST' || init.method === 'DELETE') && !recovery
    return new Response(JSON.stringify(packageResponse(recovery ? {
      recovered: true,
      outcome: 'uninstalled',
      receipt: { pluginId: 'sample-plugin', generation: 7 },
    } : mutation ? {
      result: { operation: init.method === 'DELETE' ? 'uninstalled' : 'upgraded' },
      refreshPending: false,
      restartRequired: false,
    } : {})), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const listed = await listLocalPluginPackagesApi()
    assert.equal(listed.store.revision, packageRevision)
    await importLocalPluginPackageApi({
      sourceDirectory: '  D:\\plugins\\sample  ',
      expectedRevision: packageRevision.toUpperCase(),
      replace: true,
      expectedPluginId: 'SAMPLE-PLUGIN',
    })
    await uninstallLocalPluginPackageApi('SAMPLE-PLUGIN', {
      expectedRevision: packageRevision,
    })
    await recoverLocalPluginPackageApi('SAMPLE-PLUGIN', {
      expectedRevision: packageRevision,
      expectedGeneration: 7,
    })

    assert.deepEqual(calls.map((call) => [call.url, call.init.method]), [
      ['/api/plugins/packages', undefined],
      ['/api/plugins/packages/actions/import', 'POST'],
      ['/api/plugins/packages/sample-plugin', 'DELETE'],
      ['/api/plugins/packages/sample-plugin/actions/recover', 'POST'],
    ])
    assert.deepEqual(JSON.parse(calls[1].init.body), {
      sourceDirectory: 'D:\\plugins\\sample',
      expectedRevision: packageRevision,
      replace: true,
      expectedPluginId: 'sample-plugin',
    })
    assert.deepEqual(JSON.parse(calls[2].init.body), {
      expectedRevision: packageRevision,
    })
    assert.deepEqual(JSON.parse(calls[3].init.body), {
      expectedRevision: packageRevision,
      expectedGeneration: 7,
    })
    assert.equal(calls[1].init.headers['Content-Type'], 'application/json')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('local plugin package client fails closed on invalid input before fetch', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error('must not fetch')
  }
  try {
    await assert.rejects(importLocalPluginPackageApi({
      sourceDirectory: '',
      expectedRevision: packageRevision,
    }), /source directory/)
    await assert.rejects(importLocalPluginPackageApi({
      sourceDirectory: 'D:\\plugins\\sample',
      expectedRevision: packageRevision,
      replace: true,
    }), /expected plugin id/)
    await assert.rejects(uninstallLocalPluginPackageApi('../outside', {
      expectedRevision: packageRevision,
    }), /package id/)
    await assert.rejects(uninstallLocalPluginPackageApi('sample-plugin', {
      expectedRevision: 'stale',
    }), /store revision/)
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('local plugin package client rejects incompatible receipts and mutation states', async () => {
  const originalFetch = globalThis.fetch
  const responses = [
    packageResponse({ schemaVersion: 2 }),
    packageResponse({ store: { schemaVersion: 1, revision: packageRevision, packages: [{}] } }),
    packageResponse({ result: { operation: 'installed' }, refreshPending: false }),
  ]
  globalThis.fetch = async () => new Response(JSON.stringify(responses.shift()), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  try {
    await assert.rejects(listLocalPluginPackagesApi(), /unsupported local plugin package response/)
    await assert.rejects(listLocalPluginPackagesApi(), /unsupported local plugin package response/)
    await assert.rejects(importLocalPluginPackageApi({
      sourceDirectory: 'D:\\plugins\\sample',
      expectedRevision: packageRevision,
    }), /unsupported local plugin package mutation response/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('local plugin package client accepts only complete signed Marketplace identity', async () => {
  const originalFetch = globalThis.fetch
  const signed = {
    schemaVersion: 2,
    pluginId: 'sample-plugin',
    pluginVersion: '1.0.0',
    packageDigest: `sha256-${'e'.repeat(64)}`,
    fileCount: 2,
    totalBytes: 128,
    installedAt: 1,
    publisherVerified: true,
    sourceKind: 'local-marketplace',
    marketplace: { name: 'team-local', displayName: 'Team Local' },
    publisher: {
      id: 'example-publisher',
      displayName: 'Example Publisher',
      keyId: `sha256-${'a'.repeat(64)}`,
    },
    publicationDigest: `sha256-${'b'.repeat(64)}`,
  }
  const responses = [
    packageResponse({
      store: { schemaVersion: 1, revision: packageRevision, packages: [signed] },
    }),
    packageResponse({
      store: {
        schemaVersion: 1,
        revision: packageRevision,
        packages: [{ ...signed, publisher: { id: 'example-publisher' } }],
      },
    }),
  ]
  globalThis.fetch = async () => new Response(JSON.stringify(responses.shift()), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  try {
    const accepted = await listLocalPluginPackagesApi()
    assert.deepEqual(accepted.store.packages[0], signed)
    await assert.rejects(
      listLocalPluginPackagesApi(),
      /unsupported local plugin package response/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('local plugin package client accepts explicit and dead-owner orphan recoveries only', async () => {
  const originalFetch = globalThis.fetch
  const base = {
    pluginId: 'sample-plugin',
    generation: 7,
    operation: 'uninstall',
    ownerPid: 999999,
    createdAt: 100,
    heartbeatAt: 150,
  }
  const responses = [
    packageResponse({ recoveries: [
      { ...base, phase: 'recovery_required', recoveryRequired: true },
      { ...base, generation: 8, phase: 'guarding', recoveryRequired: false },
      { ...base, generation: 9, phase: 'mutating', recoveryRequired: false },
      { ...base, generation: 10, phase: 'refreshing', recoveryRequired: false },
    ] }),
    packageResponse({ recoveries: [
      { ...base, phase: 'guarding', recoveryRequired: true },
    ] }),
    packageResponse({ recoveries: [
      { ...base, phase: 'recovery_required', recoveryRequired: false },
    ] }),
  ]
  globalThis.fetch = async () => new Response(JSON.stringify(responses.shift()), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  try {
    const accepted = await listLocalPluginPackagesApi()
    assert.equal(accepted.recoveries.length, 4)
    await assert.rejects(listLocalPluginPackagesApi(), /unsupported local plugin package recovery response/)
    await assert.rejects(listLocalPluginPackagesApi(), /unsupported local plugin package recovery response/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
