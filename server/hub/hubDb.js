/**
 * server/hub/hubDb.js
 *
 * Hub 进程专属的 DB 层。和主进程共用同一个 SQLite 文件（better-sqlite3 + WAL），
 * 但只允许操作 hub_* 表。schema 版本走独立 meta key `hub_schema_version`，
 * 不影响主进程 DB_SCHEMA_VERSION，参照 reasonix 的做法。
 *
 * 仅 Hub 进程使用；主进程不要 import 这里的任何写函数。
 */

import { randomUUID } from 'node:crypto'

import { getDb } from '../db.js'

export const HUB_SCHEMA_VERSION = 3

const DEFAULT_LEASE_MS = 60_000
const DEFAULT_MAX_ATTEMPTS = 5
const LEGACY_OWNER_ID = `hub-legacy-${process.pid}-${randomUUID()}`

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column)
}

function makeError(code, message) {
  return Object.assign(new Error(message), { code })
}

function assertHubSchemaVersion(value) {
  const version = Number(value)
  if (!Number.isInteger(version) || version < 0) {
    throw makeError(
      'HUB_SCHEMA_VERSION_INVALID',
      `Invalid hub_schema_version: ${String(value)}`
    )
  }
  if (version > HUB_SCHEMA_VERSION) {
    throw makeError(
      'HUB_SCHEMA_VERSION_UNSUPPORTED',
      `Hub schema version ${version} is newer than supported version ${HUB_SCHEMA_VERSION}`
    )
  }
  return version
}

function runImmediate(db, callback) {
  const tx = db.transaction(callback)
  return typeof tx.immediate === 'function' ? tx.immediate() : tx()
}

/**
 * 幂等迁移。多次调用应当无副作用。
 */
export function runHubMigrations(db = getDb()) {
  return runImmediate(db, () => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'hub_schema_version'").get()
    const current = row ? assertHubSchemaVersion(row.value) : 0

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

    if (current < 3) {
      const additions = [
        ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['max_attempts', `INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_ATTEMPTS}`],
        ['available_at', 'INTEGER'],
        ['lease_owner', 'TEXT'],
        ['lease_token', 'TEXT'],
        ['lease_expires_at', 'INTEGER'],
        ['heartbeat_at', 'INTEGER'],
        ['dead_lettered_at', 'INTEGER'],
      ]
      for (const [column, definition] of additions) {
        if (!hasColumn(db, 'hub_jobs', column)) {
          db.exec(`ALTER TABLE hub_jobs ADD COLUMN ${column} ${definition}`)
        }
      }
      db.prepare(`
        UPDATE hub_jobs
        SET available_at = COALESCE(available_at, created_at, updated_at)
        WHERE status = 'pending' AND available_at IS NULL
      `).run()
      db.prepare(`
        UPDATE hub_jobs
        SET attempt_count = 1
        WHERE attempt_count < 1
          AND (status <> 'pending' OR consumed_at IS NOT NULL)
      `).run()
      db.exec(`
        DROP INDEX IF EXISTS idx_hub_jobs_consumable;
        CREATE INDEX IF NOT EXISTS idx_hub_jobs_claimable
        ON hub_jobs(status, available_at, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_hub_jobs_stale_lease
        ON hub_jobs(status, lease_expires_at);
      `)
    }

    if (current < HUB_SCHEMA_VERSION) {
      db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run('hub_schema_version', String(HUB_SCHEMA_VERSION))
    }
    return HUB_SCHEMA_VERSION
  })
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
    attemptCount: row.attempt_count ?? 0,
    maxAttempts: row.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
    availableAt: row.available_at ?? null,
    leaseOwner: row.lease_owner ?? null,
    leaseToken: row.lease_token ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    heartbeatAt: row.heartbeat_at ?? null,
    deadLetteredAt: row.dead_lettered_at ?? null,
  }
}

