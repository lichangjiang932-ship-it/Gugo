import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  listManagedAttachmentUploadBlockers,
  reapDeadManagedAttachmentUploadLeases,
} from './managedAttachmentUploadLease.js'
import { createUserDataGovernanceError as governanceError } from './userDataGovernanceError.js'
import {
  foreignKeyGroups,
  primaryKeyColumns,
  quoteIdentifier,
} from './userDataRecordGraph.js'

export const CLEAR_OPERATION_STAGING = 'staging'
export const CLEAR_OPERATION_COMMITTED = 'database_committed'
export const CLEAR_OPERATION_LEASE_OWNER = crypto.randomUUID()
export const CLEAR_OPERATION_LEASE_MS = 60 * 60 * 1000

const CLEAR_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NON_TERMINAL_JOB_STATUSES = Object.freeze([
  'queued',
  'planning',
  'running',
  'waiting',
  'awaiting_approval',
  'cancel_requested',
])

export function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function attachmentRoot(env) {
  return path.join(path.resolve(String(env.APP_DATA_DIR || path.join(process.cwd(), 'server-data'))), 'attachments')
}

function artifactRoot(env) {
  return path.resolve(
    env.ARTIFACT_DIR && path.isAbsolute(String(env.ARTIFACT_DIR))
      ? String(env.ARTIFACT_DIR)
      : path.resolve(process.cwd(), String(env.ARTIFACT_DIR || '.artifacts')),
  )
}

export function clearStorageToken(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32)
}

export function clearOperationPaths({ userId, operationId, env }) {
  if (!CLEAR_OPERATION_ID_PATTERN.test(String(operationId || ''))) {
    throw governanceError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A user-data clear recovery record is invalid',
      500,
      null,
      { incomplete: true },
    )
  }
  const token = clearStorageToken(userId)
  const stageName = `.${token}.${operationId}.user-data-staging`
  const data = path.resolve(String(env.APP_DATA_DIR || path.join(process.cwd(), 'server-data')))
  const attachments = attachmentRoot(env)
  const artifacts = artifactRoot(env)
  return {
    dataRoot: data,
    dataStagePath: path.join(data, stageName),
    attachmentActivePath: path.join(attachments, token),
    attachmentRoot: attachments,
    attachmentStagePath: path.join(attachments, stageName),
    artifactRoot: artifacts,
    artifactStagePath: path.join(artifacts, stageName),
  }
}

export function fileSystemMethod(fileSystem, name) {
  const method = fileSystem?.[name] || fs[name]
  if (typeof method !== 'function') {
    throw governanceError(
      'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
      `Filesystem operation ${name} is unavailable`,
      500,
      null,
      { incomplete: true },
    )
  }
  return method.bind(fileSystem?.[name] ? fileSystem : fs)
}

export function pathExists(fileSystem, target) {
  return fileSystemMethod(fileSystem, 'existsSync')(target)
}

export function removeTree(fileSystem, target) {
  if (!pathExists(fileSystem, target)) return true
  fileSystemMethod(fileSystem, 'rmSync')(target, { recursive: true, force: true })
  return true
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function tableExists(db, name) {
  return !!db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name)
}

export function userRuntimeBlockers(db, userId, now = Date.now()) {
  const blockers = []
  if (tableExists(db, 'turn_execution_leases')) {
    const row = db.prepare(`
      SELECT session_id, turn_id FROM turn_execution_leases
      WHERE user_id = ? AND expires_at > ?
      ORDER BY expires_at DESC LIMIT 1
    `).get(userId, now)
    if (row) blockers.push({ kind: 'turn', sessionId: row.session_id, turnId: row.turn_id })
  }
  if (tableExists(db, 'jobs')) {
    const placeholders = NON_TERMINAL_JOB_STATUSES.map(() => '?').join(', ')
    const row = db.prepare(`
      SELECT id, status FROM jobs
      WHERE user_id = ? AND status IN (${placeholders})
      ORDER BY updated_at DESC LIMIT 1
    `).get(userId, ...NON_TERMINAL_JOB_STATUSES)
    if (row) blockers.push({ kind: 'job', jobId: row.id, status: row.status })
  }
  if (tableExists(db, 'job_execution_leases') && tableExists(db, 'jobs')) {
    const row = db.prepare(`
      SELECT jobs.id FROM job_execution_leases AS lease
      JOIN jobs ON jobs.id = lease.job_id
      WHERE jobs.user_id = ? AND lease.expires_at > ?
      ORDER BY lease.expires_at DESC LIMIT 1
    `).get(userId, now)
    if (row && !blockers.some((entry) => entry.kind === 'job' && entry.jobId === row.id)) {
      blockers.push({ kind: 'job_lease', jobId: row.id })
    }
  }
  if (tableExists(db, 'background_processes')) {
    const row = db.prepare(`
      SELECT id FROM background_processes
      WHERE user_id = ? AND status = 'running'
      ORDER BY updated_at DESC LIMIT 1
    `).get(userId)
    if (row) blockers.push({ kind: 'background_process', processId: row.id })
  }
  if (tableExists(db, 'session_content_outbox')) {
    const row = db.prepare(`
      SELECT session_id FROM session_content_outbox
      WHERE user_id = ? AND status = 'leased' AND lease_expires_at > ?
      ORDER BY lease_expires_at DESC LIMIT 1
    `).get(userId, now)
    if (row) blockers.push({ kind: 'session_content_materializer', sessionId: row.session_id })
  }
  blockers.push(...listManagedAttachmentUploadBlockers({ db, userId, now }))
  return blockers
}

