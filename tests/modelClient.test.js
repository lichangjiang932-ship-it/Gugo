import test from 'node:test'
import assert from 'node:assert/strict'

import {
  callModelThroughProxy,
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
