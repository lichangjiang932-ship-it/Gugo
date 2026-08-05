import assert from 'node:assert/strict'
import test from 'node:test'

import { createApiRateLimitMiddleware } from '../server/middleware.js'

function request({ method = 'GET', address = '127.0.0.1' } = {}) {
  return {
    method,
    url: '/api/sessions',
    headers: {},
    socket: { remoteAddress: address },
  }
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    writeHead(statusCode) { this.statusCode = statusCode },
    end(chunk = '') { this.body += chunk },
  }
}

function invoke(middleware, req) {
  const res = response()
  let passed = false
  middleware(req, res, () => { passed = true })
  return { res, passed }
}

test('API fallback limiter blocks bursts and isolates client addresses', () => {
  let now = 1_000
  const middleware = createApiRateLimitMiddleware({
    env: {
      NODE_ENV: 'test',
      API_RATE_LIMIT_ANONYMOUS_PER_MINUTE: '2',
      API_RATE_LIMIT_ANONYMOUS_BURST: '2',
    },
    now: () => now,
  })
  try {
    assert.equal(invoke(middleware, request()).passed, true)
    assert.equal(invoke(middleware, request()).passed, true)
    const blocked = invoke(middleware, request())
    assert.equal(blocked.passed, false)
    assert.equal(blocked.res.statusCode, 429)
    assert.equal(JSON.parse(blocked.res.body).error.code, 'RATE_LIMITED')
    assert.equal(invoke(middleware, request({ address: '127.0.0.2' })).passed, true)
    now += 60_000
    assert.equal(invoke(middleware, request()).passed, true)
  } finally {
    middleware.close()
  }
})
