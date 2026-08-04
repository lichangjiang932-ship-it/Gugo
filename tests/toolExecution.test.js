import test from 'node:test'
import assert from 'node:assert/strict'

import { buildToolSpecs, executeToolCall, getBuiltinToolRuntimeStatus, listToolNames } from '../src/lib/tools/index.js'
import { TOKEN_KEY } from '../src/lib/accountClient.js'

test('所有向模型公开的内置工具都有真实执行器', () => {
  const status = getBuiltinToolRuntimeStatus()
  assert.deepEqual(status.missingExecutors, [])
  assert.equal(buildToolSpecs(listToolNames()).length, listToolNames().length)
})

test('file artifact executors require an explicit per-turn grant', async () => {
  const denied = await executeToolCall({
    name: 'create_pptx',
    arguments: JSON.stringify({ title: 'Unexpected', markdown: '# One' }),
  })
  assert.equal(denied.ok, false)
  assert.equal(JSON.parse(denied.content).code, 'artifact_tool_not_requested')

  const allowed = await executeToolCall({
    name: 'create_pptx',
    arguments: JSON.stringify({ title: 'Requested', markdown: '# One' }),
  }, { allowedArtifactTools: new Set(['create_pptx']) })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.artifact.type, 'pptx')
})

test('executeToolCall returns normalized content from authenticated web search', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = {
    localStorage: {
      getItem(key) {
        return key === TOKEN_KEY ? 'token-123' : null
      },
    },
  }
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/tools/search')
    assert.equal(init.headers.Authorization, 'Bearer token-123')
    return new Response(JSON.stringify({
      ok: true,
      results: [{ title: 'Result', url: 'https://example.com', snippet: 'Snippet' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const result = await executeToolCall({
      name: 'web_search',
      arguments: JSON.stringify({ query: 'latest news' }),
    })

    assert.equal(result.ok, true)
    assert.match(result.content, /Result/)
    assert.match(result.content, /https:\/\/example\.com/)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})


test('executeToolCall routes workspace read_file through authenticated fs endpoint', async () => {
  const oldWindow = globalThis.window
  globalThis.window = {
    localStorage: {
      getItem: (key) => key === TOKEN_KEY ? 'token-fs' : null,
      setItem: () => {},
      removeItem: () => {},
    },
  }
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/tools/fs/read')
    assert.equal(init.headers.Authorization, 'Bearer token-fs')
    assert.deepEqual(JSON.parse(init.body), { path: 'src/App.jsx', offset: 0, limit: 20 })
    return new Response(JSON.stringify({ ok: true, path: 'src/App.jsx', content: 'hello' }), { status: 200 })
  }
  try {
    const result = await executeToolCall({ name: 'read_file', arguments: JSON.stringify({ path: 'src/App.jsx', offset: 0, limit: 20 }) }, { maxRetries: 0 })
    assert.equal(result.ok, true)
    assert.match(result.content, /src\/App\.jsx/)
  } finally {
    globalThis.fetch = oldFetch
    globalThis.window = oldWindow
  }
})

test('executeToolCall rejects malformed JSON before any backend call', async () => {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('should not fetch')
  }
  try {
    const result = await executeToolCall({ name: 'web_search', arguments: '{"query":' })
    assert.equal(result.ok, false)
    assert.equal(JSON.parse(result.content).code, 'invalid_tool_arguments')
    assert.equal(fetchCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('executeToolCall routes connected app list and open through authenticated connector endpoints', async () => {
  const oldWindow = globalThis.window
  const oldFetch = globalThis.fetch
  globalThis.window = {
    localStorage: {
      getItem: (key) => key === TOKEN_KEY ? 'token-apps' : null,
      setItem: () => {},
      removeItem: () => {},
    },
  }
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (url === '/api/connectors/apps') {
      return new Response(JSON.stringify({ ok: true, apps: [{ provider: 'web_gmail', enabled: true }] }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true, result: { app: { provider: 'web_gmail' }, browser: { connected: true } } }), { status: 200 })
  }
  try {
    const listed = await executeToolCall({ name: 'connected_app_list', arguments: '{}' })
    const opened = await executeToolCall({ name: 'connected_app_open', arguments: JSON.stringify({ provider: 'web_gmail' }) })
    assert.equal(listed.ok, true)
    assert.match(listed.content, /web_gmail/)
    assert.equal(opened.ok, true)
    assert.equal(calls[0].url, '/api/connectors/apps')
    assert.equal(calls[0].init.method, 'GET')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer token-apps')
    assert.equal(calls[1].url, '/api/connectors/apps/open')
    assert.equal(calls[1].init.method, 'POST')
    assert.deepEqual(JSON.parse(calls[1].init.body), { provider: 'web_gmail' })
  } finally {
    globalThis.fetch = oldFetch
    globalThis.window = oldWindow
  }
})
