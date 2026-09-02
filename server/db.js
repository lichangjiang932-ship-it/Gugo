import Database from './adapters/sqliteDriver.js'
import fs from 'node:fs'
import path from 'node:path'
import {
  LATEST_SCHEMA_VERSION,
  runSchemaMigrations,
} from './migrations/index.js'
import { assertCurrentSchemaContract, preflightExistingSchemaVersion } from './dbSchemaPreflight.js'
import { createAuthSessionStore } from './services/authSessionStore.js'
import { createLegacyJsonMigrationStore } from './services/legacyJsonMigrationStore.js'
import { createLoginCodeStore } from './services/loginCodeStore.js'
import { createRateLimitStore } from './services/rateLimitStore.js'
import { createUserAccountStore } from './services/userAccountStore.js'
import { createUserToolPermissionStore } from './services/userToolPermissionStore.js'
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

// Compatibility facade: focused stores receive this module's connection provider,
// so callers keep the historic db.js surface without store -> db.js cycles.
const userAccounts = createUserAccountStore(getDb)
const userToolPermissions = createUserToolPermissionStore(getDb)
const authSessions = createAuthSessionStore(getDb)
const loginCodes = createLoginCodeStore(getDb)
const rateLimits = createRateLimitStore(getDb)

export const clearUserPassword = userAccounts.clearUserPassword
export const createUser = userAccounts.createUser
export const getUserByEmail = userAccounts.getUserByEmail
export const getUserById = userAccounts.getUserById
export const setUserPassword = userAccounts.setUserPassword

export const getUserToolPermissions = userToolPermissions.getUserToolPermissions
export const isToolPermittedForUser = userToolPermissions.isToolPermittedForUser
export const setUserToolPermission = userToolPermissions.setUserToolPermission

export const createSession = authSessions.createSession
export const deleteExpiredSessions = authSessions.deleteExpiredSessions
export const deleteSession = authSessions.deleteSession
export const getSessionByToken = authSessions.getSessionByToken

export const createLoginCode = loginCodes.createLoginCode
export const deleteExpiredCodes = loginCodes.deleteExpiredCodes
export const deleteLoginCode = loginCodes.deleteLoginCode
export const getLoginCode = loginCodes.getLoginCode
export const incrementLoginAttempts = loginCodes.incrementLoginAttempts

export const checkRateLimit = rateLimits.checkRateLimit
export const deleteExpiredRates = rateLimits.deleteExpiredRates

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

const legacyJsonMigration = createLegacyJsonMigrationStore(getDb)
export const migrateFromJson = legacyJsonMigration.migrateFromJson
