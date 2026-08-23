import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'

import { getDb } from '../db.js'
import { createCompactionArchiveExportSnapshot } from './compactionArchiveExportRuntime.js'
import { acquireCompactionArchiveGovernanceLease } from './compactionArchiveGovernanceRuntime.js'
import {
  buildManagedUserFileCatalog,
  cleanupManagedDeletionStage,
  openManagedFileDescriptor,
  rollbackManagedDeletionStage,
  stageManagedDeletionDomain,
} from './userDataManagedFileCatalog.js'
import {
  collectTurnEmergencyFailureExportFiles,
  recoverTurnEmergencyFailureUserClear,
  stageTurnEmergencyFailureUserClear,
} from './turnEmergencyFailureDataGovernance.js'
import {
  assertUserDataFileSnapshot,
  captureUserDataFileSnapshot,
  mergeUserDataFileSnapshots,
} from './userDataFileSnapshot.js'
import {
  listManagedAttachmentUploadBlockers,
  reapDeadManagedAttachmentUploadLeases,
} from './managedAttachmentUploadLease.js'

export const USER_DATA_CLEAR_CONFIRMATION = 'DELETE ALL MY GUGO DATA'
const EXPORT_FORMAT = 'gugo-authoritative-user-data'
const EXPORT_VERSION = 1
const activeClears = new Set()
const CLEAR_OPERATION_STAGING = 'staging'
const CLEAR_OPERATION_COMMITTED = 'database_committed'
const CLEAR_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CLEAR_OPERATION_LEASE_OWNER = crypto.randomUUID()
const CLEAR_OPERATION_LEASE_MS = 60 * 60 * 1000
const CLEAR_PREVIEW_VERSION = 1
const CLEAR_PREVIEW_TTL_MS = 5 * 60 * 1000
const CLEAR_PREVIEW_MAX_TOKENS = 1024
const clearPreviewTokens = new Map()

function governanceError(code, message, statusCode = 400, cause = null, details = {}) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  error.statusCode = statusCode
  Object.assign(error, details)
  return error
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function tableCatalog(db) {
  const definitions = db.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC
  `).all()
  const virtualRoots = definitions
    .filter((entry) => /^CREATE\s+VIRTUAL\s+TABLE/i.test(String(entry.sql || '')))
    .map((entry) => entry.name)
  return definitions
    .filter((entry) => !virtualRoots.some((root) => entry.name === root || entry.name.startsWith(`${root}_`)))
    .map((entry) => {
      const name = entry.name
      const quoted = quoteIdentifier(name)
      const columns = db.prepare(`PRAGMA table_info(${quoted})`).all()
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoted})`).all()
      return {
        name,
        columns,
        columnNames: new Set(columns.map((column) => column.name)),
        foreignKeys,
      }
    })
}

function rowKey(row) {
  return JSON.stringify(row, (_key, value) => (
    Buffer.isBuffer(value) ? { __gugoBinary: value.toString('base64') } : value
  ))
}

function mergeRows(target, rows) {
  const seen = new Set(target.map(rowKey))
  let added = 0
  for (const row of rows) {
    const key = rowKey(row)
    if (seen.has(key)) continue
    target.push(row)
    seen.add(key)
    added += 1
  }
  return added
}

function foreignKeyGroups(table) {
  const groups = new Map()
  for (const entry of table.foreignKeys) {
    const id = Number(entry.id)
    const group = groups.get(id) || []
    group.push(entry)
    groups.set(id, group)
  }
  return [...groups.values()].map((group) => (
    group.sort((left, right) => Number(left.seq) - Number(right.seq))
  ))
}

function primaryKeyColumns(table) {
  return table.columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
}

function chatSessionPredicate(table) {
  if (table.name !== 'sessions') return null
  const columns = ['id', 'title'].filter((name) => table.columnNames.has(name))
  if (!columns.length) return '0 = 1'
  return `(${columns.map((name) => `${quoteIdentifier(name)} IS NOT NULL`).join(' OR ')})`
}

function userOwnershipColumn(table) {
  if (table.columnNames.has('user_id')) return 'user_id'
  if (table.name === 'side_effect_executions' && table.columnNames.has('owner_id')) return 'owner_id'
  return null
}

function rowsForUser(db, table, userId) {
  const ownerColumn = userOwnershipColumn(table)
  if (!ownerColumn) return []
  const predicates = [`${quoteIdentifier(ownerColumn)} IS ?`]
  const sessionPredicate = chatSessionPredicate(table)
  if (sessionPredicate) predicates.push(sessionPredicate)
  return db.prepare(`
    SELECT * FROM ${quoteIdentifier(table.name)}
    WHERE ${predicates.join(' AND ')}
  `).all(userId)
}

function rowsForRelation(db, child, mappings, parentRows, userId) {
  const tuples = []
  const seen = new Set()
  for (const row of parentRows) {
    const tuple = mappings.map(({ parentColumn }) => row[parentColumn])
    if (tuple.some((value) => value === null || value === undefined)) continue
    const key = rowKey(tuple)
    if (seen.has(key)) continue
    seen.add(key)
    tuples.push(tuple)
  }
  const rows = []
  const chunkSize = Math.max(1, Math.floor(400 / mappings.length))
  for (let offset = 0; offset < tuples.length; offset += chunkSize) {
    const chunk = tuples.slice(offset, offset + chunkSize)
    const relationPredicate = chunk.map(() => `(
      ${mappings.map(({ childColumn }) => `${quoteIdentifier(childColumn)} IS ?`).join(' AND ')}
    )`).join(' OR ')
    const predicates = [`(${relationPredicate})`]
    const parameters = chunk.flat()
    const ownerColumn = userOwnershipColumn(child)
    if (ownerColumn) {
      predicates.push(`${quoteIdentifier(ownerColumn)} IS ?`)
      parameters.push(userId)
    }
    const sessionPredicate = chatSessionPredicate(child)
    if (sessionPredicate) predicates.push(sessionPredicate)
    rows.push(...db.prepare(`
      SELECT * FROM ${quoteIdentifier(child.name)}
      WHERE ${predicates.join(' AND ')}
    `).all(...parameters))
  }
  return rows
}

function isSensitiveUserAuthenticationColumn(name) {
  const normalized = String(name || '').toLowerCase()
  return normalized.includes('password')
    || /(?:auth(?:entication)?|access|refresh|session)[_-]?token/.test(normalized)
    || /(?:mfa|totp)[_-]?(?:secret|seed|key)/.test(normalized)
    || /recovery[_-]?codes?/.test(normalized)
    || /private[_-]?key/.test(normalized)
    || normalized.includes('credential')
}

function sanitizeUserRecord(user) {
  const record = {}
  const removedFields = []
  for (const [name, value] of Object.entries(user)) {
    if (isSensitiveUserAuthenticationColumn(name)) {
      removedFields.push(name)
      continue
    }
    record[name] = value
  }
  return { record, removedFields: removedFields.sort() }
}

