import { getDb } from '../db.js'
import { BUILTIN_PLUGIN_SOURCE } from '../plugins/pluginDistributionSources.js'
import {
  PLUGIN_ID_RE,
  normalizePluginId,
  serviceError,
} from './localPluginPackageServiceContracts.js'

const MAX_RELEASE_GUARD_ROWS = 100_000
const BLOCKING_REASON = Object.freeze({
  BUILTIN: 'builtin_plugin',
  DEPENDANT: 'manifest_dependant',
  ENABLED: 'runtime_enabled',
  ACTIVE: 'runtime_active',
  RUNTIME_STATE: 'runtime_state_not_inactive',
  RELEASE: 'retained_release',
  PIN: 'release_pin',
  CHECKPOINT: 'checkpoint_reference',
  REFERENCE: 'release_reference',
})

export function isLocalProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

/**
 * Remove installation-scoped authority only after the managed package has
 * been deleted. The predicate is intentionally stricter than a plain DELETE:
 * an enabled state or any retained Release identity turns a post-delete
 * inconsistency into recovery work instead of silently erasing evidence.
 */
export function cleanupUninstalledRuntimePluginSecurityState(
  pluginId,
  { db = getDb() } = {},
) {
  const id = normalizePluginId(pluginId)
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('db is required')
  }
  return db.transaction(() => {
    const state = db.prepare(`
      SELECT enabled, active_release_id, previous_release_id,
        last_rollback_from_release_id, last_rollback_to_release_id
      FROM runtime_plugin_states
      WHERE plugin_id = ?
    `).get(id)
    const retained = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM runtime_plugin_releases WHERE plugin_id = ?) AS release_count,
        (SELECT COUNT(*) FROM runtime_plugin_release_pins WHERE plugin_id = ?) AS pin_count
    `).get(id, id)
    const unsafeState = state && (
      state.enabled !== 0
      || state.active_release_id != null
      || state.previous_release_id != null
      || state.last_rollback_from_release_id != null
      || state.last_rollback_to_release_id != null
    )
    if (unsafeState || Number(retained?.release_count) !== 0 || Number(retained?.pin_count) !== 0) {
      throw serviceError('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503, {
        pluginId: id,
        blockingReasons: ['post_uninstall_security_state'],
      })
    }

    const grantChanges = db.prepare(
      'DELETE FROM runtime_plugin_permission_grants WHERE plugin_id = ?',
    ).run(id).changes
    const stateChanges = db.prepare(`
      DELETE FROM runtime_plugin_states
      WHERE plugin_id = ?
        AND enabled = 0
        AND active_release_id IS NULL
        AND previous_release_id IS NULL
        AND last_rollback_from_release_id IS NULL
        AND last_rollback_to_release_id IS NULL
    `).run(id).changes
    if (grantChanges > 1 || stateChanges > 1 || (state && stateChanges !== 1)) {
      throw serviceError('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503, {
        pluginId: id,
        blockingReasons: ['post_uninstall_security_state'],
      })
    }

    const residue = db.prepare(`
      SELECT
        EXISTS(SELECT 1 FROM runtime_plugin_permission_grants WHERE plugin_id = ?) AS has_grant,
        EXISTS(SELECT 1 FROM runtime_plugin_states WHERE plugin_id = ?) AS has_state
    `).get(id, id)
    if (residue?.has_grant || residue?.has_state) {
      throw serviceError('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503, {
        pluginId: id,
        blockingReasons: ['post_uninstall_security_state'],
      })
    }
    return Object.freeze({
      pluginId: id,
      permissionGrantRemoved: grantChanges === 1,
      runtimeStateRemoved: stateChanges === 1,
    })
  }).immediate()
}

export function distributedPlugins(dependencies) {
  let plugins
  try {
    plugins = dependencies.listDistributedPlugins()
  } catch {
    throw serviceError('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503)
  }
  if (!Array.isArray(plugins)) {
    throw serviceError('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503)
  }
  return plugins
}

function builtinPluginIds(plugins) {
  const ids = []
  for (const plugin of plugins) {
    if (plugin?.distribution?.sourceKind !== BUILTIN_PLUGIN_SOURCE) continue
    if (!PLUGIN_ID_RE.test(String(plugin.id || ''))) {
      throw serviceError('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503)
    }
    ids.push(plugin.id)
  }
  return Object.freeze([...new Set(ids)].sort((left, right) => left.localeCompare(right, 'en')))
}

export function protectedBuiltinPluginIds(source, plugins) {
  const activeIds = builtinPluginIds(plugins)
  if (!Object.hasOwn(source, 'protectedPluginIds')) return activeIds
  if (
    source.protectedPluginIdentityComplete !== true
    || !Array.isArray(source.protectedPluginIds)
  ) {
    throw serviceError('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503, {
      blockingReasons: ['guard_unavailable'],
    })
  }
  const ids = [...activeIds]
  for (const candidate of source.protectedPluginIds) {
    if (!PLUGIN_ID_RE.test(String(candidate || ''))) {
      throw serviceError('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503, {
        blockingReasons: ['guard_unavailable'],
      })
    }
    ids.push(candidate)
  }
  return Object.freeze([...new Set(ids)].sort((left, right) => left.localeCompare(right, 'en')))
}

export function dependantPluginIds(plugins, pluginId) {
  const ids = []
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== 'object' || !Array.isArray(plugin.requires)) {
      throw serviceError('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503)
    }
    if (plugin.id !== pluginId && plugin.requires.includes(pluginId)) ids.push(plugin.id)
  }
  return Object.freeze([...new Set(ids)].sort((left, right) => left.localeCompare(right, 'en')))
}

export function managedPackagePlugins(dependencies, managedRoot) {
  let discovered
  try {
    discovered = dependencies.discoverInstalledLocalPluginPackagesSync({
      managedRoot,
    })
  } catch {
    throw serviceError('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503, {
      blockingReasons: ['guard_unavailable'],
    })
  }
  if (
    !discovered
    || !Array.isArray(discovered.plugins)
    || !Array.isArray(discovered.errors)
    || discovered.errors.length > 0
  ) {
    throw serviceError('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503, {
      blockingReasons: ['guard_unavailable'],
    })
  }
  return discovered.plugins.map((entry) => {
    const plugin = entry?.plugin
    if (!plugin || typeof plugin !== 'object' || !PLUGIN_ID_RE.test(String(plugin.id || ''))) {
      throw serviceError('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503, {
        blockingReasons: ['guard_unavailable'],
      })
    }
    return plugin
  })
}

export function runtimeBlocker(dependencies, pluginId) {
  const inventory = dependencies.listRuntimePluginInventory()
  if (!Array.isArray(inventory)) throw new TypeError('runtime inventory is unavailable')
  const entries = inventory.filter((entry) => entry?.id === pluginId)
  if (entries.length > 1) throw new TypeError('runtime inventory contains duplicate identities')
  const entry = entries[0] || null
  const state = dependencies.getRuntimePluginState(pluginId)
  if (state && state.pluginId !== pluginId) throw new TypeError('runtime state identity mismatch')
  const enabled = entry?.enabled === true || state?.enabled === true
  const active = entry?.active === true
  const runtimeState = entry ? String(entry.runtimeState || '') : 'inactive'
  const reasons = []
  if (enabled) reasons.push(BLOCKING_REASON.ENABLED)
  if (active) reasons.push(BLOCKING_REASON.ACTIVE)
  if (runtimeState !== 'inactive') reasons.push(BLOCKING_REASON.RUNTIME_STATE)
  return {
    enabled,
    active,
    runtimeState,
    inventoryPresent: Boolean(entry),
    statePresent: Boolean(state),
    reasons,
  }
}

function loadVerifiedReleaseMap(dependencies) {
  const db = dependencies.getDb()
  const rows = db.prepare(`
    SELECT plugin_id, release_id
    FROM runtime_plugin_releases
    ORDER BY plugin_id ASC, release_id ASC
    LIMIT ?
  `).all(MAX_RELEASE_GUARD_ROWS + 1)
  if (!Array.isArray(rows) || rows.length > MAX_RELEASE_GUARD_ROWS) {
    throw new TypeError('runtime Release inventory exceeds the safety limit')
  }
  const releasesById = new Map()
  for (const row of rows) {
    const release = dependencies.getRuntimePluginRelease(row?.plugin_id, row?.release_id)
    if (
      !release
      || release.pluginId !== row.plugin_id
      || release.releaseId !== row.release_id
      || releasesById.has(release.releaseId)
    ) {
      throw new TypeError('runtime Release inventory cannot be verified')
    }
    releasesById.set(release.releaseId, release)
  }
  return { db, releasesById }
}

export function releaseBlocker(dependencies, pluginId) {
  const releaseCount = dependencies.countRuntimePluginReleases(pluginId)
  if (!Number.isSafeInteger(releaseCount) || releaseCount < 0) {
    throw new TypeError('runtime Release count is invalid')
  }
  const pins = dependencies.listRuntimePluginReleasePins({ pluginId })
  if (!Array.isArray(pins)) throw new TypeError('runtime Release pins are unavailable')
  const { db, releasesById } = loadVerifiedReleaseMap(dependencies)
  const collected = dependencies.collectRuntimePluginReleaseProtections(db, releasesById)
  if (!(collected?.protections instanceof Map) || !collected.checkpointStats) {
    throw new TypeError('runtime Release protections are unavailable')
  }
  const targetReleaseIds = [...releasesById.values()]
    .filter((release) => release.pluginId === pluginId)
    .map((release) => release.releaseId)
  if (targetReleaseIds.length !== releaseCount) {
    throw new TypeError('runtime Release count changed during guard evaluation')
  }
  let referenceCount = 0
  let checkpointCount = 0
  for (const releaseId of targetReleaseIds) {
    const references = collected.protections.get(releaseId) || []
    if (!Array.isArray(references)) throw new TypeError('runtime Release protection is invalid')
    referenceCount += references.length
    checkpointCount += references.filter(({ reason }) => (
      reason === 'turn_checkpoint'
      || reason === 'job_checkpoint'
      || reason === 'legacy_turn_checkpoint'
    )).length
  }
  const reasons = []
  if (releaseCount > 0) reasons.push(BLOCKING_REASON.RELEASE)
  if (pins.length > 0) reasons.push(BLOCKING_REASON.PIN)
  if (checkpointCount > 0) reasons.push(BLOCKING_REASON.CHECKPOINT)
  if (referenceCount > 0) reasons.push(BLOCKING_REASON.REFERENCE)
  return {
    releaseCount,
    pinCount: pins.length,
    checkpointCount,
    referenceCount,
    referenceDigest: collected.checkpointStats.referenceDigest,
    reasons,
  }
}

export function assertUninstallSafe(dependencies, pluginId, plugins, protectedPluginIds) {
  if (protectedPluginIds.includes(pluginId)) {
    throw serviceError('PLUGIN_PACKAGE_ID_PROTECTED', 409, {
      pluginId,
      blockingReasons: [BLOCKING_REASON.BUILTIN],
    })
  }
  const dependants = dependantPluginIds(plugins, pluginId)
  if (dependants.length > 0) {
    throw serviceError('PLUGIN_PACKAGE_HAS_DEPENDANTS', 409, {
      pluginId,
      dependantPluginIds: dependants,
      blockingReasons: [BLOCKING_REASON.DEPENDANT],
    })
  }
  let runtime
  let releases
  try {
    runtime = runtimeBlocker(dependencies, pluginId)
    releases = releaseBlocker(dependencies, pluginId)
  } catch {
    throw serviceError('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503, {
      pluginId,
      blockingReasons: ['guard_unavailable'],
    })
  }
  if (runtime.reasons.length > 0) {
    throw serviceError('PLUGIN_PACKAGE_RUNTIME_ACTIVE', 409, {
      pluginId,
      enabled: runtime.enabled,
      active: runtime.active,
      runtimeState: runtime.runtimeState,
      blockingReasons: runtime.reasons,
    })
  }
  if (releases.reasons.length > 0) {
    throw serviceError('PLUGIN_PACKAGE_RELEASES_RETAINED', 409, {
      pluginId,
      releaseCount: releases.releaseCount,
      pinCount: releases.pinCount,
      checkpointCount: releases.checkpointCount,
      referenceCount: releases.referenceCount,
      blockingReasons: releases.reasons,
    })
  }
}
