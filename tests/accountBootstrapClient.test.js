import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TOKEN_KEY,
  bootstrapAuth,
  bootstrapAuthWithRetry,
  getAuthToken,
  loginWithPassword,
  setAuthToken,
  syncAuthTokenFromStorage,
} from '../src/lib/accountClient.js'

function createStorage() {
  const values = new Map()
  return {
    getItem(key) { return values.get(key) || null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
  }
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data }
}

test.beforeEach(() => {
  globalThis.window = { localStorage: createStorage(), sessionStorage: createStorage() }
  setAuthToken('')
})

test.after(() => {
  delete globalThis.window
})

test('local bootstrap stores its internal token and authenticates subsequent calls', async () => {
  const result = await bootstrapAuth({
    fetchImpl: async (url, options) => {
      assert.equal(url, '/api/auth/bootstrap')
      assert.equal(options.method, 'POST')
      return response({
        ok: true,
        mode: 'local',
        authenticated: true,
        token: 'local-token',
        user: { id: 'local-default', email: 'local@gugo.invalid' },
      })
    },
  })
  assert.equal(result.authenticated, true)
  assert.equal(getAuthToken(), 'local-token')
})

test('bootstrap sends an existing token and clears it when multi-user validation fails', async () => {
  setAuthToken('old-token')
  await bootstrapAuth({
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer old-token')
      return response({ ok: true, mode: 'multi_user', authenticated: false })
    },
  })
  assert.equal(getAuthToken(), '')
})

test('blocked browser storage falls back to the in-memory token', async () => {
  globalThis.window = {
    get localStorage() { throw new DOMException('blocked', 'SecurityError') },
    get sessionStorage() { throw new DOMException('blocked', 'SecurityError') },
  }
  setAuthToken('memory-token')
  assert.equal(getAuthToken(), 'memory-token')
  await bootstrapAuth({
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer memory-token')
      return response({
        ok: true,
        mode: 'local',
        authenticated: true,
        token: 'renewed-memory-token',
        user: { id: 'local-default', email: 'local@gugo.invalid' },
      })
    },
  })
  assert.equal(getAuthToken(), 'renewed-memory-token')
})

test('writing a new token removes a stale session fallback', () => {
  window.sessionStorage.setItem(TOKEN_KEY, 'stale-session-token')
  setAuthToken('fresh-token')
  assert.equal(window.sessionStorage.getItem(TOKEN_KEY), null)
  assert.equal(window.localStorage.getItem(TOKEN_KEY), 'fresh-token')
  assert.equal(getAuthToken(), 'fresh-token')
})

test('a token storage event replaces stale in-memory authentication', () => {
  setAuthToken('old-memory-token')
  window.localStorage.setItem(TOKEN_KEY, 'new-tab-token')
  window.sessionStorage.setItem(TOKEN_KEY, 'stale-session-token')
  syncAuthTokenFromStorage('new-tab-token')
  assert.equal(getAuthToken(), 'new-tab-token')
  assert.equal(window.sessionStorage.getItem(TOKEN_KEY), null)

  syncAuthTokenFromStorage(null)
  assert.equal(getAuthToken(), '')
})

test('bootstrap retries a transient startup failure without looping forever', async () => {
  let attempts = 0
  const result = await bootstrapAuthWithRetry({
    retryDelays: [0, 0],
    fetchImpl: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('server not ready')
      return response({
        ok: true,
        mode: 'local',
        authenticated: true,
        token: 'retry-token',
        user: { id: 'local-default', email: 'local@gugo.invalid' },
      })
    },
  })
  assert.equal(result.token, 'retry-token')
  assert.equal(attempts, 2)
  assert.equal(getAuthToken(), 'retry-token')
})

test('bootstrap stops after the configured retry budget', async () => {
  let attempts = 0
  await assert.rejects(
    bootstrapAuthWithRetry({
      retryDelays: [0, 0, 0],
      fetchImpl: async () => {
        attempts += 1
        throw new Error('offline')
      },
    }),
    /offline/,
  )
  assert.equal(attempts, 3)
})

test('account requests preserve the stable server error code', async () => {
  await assert.rejects(
    loginWithPassword({
      email: 'person@example.com',
      password: 'wrong-password',
      fetchImpl: async () => response({
        ok: false,
        error: '邮箱或密码不正确',
        code: 'AUTH_INVALID_CREDENTIALS',
      }, 400),
    }),
    (error) => error?.code === 'AUTH_INVALID_CREDENTIALS'
      && error.message === '邮箱或密码不正确',
  )
})
