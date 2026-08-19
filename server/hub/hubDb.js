/**
 * server/hub/hubDb.js
 *
 * Hub 进程专属的 DB 层。和主进程共用同一个 SQLite 文件（better-sqlite3 + WAL），
 * 但只允许操作 hub_* 表。schema 版本走独立 meta key `hub_schema_version`，
 * 不影响主进程 DB_SCHEMA_VERSION，参照 reasonix 的做法。
 *
 * 仅 Hub 进程使用；主进程不要 import 这里的任何写函数。
 */

import { getDb } from '../db.js'

export const HUB_SCHEMA_VERSION = 2

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column)
}

/**
 * 幂等迁移。多次调用应当无副作用。
 */
export function runHubMigrations(db = getDb()) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'hub_schema_version'").get()
  const current = row ? Number(row.value) : 0

  if (current < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hub_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_run_at INTEGER,
        consumed_at INTEGER,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hub_jobs_status ON hub_jobs(status, created_at);
    `)
  }

  if (current < 2) {
    if (!hasColumn(db, 'hub_jobs', 'consumed_at')) {
      db.exec('ALTER TABLE hub_jobs ADD COLUMN consumed_at INTEGER')
    }
    db.prepare(`
      UPDATE hub_jobs
      SET consumed_at = COALESCE(last_run_at, updated_at)
      WHERE status <> 'pending' AND consumed_at IS NULL
    `).run()
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_hub_jobs_consumable
      ON hub_jobs(status, consumed_at, created_at);
    `)
  }

  if (current < HUB_SCHEMA_VERSION) {
    db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run('hub_schema_version', String(HUB_SCHEMA_VERSION))
  }
  return HUB_SCHEMA_VERSION
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function mapJob(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    payload: parseJson(row.payload),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    consumedAt: row.consumed_at ?? null,
    lastError: row.last_error,
  }
}

function genId() {
  return 'hjob_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

export function enqueueJob({ name, payload = null }, db = getDb()) {
  if (!name || typeof name !== 'string') throw new Error('enqueueJob: name required')
  const id = genId()
  const now = Date.now()
  db.prepare(
    `INSERT INTO hub_jobs (id, name, payload, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`
  ).run(id, name, payload == null ? null : JSON.stringify(payload), now, now)
  return getJob(id, db)
}

export function getJob(id, db = getDb()) {
  return mapJob(db.prepare('SELECT * FROM hub_jobs WHERE id = ?').get(id))
}

/**
 * 原子地把最早的一条 pending 改成 running，返回该行。如果没有则返回 null。
 * 用一个事务保证并发 tick 不会拉到同一条。
 */
export function claimNextPending(db = getDb()) {
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT id FROM hub_jobs
         WHERE status = 'pending' AND consumed_at IS NULL
         ORDER BY created_at ASC, id ASC LIMIT 1`
      )
      .get()
    if (!row) return null
    const now = Date.now()
    const res = db
      .prepare(
        `UPDATE hub_jobs
         SET status = 'running', updated_at = ?, last_run_at = ?, consumed_at = ?
         WHERE id = ? AND status = 'pending' AND consumed_at IS NULL`
      )
      .run(now, now, now, row.id)
    if (res.changes !== 1) return null
    return getJob(row.id, db)
  })
  return tx()
}

export function markDone(id, { lastError = null } = {}, db = getDb()) {
  const now = Date.now()
  db.prepare(
    `UPDATE hub_jobs SET status = 'done', updated_at = ?, last_error = ?
     WHERE id = ? AND status = 'running' AND consumed_at IS NOT NULL`
  ).run(now, lastError, id)
  return getJob(id, db)
}

export function markFailed(id, errorMessage, db = getDb()) {
  const now = Date.now()
  db.prepare(
    `UPDATE hub_jobs SET status = 'failed', updated_at = ?, last_error = ?
     WHERE id = ? AND status = 'running' AND consumed_at IS NOT NULL`
  ).run(now, String(errorMessage || 'unknown error'), id)
  return getJob(id, db)
}

export function listJobs({ status = null, limit = 50 } = {}, db = getDb()) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50))
  const rows = status
    ? db
        .prepare(`SELECT * FROM hub_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
        .all(status, lim)
    : db.prepare(`SELECT * FROM hub_jobs ORDER BY created_at DESC LIMIT ?`).all(lim)
  return rows.map(mapJob)
}
