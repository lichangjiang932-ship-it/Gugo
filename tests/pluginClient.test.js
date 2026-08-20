import assert from 'node:assert/strict'
import test from 'node:test'

import { listRuntimePluginInventoryApi, runtimePluginActionApi } from '../src/lib/pluginClient.js'

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
    await runtimePluginActionApi('demo-transformer', 'reload')
    await runtimePluginActionApi('demo-transformer', 'unknown-action')
    assert.deepEqual(calls.map((call) => call.url), [
      '/api/plugins/runtime/demo-transformer/reload',
      '/api/plugins/runtime/demo-transformer/enable',
    ])
    assert.ok(calls.every((call) => call.init.method === 'POST'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('runtime plugin client reads the versioned inventory without loading plugin code', async () => {
  const originalFetch = globalThis.fetch
  let request = null
  globalThis.fetch = async (url, init = {}) => {
    request = { url, init }
    return new Response(JSON.stringify({
      ok: true,
      schemaVersion: 1,
      plugins: [{
        id: 'host-observer',
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
    assert.equal(inventory.schemaVersion, 1)
    assert.deepEqual(inventory.plugins[0].manifest.contributes, ['event:request'])
  } finally {
    globalThis.fetch = originalFetch
  }
})
