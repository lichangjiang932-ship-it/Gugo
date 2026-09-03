import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-db-store-contract-'))
const previousDataDir = process.env.APP_DATA_DIR
const previousDbPath = process.env.APP_DB_PATH
process.env.APP_DATA_DIR = dataDir
delete process.env.APP_DB_PATH

const db = await import('../server/db.js')

function clearFocusedTables() {
  const connection = db.getDb()
  for (const table of [
    'user_tool_permissions',
    'login_codes',
    'rate_limits',
    'sessions',
    'users',
  ]) {
    connection.prepare(`DELETE FROM ${table}`).run()
  }
}

test.beforeEach(clearFocusedTables)

test.after(() => {
  db.closeDb()
  fs.rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.APP_DATA_DIR
  else process.env.APP_DATA_DIR = previousDataDir
  if (previousDbPath === undefined) delete process.env.APP_DB_PATH
  else process.env.APP_DB_PATH = previousDbPath
})

test('user facade preserves lookup, idempotent creation, and password lifecycle semantics', () => {
  const created = db.createUser({ id: 'user-a', email: 'a@example.test', now: 100 })
  assert.equal(created.id, 'user-a')
  assert.equal(created.email, 'a@example.test')
  assert.equal(created.created_at, 100)
  assert.equal(created.updated_at, 100)
  assert.deepEqual(db.getUserByEmail('a@example.test'), created)
  assert.equal(db.getUserById('missing-user'), null)

  const recreated = db.createUser({ id: 'user-a', email: 'ignored@example.test', now: 200 })
  assert.equal(recreated.email, 'a@example.test')
  assert.equal(recreated.created_at, 100)
  assert.equal(recreated.updated_at, 200)

  const withPassword = db.setUserPassword({
    id: 'user-a',
    passwordHash: 'hash-value',
    passwordSalt: 'salt-value',
    now: 300,
  })
  assert.equal(withPassword.password_hash, 'hash-value')
  assert.equal(withPassword.password_salt, 'salt-value')
  assert.equal(withPassword.password_set_at, 300)
  assert.equal(withPassword.updated_at, 300)

  const cleared = db.clearUserPassword({ id: 'user-a', now: 400 })
  assert.equal(cleared.password_hash, null)
  assert.equal(cleared.password_salt, null)
  assert.equal(cleared.password_set_at, null)
  assert.equal(cleared.updated_at, 400)
})

test('tool permission facade preserves default allow, explicit overrides, and user isolation', () => {
  db.createUser({ id: 'permission-a', email: 'permission-a@example.test' })
  db.createUser({ id: 'permission-b', email: 'permission-b@example.test' })

  assert.equal(db.isToolPermittedForUser(null, 'write_file'), true)
  assert.equal(db.isToolPermittedForUser('permission-a', 'write_file'), true)
  assert.deepEqual(db.getUserToolPermissions('permission-a'), {})

  db.setUserToolPermission({
    userId: 'permission-a', toolName: 'write_file', enabled: false, now: 100,
  })
  assert.deepEqual(db.getUserToolPermissions('permission-a'), { write_file: false })
  assert.equal(db.isToolPermittedForUser('permission-a', 'write_file'), false)
  assert.equal(db.isToolPermittedForUser('permission-b', 'write_file'), true)

  db.setUserToolPermission({
    userId: 'permission-a', toolName: 'write_file', enabled: true, now: 200,
  })
  assert.deepEqual(db.getUserToolPermissions('permission-a'), { write_file: true })
  assert.equal(db.isToolPermittedForUser('permission-a', 'write_file'), true)
})

test('auth session facade preserves expiry, renewal, collision, and deletion semantics', () => {
  db.createUser({ id: 'session-a', email: 'session-a@example.test' })
  db.createUser({ id: 'session-b', email: 'session-b@example.test' })

  assert.deepEqual(
    db.createSession({ token: 'auth-token', userId: 'session-a', now: 1_000, ttlMs: 100 }),
    { token: 'auth-token', userId: 'session-a', expiresAt: 1_100 },
  )
  assert.equal(db.getSessionByToken('auth-token', 1_099)?.user_id, 'session-a')
  assert.equal(db.getSessionByToken('auth-token', 1_100), null)

  db.createSession({ token: 'auth-token', userId: 'session-a', now: 1_050, ttlMs: 200 })
  assert.equal(db.getSessionByToken('auth-token', 1_249)?.expires_at, 1_250)
  assert.throws(
    () => db.createSession({ token: 'auth-token', userId: 'session-b', now: 1_100 }),
    /session token already exists/,
  )

  db.deleteSession('auth-token')
  assert.equal(db.getSessionByToken('auth-token', 1_101), null)

  db.createSession({ token: 'expired-token', userId: 'session-a', now: 2_000, ttlMs: 10 })
  db.deleteExpiredSessions(2_011)
  assert.equal(
    db.getDb().prepare('SELECT 1 FROM sessions WHERE token = ?').get('expired-token'),
    undefined,
  )
})

