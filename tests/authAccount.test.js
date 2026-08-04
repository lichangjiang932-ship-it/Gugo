import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import os from 'node:os'

import {
  buildSendCodeResponse,
  getMailDiagnostics,
  getPublicAccount,
  handleAuthAccountRequest,
  issueEmailCode,
  sendEmailCode,
  verifyEmailCode,
} from '../server/adapters/authAccount.js'
import { getDb } from '../server/db.js'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-tests', String(process.pid))

function cleanDb() {
  const db = getDb()
  for (const table of ['ledger', 'sessions', 'login_codes', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run()
  }
}

function createReq({ url, token = '' }) {
  return {
    method: 'GET',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    socket: { remoteAddress: '127.0.0.1' },
  }
}

function createRes() {
  return {
    statusCode: 200,
    body: '',
    writeHead(statusCode) { this.statusCode = statusCode },
    end(chunk = '') { this.body += chunk },
  }
}

test.beforeEach(cleanDb)
test.after(cleanDb)

test('email code login creates an account without billing data', () => {
  const issued = issueEmailCode({ email: 'person@example.com', code: '123456' })
  assert.equal(issued.ok, true)
  assert.equal('code' in issued, false)

  const session = verifyEmailCode({ email: 'person@example.com', code: '123456' })
  assert.equal(session.ok, true)
  assert.match(session.token, /^tkn_/)
  assert.equal(session.user.email, 'person@example.com')
  assert.equal('credits' in session.user, false)
  assert.equal('ledger' in session, false)

  const account = getPublicAccount({ token: session.token })
  assert.equal(account.email, 'person@example.com')
  assert.equal('credits' in account, false)
})

test('email codes are stored as hashes instead of plaintext', () => {
  issueEmailCode({ email: 'hashed@example.com', code: '123456' })
  const row = getDb().prepare('SELECT code FROM login_codes WHERE email = ?').get('hashed@example.com')
  assert.notEqual(row.code, '123456')
  assert.match(row.code, /^sha256:/)
})

test('send-code response only exposes a development code when appropriate', () => {
  assert.deepEqual(buildSendCodeResponse({
    issued: { ok: true, email: 'local@example.com', expiresIn: 600, devCode: '123456' },
    delivery: { sent: false, devCode: '123456' },
    env: {},
  }), { ok: true, email: 'local@example.com', expiresIn: 600, devCode: '123456' })

  assert.deepEqual(buildSendCodeResponse({
    issued: { ok: true, email: 'mail@example.com', expiresIn: 600, devCode: '654321' },
    delivery: { sent: true },
    env: { AUTH_DEV_CODES: 'false' },
  }), { ok: true, email: 'mail@example.com', expiresIn: 600 })
})

test('AUTH_DEV_CODES skips SMTP even when mail is configured', async () => {
  const result = await sendEmailCode({
    env: {
      AUTH_DEV_CODES: 'true',
      MAIL_SERVER: 'smtp.example.com',
      MAIL_USERNAME: 'mailer@example.com',
      MAIL_PASSWORD: 'secret',
    },
    email: 'local@example.com',
    code: '123456',
  })
  assert.deepEqual(result, { sent: false, devCode: '123456' })
})

test('mail diagnostics are safe for browser display', () => {
  const mail = getMailDiagnostics({
    MAIL_SERVER: 'smtp.qq.com',
    MAIL_PORT: '587',
    MAIL_USE_TLS: 'true',
    MAIL_USERNAME: 'person@example.com',
    MAIL_PASSWORD: 'secret-auth-code',
    MAIL_DEFAULT_SENDER: 'person@example.com',
    AUTH_DEV_CODES: 'false',
  })
  assert.equal(mail.configured, true)
  assert.equal(mail.useTls, true)
  assert.equal(JSON.stringify(mail).includes('secret-auth-code'), false)
})

test('account endpoint omits legacy credits, ledger, and packages', async () => {
  const issued = issueEmailCode({ email: 'account@example.com', code: '123456' })
  const { token } = verifyEmailCode({ email: issued.email, code: issued.devCode })
  const res = createRes()
  await handleAuthAccountRequest(createReq({ url: '/api/account/me', token }), res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal('credits' in payload.user, false)
  assert.equal('ledger' in payload, false)
  assert.equal('packages' in payload, false)
})

test('authentication does not overwrite a legacy database balance', () => {
  const issued = issueEmailCode({ email: 'legacy-balance@example.com', code: '123456' })
  const first = verifyEmailCode({ email: issued.email, code: issued.devCode })
  getDb().prepare('UPDATE users SET credits = 321 WHERE id = ?').run(first.user.id)

  const nextCode = issueEmailCode({ email: issued.email, code: '654321' })
  const second = verifyEmailCode({ email: nextCode.email, code: nextCode.devCode })
  const stored = getDb().prepare('SELECT credits FROM users WHERE id = ?').get(first.user.id)

  assert.equal(stored.credits, 321)
  assert.equal('credits' in second.user, false)
})

test('retired billing endpoints are unavailable', async () => {
  const res = createRes()
  await handleAuthAccountRequest(createReq({ url: '/api/billing/packages' }), res)
  assert.equal(res.statusCode, 404)
})