function collectDatabaseRows(db, userId, { excludedTables = [] } = {}) {
  const excluded = new Set(excludedTables.map((name) => String(name)))
  const catalog = tableCatalog(db)
  const byName = new Map(catalog.map((table) => [table.name, table]))
  const records = new Map()
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
  if (!user) throw governanceError('USER_DATA_USER_NOT_FOUND', 'User does not exist', 404)
  const sanitizedUser = sanitizeUserRecord(user)
  records.set('users', [sanitizedUser.record])

  for (const table of catalog) {
    if (excluded.has(table.name)) continue
    if (!userOwnershipColumn(table)) continue
    records.set(table.name, rowsForUser(db, table, userId))
  }

  let changed = true
  while (changed) {
    changed = false
    for (const child of catalog) {
      if (excluded.has(child.name)) continue
      for (const group of foreignKeyGroups(child)) {
        const parentName = group[0]?.table
        const parentRows = records.get(parentName)
        const parent = byName.get(parentName)
        if (!parentRows?.length || !parent) continue
        const parentPrimaryKey = primaryKeyColumns(parent)
        const mappings = group.map((foreignKey, index) => ({
          childColumn: foreignKey.from,
          parentColumn: foreignKey.to || parentPrimaryKey[index]?.name,
        }))
        if (mappings.some(({ childColumn, parentColumn }) => (
          !childColumn || !parentColumn || !child.columnNames.has(childColumn)
        ))) continue
        const related = rowsForRelation(db, child, mappings, parentRows, userId)
        if (!related.length) continue
        const target = records.get(child.name) || []
        if (mergeRows(target, related) > 0) changed = true
        records.set(child.name, target)
      }
    }
  }

  return {
    catalog,
    excludedTables: [...excluded].sort(),
    redactedFields: { users: sanitizedUser.removedFields },
    records: Object.fromEntries(
      [...records.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, rows]) => [name, rows]),
    ),
  }
}

function sanitizeExportDatabase({ records, redactedFields, excludedTables = [] }) {
  return {
    records,
    redactedFields,
    excludedTables,
  }
}

const CLEAR_IMPACT_CATEGORIES = Object.freeze([
  'conversations',
  'tasks',
  'recoveryAndSafety',
  'modelsAndPlugins',
  'knowledgeAndAgents',
  'automationAndIntegrations',
  'evolution',
  'other',
])

function clearImpactCategory(tableName) {
  const name = String(tableName || '')
  if (/(?:checkpoint|recovery|lease|fence|side_effect|approval|audit|outbox|steering)/.test(name)) {
    return 'recoveryAndSafety'
  }
  if (/^(?:sessions|messages|turn_events|turn_artifacts|channels|channel_)/.test(name)) {
    return 'conversations'
  }
  if (/^(?:jobs|job_|subagent_|background_processes)/.test(name)) return 'tasks'
  if (/^evolution_/.test(name)) return 'evolution'
  if (/^(?:model_providers|runtime_plugin_|mcp_|user_tool_|local_file_|effort_settings)/.test(name)) {
    return 'modelsAndPlugins'
  }
  if (/^(?:agents|skills|memories|memory_|pinned_memories|entities|relations|observations|compaction_|todos|desk_notes)/.test(name)) {
    return 'knowledgeAndAgents'
  }
  if (/^(?:hooks|integrations|integration_|bridge_|cron_jobs|notifications|mobile_access_keys)/.test(name)) {
    return 'automationAndIntegrations'
  }
  return 'other'
}

function clearDatabaseImpact(records) {
  const categories = Object.fromEntries(CLEAR_IMPACT_CATEGORIES.map((name) => [name, 0]))
  let totalRows = 0
  const digest = crypto.createHash('sha256')
  for (const [tableName, rows] of Object.entries(records).sort(([left], [right]) => left.localeCompare(right))) {
    if (tableName === 'users') continue
    const sortedRows = rows.map(rowKey).sort()
    categories[clearImpactCategory(tableName)] += sortedRows.length
    totalRows += sortedRows.length
    digest.update(tableName)
    digest.update('\0')
    for (const row of sortedRows) {
      digest.update(row)
      digest.update('\0')
    }
  }
  return { categories, totalRows, digest: digest.digest('hex') }
}

function clearManagedFileImpact({ managed, userId, env, emergencyFiles, fileSystem }) {
  const attachment = attachmentBucket(userId, env)
  const attachments = captureUserDataFileSnapshot({
    root: attachment.root,
    selections: [{
      fullPath: attachment.path,
      type: 'directory',
      logicalPath: path.basename(attachment.path),
    }],
    namespace: 'attachments',
    fileSystem,
  })
  const artifacts = captureUserDataFileSnapshot({
    root: managed.deletion.artifacts.root,
    selections: managed.deletion.artifacts.entries.map((entry) => ({
      fullPath: entry.fullPath,
      type: entry.type,
      logicalPath: path.relative(managed.deletion.artifacts.root, entry.fullPath)
        .split(path.sep).join('/'),
    })),
    namespace: 'artifacts',
    fileSystem,
  })
  const data = captureUserDataFileSnapshot({
    root: managed.deletion.data.root,
    selections: managed.deletion.data.entries.map((entry) => ({
      fullPath: entry.fullPath,
      type: entry.type,
      logicalPath: path.relative(managed.deletion.data.root, entry.fullPath)
        .split(path.sep).join('/'),
    })),
    namespace: 'data',
    fileSystem,
  })
  const emergency = mergeUserDataFileSnapshots({
    entries: emergencyFiles.map((file) => ({
      path: `emergency-journal/${file.id}`,
      type: 'file',
      size: Number(file.size) || 0,
      sha256: String(file.sha256 || ''),
    })),
  })
  const managedSnapshot = mergeUserDataFileSnapshots(attachments, artifacts, data)
  const snapshot = mergeUserDataFileSnapshots(managedSnapshot, emergency)
  return {
    removableFiles: snapshot.fileCount,
    removableBytes: snapshot.totalBytes,
    preservedShared: managed.stats.managedFiles.preservedShared,
    alreadyMissing: managed.stats.managedFiles.alreadyMissing,
    digest: snapshot.digest,
    snapshot,
    managedSnapshot,
    domainSnapshots: { attachments, artifacts, data },
  }
}

function prepareClearImpact({
  userId,
  db,
  env,
  cwd,
  tempDir,
  fileSystem,
  includeCompactionArchives = true,
}) {
  const collected = collectDatabaseRows(db, userId)
  const catalogByName = new Map(collected.catalog.map((table) => [table.name, table]))
  const managed = buildManagedUserFileCatalog({
    records: collected.records,
    userId,
    db,
    catalogByName,
    env,
    purpose: 'clear',
    fileSystem,
    includeCompactionArchives,
  })
  const emergencyFiles = collectTurnEmergencyFailureExportFiles({
    userId,
    env,
    cwd,
    tempDir,
    fileSystem,
  })
  return {
    ...collected,
    managed,
    database: clearDatabaseImpact(collected.records),
    files: clearManagedFileImpact({
      managed,
      userId,
      env,
      emergencyFiles,
      fileSystem,
    }),
  }
}