test('login code facade preserves replacement, attempt, expiry, and deletion semantics', () => {
  assert.deepEqual(
    db.createLoginCode({ email: 'code@example.test', code: 'first', now: 1_000, ttlMs: 100 }),
    { email: 'code@example.test', code: 'first', expiresAt: 1_100 },
  )
  assert.equal(db.getLoginCode('code@example.test')?.attempts, 0)
  db.incrementLoginAttempts('code@example.test')
  assert.equal(db.getLoginCode('code@example.test')?.attempts, 1)

  db.createLoginCode({ email: 'code@example.test', code: 'second', now: 2_000, ttlMs: 200 })
  const replaced = db.getLoginCode('code@example.test')
  assert.equal(replaced.code, 'second')
  assert.equal(replaced.attempts, 0)
  assert.equal(replaced.expires_at, 2_200)

  db.deleteExpiredCodes(2_201)
  assert.equal(db.getLoginCode('code@example.test'), null)
  db.createLoginCode({ email: 'delete@example.test', code: 'third' })
  db.deleteLoginCode('delete@example.test')
  assert.equal(db.getLoginCode('delete@example.test'), null)
})

test('rate limit facade preserves counters, reset time, and per-key window isolation', () => {
  const input = { key: 'login:client-a', windowMs: 100, maxRequests: 2 }
  assert.deepEqual(db.checkRateLimit({ ...input, now: 1_000 }), { allowed: true, remaining: 1 })
  assert.deepEqual(db.checkRateLimit({ ...input, now: 1_010 }), { allowed: true, remaining: 0 })
  assert.deepEqual(
    db.checkRateLimit({ ...input, now: 1_020 }),
    { allowed: false, remaining: 0, resetAt: 1_100 },
  )

  assert.deepEqual(
    db.checkRateLimit({ key: 'tool:client-a', windowMs: 10, maxRequests: 3, now: 1_050 }),
    { allowed: true, remaining: 2 },
  )
  assert.ok(db.getDb().prepare('SELECT 1 FROM rate_limits WHERE key = ?').get('login:client-a'))
  assert.deepEqual(db.checkRateLimit({ ...input, now: 1_101 }), { allowed: true, remaining: 1 })

  db.deleteExpiredRates(1_102)
  assert.equal(db.getDb().prepare('SELECT 1 FROM rate_limits WHERE key = ?').get('tool:client-a'), undefined)
})

test('legacy JSON migration facade remains idempotent and creates reusable auth sessions', () => {
  const legacyStore = {
    users: {
      legacy: { id: 'legacy', email: 'legacy@example.test', createdAt: 500 },
    },
    sessions: { 'legacy-token': 'legacy' },
  }

  db.migrateFromJson(legacyStore)
  assert.doesNotThrow(() => db.migrateFromJson(legacyStore))
  assert.equal(db.getUserById('legacy')?.created_at, 500)
  assert.equal(db.getSessionByToken('legacy-token')?.user_id, 'legacy')
})

test('legacy JSON migration rolls back every user and session when a token collides', () => {
  db.createUser({ id: 'existing-owner', email: 'existing-owner@example.test' })
  db.createSession({ token: 'occupied-token', userId: 'existing-owner' })

  assert.throws(
    () => db.migrateFromJson({
      users: {
        imported: { id: 'imported', email: 'imported@example.test', createdAt: 500 },
      },
      sessions: {
        'new-token': 'imported',
        'occupied-token': 'imported',
      },
    }),
    /session token already exists/,
  )

  assert.equal(db.getUserById('imported'), null)
  assert.equal(db.getSessionByToken('new-token'), null)
  assert.equal(db.getSessionByToken('occupied-token')?.user_id, 'existing-owner')
})
