import Database from './adapters/sqliteDriver.js'
import fs from 'node:fs'
import path from 'node:path'
import {
  LATEST_SCHEMA_VERSION,
  runSchemaMigrations,
} from './migrations/index.js'
import { assertCurrentSchemaContract, preflightExistingSchemaVersion } from './dbSchemaPreflight.js'
import { validateRuntimeStoragePath } from './utils/runtimeStoragePath.js'

export const DB_SCHEMA_VERSION = LATEST_SCHEMA_VERSION
const DEFAULT_DATA_DIR = path.join(process.cwd(), 'server-data')

function getDataDir() {
  return validateRuntimeStoragePath(process.env.APP_DATA_DIR, { key: 'APP_DATA_DIR' }) || DEFAULT_DATA_DIR
}

function getDbPath() {
  return validateRuntimeStoragePath(process.env.APP_DB_PATH, { key: 'APP_DB_PATH' })
    || path.join(getDataDir(), 'app.db')
}

let _db = null

function ensureDataDir() {
  const directories = new Set([
    getDataDir(),
    path.dirname(getDbPath()),
  ])
  for (const dir of directories) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }
}

export function getDb() {
  if (_db) return _db
  ensureDataDir()
  const db = new Database(getDbPath())
  try {
    // Inspect an existing database before any schema, repair, or migration
    // write. A database without a meta table is an uninitialized database.
    preflightExistingSchemaVersion(db, DB_SCHEMA_VERSION)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    // Provider tokens, OAuth material and other encrypted credential envelopes
    // must not remain in SQLite freelist cells after their owning rows are
    // deleted. `secure_delete` overwrites deleted cell content before the page is
    // released; callers that delete credentials additionally checkpoint the WAL.
    db.pragma('secure_delete = ON')
    // ★ #37: 写入并发时遇到 SQLITE_BUSY 自动等待最多 5s 而不是立刻报错
    db.pragma('busy_timeout = 5000')
    // synchronous=NORMAL 配合 WAL 是耐久性/性能折中,符合本应用 (本地工作台) 场景
    db.pragma('synchronous = NORMAL')
    runMigrations(db)
    assertCurrentSchemaContract(db, DB_SCHEMA_VERSION)
    _db = db
    return _db
  } catch (error) {
    try { db.close() } catch { /* Preserve the startup error. */ }
    throw error
  }
}

function runMigrations(db) {
  runSchemaMigrations(db)
}

// G6 health: 健康探针只看「能否打开 db + 拿到 schema_version」, 不做写入,
// 用于 /api/health 给运维一眼判断 db 子系统状态.
export function getDbStatus() {
  try {
    const db = getDb()
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((table) => table.name)
    return {
      ok: true,
      schemaVersion: row?.value || null,
      path: getDbPath(),
      tables,
    }
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      path: getDbPath(),
    }
  }
}

export function closeDb() {
  if (_db) {
    _db.close()
    _db = null
  }
}

/* ── Users ── */

export function createUser({ id, email, now = Date.now() }) {
  const db = getDb()
  const stmt = db.prepare(
    'INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at'
  )
  stmt.run(id, email, now, now)
  return getUserById(id)
}

export function getUserById(id) {
  const db = getDb()
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?')
  return stmt.get(id) || null
}

export function getUserByEmail(email) {
  const db = getDb()
  const stmt = db.prepare('SELECT * FROM users WHERE email = ?')
  return stmt.get(email) || null
}

export function setUserPassword({ id, passwordHash, passwordSalt, now = Date.now() }) {
  const db = getDb()
  const stmt = db.prepare(
    'UPDATE users SET password_hash = ?, password_salt = ?, password_set_at = ?, updated_at = ? WHERE id = ?'
  )
  stmt.run(passwordHash, passwordSalt, now, now, id)
  return getUserById(id)
}

export function clearUserPassword({ id, now = Date.now() }) {
  const db = getDb()
  db.prepare(
    'UPDATE users SET password_hash = NULL, password_salt = NULL, password_set_at = NULL, updated_at = ? WHERE id = ?'
  ).run(now, id)
  return getUserById(id)
}

/* ── User Tool Permissions (per-user 工具 gate) ── */

/**
 * 设置某用户对某工具的权限。enabled=false 表示显式禁用(默认放行,只存覆盖)。
 */
