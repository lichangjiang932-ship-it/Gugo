import { createHash, randomUUID } from 'node:crypto'

import { getDb } from '../db.js'

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/u
const TOKEN_RE = /^[a-zA-Z0-9._:-]{16,128}$/u
const SHA256_RE = /^sha256-[a-f0-9]{64}$/u
const PHASES = new Set(['guarding', 'mutating', 'refreshing'])
const RECOVERY_PHASES = new Set([...PHASES, 'recovery_required'])
const MAX_PLUGIN_IDS = 1_024
const RECOVERY_OUTCOMES = new Set(['installed', 'uninstalled'])
const RECOVERY_AUTHORIZATIONS = new Set([
  'explicit_recovery_required',
  'owner_process_not_alive',
])

function barrierError(code, message, statusCode, retryable = false) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    retryable,
  })
}

function normalizePluginId(value) {
  const pluginId = String(value || '').trim().toLowerCase()
  if (!PLUGIN_ID_RE.test(pluginId)) throw new TypeError('pluginId is invalid')
  return pluginId
}

function normalizePluginIds(values) {
  const source = Array.isArray(values) ? values : [values]
  if (source.length > MAX_PLUGIN_IDS) throw new TypeError('too many pluginIds')
  return [...new Set(source.filter((value) => value != null).map(normalizePluginId))]
    .sort((left, right) => left.localeCompare(right, 'en'))
}

function normalizeTimestamp(value, label = 'now') {
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
  return timestamp
}

function normalizeGeneration(value) {
  const generation = Number(value)
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new TypeError('generation must be a positive safe integer')
  }
  return generation
}

function normalizeToken(value) {
  const token = String(value || '').trim()
  if (!TOKEN_RE.test(token)) throw new TypeError('token is invalid')
  return token
}

function normalizeOwnerPid(value) {
  const ownerPid = Number(value)
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 0) {
    throw new TypeError('ownerPid must be a non-negative safe integer')
  }
  return ownerPid
}

function normalizeStoreRevision(value) {
  if (value == null) return null
  const revision = String(value).trim().toLowerCase()
  if (!SHA256_RE.test(revision)) throw new TypeError('storeRevision is invalid')
  return revision
}

function normalizePhase(value) {
  const phase = String(value || '').trim()
  if (!PHASES.has(phase)) throw new TypeError('phase is invalid')
  return phase
}

function normalizeNonNegativeCount(value, label) {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
  return count
}

function normalizeRecoveryEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('recovery evidence must be an object')
  }
  const outcome = String(value.outcome || '')
  if (!RECOVERY_OUTCOMES.has(outcome)) throw new TypeError('recovery outcome is invalid')
  const recoveryAuthorization = String(value.recoveryAuthorization || '')
  if (!RECOVERY_AUTHORIZATIONS.has(recoveryAuthorization)) {
    throw new TypeError('recovery authorization is invalid')
  }
  const barrierPhase = String(value.barrierPhase || '')
  if (!RECOVERY_PHASES.has(barrierPhase)) throw new TypeError('barrierPhase is invalid')
  const barrierOwnerPid = normalizeOwnerPid(value.barrierOwnerPid)
  const barrierHeartbeatAt = normalizeTimestamp(value.barrierHeartbeatAt, 'barrierHeartbeatAt')
  const barrierStoreRevision = normalizeStoreRevision(value.barrierStoreRevision)
  if (typeof value.barrierRecoveryRequired !== 'boolean') {
    throw new TypeError('barrierRecoveryRequired must be a boolean')
  }
  const explicitRecovery = recoveryAuthorization === 'explicit_recovery_required'
  if (
    explicitRecovery !== value.barrierRecoveryRequired
    || explicitRecovery !== (barrierPhase === 'recovery_required')
  ) {
    throw new TypeError('recovery authorization does not match the barrier phase')
  }
  const booleanFields = [
    'diskInstalled',
    'registryPresent',
    'runtimeInventoryPresent',
    'runtimeStatePresent',
    'permissionGrantPresent',
    'runtimeEnabled',
    'runtimeActive',
  ]
  for (const field of booleanFields) {
    if (typeof value[field] !== 'boolean') throw new TypeError(`${field} must be a boolean`)
  }
  const observedStoreRevision = normalizeStoreRevision(value.observedStoreRevision)
  if (!observedStoreRevision) throw new TypeError('observedStoreRevision is required')
  const referenceDigest = normalizeStoreRevision(value.referenceDigest)
  if (!referenceDigest) throw new TypeError('referenceDigest is required')
  const packageDigest = value.packageDigest == null ? null : normalizeStoreRevision(value.packageDigest)
  const registryRevision = normalizeNonNegativeCount(value.registryRevision, 'registryRevision')
  const runtimeState = String(value.runtimeState || '')
  if (runtimeState !== 'inactive') throw new TypeError('runtimeState must be inactive')
  const releaseCount = normalizeNonNegativeCount(value.releaseCount, 'releaseCount')
  const pinCount = normalizeNonNegativeCount(value.pinCount, 'pinCount')
  const checkpointCount = normalizeNonNegativeCount(value.checkpointCount, 'checkpointCount')
  const referenceCount = normalizeNonNegativeCount(value.referenceCount, 'referenceCount')
  if (
    value.runtimeEnabled
    || value.runtimeActive
    || releaseCount !== 0
    || pinCount !== 0
    || checkpointCount !== 0
    || referenceCount !== 0
  ) {
    throw new TypeError('recovery evidence contains an active runtime dependency')
  }
  if (outcome === 'installed') {
    if (!value.diskInstalled || !value.registryPresent || !packageDigest) {
      throw new TypeError('installed recovery evidence is incomplete')
    }
  } else if (
    value.diskInstalled
    || value.registryPresent
    || value.runtimeInventoryPresent
    || value.runtimeStatePresent
    || value.permissionGrantPresent
    || packageDigest
  ) {
    throw new TypeError('uninstalled recovery evidence contains residual state')
  }
  return Object.freeze({
    schemaVersion: 1,
    outcome,
    recoveryAuthorization,
    barrierPhase,
    barrierOwnerPid,
    barrierHeartbeatAt,
    barrierStoreRevision,
    barrierRecoveryRequired: value.barrierRecoveryRequired,
    observedStoreRevision,
    registryRevision,
    packageDigest,
    diskInstalled: value.diskInstalled,
    registryPresent: value.registryPresent,
    runtimeInventoryPresent: value.runtimeInventoryPresent,
    runtimeStatePresent: value.runtimeStatePresent,
    permissionGrantPresent: value.permissionGrantPresent,
    runtimeEnabled: false,
    runtimeActive: false,
    runtimeState,
    releaseCount,
    pinCount,
    checkpointCount,
    referenceCount,
    referenceDigest,
  })
}

function publicBarrier(row) {
  return row ? Object.freeze({
    pluginId: row.plugin_id,
    generation: Number(row.generation),
    operation: row.operation,
    phase: row.phase,
    ownerPid: Number(row.owner_pid),
    storeRevision: row.store_revision || null,
    createdAt: Number(row.created_at),
    heartbeatAt: Number(row.heartbeat_at),
    recoveryRequired: row.recovery_required === 1,
  }) : null
}

function leaseView(row) {
  const barrier = publicBarrier(row)
  return Object.freeze({
    ...barrier,
    token: row.token,
  })
}

function selectBarrier(db, pluginId) {
  return db.prepare(`
    SELECT plugin_id, token, generation, operation, phase, owner_pid,
      store_revision, created_at, heartbeat_at, recovery_required
    FROM runtime_plugin_mutation_barriers
    WHERE plugin_id = ?
  `).get(pluginId)
}

function activeBarrierError(row) {
  if (row?.recovery_required === 1) {
    return barrierError(
      'PLUGIN_LIFECYCLE_BARRIER_RECOVERY_REQUIRED',
      '插件包生命周期屏障需要本地恢复，已拒绝继续修改',
      503,
      false,
    )
  }
  return barrierError(
    'PLUGIN_LIFECYCLE_EXCLUSIVE_OPERATION_ACTIVE',
    '插件生命周期正在执行独占操作，请稍后重试',
    409,
    true,
  )
}

function ownershipLostError() {
  return barrierError(
    'PLUGIN_LIFECYCLE_BARRIER_OWNERSHIP_LOST',
    '插件包生命周期屏障所有权已变化',
    409,
    false,
  )
}

