import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import os from 'node:os'

import { handleToolProxyRequest } from '../server/adapters/toolProxy.js'
import {
  issueEmailCode,
  verifyEmailCode,
} from '../server/adapters/authAccount.js'
import { getDb } from '../server/db.js'
import { setApprovalMode } from '../server/services/approvalSettingsStore.js'
import { upsertHook } from '../server/services/hooksService.js'
import { configureWebSearch } from '../server/services/webSearchService.js'

// 每个测试进程使用独立数据库目录，避免并行测试冲突
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-tests', String(process.pid))

function cleanDb() {
  const db = getDb()
  for (const table of ['pending_approvals', 'notifications', 'hooks', 'sessions', 'login_codes', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run()
  }
}

function createReq({
  url = '/api/tools/unknown',
  token = '',
  ip = '203.0.113.10',
  forwardedFor = ip,
  body = {},
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
      yield Buffer.from(JSON.stringify(body))
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

function createClosableReq(options = {}) {
  return Object.assign(new EventEmitter(), createReq(options))
}

function createClosableRes() {
  const res = Object.assign(new EventEmitter(), createRes(), {
    destroyed: false,
    writableEnded: false,
  })
  const end = res.end
  res.end = function closeResponse(chunk = '') {
    end.call(this, chunk)
    this.writableEnded = true
  }
  return res
}

async function waitForPendingApproval(userId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = getDb().prepare(`
      SELECT * FROM pending_approvals
       WHERE user_id = ? AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1
    `).get(userId)
    if (row) return row
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for direct tool approval')
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

test('legacy web search endpoint uses the user-scoped dedicated configuration', async () => {
  const { token, user } = verifyEmailCode({
    email: 'legacy-search-user@example.com',
    code: issueEmailCode({ email: 'legacy-search-user@example.com', code: '555555' }).devCode,
  })
  configureWebSearch({ userId: user.id, provider: 'brave', enabled: false, apiKey: 'search-key', config: {} })
  const res = createRes()
  await handleToolProxyRequest(createReq({
    url: '/api/tools/search', token, ip: '198.51.100.90', body: { query: 'latest' },
  }), res)
  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.body).error, /联网搜索已关闭/)
})

test('direct tool ask cancels its persisted approval when the response closes early', async () => {
  const previousEnabled = process.env.HOOKS_SHELL_ENABLED
  const previousAllowed = process.env.HOOKS_SHELL_ALLOWED_COMMANDS
  process.env.HOOKS_SHELL_ENABLED = '1'
  process.env.HOOKS_SHELL_ALLOWED_COMMANDS = process.execPath

  try {
    const { token, user } = verifyEmailCode({
      email: 'direct-tool-disconnect@example.com',
      code: issueEmailCode({ email: 'direct-tool-disconnect@example.com', code: '666666' }).devCode,
    })
    setApprovalMode({ userId: user.id, mode: 'normal' })
    upsertHook({
      userId: user.id,
      event: 'pre_tool_use',
      toolPattern: 'web_search',
      kind: 'shell',
      command: [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify({ allow: true, permissionDecision: "ask", reason: "review direct search" }))',
      ],
      enabled: true,
      blocking: true,
      timeoutMs: 5000,
    })

    const req = createClosableReq({
      url: '/api/tools/search',
      token,
      ip: '198.51.100.91',
      body: { query: 'disconnect approval test' },
    })
    const res = createClosableRes()
    const handling = handleToolProxyRequest(req, res)
    const approval = await waitForPendingApproval(user.id)

    res.destroyed = true
    res.emit('close')
    await handling

    const persisted = getDb().prepare('SELECT status, decided_at FROM pending_approvals WHERE id = ?').get(approval.id)
    assert.equal(persisted.status, 'cancelled')
    assert.ok(Number.isFinite(persisted.decided_at))
    assert.equal(res.writableEnded, false)
    assert.equal(res.body, '')
  } finally {
    if (previousEnabled == null) delete process.env.HOOKS_SHELL_ENABLED
    else process.env.HOOKS_SHELL_ENABLED = previousEnabled
    if (previousAllowed == null) delete process.env.HOOKS_SHELL_ALLOWED_COMMANDS
    else process.env.HOOKS_SHELL_ALLOWED_COMMANDS = previousAllowed
  }
})