function pruneClearPreviewTokens(now) {
  for (const [token, entry] of clearPreviewTokens) {
    if (entry.expiresAt <= now) clearPreviewTokens.delete(token)
  }
  while (clearPreviewTokens.size >= CLEAR_PREVIEW_MAX_TOKENS) {
    clearPreviewTokens.delete(clearPreviewTokens.keys().next().value)
  }
}

function issueClearPreviewToken({
  userId,
  databaseDigest,
  fileDigest,
  compactionPortId,
  compactionGovernanceVersion,
  compactionDigest,
  now,
}) {
  pruneClearPreviewTokens(now)
  const token = crypto.randomBytes(32).toString('base64url')
  const expiresAt = now + CLEAR_PREVIEW_TTL_MS
  clearPreviewTokens.set(token, {
    userId,
    databaseDigest,
    fileDigest,
    compactionPortId,
    compactionGovernanceVersion,
    compactionDigest,
    expiresAt,
  })
  return { token, expiresAt }
}

function consumeClearPreviewToken({ token, userId, now }) {
  const safeToken = String(token || '')
  const entry = clearPreviewTokens.get(safeToken)
  if (entry) clearPreviewTokens.delete(safeToken)
  if (!entry || entry.userId !== userId) {
    throw governanceError(
      'USER_DATA_CLEAR_PREVIEW_REQUIRED',
      'Load a fresh server-side impact preview before clearing local data',
      409,
    )
  }
  if (entry.expiresAt <= now) {
    throw governanceError(
      'USER_DATA_CLEAR_PREVIEW_EXPIRED',
      'The data-clear impact preview expired; load it again before continuing',
      409,
    )
  }
  return entry
}

function assertClearPreviewMatches(preview, impact, {
  databaseOnly = false,
  compactionArchivePort = null,
  archiveDeletionPreview = null,
} = {}) {
  const matches = preview.databaseDigest === impact.database.digest
    && (databaseOnly || (
      preview.fileDigest === impact.files.digest
      && preview.compactionPortId === compactionArchivePort?.id
      && preview.compactionGovernanceVersion === compactionArchivePort?.governanceApiVersion
      && preview.compactionDigest === archiveDeletionPreview?.digest
    ))
  if (!matches) {
    throw governanceError(
      'USER_DATA_CLEAR_PREVIEW_CHANGED',
      'Local data changed after the impact preview; review the refreshed impact before clearing',
      409,
      null,
      { incomplete: false, databaseCleared: false, cleanupPending: false },
    )
  }
}

function assertArtifactDeletionStillExclusive({ db, catalogByName, userId, entries }) {
  const references = new Map()
  for (const entry of entries || []) {
    const column = entry?.kind === 'artifact'
      ? 'filename'
      : ['artifact-source', 'html-artifact-assets'].includes(entry?.kind)
        ? 'id'
        : null
    const value = String(entry?.id || '')
    if (column && value) references.set(`${column}\0${value}`, { column, value })
  }
  for (const { column, value } of references.values()) {
    for (const tableName of ['job_artifacts', 'turn_artifacts']) {
      const table = catalogByName.get(tableName)
      if (!table?.columnNames?.has(column) || !table.columnNames.has('user_id')) continue
      const foreignReference = db.prepare(`
        SELECT 1 FROM ${quoteIdentifier(tableName)}
        WHERE ${quoteIdentifier(column)} IS ?
          AND ${quoteIdentifier('user_id')} IS NOT ?
        LIMIT 1
      `).get(value, userId)
      if (foreignReference) {
        throw governanceError(
          'USER_DATA_CLEAR_PREVIEW_CHANGED',
          'An artifact became shared after the impact preview; review the refreshed impact before clearing',
          409,
          null,
          { incomplete: false, databaseCleared: false, cleanupPending: false },
        )
      }
    }
  }
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function attachmentRoot(env) {
  return path.join(path.resolve(String(env.APP_DATA_DIR || path.join(process.cwd(), 'server-data'))), 'attachments')
}

function artifactRoot(env) {
  return path.resolve(
    env.ARTIFACT_DIR && path.isAbsolute(String(env.ARTIFACT_DIR))
      ? String(env.ARTIFACT_DIR)
      : path.resolve(process.cwd(), String(env.ARTIFACT_DIR || '.artifacts')),
  )
}

function clearStorageToken(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32)
}

