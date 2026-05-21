import test from 'node:test'
import assert from 'node:assert/strict'

import { executeToolCall } from '../src/lib/tools/index.js'
import { TOKEN_KEY } from '../src/lib/accountClient.js'

test('executeToolCall preserves backend tool billing for chat-level accounting', async () => {
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
      billing: { creditsCharged: 2, credits: 998 },
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
    assert.deepEqual(result.billing, { creditsCharged: 2, credits: 998 })
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
