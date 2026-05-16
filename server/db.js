import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'server-data')

function getDataDir() {
  return process.env.APP_DATA_DIR || DEFAULT_DATA_DIR
}

function getDbPath() {
  return process.env.APP_DB_PATH || path.join(getDataDir(), 'app.db')
}

let _db = null

function ensureDataDir() {
  const dir = getDataDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export function getDb() {
  if (_db) return _db
  ensureDataDir()
  _db = new Database(getDbPath())
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  // ★ #37: 写入并发时遇到 SQLITE_BUSY 自动等待最多 5s 而不是立刻报错
  _db.pragma('busy_timeout = 5000')
  // synchronous=NORMAL 配合 WAL 是耐久性/性能折中,符合本应用 (本地工作台) 场景
  _db.pragma('synchronous = NORMAL')
  initSchema(_db)
  runMigrations(_db)
  return _db
}

function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all()
  return rows.some((row) => row.name === column)
}

function getSchemaVersionInternal(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  return row ? Number(row.value) : 0
}

function setSchemaVersionInternal(db, version) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('schema_version', String(version))
}

function runMigrations(db) {
  const version = getSchemaVersionInternal(db)
  if (version < 2) migrateToV2(db)
}

/**
 * Migration v2:为 jobs / job_artifacts / skills 引入 user_id 归属列。
 * v1 阶段后台作业 / 技能未做用户隔离,理论上所有历史数据都属于「无归属」,
 * 而 v2 之后所有写入都强制带 user_id。为避免历史孤儿数据被错误访问,
 * 一次性清空这几张表(本项目尚未公开,清理代价可控),然后加列。
 */
function migrateToV2(db) {
  if (!hasColumn(db, 'jobs', 'user_id')) {
    db.exec('DELETE FROM job_artifacts; DELETE FROM job_events; DELETE FROM job_steps; DELETE FROM jobs;')
    db.exec('ALTER TABLE jobs ADD COLUMN user_id TEXT')
  }
  if (!hasColumn(db, 'job_artifacts', 'user_id')) {
    db.exec('ALTER TABLE job_artifacts ADD COLUMN user_id TEXT')
  }
  if (!hasColumn(db, 'skills', 'user_id')) {
    db.exec('DELETE FROM skill_assets; DELETE FROM skills;')
    db.exec('ALTER TABLE skills ADD COLUMN user_id TEXT')
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_job_artifacts_user ON job_artifacts(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id, created_at);
  `)
  setSchemaVersionInternal(db, 2)
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      credits INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS login_codes (
      email TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      package_id TEXT,
      model_name TEXT,
      credits INTEGER NOT NULL,
      balance INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at);

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);

    CREATE TABLE IF NOT EXISTS job_steps (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      parent_step_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      input_json TEXT,
      output_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_job_steps_job_sort ON job_steps(job_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_job_steps_status ON job_steps(status);

    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      step_id TEXT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_events_job_created ON job_events(job_id, created_at, id);

    CREATE TABLE IF NOT EXISTS job_artifacts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      user_id TEXT,
      step_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      filename TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_artifacts_job_created ON job_artifacts(job_id, created_at);

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      version TEXT NOT NULL,
      icon TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skill_assets (
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (skill_id, path)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 迁移：如果 meta 表没有 schema_version，插入初始值（runMigrations 会推到当前版本）
    INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
  `)
}

// G6 health: 健康探针只看「能否打开 db + 拿到 schema_version」, 不做写入,
// 用于 /api/health 给运维一眼判断 db 子系统状态.
export function getDbStatus() {
  try {
    const db = getDb()
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    return {
      ok: true,
      schemaVersion: row?.value || null,
      path: getDbPath(),
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

export function createUser({ id, email, credits = 0, now = Date.now() }) {
  const db = getDb()
  const stmt = db.prepare(
    'INSERT INTO users (id, email, credits, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, credits = excluded.credits'
  )
  stmt.run(id, email, credits, now, now)
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

export function updateUserCredits({ id, credits, now = Date.now() }) {
  const db = getDb()
  const stmt = db.prepare('UPDATE users SET credits = ?, updated_at = ? WHERE id = ?')
  stmt.run(credits, now, id)
  return getUserById(id)
}

/* ── Sessions (auth tokens) ── */

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export function createSession({ token, userId, now = Date.now(), ttlMs = TOKEN_TTL_MS }) {
  const db = getDb()
  // 清理过期 session
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
  const stmt = db.prepare(
    'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(token) DO UPDATE SET expires_at = excluded.expires_at'
  )
  stmt.run(token, userId, now + ttlMs, now)
  return { token, userId, expiresAt: now + ttlMs }
}

export function getSessionByToken(token, now = Date.now()) {
  const db = getDb()
  const stmt = db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?')
  return stmt.get(token, now) || null
}

export function deleteSession(token) {
  const db = getDb()
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

export function deleteExpiredSessions(now = Date.now()) {
  const db = getDb()
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
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

/* ── Ledger ── */

export function addLedgerEntry({ id, userId, type, packageId, modelName, credits, balance, now = Date.now(), ignoreDuplicate = false }) {
  const db = getDb()
  const stmt = db.prepare(
    `${ignoreDuplicate ? 'INSERT OR IGNORE' : 'INSERT'} INTO ledger (id, user_id, type, package_id, model_name, credits, balance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  stmt.run(id, userId, type, packageId || null, modelName || null, credits, balance, now)
  return getLedgerForUser(userId)
}

export function getLedgerForUser(userId, limit = 50) {
  const db = getDb()
  const stmt = db.prepare(
    'SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  )
  return stmt.all(userId, limit)
}

/* ── Rate Limits ── */

export function checkRateLimit({ key, windowMs, maxRequests, now = Date.now() }) {
  const db = getDb()
  // 清理旧窗口
  db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(now - windowMs)

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
  db.transaction(() => {
    for (const user of Object.values(store.users || {})) {
      createUser({ id: user.id, email: user.email, credits: user.credits || 0, now: user.createdAt || now })
    }
    for (const [token, userId] of Object.entries(store.sessions || {})) {
      createSession({ token, userId, now, ttlMs: TOKEN_TTL_MS })
    }
    for (const entry of store.ledger || []) {
      addLedgerEntry({
        id: entry.id,
        userId: entry.userId,
        type: entry.type,
        packageId: entry.packageId,
        modelName: entry.modelName,
        credits: entry.credits,
        balance: entry.balance,
        now: entry.createdAt || now,
        ignoreDuplicate: true,
      })
    }
  })()
}