function integrityError() {
  return barrierError(
    'PLUGIN_LIFECYCLE_BARRIER_INTEGRITY_ERROR',
    '插件包生命周期屏障状态不完整，需要本地恢复',
    503,
    false,
  )
}

export function getRuntimePluginMutationBarrier(pluginId, { db = getDb() } = {}) {
  return publicBarrier(selectBarrier(db, normalizePluginId(pluginId)))
}

export function listRuntimePluginMutationBarriers({
  recoveryRequired = null,
  db = getDb(),
} = {}) {
  if (recoveryRequired !== null && typeof recoveryRequired !== 'boolean') {
    throw new TypeError('recoveryRequired must be a boolean or null')
  }
  const rows = db.prepare(`
    SELECT plugin_id, token, generation, operation, phase, owner_pid,
      store_revision, created_at, heartbeat_at, recovery_required
    FROM runtime_plugin_mutation_barriers
    WHERE (? IS NULL OR recovery_required = ?)
    ORDER BY plugin_id ASC
    LIMIT 1025
  `).all(
    recoveryRequired === null ? null : Number(recoveryRequired),
    recoveryRequired === null ? null : Number(recoveryRequired),
  )
  if (!Array.isArray(rows) || rows.length > 1_024) throw integrityError()
  return Object.freeze(rows.map(publicBarrier))
}

export function hasRuntimePluginMutationBarrier(pluginId, { db = getDb() } = {}) {
  return Boolean(selectBarrier(db, normalizePluginId(pluginId)))
}

export function assertRuntimePluginMutationAvailable(pluginIds, { db = getDb() } = {}) {
  const ids = normalizePluginIds(pluginIds)
  if (ids.length === 0) return true
  const placeholders = ids.map(() => '?').join(', ')
  const row = db.prepare(`
    SELECT plugin_id, token, generation, operation, phase, owner_pid,
      store_revision, created_at, heartbeat_at, recovery_required
    FROM runtime_plugin_mutation_barriers
    WHERE plugin_id IN (${placeholders})
    ORDER BY plugin_id ASC
    LIMIT 1
  `).get(...ids)
  if (row) throw activeBarrierError(row)
  return true
}

