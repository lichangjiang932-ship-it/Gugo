import assert from 'node:assert/strict'
import test from 'node:test'

import { redactUrlForLog, requestLogger } from '../server/middleware.js'

test('request log URLs redact credentials while preserving ordinary query fields', () => {
  const logged = redactUrlForLog(
    '/api/local-files/verified/file-1?turnId=turn-1&token=session-secret&access_token=oauth-secret&api_key=provider-secret&preview=1',
  )

  assert.match(logged, /^\/api\/local-files\/verified\/file-1\?/)
  assert.match(logged, /turnId=turn-1/)
  assert.match(logged, /preview=1/)
  assert.equal((logged.match(/\[REDACTED\]/g) || []).length, 3)
  assert.doesNotMatch(logged, /session-secret|oauth-secret|provider-secret/)
})

test('requestLogger never writes a query bearer token and does not mutate the request URL', () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousLogLevel = process.env.LOG_LEVEL
  const previousLog = console.log
  const lines = []
  const req = {
    method: 'GET',
    url: '/api/local-files/verified/file-1?turnId=turn-1&token=tkn_do_not_log&preview=1',
  }
  const originalUrl = req.url
  const res = {
    statusCode: 200,
    end() {},
  }

  process.env.NODE_ENV = 'development'
  process.env.LOG_LEVEL = 'info'
  console.log = (...args) => lines.push(args.join(' '))
  try {
    requestLogger(req, res, () => res.end())
  } finally {
    console.log = previousLog
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousLogLevel === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = previousLogLevel
  }

  assert.equal(req.url, originalUrl)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /token=\[REDACTED\]/)
  assert.doesNotMatch(lines[0], /tkn_do_not_log/)
})
