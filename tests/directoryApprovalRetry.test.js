import assert from 'node:assert/strict'
import test from 'node:test'

import { TOKEN_KEY } from '../src/lib/accountClient.js'
import {
  createManagedProjectDirectoryApi,
  getLocalFileAccessApi,
  selectLocalDirectoryApi,
} from '../src/lib/localFileAccessClient.js'
import { executeToolCall } from '../src/lib/tools/index.js'

function mockWindow(directoryGate) {
  return {
    localStorage: {
      getItem: (key) => key === TOKEN_KEY ? 'token-directory' : null,
      setItem: () => {},
      removeItem: () => {},
    },
    __directoryApprovalGate: directoryGate,
  }
}

function unauthorizedResponse({ accessMode = 'read_only' } = {}) {
  return new Response(JSON.stringify({
    ok: false,
    code: 'PATH_NOT_AUTHORIZED',
    error: '该路径未获得授权',
    retryable: false,
    path: 'D:\\private\\note.txt',
    suggestGrantPath: 'D:\\private',
    requiredAccessMode: accessMode,
  }), { status: 403, headers: { 'Content-Type': 'application/json' } })
}

test('executeToolCall retries the exact file call once after directory approval', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const requests = []
  let fetchCalls = 0
  globalThis.window = mockWindow(async (request) => {
    requests.push(request)
    return { approved: true }
  })
  globalThis.fetch = async () => {
    fetchCalls += 1
    if (fetchCalls === 1) return unauthorizedResponse()
    return new Response(JSON.stringify({ ok: true, path: 'D:\\private\\note.txt', content: 'granted' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const result = await executeToolCall({
      name: 'read_file',
      arguments: JSON.stringify({ path: 'D:\\private\\note.txt' }),
    }, { maxRetries: 2 })

    assert.equal(result.ok, true)
    assert.equal(result.attempts, 2)
    assert.equal(fetchCalls, 2)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].suggestGrantPath, 'D:\\private')
    assert.equal(requests[0].requiredAccessMode, 'read_only')
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('executeToolCall does not retry when directory approval is rejected', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  let gateCalls = 0
  let fetchCalls = 0
  globalThis.window = mockWindow(async () => {
    gateCalls += 1
    return { approved: false, reason: '不授权该目录' }
  })
  globalThis.fetch = async () => {
    fetchCalls += 1
    return unauthorizedResponse()
  }

  try {
    const result = await executeToolCall({
      name: 'read_file',
      arguments: JSON.stringify({ path: 'D:\\private\\note.txt' }),
    }, { maxRetries: 2 })
    const payload = JSON.parse(result.content)

    assert.equal(result.ok, false)
    assert.equal(payload.code, 'PATH_AUTHORIZATION_REJECTED')
    assert.equal(payload.attempts, 1)
    assert.equal(fetchCalls, 1)
    assert.equal(gateCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('executeToolCall never reopens authorization or generic retries after the one retry fails', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  let gateCalls = 0
  let fetchCalls = 0
  globalThis.window = mockWindow(async () => {
    gateCalls += 1
    return true
  })
  globalThis.fetch = async () => {
    fetchCalls += 1
    return unauthorizedResponse({ accessMode: 'read_write' })
  }

  try {
    const result = await executeToolCall({
      name: 'read_file',
      arguments: JSON.stringify({ path: 'D:\\private\\note.txt' }),
    }, { maxRetries: 3 })
    const payload = JSON.parse(result.content)

    assert.equal(result.ok, false)
    assert.equal(payload.code, 'PATH_NOT_AUTHORIZED')
    assert.equal(payload.attempts, 2)
    assert.equal(fetchCalls, 2)
    assert.equal(gateCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('local file access client preserves directory authorization metadata', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = mockWindow(async () => false)
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
  globalThis.window = mockWindow(async () => false)
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
  globalThis.window = mockWindow(async () => false)
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