export function assertUserRuntimeIdle(db, userId, now = Date.now()) {
  const blockers = userRuntimeBlockers(db, userId, now)
  if (!blockers.length) return
  throw governanceError(
    'USER_DATA_CLEAR_RUNTIME_ACTIVE',
    'Stop active turns, jobs, background processes, attachment uploads, and session materialization before clearing local data',
    409,
    null,
    { incomplete: false, databaseCleared: false, cleanupPending: false, blockers },
  )
}

export function checkpointUserDataWal(db) {
  let state
  try {
    state = db.pragma('wal_checkpoint(TRUNCATE)')?.[0] || {}
  } catch (cause) {
    throw governanceError(
      'USER_DATA_CLEAR_WAL_INCOMPLETE',
      'User data was cleared, but the SQLite WAL could not be truncated',
      500,
      cause,
      { incomplete: true, databaseCleared: true, cleanupPending: true },
    )
  }
  const checkpoint = {
    busy: Number(state.busy) || 0,
    log: Number(state.log) || 0,
    checkpointed: Number(state.checkpointed) || 0,
  }
  if (checkpoint.busy > 0) {
    throw governanceError(
      'USER_DATA_CLEAR_WAL_INCOMPLETE',
      'User data was cleared, but the SQLite WAL is still busy',
      503,
      null,
      { incomplete: true, databaseCleared: true, cleanupPending: true, walCheckpoint: checkpoint },
    )
  }
  return checkpoint
}

export function insertClearOperation(db, {
  operationId,
  userId,
  compactionPortId,
  compactionGovernanceVersion,
  compactionDigest,
  now = Date.now(),
}) {
  try {
    db.transaction(() => {
      reapDeadManagedAttachmentUploadLeases({ db, userId, now })
      assertUserRuntimeIdle(db, userId, now)
      const inserted = db.prepare(`
        INSERT INTO user_data_clear_operations
          (operation_id, owner_id, lease_owner, lease_pid, lease_expires_at,
           status, operation_kind, session_id, compaction_port_id,
           compaction_governance_version, compaction_digest,
           compaction_stage_token, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, 'user_clear', NULL, ?, ?, ?, NULL, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM user_data_clear_operations)
      `).run(
        operationId,
        userId,
        CLEAR_OPERATION_LEASE_OWNER,
        process.pid,
        now + CLEAR_OPERATION_LEASE_MS,
        CLEAR_OPERATION_STAGING,
        compactionPortId,
        compactionGovernanceVersion,
        compactionDigest,
        now,
        now,
      )
      if (inserted.changes !== 1) {
        throw governanceError(
          'USER_DATA_CLEAR_IN_PROGRESS',
          'Another recoverable data clear is already in progress',
          409,
        )
      }
    }).immediate()
  } catch (cause) {
    if (cause?.code === 'USER_DATA_CLEAR_IN_PROGRESS') throw cause
    if (String(cause?.code || '').startsWith('SQLITE_CONSTRAINT')) {
      throw governanceError(
        'USER_DATA_CLEAR_IN_PROGRESS',
        'A recoverable data clear is already in progress',
        409,
        cause,
      )
    }
    throw cause
  }
}

export function persistCompactionStageReceipt(db, {
  operationId,
  userId,
  compactionPortId,
  compactionGovernanceVersion,
  compactionDigest,
  stageToken,
  now = Date.now(),
}) {
  const updated = db.prepare(`
    UPDATE user_data_clear_operations
    SET compaction_stage_token = ?, updated_at = ?
    WHERE operation_id = ? AND owner_id = ? AND status = ?
      AND operation_kind = 'user_clear' AND session_id IS NULL
      AND lease_owner = ? AND lease_pid = ?
      AND compaction_port_id = ?
      AND compaction_governance_version = ?
      AND compaction_digest = ?
      AND compaction_stage_token IS NULL
  `).run(
    stageToken,
    now,
    operationId,
    userId,
    CLEAR_OPERATION_STAGING,
    CLEAR_OPERATION_LEASE_OWNER,
    process.pid,
    compactionPortId,
    compactionGovernanceVersion,
    compactionDigest,
  )
  if (updated.changes !== 1) {
    throw governanceError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'The compaction archive deletion receipt could not be persisted',
      500,
      null,
      { incomplete: true, databaseCleared: false, cleanupPending: true },
    )
  }
}

