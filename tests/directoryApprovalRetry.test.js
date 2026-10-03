import assert from 'node:assert/strict'
import test from 'node:test'

import { TOKEN_KEY } from '../src/lib/accountClient.js'
import {
  createManagedProjectDirectoryApi,
  getLocalFileAccessApi,
  selectLocalDirectoryApi,
} from '../src/lib/localFileAccessClient.js'

function mockWindow() {
  return {
    localStorage: {
      getItem: (key) => key === TOKEN_KEY ? 'token-directory' : null,
      setItem: () => {},
      removeItem: () => {},
    },
  }
}

test('local file access client preserves directory authorization metadata', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = mockWindow()
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    error: {
      code: 'PATH_NOT_AUTHORIZED',
      message: '需要授权',
      path: 'D:\\private\\note.txt',
      suggestGrantPath: 'D:\\private',
      requiredAccessMode: 'read_only',
    },
  }), { status: 403, headers: { 'Content-Type': 'application/json' } })

  try {
    await assert.rejects(getLocalFileAccessApi, (error) => {
      assert.equal(error.code, 'PATH_NOT_AUTHORIZED')
      assert.equal(error.path, 'D:\\private\\note.txt')
      assert.equal(error.suggestGrantPath, 'D:\\private')
      assert.equal(error.requiredAccessMode, 'read_only')
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('managed project client turns a stale backend 405 into a restart-required error', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = mockWindow()
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' },
  }), { status: 405, headers: { 'Content-Type': 'application/json' } })

  try {
    await assert.rejects(
      () => createManagedProjectDirectoryApi('新项目'),
      (error) => error?.code === 'PROJECT_CREATION_RESTART_REQUIRED' && error?.status === 405,
    )
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('local directory picker client calls the native host selection endpoint', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = mockWindow()
  let request = null
  globalThis.fetch = async (url, init) => {
    request = { url, init }
    return new Response(JSON.stringify({
      ok: true,
      supported: true,
      canceled: false,
      path: 'D:\\Projects\\selected',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const result = await selectLocalDirectoryApi(' D:\\Projects ')
    assert.equal(request.url, '/api/local-files/select-directory')
    assert.equal(request.init.method, 'POST')
    assert.equal(request.init.headers.Authorization, 'Bearer token-directory')
    assert.deepEqual(JSON.parse(request.init.body), { defaultPath: 'D:\\Projects' })
    assert.deepEqual(result, {
      ok: true,
      supported: true,
      canceled: false,
      path: 'D:\\Projects\\selected',
    })
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})
