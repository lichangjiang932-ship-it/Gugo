import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'

import { handleToolProxyRequest } from '../server/toolProxy.js'
import {
  issueEmailCode,
  rechargeAccount,
  verifyEmailCode,
} from '../server/billingAuth.js'
import { getDb } from '../server/db.js'

// 每个测试进程使用独立数据库目录，避免并行测试冲突
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-tests', String(process.pid))

function cleanDb() {
  const db = getDb()
  for (const table of ['ledger', 'sessions', 'login_codes', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run()
  }
}

function createReq({ url = '/api/tools/unknown', token = '', ip = '203.0.113.10' } = {}) {
  let sent = false
  return {
    method: 'POST',
    url,
    headers: {
      'x-forwarded-for': ip,
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
  rechargeAccount({ token, packageId: 'local-10' })

  const res = createRes()
  await handleToolProxyRequest(createReq({ ip, token }), res)

  assert.equal(res.statusCode, 404)
  assert.equal(res.headers['X-RateLimit-Remaining'], '19')
})