function genId() {
  return 'hjob_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

function isDb(value) {
  return Boolean(value && typeof value.prepare === 'function' && typeof value.transaction === 'function')
}

function finiteNow(value = Date.now) {
  const now = Number(typeof value === 'function' ? value() : value)
  if (!Number.isFinite(now) || now < 0) throw new TypeError('now must be a non-negative number')
  return Math.trunc(now)
}

function positiveLeaseMs(value = DEFAULT_LEASE_MS) {
  const leaseMs = Number(value)
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new TypeError('leaseMs must be positive')
  return Math.trunc(leaseMs)
}

function requireLeaseIdentity(ownerId, leaseToken) {
  if (typeof ownerId !== 'string' || !ownerId.trim()) {
    throw new TypeError('ownerId must be a non-empty string')
  }
  if (typeof leaseToken !== 'string' || !leaseToken.trim()) {
    throw new TypeError('leaseToken must be a non-empty string')
  }
  return { ownerId: ownerId.trim(), leaseToken: leaseToken.trim() }
}

function leaseLost(id) {
  throw makeError('HUB_JOB_LEASE_LOST', `Hub job lease lost: ${id}`)
}

export function enqueueJob({
  name,
  payload = null,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  availableAt = null,
}, db = getDb()) {
  if (!name || typeof name !== 'string') throw new Error('enqueueJob: name required')
  const normalizedMaxAttempts = Number(maxAttempts)
  if (!Number.isInteger(normalizedMaxAttempts) || normalizedMaxAttempts < 1) {
    throw new TypeError('enqueueJob: maxAttempts must be a positive integer')
  }
  const id = genId()
  const now = Date.now()
  const normalizedAvailableAt = availableAt == null ? now : finiteNow(availableAt)
  db.prepare(
    `INSERT INTO hub_jobs (
       id, name, payload, status, created_at, updated_at, max_attempts, available_at
     ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    id,
    name,
    payload == null ? null : JSON.stringify(payload),
    now,
    now,
    normalizedMaxAttempts,
    normalizedAvailableAt
  )
  return getJob(id, db)
}

export function getJob(id, db = getDb()) {
  return mapJob(db.prepare('SELECT * FROM hub_jobs WHERE id = ?').get(id))
}

/**
 * 原子领取最早到期的 pending job。保留旧的 claimNextPending(db) 调用签名；
 * 所有调用者都必须把返回的 leaseOwner/leaseToken 用作后续写入的 fencing proof。
 */
export function claimNextPending(optionsOrDb = {}, maybeDb) {
  const options = isDb(optionsOrDb) ? {} : (optionsOrDb || {})
  const db = isDb(optionsOrDb) ? optionsOrDb : (maybeDb || getDb())
  const ownerId = typeof options.ownerId === 'string' && options.ownerId.trim()
    ? options.ownerId.trim()
    : LEGACY_OWNER_ID
  const leaseMs = positiveLeaseMs(options.leaseMs)
  const leaseToken = randomUUID()

  const claimed = runImmediate(db, () => {
    const now = finiteNow(options.now)
    const row = db
      .prepare(
        `SELECT id FROM hub_jobs
         WHERE status = 'pending'
           AND dead_lettered_at IS NULL
           AND COALESCE(available_at, created_at) <= ?
           AND attempt_count < max_attempts
         ORDER BY COALESCE(available_at, created_at) ASC, created_at ASC, id ASC
         LIMIT 1`
      )
      .get(now)
    if (!row) return null
    const res = db
      .prepare(
        `UPDATE hub_jobs
         SET status = 'running',
             updated_at = ?,
             last_run_at = ?,
             consumed_at = COALESCE(consumed_at, ?),
             attempt_count = attempt_count + 1,
             available_at = NULL,
             lease_owner = ?,
             lease_token = ?,
             lease_expires_at = ?,
             heartbeat_at = ?
         WHERE id = ?
           AND status = 'pending'
           AND dead_lettered_at IS NULL
           AND COALESCE(available_at, created_at) <= ?
           AND attempt_count < max_attempts`
      )
      .run(
        now,
        now,
        now,
        ownerId,
        leaseToken,
        now + leaseMs,
        now,
        row.id,
        now
      )
    if (res.changes !== 1) return null
    return getJob(row.id, db)
  })

  return claimed
}

function resolveTerminalOptions(rawOptions) {
  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {}
  return {
    ...options,
    ...requireLeaseIdentity(options.ownerId, options.leaseToken),
  }
}

export function renewJobLease(id, options = {}, db = getDb()) {
  const identity = requireLeaseIdentity(options.ownerId, options.leaseToken)
  const leaseMs = positiveLeaseMs(options.leaseMs)
  return runImmediate(db, () => {
    const now = finiteNow(options.now)
    const res = db.prepare(`
      UPDATE hub_jobs
      SET updated_at = ?, heartbeat_at = ?, lease_expires_at = ?
      WHERE id = ?
        AND status = 'running'
        AND lease_owner = ?
        AND lease_token = ?
        AND lease_expires_at > ?
    `).run(
      now,
      now,
      now + leaseMs,
      id,
      identity.ownerId,
      identity.leaseToken,
      now
    )
    if (res.changes !== 1) leaseLost(id)
    return getJob(id, db)
  })
}

export function markDone(id, options = {}, db = getDb()) {
  const normalized = resolveTerminalOptions(options)
  const job = runImmediate(db, () => {
    const now = finiteNow(normalized.now)
    const res = db.prepare(`
      UPDATE hub_jobs
      SET status = 'done',
          updated_at = ?,
          last_error = ?,
          available_at = NULL,
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          dead_lettered_at = NULL
      WHERE id = ?
        AND status = 'running'
        AND lease_owner = ?
        AND lease_token = ?
        AND lease_expires_at > ?
    `).run(
      now,
      normalized.lastError ?? null,
      id,
      normalized.ownerId,
      normalized.leaseToken,
      now
    )
    if (res.changes !== 1) leaseLost(id)
    return getJob(id, db)
  })
  return job
}

export function recordJobFailure(id, options = {}, db = getDb()) {
  const normalized = resolveTerminalOptions(options)
  const retryable = options.retryable !== false
  const rawBackoffMs = options.backoffMs ?? 0
  const backoffMs = Number(rawBackoffMs)
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new TypeError('backoffMs must be a non-negative number')
  }
  const lastError = String(options.errorMessage ?? options.lastError ?? 'unknown error')
  const retryFlag = retryable ? 1 : 0
  const job = runImmediate(db, () => {
    const now = finiteNow(normalized.now)
    const retryAt = now + Math.trunc(backoffMs)
    const res = db.prepare(`
      UPDATE hub_jobs
      SET status = CASE
            WHEN ? = 1 AND attempt_count < max_attempts THEN 'pending'
            ELSE 'failed'
          END,
          updated_at = ?,
          last_error = ?,
          available_at = CASE
            WHEN ? = 1 AND attempt_count < max_attempts THEN ?
            ELSE NULL
          END,
          dead_lettered_at = CASE
            WHEN ? = 1 AND attempt_count >= max_attempts THEN ?
            ELSE NULL
          END,
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL
      WHERE id = ?
        AND status = 'running'
        AND lease_owner = ?
        AND lease_token = ?
        AND lease_expires_at > ?
    `).run(
      retryFlag,
      now,
      lastError,
      retryFlag,
      retryAt,
      retryFlag,
      now,
      id,
      normalized.ownerId,
      normalized.leaseToken,
      now
    )
    if (res.changes !== 1) leaseLost(id)
    return getJob(id, db)
  })
  return job
}

export function markFailed(id, errorOrOptions, db = getDb()) {
  const options = errorOrOptions && typeof errorOrOptions === 'object'
    ? { ...errorOrOptions, retryable: false }
    : { errorMessage: errorOrOptions, retryable: false }
  return recordJobFailure(id, options, db)
}

/**
 * 将过期（以及 v2 遗留的无租约）running job 恢复为 pending；已经耗尽尝试
 * 次数的 job 进入 dead letter 终态。所有恢复路径都会清理旧 lease proof。
 */
export function recoverStaleJobs(optionsOrDb = {}, maybeDb) {
  const options = isDb(optionsOrDb) ? {} : (optionsOrDb || {})
  const db = isDb(optionsOrDb) ? optionsOrDb : (maybeDb || getDb())

  return runImmediate(db, () => {
    const now = finiteNow(options.now)
    const deadLettered = db.prepare(`
      UPDATE hub_jobs
      SET status = 'failed',
          updated_at = ?,
          available_at = NULL,
          dead_lettered_at = ?,
          last_error = COALESCE(last_error, 'Hub job lease expired after maximum attempts'),
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL
      WHERE status = 'running'
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        AND attempt_count >= max_attempts
    `).run(now, now, now).changes

    const requeued = db.prepare(`
      UPDATE hub_jobs
      SET status = 'pending',
          updated_at = ?,
          available_at = ?,
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL
      WHERE status = 'running'
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        AND attempt_count < max_attempts
    `).run(now, now, now).changes

    return {
      recovered: requeued + deadLettered,
      requeued,
      deadLettered,
    }
  })
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