function clearOperationPaths({ userId, operationId, env }) {
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

function fileSystemMethod(fileSystem, name) {
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

function pathExists(fileSystem, target) {
  return fileSystemMethod(fileSystem, 'existsSync')(target)
}

function removeTree(fileSystem, target) {
  if (!pathExists(fileSystem, target)) return true
  fileSystemMethod(fileSystem, 'rmSync')(target, { recursive: true, force: true })
  return true
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

const NON_TERMINAL_JOB_STATUSES = Object.freeze([
  'queued',
  'planning',
  'running',
  'waiting',
  'awaiting_approval',
  'cancel_requested',
])

function tableExists(db, name) {
  return !!db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name)
}

function userRuntimeBlockers(db, userId, now = Date.now()) {
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

function assertUserRuntimeIdle(db, userId, now = Date.now()) {
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

function assertUserSessionContentExportReady(db, userId) {
  if (!tableExists(db, 'session_content_outbox')) return
  const pending = db.prepare(`
    SELECT session_id, status
    FROM session_content_outbox
    WHERE user_id = ? AND status <> 'materialized'
    ORDER BY id ASC LIMIT 1
  `).get(userId)
  if (!pending) return
  throw governanceError(
    'USER_DATA_EXPORT_MATERIALIZATION_PENDING',
    'Session content is still being committed to local storage; retry the export shortly',
    409,
    null,
    { sessionId: pending.session_id, materializationStatus: pending.status },
  )
}

function checkpointUserDataWal(db) {
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

function insertClearOperation(db, {
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

function persistCompactionStageReceipt(db, {
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

function renewClearOperationLease(db, {
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

function deleteClearOperation(db, {
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

function childFirstTableOrder(catalog, tableNames) {
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

function deleteCollectedRows(db, table, rows) {
  let changes = 0
  for (const row of rows) {
    const locator = rowLocator(table, row)
    changes += db.prepare(`
      DELETE FROM ${quoteIdentifier(table.name)} WHERE ${locator.predicate}
    `).run(...locator.values).changes
  }
  return changes
}

function assertCollectedRowsDeleted(db, table, rows) {
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

export function previewAuthoritativeUserDataClear({
  userId,
  db = getDb(),
  env = process.env,
  now = Date.now(),
  cwd = process.cwd(),
  tempDir,
  fileSystem = fs,
} = {}, {
  acquireGovernanceLease = acquireCompactionArchiveGovernanceLease,
} = {}) {
  const safeUserId = String(userId || '').trim()
  if (!safeUserId) throw governanceError('UNAUTHORIZED', 'User is required', 401)
  const lease = acquireGovernanceLease()
  try {
    const archiveDeletionPreview = lease.port.previewDeletion({
      userId: safeUserId,
      scope: { kind: 'user' },
    })
    const impact = db.transaction(() => {
      reapDeadManagedAttachmentUploadLeases({ db, userId: safeUserId, now })
      return prepareClearImpact({
        userId: safeUserId,
        db,
        env,
        cwd,
        tempDir,
        fileSystem,
        includeCompactionArchives: false,
      })
    }).immediate()
    const blockers = userRuntimeBlockers(db, safeUserId, now)
    const blockerCounts = blockers.reduce((counts, blocker) => {
      counts[blocker.kind] = (counts[blocker.kind] || 0) + 1
      return counts
    }, {})
    const authorization = issueClearPreviewToken({
      userId: safeUserId,
      databaseDigest: impact.database.digest,
      fileDigest: impact.files.digest,
      compactionPortId: lease.port.id,
      compactionGovernanceVersion: lease.port.governanceApiVersion,
      compactionDigest: archiveDeletionPreview.digest,
      now,
    })
    const result = {
      ok: true,
      preview: {
        version: CLEAR_PREVIEW_VERSION,
        token: authorization.token,
        expiresAt: authorization.expiresAt,
        canClear: blockers.length === 0,
        blockers: blockerCounts,
        databaseRows: {
          total: impact.database.totalRows,
          categories: impact.database.categories,
        },
        managedFiles: {
          removable: impact.files.removableFiles + archiveDeletionPreview.fileCount,
          removableBytes: impact.files.removableBytes + archiveDeletionPreview.totalBytes,
          preservedShared: impact.files.preservedShared,
          alreadyMissing: impact.files.alreadyMissing + archiveDeletionPreview.alreadyMissing,
        },
        retained: {
          accountIdentity: true,
          loginSessions: true,
          credentialVaultKey: true,
        },
        irreversible: true,
      },
    }
    lease.release()
    return result
  } catch (error) {
    try {
      lease.release()
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'User-data clear preview failed and its governance lease could not be released',
        { cause: releaseError },
      )
    }
    throw error
  }
}

export function buildAuthoritativeUserDataSnapshot({
  userId,
  db = getDb(),
  env = process.env,
  now = Date.now(),
  cwd = process.cwd(),
  tempDir,
  fileSystem = fs,
  compactionArchivePort,
} = {}) {
  const safeUserId = String(userId || '').trim()
  if (!safeUserId) throw governanceError('UNAUTHORIZED', 'User is required', 401)
  const compactionExport = createCompactionArchiveExportSnapshot({
    userId: safeUserId,
    port: compactionArchivePort,
  })
  try {
    return db.transaction(() => {
      assertUserSessionContentExportReady(db, safeUserId)
      const collected = collectDatabaseRows(db, safeUserId, {
        excludedTables: ['compaction_archive'],
      })
      const {
        records,
        redactedFields,
        excludedTables,
      } = sanitizeExportDatabase(collected)
      const { catalog } = collected
      const managed = buildManagedUserFileCatalog({
        records,
        userId: safeUserId,
        db,
        catalogByName: new Map(catalog.map((table) => [table.name, table])),
        env,
        purpose: 'export',
        fileSystem,
      })
      const emergencyJournalFiles = collectTurnEmergencyFailureExportFiles({
        userId: safeUserId,
        env,
        cwd,
        tempDir,
        fileSystem,
      })
      const files = [...managed.files, ...emergencyJournalFiles, ...compactionExport.files]
      const tableCounts = Object.fromEntries(
        Object.entries(records).map(([name, rows]) => [name, rows.length]),
      )
      const manifest = {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: new Date(now).toISOString(),
        userId: safeUserId,
        credentialKeyIncluded: false,
        authenticationSessionsIncluded: false,
        database: { tableCounts, redactedFields, excludedTables, tables: records },
        compactionArchiveSource: {
          portId: compactionExport.portId,
          governanceApiVersion: compactionExport.governanceApiVersion,
        },
        compactionArchives: compactionExport.manifestEntries,
        files: files.map((file) => ({
          kind: file.kind,
          id: file.id,
          archivePath: file.archivePath,
          size: file.size,
          sha256: file.sha256,
        })),
      }
      return { manifest, files, compactionExport }
    }).immediate()
  } catch (error) {
    try {
      compactionExport.releaseSnapshot()
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'User-data export snapshot creation failed and compaction cleanup also failed',
        { cause: releaseError },
      )
    }
    throw error
  }
}

export function createAuthoritativeUserDataArchive(options = {}, {
  acquireGovernanceLease = acquireCompactionArchiveGovernanceLease,
} = {}) {
  const lease = acquireGovernanceLease()
  let compactionExport = null
  let resourcesReleased = false
  const releaseResources = () => {
    if (resourcesReleased) return false
    resourcesReleased = true
    const errors = []
    try { compactionExport?.releaseSnapshot() } catch (error) { errors.push(error) }
    try { lease.release() } catch (error) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'User-data export resources could not be released')
    }
    return true
  }
  let snapshot
  try {
    snapshot = buildAuthoritativeUserDataSnapshot({
      ...options,
      compactionArchivePort: lease.port,
    })
    compactionExport = snapshot.compactionExport
  } catch (error) {
    try {
      releaseResources()
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'User-data export setup failed and its governance lease could not be released',
        { cause: releaseError },
      )
    }
    throw error
  }
  const { manifest, files } = snapshot
  const zip = new JSZip()
  zip.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
  zip.file('README.txt', [
    'Gugo authoritative local user-data export',
    'The archive contains user-owned database records and managed file contents.',
    'Authentication session tokens and the credential-vault key are intentionally excluded.',
    'Encrypted credential envelopes remain encrypted; keep the original vault key separately if they must be restored.',
    '',
  ].join('\n'))
  const fileStreams = []
  try {
    for (const file of files) {
      if (typeof file.createReadStream === 'function') {
        const fileStream = file.createReadStream()
        fileStreams.push(fileStream)
        zip.file(file.archivePath, fileStream)
        continue
      }
      if (Buffer.isBuffer(file.bytes)) {
        zip.file(file.archivePath, file.bytes)
        continue
      }
      const descriptor = openManagedFileDescriptor(file)
      if (file.size === 0) {
        fs.closeSync(descriptor)
        zip.file(file.archivePath, Buffer.alloc(0))
        continue
      }
      const stream = fs.createReadStream(file.fullPath, {
        fd: descriptor,
        autoClose: true,
        start: 0,
        end: file.size - 1,
      })
      fileStreams.push(stream)
      zip.file(file.archivePath, stream)
    }
  } catch (error) {
    for (const stream of fileStreams) stream.destroy()
    try {
      releaseResources()
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'User-data export file setup failed and its resources could not be released',
        { cause: releaseError },
      )
    }
    throw error
  }
  const stamp = manifest.exportedAt.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const stream = zip.generateNodeStream({ streamFiles: true, compression: 'DEFLATE' })
  stream.once('error', (error) => {
    for (const fileStream of fileStreams) fileStream.destroy()
    try {
      releaseResources()
    } catch (releaseError) {
      error.cleanupError = releaseError
    }
  })
  stream.once('end', () => {
    try {
      releaseResources()
    } catch (error) {
      stream.destroy(error)
    }
  })
  stream.once('close', () => {
    if (resourcesReleased) return
    for (const fileStream of fileStreams) fileStream.destroy()
    try { releaseResources() } catch { /* surfaced by explicit dispose/error paths */ }
  })
  const dispose = () => {
    for (const fileStream of fileStreams) fileStream.destroy()
    if (!stream.destroyed) stream.destroy()
    return releaseResources()
  }
  return {
    filename: `gugo-user-data-${stamp}.zip`,
    manifest,
    stream,
    dispose,
  }
}

function attachmentBucket(userId, env) {
  const root = path.resolve(attachmentRoot(env))
  const bucket = clearStorageToken(userId)
  return { root, path: path.join(root, bucket) }
}

function stageAttachmentDeletion(
  userId,
  operationId,
  env,
  fileSystem = fs,
  expectedSnapshot = null,
) {
  const bucket = attachmentBucket(userId, env)
  const { attachmentStagePath: staged } = clearOperationPaths({ userId, operationId, env })
  const logicalPath = path.basename(bucket.path)
  const capture = (fullPath) => captureUserDataFileSnapshot({
    root: bucket.root,
    selections: [{ fullPath, type: 'directory', logicalPath }],
    namespace: 'attachments',
    fileSystem,
    code: 'USER_DATA_CLEAR_PREVIEW_CHANGED',
    message: 'Managed attachments changed after the impact preview',
  })
  if (pathExists(fileSystem, staged)) {
    throw governanceError(
      'USER_DATA_CLEAR_JOURNAL_CONFLICT',
      'The attachment clear staging path already exists',
      500,
      null,
      { incomplete: true, databaseCleared: false },
    )
  }
  if (!pathExists(fileSystem, bucket.path)) {
    if (expectedSnapshot) assertUserDataFileSnapshot(expectedSnapshot, capture(bucket.path))
    return {
      cleanup: () => true,
      rollback: () => true,
      assertStable() {
        if (expectedSnapshot) assertUserDataFileSnapshot(expectedSnapshot, capture(bucket.path))
        return true
      },
    }
  }
  const activeSnapshot = capture(bucket.path)
  if (expectedSnapshot) assertUserDataFileSnapshot(expectedSnapshot, activeSnapshot)
  const handle = {
    cleanup() {
      removeTree(fileSystem, staged)
      return true
    },
    rollback() {
      if (!pathExists(fileSystem, staged)) return true
      if (pathExists(fileSystem, bucket.path)) {
        throw governanceError(
          'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
          'The attachment bucket could not be restored because its destination exists',
          500,
          null,
          { incomplete: true, databaseCleared: false },
        )
      }
      fileSystemMethod(fileSystem, 'renameSync')(staged, bucket.path)
      return true
    },
    assertStable() {
      if (pathExists(fileSystem, bucket.path)) {
        throw governanceError(
          'USER_DATA_CLEAR_PREVIEW_CHANGED',
          'Managed attachments changed while they were being staged',
          409,
          null,
          { incomplete: false, databaseCleared: false, cleanupPending: false },
        )
      }
      if (expectedSnapshot) assertUserDataFileSnapshot(expectedSnapshot, capture(staged))
      return true
    },
  }
  try {
    fileSystemMethod(fileSystem, 'renameSync')(bucket.path, staged)
    handle.assertStable()
    return handle
  } catch (cause) {
    let rollbackCause = null
    try { handle.rollback() } catch (error) { rollbackCause = error }
    if (rollbackCause) {
      throw governanceError(
        'USER_DATA_CLEAR_RECOVERY_INCOMPLETE',
        'Managed attachments could not be staged or fully restored; recovery evidence was retained',
        500,
        new AggregateError([cause, rollbackCause]),
        {
          incomplete: true,
          databaseCleared: false,
          cleanupPending: true,
          recoveryRequired: true,
        },
      )
    }
    throw cause
  }
}

function assertSafeStagingDirectory(fileSystem, root, stagedPath) {
  if (!pathExists(fileSystem, stagedPath)) return false
  const stageStat = fileSystemMethod(fileSystem, 'lstatSync')(stagedPath)
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) {
    throw governanceError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A user-data clear staging path is not a safe directory',
      500,
      null,
      { incomplete: true },
    )
  }
  const realRoot = fileSystemMethod(fileSystem, 'realpathSync')(root)
  const realStage = fileSystemMethod(fileSystem, 'realpathSync')(stagedPath)
  if (!isInside(realRoot, realStage)) {
    throw governanceError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A user-data clear staging path escaped its managed root',
      500,
      null,
      { incomplete: true },
    )
  }
  return true
}

function rollbackRecoveredAttachmentStage(paths, fileSystem) {
  if (!assertSafeStagingDirectory(
    fileSystem,
    paths.attachmentRoot,
    paths.attachmentStagePath,
  )) return true
  if (pathExists(fileSystem, paths.attachmentActivePath)) {
    throw governanceError(
      'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
      'The staged attachment bucket conflicts with an active bucket',
      500,
      null,
      { incomplete: true, databaseCleared: false },
    )
  }
  fileSystemMethod(fileSystem, 'renameSync')(
    paths.attachmentStagePath,
    paths.attachmentActivePath,
  )
  return true
}

function cleanupCommittedClearOperation({
  paths,
  userId,
  operationId,
  fileSystem,
  renewLease = () => true,
}) {
  renewLease()
  cleanupManagedDeletionStage({
    root: paths.artifactRoot,
    stagePath: paths.artifactStagePath,
    domain: 'artifacts',
    operationId,
    userId,
    fileSystem,
  })
  renewLease()
  cleanupManagedDeletionStage({
    root: paths.dataRoot,
    stagePath: paths.dataStagePath,
    domain: 'data',
    operationId,
    userId,
    fileSystem,
  })
  renewLease()
  if (assertSafeStagingDirectory(fileSystem, paths.attachmentRoot, paths.attachmentStagePath)) {
    removeTree(fileSystem, paths.attachmentStagePath)
  }
  renewLease()
}

function compactionJournalBinding(operation, compactionArchivePort) {
  if (operation.operation_kind !== 'user_clear' || operation.session_id !== null) {
    throw governanceError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A non-user clear journal cannot be recovered as a full data clear',
      500,
      null,
      { incomplete: true, cleanupPending: true },
    )
  }
  const identity = [
    operation.compaction_port_id,
    operation.compaction_governance_version,
    operation.compaction_digest,
  ]
  if (identity.every((value) => value === null)) {
    if (operation.compaction_stage_token !== null) {
      throw governanceError(
        'USER_DATA_CLEAR_JOURNAL_INVALID',
        'A legacy data-clear journal contains an orphaned compaction stage token',
        500,
        null,
        { incomplete: true, cleanupPending: true },
      )
    }
    return null
  }
  if (identity.some((value) => value === null)) {
    throw governanceError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A data-clear journal contains an incomplete compaction port identity',
      500,
      null,
      { incomplete: true, cleanupPending: true },
    )
  }
  if (operation.compaction_port_id !== compactionArchivePort.id
    || operation.compaction_governance_version !== compactionArchivePort.governanceApiVersion) {
    throw governanceError(
      'USER_DATA_CLEAR_COMPACTION_PORT_CHANGED',
      'The compaction archive provider changed while a recoverable data clear was pending',
      409,
      null,
      { incomplete: true, cleanupPending: true },
    )
  }
  return {
    digest: operation.compaction_digest,
    stageToken: operation.compaction_stage_token,
  }
}

function recoverCompactionArchiveDeletion({
  port,
  userId,
  operationId,
  binding,
  databaseCommitted,
}) {
  if (!binding) return null
  const result = port.recoverDeletion({
    userId,
    operationId,
    databaseCommitted,
    expectedDigest: binding.digest,
    expectedStageToken: binding.stageToken,
  })
  const expectedState = databaseCommitted ? 'committed' : 'rolled_back'
  const missingUnstagedOperation = result?.recovered === false
    && !databaseCommitted
    && binding.stageToken === null
    && result?.state === 'none'
    && result?.digest === null
    && result?.stageToken === null
  const matchingTerminalEvidence = result?.recovered === true
    && result?.state === expectedState
    && result?.digest === binding.digest
    && (binding.stageToken === null || result?.stageToken === binding.stageToken)
  if (!matchingTerminalEvidence && !missingUnstagedOperation) {
    throw governanceError(
      'USER_DATA_CLEAR_COMPACTION_RECOVERY_CONFLICT',
      'Compaction archive recovery evidence conflicts with the database clear journal',
      500,
      null,
      {
        incomplete: true,
        databaseCleared: databaseCommitted,
        cleanupPending: true,
      },
    )
  }
  return result
}

function recoverPendingClearOperation({
  db,
  userId,
  env,
  cwd,
  tempDir,
  fileSystem,
  compactionArchivePort,
}) {
  const operation = db.prepare(`
    SELECT operation_id, owner_id, lease_owner, lease_pid, lease_expires_at, status,
           operation_kind, session_id, compaction_port_id,
           compaction_governance_version, compaction_digest, compaction_stage_token
    FROM user_data_clear_operations
    WHERE owner_id = ?
  `).get(userId)
  if (!operation) return null
  const compactionBinding = compactionJournalBinding(operation, compactionArchivePort)
  const now = Date.now()
  // Expiry is a crash-recovery hint, not permission to race a process that is
  // demonstrably still alive. Synchronous hashing/staging can legitimately run
  // longer than the nominal lease window and cannot service a timer heartbeat.
  const foreignLiveLease = operation.lease_owner !== CLEAR_OPERATION_LEASE_OWNER
    && isProcessAlive(operation.lease_pid)
  if (foreignLiveLease) {
    throw governanceError(
      'USER_DATA_CLEAR_IN_PROGRESS',
      'Another local process is clearing this user data',
      409,
    )
  }
  const claimed = db.prepare(`
    UPDATE user_data_clear_operations
    SET lease_owner = ?, lease_pid = ?, lease_expires_at = ?, updated_at = ?
    WHERE operation_id = ? AND lease_owner = ? AND lease_expires_at = ?
  `).run(
    CLEAR_OPERATION_LEASE_OWNER,
    process.pid,
    now + CLEAR_OPERATION_LEASE_MS,
    now,
    operation.operation_id,
    operation.lease_owner,
    operation.lease_expires_at,
  )
  if (claimed.changes !== 1) {
    throw governanceError(
      'USER_DATA_CLEAR_IN_PROGRESS',
      'Another local process claimed this user-data clear recovery',
      409,
    )
  }
  const renewLease = () => renewClearOperationLease(db, {
    operationId: operation.operation_id,
    userId,
    status: operation.status,
  })
  renewLease()
  const paths = clearOperationPaths({ userId, operationId: operation.operation_id, env })
  if (operation.status === CLEAR_OPERATION_STAGING) {
    try {
      renewLease()
      recoverCompactionArchiveDeletion({
        port: compactionArchivePort,
        userId,
        operationId: operation.operation_id,
        binding: compactionBinding,
        databaseCommitted: false,
      })
      renewLease()
      rollbackManagedDeletionStage({
        root: paths.dataRoot,
        stagePath: paths.dataStagePath,
        domain: 'data',
        operationId: operation.operation_id,
        userId,
        fileSystem,
      })
      renewLease()
      rollbackManagedDeletionStage({
        root: paths.artifactRoot,
        stagePath: paths.artifactStagePath,
        domain: 'artifacts',
        operationId: operation.operation_id,
        userId,
        fileSystem,
      })
      renewLease()
      rollbackRecoveredAttachmentStage(paths, fileSystem)
      renewLease()
      recoverTurnEmergencyFailureUserClear({
        operationId: operation.operation_id,
        committed: false,
        env,
        cwd,
        tempDir,
        fileSystem,
      })
      renewLease()
      deleteClearOperation(db, {
        operationId: operation.operation_id,
        userId,
        status: CLEAR_OPERATION_STAGING,
      })
      return { recovered: 'rolled_back', operationId: operation.operation_id }
    } catch (cause) {
      if (cause?.code?.startsWith('USER_DATA_')) throw cause
      throw governanceError(
        'USER_DATA_CLEAR_RECOVERY_INCOMPLETE',
        'A staged user-data clear could not be restored',
        500,
        cause,
        { incomplete: true, databaseCleared: false, cleanupPending: true },
      )
    }
  }
  if (operation.status !== CLEAR_OPERATION_COMMITTED) {
    throw governanceError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A user-data clear recovery record has an unknown state',
      500,
      null,
      { incomplete: true, cleanupPending: true },
    )
  }
  try {
    renewLease()
    recoverCompactionArchiveDeletion({
      port: compactionArchivePort,
      userId,
      operationId: operation.operation_id,
      binding: compactionBinding,
      databaseCommitted: true,
    })
    renewLease()
    recoverTurnEmergencyFailureUserClear({
      operationId: operation.operation_id,
      committed: true,
      env,
      cwd,
      tempDir,
      fileSystem,
    })
    renewLease()
    cleanupCommittedClearOperation({
      paths,
      userId,
      operationId: operation.operation_id,
      fileSystem,
      renewLease,
    })
    renewLease()
    checkpointUserDataWal(db)
    renewLease()
    deleteClearOperation(db, {
      operationId: operation.operation_id,
      userId,
      status: CLEAR_OPERATION_COMMITTED,
    })
    return { recovered: 'cleanup_completed', operationId: operation.operation_id }
  } catch (cause) {
    if (cause?.code?.startsWith('USER_DATA_')) {
      cause.databaseCleared = true
      cause.cleanupPending = true
      throw cause
    }
    throw governanceError(
      'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
      'Committed user data is no longer active, but physical file cleanup is still pending',
      500,
      cause,
      { incomplete: true, databaseCleared: true, cleanupPending: true },
    )
  }
}

export function clearAuthoritativeUserData({
  userId,
  confirmation,
  previewToken,
  requirePreview = true,
  previewNow = Date.now(),
  db = getDb(),
  env = process.env,
  cwd = process.cwd(),
  tempDir,
  fileSystem = fs,
} = {}, {
  acquireGovernanceLease = acquireCompactionArchiveGovernanceLease,
} = {}) {
  const safeUserId = String(userId || '').trim()
  if (!safeUserId) throw governanceError('UNAUTHORIZED', 'User is required', 401)
  if (confirmation !== USER_DATA_CLEAR_CONFIRMATION) {
    throw governanceError(
      'USER_DATA_CLEAR_CONFIRMATION_REQUIRED',
      `Type exactly: ${USER_DATA_CLEAR_CONFIRMATION}`,
      400,
    )
  }
  if (activeClears.size > 0) {
    throw governanceError('USER_DATA_CLEAR_IN_PROGRESS', 'A data clear is already in progress', 409)
  }
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(safeUserId)) {
    throw governanceError('USER_DATA_USER_NOT_FOUND', 'User does not exist', 404)
  }
  const preview = requirePreview || previewToken
    ? consumeClearPreviewToken({ token: previewToken, userId: safeUserId, now: previewNow })
    : null
  const governanceLease = acquireGovernanceLease()
  const compactionArchivePort = governanceLease.port

  activeClears.add(safeUserId)
  let stagedAttachments = null
  let stagedArtifacts = null
  let stagedData = null
  let stagedEmergencyJournals = null
  let compactionStageReceipt = null
  let archiveDeletionPreview = null
  let operationId = null
  let databaseCommitted = false
  let terminalError = null
  let clearResult = null
  try {
    recoverPendingClearOperation({
      db,
      userId: safeUserId,
      env,
      cwd,
      tempDir,
      fileSystem,
      compactionArchivePort,
    })
    assertUserRuntimeIdle(db, safeUserId)
    archiveDeletionPreview = compactionArchivePort.previewDeletion({
      userId: safeUserId,
      scope: { kind: 'user' },
    })
    const pendingOperationId = crypto.randomUUID()
    insertClearOperation(db, {
      operationId: pendingOperationId,
      userId: safeUserId,
      compactionPortId: compactionArchivePort.id,
      compactionGovernanceVersion: compactionArchivePort.governanceApiVersion,
      compactionDigest: archiveDeletionPreview.digest,
      now: Date.now(),
    })
    operationId = pendingOperationId
    const renewStagingLease = () => renewClearOperationLease(db, {
      operationId,
      userId: safeUserId,
      status: CLEAR_OPERATION_STAGING,
    })
    const preparedImpact = preview
      ? prepareClearImpact({
          userId: safeUserId,
          db,
          env,
          cwd,
          tempDir,
          fileSystem,
          includeCompactionArchives: false,
        })
      : null
    if (preview) {
      assertClearPreviewMatches(preview, preparedImpact, {
        compactionArchivePort,
        archiveDeletionPreview,
      })
    }
    const { catalog, records } = preparedImpact || collectDatabaseRows(db, safeUserId)
    const ownedTables = catalog.filter((table) => userOwnershipColumn(table))
    const catalogByName = new Map(catalog.map((table) => [table.name, table]))
    const relatedWithoutOwner = Object.keys(records).filter((name) => (
      name !== 'users'
      && !userOwnershipColumn(catalogByName.get(name))
      && records[name].length > 0
    ))
    const unownedDeletionOrder = childFirstTableOrder(catalog, relatedWithoutOwner)
    // The durable operation row prevents another process from claiming pending
    // content while files are enumerated and staged. A claim that won just
    // before the barrier remains visible as a lease and aborts this clear.
    assertUserRuntimeIdle(db, safeUserId)
    renewStagingLease()
    let managed = preparedImpact?.managed || null
    try {
      managed ||= buildManagedUserFileCatalog({
          records,
          userId: safeUserId,
          db,
          catalogByName,
          env,
          purpose: 'clear',
          fileSystem,
          includeCompactionArchives: false,
        })
    } catch (error) {
      if (error?.code?.startsWith('USER_DATA_CLEAR_')) {
        error.incomplete = true
        error.databaseCleared = false
      }
      throw error
    }
    renewStagingLease()
    stagedEmergencyJournals = stageTurnEmergencyFailureUserClear({
      userId: safeUserId,
      operationId,
      env,
      cwd,
      tempDir,
      fileSystem,
    })
    renewStagingLease()
    const paths = clearOperationPaths({ userId: safeUserId, operationId, env })
    stagedAttachments = stageAttachmentDeletion(
      safeUserId,
      operationId,
      env,
      fileSystem,
      preparedImpact?.files?.domainSnapshots?.attachments || null,
    )
    renewStagingLease()
    stagedArtifacts = stageManagedDeletionDomain({
      root: managed.deletion.artifacts.root,
      stagePath: paths.artifactStagePath,
      domain: 'artifacts',
      entries: managed.deletion.artifacts.entries,
      operationId,
      userId: safeUserId,
      expectedSnapshot: preparedImpact?.files?.domainSnapshots?.artifacts || null,
      fileSystem,
    })
    renewStagingLease()
    stagedData = stageManagedDeletionDomain({
      root: managed.deletion.data.root,
      stagePath: paths.dataStagePath,
      domain: 'data',
      entries: managed.deletion.data.entries,
      operationId,
      userId: safeUserId,
      expectedSnapshot: preparedImpact?.files?.domainSnapshots?.data || null,
      fileSystem,
    })
    renewStagingLease()
    const compactionStageResult = compactionArchivePort.stageDeletion({
      userId: safeUserId,
      scope: { kind: 'user' },
      operationId,
      expectedDigest: archiveDeletionPreview.digest,
    })
    compactionStageReceipt = {
      userId: safeUserId,
      operationId,
      stageToken: compactionStageResult.stageToken,
      digest: compactionStageResult.digest,
    }
    persistCompactionStageReceipt(db, {
      operationId,
      userId: safeUserId,
      compactionPortId: compactionArchivePort.id,
      compactionGovernanceVersion: compactionArchivePort.governanceApiVersion,
      compactionDigest: compactionStageReceipt.digest,
      stageToken: compactionStageReceipt.stageToken,
    })
    renewStagingLease()
    stagedAttachments.assertStable()
    stagedArtifacts.assertStable()
    stagedData.assertStable()
    compactionArchivePort.assertDeletionStable(compactionStageReceipt)
    const deleted = db.transaction(() => {
      db.pragma('defer_foreign_keys = ON')
      renewStagingLease()
      assertUserRuntimeIdle(db, safeUserId)
      stagedAttachments.assertStable()
      stagedArtifacts.assertStable()
      stagedData.assertStable()
      compactionArchivePort.assertDeletionStable(compactionStageReceipt)
      if (preview) {
        assertClearPreviewMatches(preview, {
          database: clearDatabaseImpact(collectDatabaseRows(db, safeUserId).records),
        }, { databaseOnly: true })
      }
      // The artifact files have already moved to staging, but another owner
      // may have acquired a reference immediately before this IMMEDIATE
      // transaction. Recheck under SQLite's write lock before authorizing
      // either database deletion or later physical cleanup.
      assertArtifactDeletionStillExclusive({
        db,
        catalogByName,
        userId: safeUserId,
        entries: managed.deletion.artifacts.entries,
      })
      const counts = {}
      for (const name of unownedDeletionOrder) {
        const table = catalogByName.get(name)
        counts[name] = deleteCollectedRows(db, table, records[name])
      }
      for (const table of ownedTables.filter((entry) => entry.name !== 'sessions')) {
        const ownerColumn = userOwnershipColumn(table)
        counts[table.name] = db.prepare(
          `DELETE FROM ${quoteIdentifier(table.name)} WHERE ${quoteIdentifier(ownerColumn)} = ?`,
        ).run(safeUserId).changes
      }
      counts.sessions = db.prepare(`
        DELETE FROM sessions
        WHERE user_id = ? AND (id IS NOT NULL OR title IS NOT NULL)
      `).run(safeUserId).changes
      for (const table of ownedTables) {
        const remaining = table.name === 'sessions'
          ? db.prepare(`
              SELECT COUNT(*) AS count FROM sessions
              WHERE user_id = ? AND (id IS NOT NULL OR title IS NOT NULL)
            `).get(safeUserId).count
          : db.prepare(`
              SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)}
              WHERE ${quoteIdentifier(userOwnershipColumn(table))} = ?
            `).get(safeUserId).count
        if (remaining !== 0) {
          throw governanceError('USER_DATA_CLEAR_INCOMPLETE', `Could not clear ${table.name}`, 500)
        }
      }
      for (const name of unownedDeletionOrder) {
        assertCollectedRowsDeleted(db, catalogByName.get(name), records[name])
      }
      const resetAccount = db.prepare(`
        UPDATE users SET updated_at = ? WHERE id = ?
      `).run(Date.now(), safeUserId)
      if (resetAccount.changes !== 1) {
        throw governanceError(
          'USER_DATA_CLEAR_INCOMPLETE',
          'Could not reset retained account metadata',
          500,
        )
      }
      const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all()
      if (foreignKeyViolations.length) {
        throw governanceError(
          'USER_DATA_CLEAR_INCOMPLETE',
          'Could not clear user data without violating relational ownership boundaries',
          500,
          null,
          { incomplete: true, databaseCleared: false },
        )
      }
      const marked = db.prepare(`
        UPDATE user_data_clear_operations
        SET status = ?, lease_owner = ?, lease_pid = ?, lease_expires_at = ?, updated_at = ?
        WHERE operation_id = ? AND owner_id = ? AND status = ? AND lease_owner = ?
          AND operation_kind = 'user_clear' AND session_id IS NULL
          AND compaction_port_id = ?
          AND compaction_governance_version = ?
          AND compaction_digest = ?
          AND compaction_stage_token = ?
      `).run(
        CLEAR_OPERATION_COMMITTED,
        CLEAR_OPERATION_LEASE_OWNER,
        process.pid,
        Date.now() + CLEAR_OPERATION_LEASE_MS,
        Date.now(),
        operationId,
        safeUserId,
        CLEAR_OPERATION_STAGING,
        CLEAR_OPERATION_LEASE_OWNER,
        compactionArchivePort.id,
        compactionArchivePort.governanceApiVersion,
        compactionStageReceipt.digest,
        compactionStageReceipt.stageToken,
      )
      if (marked.changes !== 1) {
        throw governanceError(
          'USER_DATA_CLEAR_JOURNAL_INVALID',
          'The user-data clear journal could not be committed',
          500,
          null,
          { incomplete: true, databaseCleared: false },
        )
      }
      return counts
    }).immediate()
    databaseCommitted = true
    const renewCommittedLease = () => renewClearOperationLease(db, {
      operationId,
      userId: safeUserId,
      status: CLEAR_OPERATION_COMMITTED,
    })
    let walCheckpoint
    try {
      renewCommittedLease()
      compactionArchivePort.commitDeletion(compactionStageReceipt)
      renewCommittedLease()
      stagedArtifacts.cleanup()
      renewCommittedLease()
      stagedData.cleanup()
      renewCommittedLease()
      stagedAttachments.cleanup()
      renewCommittedLease()
      stagedEmergencyJournals.cleanup()
      renewCommittedLease()
      walCheckpoint = checkpointUserDataWal(db)
      renewCommittedLease()
      deleteClearOperation(db, {
        operationId,
        userId: safeUserId,
        status: CLEAR_OPERATION_COMMITTED,
      })
    } catch (cause) {
      if (cause?.code?.startsWith('USER_DATA_')) {
        cause.incomplete = true
        cause.databaseCleared = true
        cause.cleanupPending = true
        throw cause
      }
      throw governanceError(
        'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
        'User data is no longer active, but physical file cleanup is still pending',
        500,
        cause,
        { incomplete: true, databaseCleared: true, cleanupPending: true },
      )
    }
    clearResult = {
      ok: true,
      deleted,
      accountPreserved: true,
      authenticationSessionsPreserved: true,
      retainedAccountFieldsReset: [],
      attachmentFilesRemoved: true,
      artifactFiles: managed.stats.artifactFiles,
      managedFiles: managed.stats.managedFiles,
      emergencyFailureJournals: stagedEmergencyJournals.stats,
      walCheckpoint,
    }
  } catch (error) {
    let failure = error
    if (!databaseCommitted) {
      const rollbackErrors = []
      if (operationId) {
        try {
          recoverCompactionArchiveDeletion({
            port: compactionArchivePort,
            userId: safeUserId,
            operationId,
            binding: {
              digest: archiveDeletionPreview.digest,
              stageToken: compactionStageReceipt?.stageToken || null,
            },
            databaseCommitted: false,
          })
        } catch (rollbackCause) {
          rollbackErrors.push(rollbackCause)
        }
      }
      for (const stage of [
        stagedData,
        stagedArtifacts,
        stagedAttachments,
        stagedEmergencyJournals,
      ]) {
        try { stage?.rollback() } catch (rollbackCause) { rollbackErrors.push(rollbackCause) }
      }
      let recoveryEvidence = !!error?.recoveryRequired
      if (operationId) {
        const paths = clearOperationPaths({ userId: safeUserId, operationId, env })
        recoveryEvidence ||= [
          paths.dataStagePath,
          paths.artifactStagePath,
          paths.attachmentStagePath,
        ].some((target) => pathExists(fileSystem, target))
        if (!rollbackErrors.length && !recoveryEvidence) {
          const released = deleteClearOperation(db, {
            operationId,
            userId: safeUserId,
            status: CLEAR_OPERATION_STAGING,
            required: false,
          })
          if (!released && error?.code !== 'USER_DATA_CLEAR_LEASE_LOST') recoveryEvidence = true
        }
      }
      if (rollbackErrors.length || recoveryEvidence) {
        failure = governanceError(
          'USER_DATA_CLEAR_RECOVERY_INCOMPLETE',
          'The failed user-data clear could not fully restore staged files; recovery evidence was retained',
          500,
          new AggregateError([error, ...rollbackErrors]),
          {
            incomplete: true,
            databaseCleared: false,
            cleanupPending: true,
            recoveryRequired: true,
          },
        )
      }
    }
    terminalError = failure
  } finally {
    activeClears.delete(safeUserId)
  }
  try {
    governanceLease.release()
  } catch (releaseError) {
    if (terminalError) {
      throw new AggregateError(
        [terminalError, releaseError],
        'User-data clear failed and its compaction governance lease could not be released',
        { cause: releaseError },
      )
    }
    throw releaseError
  }
  if (terminalError) throw terminalError
  return clearResult
}
