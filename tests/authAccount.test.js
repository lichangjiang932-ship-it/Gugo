import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import os from 'node:os'

import {
  bootstrapAuth,
  buildSendCodeResponse,
  getMailDiagnostics,
  getPublicAccount,
  handleAuthAccountRequest,
  issueEmailCode,
  sendEmailCode,
  verifyEmailCode,
} from '../server/adapters/authAccount.js'
import { createSession, createUser, getDb, getSessionByToken } from '../server/db.js'
import { upsertSession } from '../server/services/sessionStore.js'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-tests', String(process.pid))

function cleanDb() {
  const db = getDb()
  for (const table of ['ledger', 'sessions', 'login_codes', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run()
  }
  db.prepare("DELETE FROM meta WHERE key = 'local_auth_owner_user_id'").run()
}

function createReq({ url, token = '', method = 'GET' }) {
  return {
    method,
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

test('default local mode bootstraps one reusable internal session', async () => {
  const now = Date.now()
  const first = bootstrapAuth({ env: {}, now })
  const second = bootstrapAuth({ env: {}, now: now + 1 })

  assert.equal(first.mode, 'local')
  assert.equal(first.authenticated, true)
  assert.match(first.token, /^tkn_/)
  assert.equal(second.token, first.token)
  assert.equal(second.user.id, first.user.id)
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM users').get().count, 1)
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1)

  const res = createRes()
  await handleAuthAccountRequest(createReq({ url: '/api/account/me', token: first.token }), res)
  assert.equal(res.statusCode, 200)
})

test('chat ids never authenticate or replace the reusable local auth token', () => {
  const now = Date.now()
  const first = bootstrapAuth({ env: {}, now })
  upsertSession({
    id: 'local-chat-id',
    userId: first.user.id,
    title: 'Local chat',
    createdAt: now + 1,
  })

  assert.equal(getSessionByToken('local-chat-id', now + 2), null)
  assert.throws(
    () => createSession({ token: 'local-chat-id', userId: first.user.id, now: now + 2 }),
    /session token already exists/,
  )
  assert.throws(
    () => upsertSession({ id: first.token, userId: first.user.id, title: 'Not a chat' }),
    /session not found/,
  )

  const second = bootstrapAuth({ token: 'local-chat-id', env: {}, now: now + 3 })
  assert.equal(second.token, first.token)
  assert.equal(getSessionByToken(first.token, now + 3)?.user_id, first.user.id)
  const chat = getDb().prepare('SELECT title, user_id FROM sessions WHERE token = ?').get('local-chat-id')
  assert.deepEqual(chat, { title: 'Local chat', user_id: first.user.id })
})

test('multi-user mode never creates an anonymous session', () => {
  const result = bootstrapAuth({ env: { AUTH_MODE: 'multi_user' } })
  assert.deepEqual(result, { ok: true, mode: 'multi_user', authenticated: false })
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0)
})

test('local mode adopts a sole legacy user and cannot be flipped by another token', () => {
  const now = Date.now()
  createUser({ id: 'owner', email: 'owner@example.com', now })
  const adopted = bootstrapAuth({ env: {}, now })
  assert.equal(adopted.user.id, 'owner')

  createUser({ id: 'other', email: 'other@example.com', now })
  createSession({ token: 'other-token', userId: 'other', now })
  const afterOtherToken = bootstrapAuth({ token: 'other-token', env: {}, now: now + 1 })
  assert.equal(afterOtherToken.user.id, 'owner')
  assert.equal(afterOtherToken.token, adopted.token)
})

test('multi-user bootstrap restores only a valid existing session', () => {
  const now = Date.now()
  createUser({ id: 'member', email: 'member@example.com', now })
  createSession({ token: 'member-token', userId: 'member', now })
  const result = bootstrapAuth({ token: 'member-token', env: { AUTH_MODE: 'multi_user' }, now })
  assert.equal(result.authenticated, true)
  assert.equal(result.user.id, 'member')
  assert.equal('token' in result, false)
})

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