export function renewClearOperationLease(db, {
  operationId,
  userId,
  status,
  now = Date.now(),
}) {
  const renewed = db.prepare(`
    UPDATE user_data_clear_operations
    SET lease_pid = ?, lease_expires_at = ?, updated_at = ?
    WHERE operation_id = ? AND owner_id = ? AND status = ? AND lease_owner = ?
  `).run(
    process.pid,
    now + CLEAR_OPERATION_LEASE_MS,
    now,
    operationId,
    userId,
    status,
    CLEAR_OPERATION_LEASE_OWNER,
  )
  if (renewed.changes !== 1) {
    throw governanceError(
      'USER_DATA_CLEAR_LEASE_LOST',
      'The user-data clear lease changed while the operation was running',
      409,
      null,
      {
        incomplete: true,
        databaseCleared: status === CLEAR_OPERATION_COMMITTED,
        cleanupPending: true,
      },
    )
  }
  return now + CLEAR_OPERATION_LEASE_MS
}

export function deleteClearOperation(db, {
  operationId,
  userId,
  status,
  required = true,
}) {
  const deleted = db.prepare(`
    DELETE FROM user_data_clear_operations
    WHERE operation_id = ? AND owner_id = ? AND status = ?
      AND lease_owner = ? AND lease_pid = ?
  `).run(
    operationId,
    userId,
    status,
    CLEAR_OPERATION_LEASE_OWNER,
    process.pid,
  )
  if (required && deleted.changes !== 1) {
    throw governanceError(
      'USER_DATA_CLEAR_LEASE_LOST',
      'The user-data clear lease changed before its journal could be released',
      409,
      null,
      {
        incomplete: true,
        databaseCleared: status === CLEAR_OPERATION_COMMITTED,
        cleanupPending: true,
      },
    )
  }
  return deleted.changes === 1
}

export function childFirstTableOrder(catalog, tableNames) {
  const selected = new Set(tableNames)
  const edges = new Map([...selected].map((name) => [name, new Set()]))
  const incoming = new Map([...selected].map((name) => [name, 0]))
  for (const child of catalog) {
    if (!selected.has(child.name)) continue
    for (const group of foreignKeyGroups(child)) {
      const parent = group[0]?.table
      if (!selected.has(parent) || parent === child.name || edges.get(child.name).has(parent)) continue
      edges.get(child.name).add(parent)
      incoming.set(parent, incoming.get(parent) + 1)
    }
  }
  const ready = [...selected].filter((name) => incoming.get(name) === 0).sort()
  const ordered = []
  while (ready.length) {
    const name = ready.shift()
    ordered.push(name)
    for (const parent of edges.get(name)) {
      incoming.set(parent, incoming.get(parent) - 1)
      if (incoming.get(parent) === 0) {
        ready.push(parent)
        ready.sort()
      }
    }
  }
  for (const name of [...selected].sort()) {
    if (!ordered.includes(name)) ordered.push(name)
  }
  return ordered
}

function rowLocator(table, row) {
  const keyColumns = primaryKeyColumns(table)
  const columns = keyColumns.length ? keyColumns : table.columns
  if (!columns.length) {
    throw governanceError(
      'USER_DATA_CLEAR_INCOMPLETE',
      `Could not identify rows in ${table.name}`,
      500,
    )
  }
  return {
    predicate: columns.map((column) => `${quoteIdentifier(column.name)} IS ?`).join(' AND '),
    values: columns.map((column) => row[column.name]),
  }
}

export function deleteCollectedRows(db, table, rows) {
  let changes = 0
  for (const row of rows) {
    const locator = rowLocator(table, row)
    changes += db.prepare(`
      DELETE FROM ${quoteIdentifier(table.name)} WHERE ${locator.predicate}
    `).run(...locator.values).changes
  }
  return changes
}

export function assertCollectedRowsDeleted(db, table, rows) {
  for (const row of rows) {
    const locator = rowLocator(table, row)
    const remaining = db.prepare(`
      SELECT 1 FROM ${quoteIdentifier(table.name)}
      WHERE ${locator.predicate} LIMIT 1
    `).get(...locator.values)
    if (remaining) {
      throw governanceError('USER_DATA_CLEAR_INCOMPLETE', `Could not clear ${table.name}`, 500)
    }
  }
}
