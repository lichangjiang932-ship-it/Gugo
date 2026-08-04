import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'

import { handleToolProxyRequest } from '../server/adapters/toolProxy.js'
import {
  issueEmailCode,
  verifyEmailCode,
} from '../server/adapters/authAccount.js'
import { getDb } from '../server/db.js'

// 每个测试进程使用独立数据库目录，避免并行测试冲突
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-tests', String(process.pid))

function cleanDb() {
  const db = getDb()
  for (const table of ['ledger', 'sessions', 'login_codes', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run()
  }
}

function createReq({
  url = '/api/tools/unknown',
  token = '',
  ip = '203.0.113.10',
  forwardedFor = ip,
} = {}) {
  let sent = false
  return {
    method: 'POST',
    url,
    headers: {
      'x-forwarded-for': forwardedFor,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    socket: { remoteAddress: ip },
    async *[Symbol.asyncIterator]() {
      if (sent) return
      sent = true
      yield Buffer.from('{}')
    },
  }
}

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    writeHead(status, headers = {}) {
      this.statusCode = status
      Object.assign(this.headers, headers)
    },
    end(chunk = '') {
      this.body += chunk
    },
  }
}

test.beforeEach(() => {
  cleanDb()
})

test.after(() => {
  cleanDb()
})

test('unauthenticated tool requests do not consume the authenticated rate bucket', async () => {
  const ip = '198.51.100.42'
  for (let i = 0; i < 20; i += 1) {
    const res = createRes()
    await handleToolProxyRequest(createReq({ ip }), res)
    assert.equal(res.statusCode, 401)
  }

  const { token } = verifyEmailCode({
    email: 'rate-user@example.com',
    code: issueEmailCode({ email: 'rate-user@example.com', code: '333333' }).devCode,
  })
  const res = createRes()
  await handleToolProxyRequest(createReq({ ip, token }), res)

  assert.equal(res.statusCode, 404)
  assert.equal(res.headers['X-RateLimit-Remaining'], '19')
})

test('tool rate limit ignores forged X-Forwarded-For unless TRUST_PROXY is enabled', async () => {
  const previous = process.env.TRUST_PROXY
  delete process.env.TRUST_PROXY
  try {
    const { token } = verifyEmailCode({
      email: 'rate-forwarded-user@example.com',
      code: issueEmailCode({ email: 'rate-forwarded-user@example.com', code: '444444' }).devCode,
    })
    const socketIp = '198.51.100.77'
    for (let i = 0; i < 20; i += 1) {
      const res = createRes()
      await handleToolProxyRequest(createReq({
        ip: socketIp,
        forwardedFor: `203.0.113.${i + 1}`,
        token,
      }), res)
      assert.equal(res.statusCode, 404)
    }

    const blocked = createRes()
    await handleToolProxyRequest(createReq({
      ip: socketIp,
      forwardedFor: '192.0.2.200',
      token,
    }), blocked)
    assert.equal(blocked.statusCode, 429)
  } finally {
    if (previous == null) delete process.env.TRUST_PROXY
    else process.env.TRUST_PROXY = previous
  }
})
