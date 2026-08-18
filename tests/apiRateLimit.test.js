import assert from 'node:assert/strict'
import test from 'node:test'

import { createApiRateLimitMiddleware } from '../server/middleware.js'

function request({ method = 'GET', address = '127.0.0.1', url = '/api/sessions' } = {}) {
  return {
    method,
    url,
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

test('issued local HTML preview tickets use a separate resource burst without weakening anonymous limits', () => {
  const activeTicket = 'issued-preview-ticket'
  const middleware = createApiRateLimitMiddleware({
    env: {
      NODE_ENV: 'test',
      API_RATE_LIMIT_ANONYMOUS_PER_MINUTE: '2',
      API_RATE_LIMIT_ANONYMOUS_BURST: '2',
      API_RATE_LIMIT_LOCAL_HTML_PREVIEW_PER_MINUTE: '50',
      API_RATE_LIMIT_LOCAL_HTML_PREVIEW_BURST: '50',
    },
    isActiveLocalHtmlPreviewTicket: (ticket) => ticket === activeTicket,
  })
  try {
    for (let index = 0; index < 43; index += 1) {
      const result = invoke(middleware, request({
        method: index === 42 ? 'HEAD' : 'GET',
        url: `/api/local-files/previews/${activeTicket}/photo-${index}.jpg`,
      }))
      assert.equal(result.passed, true, `preview resource ${index + 1} should not be rate limited`)
    }
    for (let index = 43; index < 50; index += 1) {
      assert.equal(invoke(middleware, request({
        url: `/api/local-files/previews/${activeTicket}/photo-${index}.jpg`,
      })).passed, true)
    }
    const previewBlocked = invoke(middleware, request({
      url: `/api/local-files/previews/${activeTicket}/photo-50.jpg`,
    }))
    assert.equal(previewBlocked.passed, false)
    assert.equal(previewBlocked.res.statusCode, 429)

    assert.equal(invoke(middleware, request({ address: '127.0.0.2' })).passed, true)
    assert.equal(invoke(middleware, request({ address: '127.0.0.2' })).passed, true)
    const ordinaryBlocked = invoke(middleware, request({ address: '127.0.0.2' }))
    assert.equal(ordinaryBlocked.passed, false)
    assert.equal(ordinaryBlocked.res.statusCode, 429)

    const fakeTicketBlocked = invoke(middleware, request({
      address: '127.0.0.2',
      url: '/api/local-files/previews/not-issued/photo.jpg',
    }))
    assert.equal(fakeTicketBlocked.passed, false)
    assert.equal(fakeTicketBlocked.res.statusCode, 429)
  } finally {
    middleware.close()
  }
})