export function setUserToolPermission({ userId, toolName, enabled, now = Date.now() }) {
  const db = getDb()
  db.prepare(
    `INSERT INTO user_tool_permissions (user_id, tool_name, enabled, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, tool_name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  ).run(userId, toolName, enabled ? 1 : 0, now)
}

/**
 * 返回该用户的显式权限覆盖 map: { toolName: boolean }。只含显式设过的工具。
 */
export function getUserToolPermissions(userId) {
  const db = getDb()
  const rows = db
    .prepare('SELECT tool_name, enabled FROM user_tool_permissions WHERE user_id = ?')
    .all(userId)
  const map = {}
  for (const row of rows) map[row.tool_name] = !!row.enabled
  return map
}

/**
 * 工具是否对该用户放行。默认放行(无显式覆盖即 true);只有显式 enabled=0 才拒绝。
 */
export function isToolPermittedForUser(userId, toolName) {
  if (!userId) return true // 无用户上下文(系统/匿名内部调用)不 gate
  const db = getDb()
  const row = db
    .prepare('SELECT enabled FROM user_tool_permissions WHERE user_id = ? AND tool_name = ?')
    .get(userId, toolName)
  if (!row) return true
  return !!row.enabled
}

/* ── Sessions (auth tokens) ── */

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export function createSession({ token, userId, now = Date.now(), ttlMs = TOKEN_TTL_MS }) {
  const db = getDb()
  // 清理过期 session
  db.prepare('DELETE FROM sessions WHERE id IS NULL AND title IS NULL AND expires_at < ?').run(now)
  const stmt = db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET expires_at = excluded.expires_at
     WHERE sessions.id IS NULL AND sessions.title IS NULL AND sessions.user_id = excluded.user_id`
  )
  const result = stmt.run(token, userId, now + ttlMs, now)
  if (result.changes !== 1) throw new Error('session token already exists')
  return { token, userId, expiresAt: now + ttlMs }
}

export function getSessionByToken(token, now = Date.now()) {
  const db = getDb()
  const stmt = db.prepare(`
    SELECT * FROM sessions
    WHERE token = ? AND id IS NULL AND title IS NULL AND expires_at > ?
  `)
  return stmt.get(token, now) || null
}

export function deleteSession(token) {
  const db = getDb()
  db.prepare('DELETE FROM sessions WHERE token = ? AND id IS NULL AND title IS NULL').run(token)
}

export function deleteExpiredSessions(now = Date.now()) {
  const db = getDb()
  db.prepare('DELETE FROM sessions WHERE id IS NULL AND title IS NULL AND expires_at < ?').run(now)
}

/* ── Login Codes ── */

export function createLoginCode({ email, code, now = Date.now(), ttlMs = 10 * 60 * 1000 }) {
  const db = getDb()
  const stmt = db.prepare(
    'INSERT INTO login_codes (email, code, attempts, expires_at, created_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT(email) DO UPDATE SET code = excluded.code, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at'
  )
  stmt.run(email, code, now + ttlMs, now)
  return { email, code, expiresAt: now + ttlMs }
}

export function getLoginCode(email) {
  const db = getDb()
  const stmt = db.prepare('SELECT * FROM login_codes WHERE email = ?')
  return stmt.get(email) || null
}

export function incrementLoginAttempts(email) {
  const db = getDb()
  const stmt = db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?')
  stmt.run(email)
}

export function deleteLoginCode(email) {
  const db = getDb()
  db.prepare('DELETE FROM login_codes WHERE email = ?').run(email)
}

export function deleteExpiredCodes(now = Date.now()) {
  const db = getDb()
  db.prepare('DELETE FROM login_codes WHERE expires_at < ?').run(now)
}

/* ── Rate Limits ── */

export function checkRateLimit({ key, windowMs, maxRequests, now = Date.now() }) {
  const db = getDb()
  return db.transaction(() => {
    // 只清理当前 key 的旧窗口；不同限流器可能窗口长度不同，不能互相删记录。
    db.prepare('DELETE FROM rate_limits WHERE key = ? AND window_start < ?').run(key, now - windowMs)

    const row = db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key)
    if (!row) {
      db.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)').run(key, now)
      return { allowed: true, remaining: maxRequests - 1 }
    }

    if (row.count >= maxRequests) {
      return { allowed: false, remaining: 0, resetAt: row.window_start + windowMs }
    }

    db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key)
    return { allowed: true, remaining: maxRequests - row.count - 1 }
  })()
}

/* ── Migration ── */

export function getSchemaVersion() {
  const db = getDb()
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  return row ? Number(row.value) : 0
}

export function setSchemaVersion(version) {
  const db = getDb()
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('schema_version', String(version))
}

export function deleteExpiredRates(now = Date.now()) {
  const db = getDb()
  db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(now)
}

/* ── 旧 JSON 数据迁移 ── */

export function migrateFromJson(store) {
  const db = getDb()
  const now = Date.now()
  const insertUser = db.prepare(
    'INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at'
  )
  db.transaction(() => {
    for (const user of Object.values(store.users || {})) {
      const createdAt = user.createdAt || now
      insertUser.run(user.id, user.email, createdAt, createdAt)
    }
    for (const [token, userId] of Object.entries(store.sessions || {})) {
      createSession({ token, userId, now, ttlMs: TOKEN_TTL_MS })
    }
  })()
}
