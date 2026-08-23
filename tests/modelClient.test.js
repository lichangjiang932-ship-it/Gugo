import test from 'node:test'
import assert from 'node:assert/strict'

import {
  callModelThroughProxy,
  callModelThroughProxyStream,
  discoverModelProvider,
  getModelStatus,
  getSystemDiagnostics,
  testModelEndpoint,
  testModelProvider,
} from '../src/lib/modelClient.js'
import { setAuthToken } from '../src/lib/accountClient.js'

test('getModelStatus reads backend model status', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, '/api/model/status')
    return new Response(JSON.stringify({ ok: true, configured: true, modelName: 'gpt-test' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const result = await getModelStatus({ fetchImpl })
  assert.deepEqual(result, { ok: true, configured: true, modelName: 'gpt-test' })
})

test('model client preserves structured backend error details', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    ok: false,
    error: { code: 'MODEL_CONFIG_MISSING', message: '模型服务尚未配置' },
  }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  })

  await assert.rejects(
    () => getModelStatus({ fetchImpl }),
    (error) => {
      assert.equal(error.message, '模型服务尚未配置')
      assert.equal(error.code, 'MODEL_CONFIG_MISSING')
      assert.equal(error.status, 503)
      assert.equal(error.payload.error.message, '模型服务尚未配置')
      return true
    },
  )
})

test('testModelEndpoint posts no endpoint configuration and includes local auth', async () => {
  const calls = []
  const originalWindow = globalThis.window
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  }
  globalThis.window = { localStorage: storage, sessionStorage: storage }
  setAuthToken('model-test-token')
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ ok: true, latency: 12, reply: 'pong' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const result = await testModelEndpoint({ fetchImpl })

    assert.deepEqual(result, { ok: true, latency: 12, reply: 'pong' })
    assert.equal(calls[0].url, '/api/model/test')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer model-test-token')
    assert.deepEqual(JSON.parse(calls[0].init.body), {})
  } finally {
    setAuthToken('')
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})

test('provider test client sends the explicit target model', async () => {
  let request = null
  const result = await testModelProvider('provider/id', '  model-b  ', {
    fetchImpl: async (url, init) => {
      request = { url, init }
      return new Response(JSON.stringify({ ok: true, modelName: 'model-b' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  assert.deepEqual(result, { ok: true, modelName: 'model-b' })
  assert.equal(request.url, '/api/model/providers/provider%2Fid/test')
  assert.equal(request.init.method, 'POST')
  assert.deepEqual(JSON.parse(request.init.body), { modelName: 'model-b' })
})

test('provider discovery client forwards saved Header removal intent', async () => {
  let request = null
  const result = await discoverModelProvider({
    id: 'provider-id',
    baseUrl: 'http://127.0.0.1:1234/v1',
    headers: { 'X-New-Auth': 'replacement' },
    removeHeaderKeys: ['X-Saved-Auth', 'x-stale-header'],
  }, {
    fetchImpl: async (url, init) => {
      request = { url, init }
      return new Response(JSON.stringify({ ok: true, models: ['local-model'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  assert.deepEqual(result, { ok: true, models: ['local-model'] })
  assert.equal(request.url, '/api/model/providers/discover')
  assert.equal(request.init.method, 'POST')
  assert.deepEqual(JSON.parse(request.init.body), {
    id: 'provider-id',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: '',
    headers: { 'X-New-Auth': 'replacement' },
    clearApiKey: false,
    clearHeaders: false,
    removeHeaderKeys: ['X-Saved-Auth', 'x-stale-header'],
  })
})

test('getSystemDiagnostics reads safe backend diagnostics with optional endpoint check', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return new Response(JSON.stringify({ ok: true, model: { configured: true } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const result = await getSystemDiagnostics({ check: true, fetchImpl })

  assert.deepEqual(result, { ok: true, model: { configured: true } })
  assert.equal(calls[0], '/api/system/diagnostics?check=1')
})

test('callModelThroughProxy returns the model reply from the local proxy', async () => {
  const calls = []
  const fetchImpl = async () =>
    new Response(JSON.stringify({ reply: 'hello from model' }), {
      status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

  const reply = await callModelThroughProxy({
    messages: [{ role: 'user', content: 'hello' }],
    modelName: 'gpt-pro',
    modelProviderId: 'provider-uuid',
    fetchImpl: (url, init) => {
      calls.push({ url, init })
      return fetchImpl(url, init)
    },
  })

  assert.deepEqual(reply, { reply: 'hello from model' })
  assert.equal(calls[0].url, '/api/model/chat')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    messages: [{ role: 'user', content: 'hello' }],
    modelName: 'gpt-pro',
    modelProviderId: 'provider-uuid',
  })
})

test('proxy failures throw readable errors from response payload', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: '端点不可达，请确认本地模型服务或代理已启动。' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })

  await assert.rejects(
    () =>
      callModelThroughProxy({
        messages: [{ role: 'user', content: 'hello' }],
        fetchImpl,
      }),
    /端点不可达/
  )
})

test('streaming model calls surface backend SSE errors', async () => {
  const fetchImpl = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"ok":false,"error":"模型服务不可用"}\n\n'))
          controller.close()
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }
    )

  const stream = callModelThroughProxyStream({
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl,
  })

  await assert.rejects(async () => {
    for await (const delta of stream) {
      assert.fail(`unexpected token delta before backend error: ${delta}`)
    }
  }, /模型服务不可用/)
})

test('streaming yields a completion event with final response metadata', async () => {
  const fetchImpl = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(enc.encode('data: {"ok":true,"delta":"hi"}\n\n'))
          controller.enqueue(enc.encode('data: {"ok":true,"done":true,"latency":42,"injectedMemoryIds":["mem-1","mem-2"],"finishReason":"stop"}\n\n'))
          controller.close()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    )

  const events = []
  for await (const event of callModelThroughProxyStream({
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl,
  })) {
    events.push(event)
  }

  // 应有 text 帧 + complete 帧两条（done 后流式终止，complete 帧必须在 return 之前 yield）
  assert.deepEqual(events[0], { type: 'text', delta: 'hi' })
  assert.equal(events[1].type, 'complete')
  assert.deepEqual(events[1].injectedMemoryIds, ['mem-1', 'mem-2'])
  assert.equal(events[1].finishReason, 'stop')
})
