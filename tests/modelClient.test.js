import test from 'node:test'
import assert from 'node:assert/strict'

import {
  callModelThroughProxy,
  callModelThroughProxyStream,
  getModelStatus,
  getSystemDiagnostics,
  testModelEndpoint,
} from '../src/lib/modelClient.js'

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

test('testModelEndpoint posts no endpoint configuration to local proxy', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ ok: true, latency: 12, reply: 'pong' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const result = await testModelEndpoint({ fetchImpl })

  assert.deepEqual(result, { ok: true, latency: 12, reply: 'pong' })
  assert.equal(calls[0].url, '/api/model/test')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), {})
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

test('callModelThroughProxy returns billing-aware response from local proxy', async () => {
  const calls = []
  const fetchImpl = async () =>
    new Response(JSON.stringify({ reply: 'hello from model' }), {
      status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

  const reply = await callModelThroughProxy({
    messages: [{ role: 'user', content: 'hello' }],
    modelName: 'gpt-pro',
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

test('streaming yields billing event on done frame for tool-call charge accounting', async () => {
  const fetchImpl = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(enc.encode('data: {"ok":true,"delta":"hi"}\n\n'))
          controller.enqueue(enc.encode('data: {"ok":true,"done":true,"latency":42,"injectedMemoryIds":["mem-1","mem-2"],"billing":{"creditsCharged":7,"credits":993,"error":null}}\n\n'))
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

  // 应有 text 帧 + billing 帧两条 (done 后流式终止,billing 帧必须在 return 之前 yield)
  assert.deepEqual(events[0], { type: 'text', delta: 'hi' })
  assert.equal(events[1].type, 'billing')
  assert.equal(events[1].billing.creditsCharged, 7)
  assert.equal(events[1].billing.credits, 993)
  assert.deepEqual(events[1].injectedMemoryIds, ['mem-1', 'mem-2'])
})