export function acquireRuntimePluginMutationBarrier(pluginId, {
  db = getDb(),
  token = randomUUID(),
  now = Date.now(),
  ownerPid = process.pid,
  operation = 'uninstall',
  phase = 'guarding',
  storeRevision = null,
} = {}) {
  const id = normalizePluginId(pluginId)
  const leaseToken = normalizeToken(token)
  const timestamp = normalizeTimestamp(now)
  const pid = normalizeOwnerPid(ownerPid)
  const normalizedPhase = normalizePhase(phase)
  const revision = normalizeStoreRevision(storeRevision)
  if (operation !== 'uninstall') throw new TypeError('operation must be uninstall')

  return db.transaction(() => {
    const existing = selectBarrier(db, id)
    if (existing) throw activeBarrierError(existing)
    const previous = db.prepare(`
      SELECT last_generation, generation_claimed
      FROM runtime_plugin_mutation_barrier_generations
      WHERE plugin_id = ?
    `).get(id)
    if (previous && Number(previous.generation_claimed) !== 1) {
      throw integrityError()
    }
    const generation = (Number(previous?.last_generation) || 0) + 1
    normalizeGeneration(generation)
    if (previous) {
      const advanced = db.prepare(`
        UPDATE runtime_plugin_mutation_barrier_generations SET
          last_generation = ?, generation_claimed = 0
        WHERE plugin_id = ?
          AND last_generation = ?
          AND generation_claimed = 1
      `).run(generation, id, Number(previous.last_generation))
      if (advanced.changes !== 1) throw integrityError()
    } else {
      db.prepare(`
        INSERT INTO runtime_plugin_mutation_barrier_generations (
          plugin_id, last_generation, generation_claimed
        ) VALUES (?, ?, 0)
      `).run(id, generation)
    }
    db.prepare(`
      INSERT INTO runtime_plugin_mutation_barriers (
        plugin_id, token, generation, operation, phase, owner_pid,
        store_revision, created_at, heartbeat_at, recovery_required
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      id,
      leaseToken,
      generation,
      operation,
      normalizedPhase,
      pid,
      revision,
      timestamp,
      timestamp,
    )
    return leaseView(selectBarrier(db, id))
  }).immediate()
}

export function heartbeatRuntimePluginMutationBarrier({
  pluginId,
  token,
  generation,
  phase = 'guarding',
  now = Date.now(),
  db = getDb(),
} = {}) {
  const id = normalizePluginId(pluginId)
  const leaseToken = normalizeToken(token)
  const leaseGeneration = normalizeGeneration(generation)
  const timestamp = normalizeTimestamp(now)
  const normalizedPhase = normalizePhase(phase)
  const changed = db.prepare(`
    UPDATE runtime_plugin_mutation_barriers SET
      phase = ?, heartbeat_at = ?
    WHERE plugin_id = ? AND token = ? AND generation = ?
      AND recovery_required = 0 AND heartbeat_at <= ?
  `).run(
    normalizedPhase,
    timestamp,
    id,
    leaseToken,
    leaseGeneration,
    timestamp,
  )
  if (changed.changes !== 1) {
    const current = selectBarrier(db, id)
    if (current?.recovery_required === 1) throw activeBarrierError(current)
    throw ownershipLostError()
  }
  return leaseView(selectBarrier(db, id))
}

export function markRuntimePluginMutationBarrierRecoveryRequired({
  pluginId,
  token,
  generation,
  now = Date.now(),
  db = getDb(),
} = {}) {
  const id = normalizePluginId(pluginId)
  const leaseToken = normalizeToken(token)
  const leaseGeneration = normalizeGeneration(generation)
  const timestamp = normalizeTimestamp(now)
  const changed = db.prepare(`
    UPDATE runtime_plugin_mutation_barriers SET
      phase = 'recovery_required', recovery_required = 1, heartbeat_at = ?
    WHERE plugin_id = ? AND token = ? AND generation = ?
      AND heartbeat_at <= ?
  `).run(timestamp, id, leaseToken, leaseGeneration, timestamp)
  if (changed.changes !== 1) throw ownershipLostError()
  return publicBarrier(selectBarrier(db, id))
}

export function releaseRuntimePluginMutationBarrier({
  pluginId,
  token,
  generation,
  db = getDb(),
} = {}) {
  const id = normalizePluginId(pluginId)
  const leaseToken = normalizeToken(token)
  const leaseGeneration = normalizeGeneration(generation)
  return db.transaction(() => {
    const changed = db.prepare(`
      DELETE FROM runtime_plugin_mutation_barriers
      WHERE plugin_id = ? AND token = ? AND generation = ?
        AND recovery_required = 0
    `).run(id, leaseToken, leaseGeneration)
    if (changed.changes !== 1) {
      const current = selectBarrier(db, id)
      if (current?.recovery_required === 1) throw activeBarrierError(current)
      throw ownershipLostError()
    }
    return true
  }).immediate()
}

/**
 * Atomically append verified recovery evidence and CAS-delete the exact lease.
 * Filesystem/registry attestations are produced by localPluginPackageService;
 * database residue is independently rechecked here while the barrier is live.
 */
export function completeRuntimePluginMutationBarrierRecovery({
  pluginId,
  generation,
  evidence,
  receiptId = randomUUID(),
  now = Date.now(),
  db = getDb(),
} = {}) {
  const id = normalizePluginId(pluginId)
  const expectedGeneration = normalizeGeneration(generation)
  const normalizedEvidence = normalizeRecoveryEvidence(evidence)
  const idempotencyKey = normalizeToken(receiptId)
  const verifiedAt = normalizeTimestamp(now)
  return db.transaction(() => {
    const current = selectBarrier(db, id)
    if (!current || Number(current.generation) !== expectedGeneration) {
      throw ownershipLostError()
    }
    const currentRecoveryRequired = Number(current.recovery_required) === 1
    const explicitlyRecoverable = current.phase === 'recovery_required' && currentRecoveryRequired
    const orphanRecoverable = PHASES.has(current.phase) && !currentRecoveryRequired
    if (!explicitlyRecoverable && !orphanRecoverable) {
      throw barrierError(
        'PLUGIN_LIFECYCLE_BARRIER_NOT_RECOVERABLE',
        '插件包生命周期屏障不处于可恢复状态',
        409,
        false,
      )
    }
    if (
      current.phase !== normalizedEvidence.barrierPhase
      || Number(current.owner_pid) !== normalizedEvidence.barrierOwnerPid
      || Number(current.heartbeat_at) !== normalizedEvidence.barrierHeartbeatAt
      || (current.store_revision || null) !== normalizedEvidence.barrierStoreRevision
      || currentRecoveryRequired !== normalizedEvidence.barrierRecoveryRequired
      || explicitlyRecoverable !== (
        normalizedEvidence.recoveryAuthorization === 'explicit_recovery_required'
      )
    ) {
      throw ownershipLostError()
    }
    const residue = db.prepare(`
      SELECT
        EXISTS(SELECT 1 FROM runtime_plugin_states WHERE plugin_id = ?) AS has_state,
        COALESCE((SELECT enabled FROM runtime_plugin_states WHERE plugin_id = ?), 0) AS enabled,
        COALESCE((SELECT active_release_id FROM runtime_plugin_states WHERE plugin_id = ?), '') AS active_release_id,
        COALESCE((SELECT previous_release_id FROM runtime_plugin_states WHERE plugin_id = ?), '') AS previous_release_id,
        COALESCE((SELECT last_rollback_from_release_id FROM runtime_plugin_states WHERE plugin_id = ?), '') AS rollback_from_release_id,
        COALESCE((SELECT last_rollback_to_release_id FROM runtime_plugin_states WHERE plugin_id = ?), '') AS rollback_to_release_id,
        (SELECT COUNT(*) FROM runtime_plugin_releases WHERE plugin_id = ?) AS release_count,
        (SELECT COUNT(*) FROM runtime_plugin_release_pins WHERE plugin_id = ?) AS pin_count,
        EXISTS(SELECT 1 FROM runtime_plugin_permission_grants WHERE plugin_id = ?) AS has_grant
    `).get(id, id, id, id, id, id, id, id, id)
    if (
      Number(residue?.enabled) !== 0
      || residue?.active_release_id
      || residue?.previous_release_id
      || residue?.rollback_from_release_id
      || residue?.rollback_to_release_id
      || Number(residue?.release_count) !== 0
      || Number(residue?.pin_count) !== 0
      || Boolean(residue?.has_state) !== normalizedEvidence.runtimeStatePresent
      || Boolean(residue?.has_grant) !== normalizedEvidence.permissionGrantPresent
    ) {
      throw integrityError()
    }
    if (
      normalizedEvidence.outcome === 'installed'
      && current.store_revision !== normalizedEvidence.observedStoreRevision
    ) {
      throw integrityError()
    }
    const tokenFingerprint = `sha256-${createHash('sha256').update(current.token).digest('hex')}`
    const receipt = Object.freeze({
      receiptId: idempotencyKey,
      pluginId: id,
      generation: expectedGeneration,
      operation: current.operation,
      tokenFingerprint,
      barrierStoreRevision: current.store_revision || null,
      observedStoreRevision: normalizedEvidence.observedStoreRevision,
      evidence: normalizedEvidence,
      verifiedAt,
    })
    db.prepare(`
      INSERT INTO runtime_plugin_mutation_recovery_receipts (
        receipt_id, plugin_id, generation, operation, token_fingerprint,
        barrier_store_revision, observed_store_revision, evidence_json, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.receiptId,
      receipt.pluginId,
      receipt.generation,
      receipt.operation,
      receipt.tokenFingerprint,
      receipt.barrierStoreRevision,
      receipt.observedStoreRevision,
      JSON.stringify(receipt.evidence),
      receipt.verifiedAt,
    )
    const changed = db.prepare(`
      DELETE FROM runtime_plugin_mutation_barriers
      WHERE plugin_id = ? AND token = ? AND generation = ?
        AND phase = ? AND recovery_required = ?
        AND owner_pid = ? AND heartbeat_at = ? AND store_revision IS ?
    `).run(
      id,
      current.token,
      expectedGeneration,
      current.phase,
      Number(current.recovery_required),
      Number(current.owner_pid),
      Number(current.heartbeat_at),
      current.store_revision || null,
    )
    if (changed.changes !== 1) throw ownershipLostError()
    return receipt
  }).immediate()
}
