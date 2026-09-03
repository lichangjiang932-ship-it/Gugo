import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { getDb } from '../db.js'
import { acquireCompactionArchiveGovernanceLease } from './compactionArchiveGovernanceRuntime.js'
import { reapDeadManagedAttachmentUploadLeases } from './managedAttachmentUploadLease.js'
import { collectTurnEmergencyFailureExportFiles } from './turnEmergencyFailureDataGovernance.js'
import { userRuntimeBlockers } from './userDataClearJournal.js'
import { createUserDataGovernanceError as governanceError } from './userDataGovernanceError.js'
import {
  captureUserDataFileSnapshot,
  mergeUserDataFileSnapshots,
} from './userDataFileSnapshot.js'
import { buildManagedUserFileCatalog } from './userDataManagedFileCatalog.js'
import {
  collectDatabaseRows,
  quoteIdentifier,
  rowKey,
} from './userDataRecordGraph.js'

const CLEAR_PREVIEW_VERSION = 1
const CLEAR_PREVIEW_TTL_MS = 5 * 60 * 1000
const CLEAR_PREVIEW_MAX_TOKENS = 1024
const clearPreviewTokens = new Map()

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

export function clearDatabaseImpact(records) {
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

function clearManagedFileImpact({
  managed,
  userId,
  emergencyFiles,
  fileSystem,
  attachmentGovernancePort,
}) {
  const attachments = attachmentGovernancePort.captureUserClearSnapshot({ userId })
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

export function prepareClearImpact({
  userId,
  db,
  env,
  cwd,
  tempDir,
  fileSystem,
  attachmentGovernancePort,
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
      attachmentGovernancePort,
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

export function consumeClearPreviewToken({ token, userId, now }) {
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

export function assertClearPreviewMatches(preview, impact, {
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

export function assertArtifactDeletionStillExclusive({ db, catalogByName, userId, entries }) {
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
  attachmentGovernancePort,
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
        attachmentGovernancePort,
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
