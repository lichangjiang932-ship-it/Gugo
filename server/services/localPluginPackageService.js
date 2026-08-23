import path from 'node:path'

import { getDb } from '../db.js'
import {
  discoverInstalledLocalPluginPackagesSync,
  installLocalPluginPackage,
  listInstalledLocalPluginPackages,
  runWithLockedLocalPluginPackageStoreSnapshot,
  uninstallLocalPluginPackage,
} from '../plugins/localPluginPackageStore.js'
import {
  BUILTIN_PLUGIN_SOURCE,
  MANAGED_USER_PLUGIN_SOURCE,
} from '../plugins/pluginDistributionSources.js'
import {
  getPluginDiscoverySourceSnapshot,
  listDistributedPlugins,
  refreshPlugins,
} from '../plugins/pluginRegistry.js'
import { listRuntimePluginInventory } from './runtimePluginControlService.js'
import { collectRuntimePluginReleaseProtections } from './runtimePluginReleaseGcReferences.js'
import { listRuntimePluginReleasePins } from './runtimePluginReleaseReferenceStore.js'
import {
  countRuntimePluginReleases,
  getRuntimePluginRelease,
  getRuntimePluginState,
} from './runtimePluginStateStore.js'
import { runRuntimePluginLifecycleOperation } from './runtimePluginLifecycleCoordinator.js'
import {
  assertRuntimePluginMutationAvailable,
  completeRuntimePluginMutationBarrierRecovery,
  getRuntimePluginMutationBarrier,
  listRuntimePluginMutationBarriers,
} from './runtimePluginMutationBarrierStore.js'

export const LOCAL_PLUGIN_PACKAGE_SERVICE_SCHEMA_VERSION = 1

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/u
const SHA256_RE = /^sha256-[a-f0-9]{64}$/u
const MAX_SOURCE_DIRECTORY_LENGTH = 4_096
const MAX_RELEASE_GUARD_ROWS = 100_000
const IMPORT_FIELDS = Object.freeze([
  'sourceDirectory',
  'expectedRevision',
  'replace',
  'expectedPluginId',
])
const UNINSTALL_FIELDS = Object.freeze(['pluginId', 'expectedRevision'])
const RECOVERY_FIELDS = Object.freeze(['pluginId', 'expectedRevision', 'expectedGeneration'])
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

const PUBLIC_MESSAGES = Object.freeze({
  PLUGIN_PACKAGE_SERVICE_INPUT_INVALID: '本地插件包请求无效',
  PLUGIN_PACKAGE_DISCOVERY_UNAVAILABLE: '本地插件包目录尚未由启动流程启用',
  PLUGIN_PACKAGE_DISCOVERY_CHANGED: '本地插件包目录身份已变化，请重启后重试',
  PLUGIN_PACKAGE_ID_PROTECTED: '该插件 ID 由内置插件保留，不能导入或卸载',
  PLUGIN_PACKAGE_HAS_DEPENDANTS: '仍有其他插件依赖该插件，不能卸载',
  PLUGIN_PACKAGE_RUNTIME_ACTIVE: '插件仍处于启用或活动状态，不能卸载',
  PLUGIN_PACKAGE_RELEASES_RETAINED: '插件仍有 Release 或运行回执引用，不能卸载',
  PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE: '无法完整验证插件卸载安全性，已拒绝卸载',
  PLUGIN_PACKAGE_REVISION_REQUIRED: '需要有效的插件包目录版本，请刷新后重试',
  PLUGIN_PACKAGE_REVISION_CONFLICT: '插件包目录已变化，请刷新后重试',
  PLUGIN_PACKAGE_ALREADY_INSTALLED: '该插件包已安装；升级时必须明确选择替换',
  PLUGIN_PACKAGE_NOT_INSTALLED: '该插件包尚未安装',
  PLUGIN_PACKAGE_ID_MISMATCH: '所选插件包与目标插件 ID 不一致',
  PLUGIN_PACKAGE_SOURCE_NOT_FOUND: '所选本地插件目录不存在',
  PLUGIN_PACKAGE_SOURCE_INVALID: '所选本地插件目录无效',
  PLUGIN_PACKAGE_SOURCE_OVERLAP: '所选插件目录不能位于受管插件目录内或与其重叠',
  PLUGIN_PACKAGE_STORE_BUSY: '插件包目录正由另一项操作使用，请稍后重试',
  PLUGIN_PACKAGE_STORE_FAILED: '本地插件包操作失败',
  PLUGIN_PACKAGE_REFRESH_FAILED: '插件包已保存到本地，但当前进程刷新失败',
  PLUGIN_PACKAGE_RECOVERY_NOT_REQUIRED: '该插件没有需要恢复的生命周期屏障',
  PLUGIN_PACKAGE_RECOVERY_OWNER_ACTIVE: '原插件生命周期进程仍在运行，已拒绝恢复',
  PLUGIN_PACKAGE_RECOVERY_UNSAFE: '无法证明插件磁盘、Registry 与运行状态一致，已拒绝恢复',
})

function isLocalProcessAlive(pid) {
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

const DEFAULT_DEPENDENCIES = Object.freeze({
  getDb,
  getPluginDiscoverySourceSnapshot,
  listInstalledLocalPluginPackages,
  discoverInstalledLocalPluginPackagesSync,
  installLocalPluginPackage,
  uninstallLocalPluginPackage,
  listDistributedPlugins,
  refreshPlugins,
  listRuntimePluginInventory,
  getRuntimePluginState,
  getRuntimePluginRelease,
  countRuntimePluginReleases,
  listRuntimePluginReleasePins,
  collectRuntimePluginReleaseProtections,
  runRuntimePluginLifecycleOperation,
  cleanupUninstalledRuntimePluginSecurityState,
  runWithLockedLocalPluginPackageStoreSnapshot,
  getRuntimePluginMutationBarrier,
  listRuntimePluginMutationBarriers,
  completeRuntimePluginMutationBarrierRecovery,
  assertRuntimePluginMutationAvailable,
  isLocalProcessAlive,
})

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

function serviceError(code, statusCode, details = null) {
  const error = new Error(PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.PLUGIN_PACKAGE_STORE_FAILED)
  error.code = code
  error.statusCode = statusCode
  error.retryable = false
  if (details) error.details = deepFreeze(details)
  return error
}

function safeDependencyError(error, fallbackCode = 'PLUGIN_PACKAGE_STORE_FAILED') {
  const candidate = typeof error?.code === 'string' ? error.code : ''
  const code = candidate.startsWith('PLUGIN_PACKAGE_') ? candidate : fallbackCode
  const statusCode = Number.isInteger(error?.statusCode)
    && error.statusCode >= 400
    && error.statusCode <= 599
    ? error.statusCode
    : code === 'PLUGIN_PACKAGE_STORE_BUSY' ? 409 : 500
  return serviceError(code, statusCode)
}

function ownRequestValues(input, allowedFields, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  let prototype
  let keys
  try {
    prototype = Object.getPrototypeOf(input)
    keys = Reflect.ownKeys(input)
  } catch {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  const allowed = new Set(allowedFields)
  const output = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
    }
    output[key] = descriptor.value
  }
  if (!keys.length && label === 'import') {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  return output
}

function normalizePluginId(value) {
  const pluginId = String(value || '').trim().toLowerCase()
  if (!PLUGIN_ID_RE.test(pluginId)) {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  return pluginId
}

function normalizeRevision(value) {
  const revision = String(value || '').trim().toLowerCase()
  if (!SHA256_RE.test(revision)) {
    throw serviceError('PLUGIN_PACKAGE_REVISION_REQUIRED', 409)
  }
  return revision
}

function normalizeImportRequest(input) {
  const values = ownRequestValues(input, IMPORT_FIELDS, 'import')
  const sourceDirectoryInput = typeof values.sourceDirectory === 'string'
    ? values.sourceDirectory.trim()
    : ''
  if (
    !sourceDirectoryInput
    || sourceDirectoryInput.length > MAX_SOURCE_DIRECTORY_LENGTH
    || sourceDirectoryInput.includes('\0')
    || !path.isAbsolute(sourceDirectoryInput)
  ) {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  const sourceDirectory = path.normalize(sourceDirectoryInput)
  const replace = values.replace === undefined ? false : values.replace
  if (typeof replace !== 'boolean') {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  const expectedPluginId = values.expectedPluginId == null
    ? null
    : normalizePluginId(values.expectedPluginId)
  if (replace && !expectedPluginId) {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  return Object.freeze({
    sourceDirectory,
    expectedRevision: normalizeRevision(values.expectedRevision),
    replace,
    expectedPluginId,
  })
}

function normalizeUninstallRequest(input) {
  const values = ownRequestValues(input, UNINSTALL_FIELDS, 'uninstall')
  return Object.freeze({
    pluginId: normalizePluginId(values.pluginId),
    expectedRevision: normalizeRevision(values.expectedRevision),
  })
}

function normalizeRecoveryRequest(input) {
  const values = ownRequestValues(input, RECOVERY_FIELDS, 'recovery')
  const expectedGeneration = Number(values.expectedGeneration)
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  return Object.freeze({
    pluginId: normalizePluginId(values.pluginId),
    expectedRevision: normalizeRevision(values.expectedRevision),
    expectedGeneration,
  })
}

function packageView(value) {
  if (
    !value
    || typeof value !== 'object'
    || !PLUGIN_ID_RE.test(String(value.pluginId || ''))
    || typeof value.pluginVersion !== 'string'
    || !SHA256_RE.test(String(value.packageDigest || ''))
    || !Number.isSafeInteger(value.fileCount)
    || !Number.isSafeInteger(value.totalBytes)
    || !Number.isSafeInteger(value.installedAt)
  ) {
    throw serviceError('PLUGIN_PACKAGE_STORE_FAILED', 500)
  }
  return Object.freeze({
    schemaVersion: Number(value.schemaVersion) || 1,
    pluginId: value.pluginId,
    pluginVersion: value.pluginVersion,
    packageDigest: value.packageDigest,
    fileCount: value.fileCount,
    totalBytes: value.totalBytes,
    installedAt: value.installedAt,
    publisherVerified: value.publisherVerified === true,
    sourceKind: String(value.sourceKind || 'local-directory'),
  })
}

function storeView(value) {
  if (
    !value
    || typeof value !== 'object'
    || value.schemaVersion !== 1
    || !SHA256_RE.test(String(value.revision || ''))
    || !Array.isArray(value.packages)
  ) {
    throw serviceError('PLUGIN_PACKAGE_STORE_FAILED', 500)
  }
  return Object.freeze({
    schemaVersion: 1,
    revision: value.revision,
    packages: Object.freeze(value.packages.map(packageView)),
  })
}

function mutationResultView(value) {
  if (!value || typeof value !== 'object') {
    throw serviceError('PLUGIN_PACKAGE_STORE_FAILED', 500)
  }
  return Object.freeze({
    changed: value.changed === true,
    operation: String(value.operation || ''),
    package: packageView(value.package),
    cleanupDeferred: value.cleanupDeferred === true,
  })
}

function distributedPlugins(dependencies) {
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

function protectedBuiltinPluginIds(source, plugins) {
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

function dependantPluginIds(plugins, pluginId) {
  const ids = []
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== 'object' || !Array.isArray(plugin.requires)) {
      throw serviceError('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503)
    }
    if (plugin.id !== pluginId && plugin.requires.includes(pluginId)) ids.push(plugin.id)
  }
  return Object.freeze([...new Set(ids)].sort((left, right) => left.localeCompare(right, 'en')))
}

function managedPackagePlugins(dependencies, managedRoot) {
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

function runtimeBlocker(dependencies, pluginId) {
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

function releaseBlocker(dependencies, pluginId) {
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

function assertUninstallSafe(dependencies, pluginId, plugins, protectedPluginIds) {
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

function refreshFailureView(error) {
  const candidate = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/u.test(error.code)
    ? error.code
    : 'PLUGIN_PACKAGE_REFRESH_FAILED'
  return Object.freeze({
    code: candidate,
    message: PUBLIC_MESSAGES.PLUGIN_PACKAGE_REFRESH_FAILED,
  })
}

export function createLocalPluginPackageService(overrides = {}) {
  const dependencies = Object.freeze({ ...DEFAULT_DEPENDENCIES, ...overrides })
  for (const [name, value] of Object.entries(dependencies)) {
    if (typeof value !== 'function') throw new TypeError(`${name} dependency must be a function`)
  }
  let managedRootDir = null

  function resolveManagedSource() {
    const source = dependencies.getPluginDiscoverySourceSnapshot()
    if (!source || source.includeManaged !== true || typeof source.managedRootDir !== 'string') {
      throw serviceError('PLUGIN_PACKAGE_DISCOVERY_UNAVAILABLE', 503)
    }
    if (managedRootDir === null) managedRootDir = source.managedRootDir
    if (source.managedRootDir !== managedRootDir) {
      throw serviceError('PLUGIN_PACKAGE_DISCOVERY_CHANGED', 409)
    }
    return Object.freeze({
      source,
      managedRoot: managedRootDir,
    })
  }

  function assertRefreshTarget(snapshot, result) {
    if (!Array.isArray(snapshot.distributedPlugins)) {
      throw serviceError('PLUGIN_PACKAGE_REFRESH_FAILED', 500)
    }
    const plugins = snapshot.distributedPlugins
    const target = plugins.find((plugin) => plugin?.id === result.package.pluginId) || null
    if (result.operation === 'uninstalled') {
      if (target?.distribution?.sourceKind === MANAGED_USER_PLUGIN_SOURCE) {
        throw serviceError('PLUGIN_PACKAGE_REFRESH_FAILED', 500)
      }
      return
    }
    if (
      !target
      || target.version !== result.package.pluginVersion
      || target.distribution?.sourceKind !== MANAGED_USER_PLUGIN_SOURCE
      || target.distribution?.verifiedPackage !== true
      || target.distribution?.installReceipt?.pluginId !== result.package.pluginId
      || target.distribution?.installReceipt?.pluginVersion !== result.package.pluginVersion
      || target.distribution?.installReceipt?.packageDigest !== result.package.packageDigest
    ) {
      throw serviceError('PLUGIN_PACKAGE_REFRESH_FAILED', 500)
    }
  }

  async function refreshAfterMutation(result) {
    try {
      const snapshot = await dependencies.refreshPlugins()
      if (
        !snapshot
        || !Array.isArray(snapshot.plugins)
        || !Array.isArray(snapshot.errors)
        || snapshot.errors.length > 0
      ) {
        throw serviceError('PLUGIN_PACKAGE_REFRESH_FAILED', 500)
      }
      assertRefreshTarget(snapshot, result)
      return Object.freeze({
        refreshPending: false,
        restartRequired: false,
        refreshError: null,
      })
    } catch (error) {
      return Object.freeze({
        refreshPending: true,
        restartRequired: true,
        refreshError: refreshFailureView(error),
      })
    }
  }

  async function listPackages() {
    const { managedRoot: root } = resolveManagedSource()
    try {
      const store = storeView(await dependencies.listInstalledLocalPluginPackages({
        managedRoot: root,
      }))
      return Object.freeze({
        schemaVersion: LOCAL_PLUGIN_PACKAGE_SERVICE_SCHEMA_VERSION,
        store,
        recoveries: Object.freeze(dependencies.listRuntimePluginMutationBarriers({
          db: dependencies.getDb(),
        }).filter((barrier) => (
          barrier.recoveryRequired || !dependencies.isLocalProcessAlive(barrier.ownerPid)
        ))),
      })
    } catch (error) {
      if (error?.code === 'PLUGIN_PACKAGE_STORE_FAILED') throw error
      throw safeDependencyError(error)
    }
  }

  async function importPackageOperation(request) {
    const { source, managedRoot: root } = resolveManagedSource()
    const plugins = distributedPlugins(dependencies)
    const protectedPluginIds = protectedBuiltinPluginIds(source, plugins)
    let mutation
    try {
      mutation = await dependencies.installLocalPluginPackage({
        sourceDir: request.sourceDirectory,
        managedRoot: root,
        expectedRevision: request.expectedRevision,
        expectedPluginId: request.expectedPluginId,
        replace: request.replace,
        protectedPluginIds,
        assertMutationAvailable: (pluginId) => (
          dependencies.assertRuntimePluginMutationAvailable(pluginId, {
            db: dependencies.getDb(),
          })
        ),
      })
    } catch (error) {
      throw safeDependencyError(error)
    }
    const store = storeView(mutation?.store)
    const result = mutationResultView(mutation)
    const refresh = await refreshAfterMutation(result)
    return deepFreeze({
      schemaVersion: LOCAL_PLUGIN_PACKAGE_SERVICE_SCHEMA_VERSION,
      store,
      result,
      refreshPending: refresh.refreshPending,
      restartRequired: refresh.restartRequired,
      ...(refresh.refreshError ? { refreshError: refresh.refreshError } : {}),
    })
  }

  async function importPackage(input) {
    const request = normalizeImportRequest(input)
    if (!request.expectedPluginId) return importPackageOperation(request)
    return dependencies.runRuntimePluginLifecycleOperation(
      request.expectedPluginId,
      () => importPackageOperation(request),
    )
  }

  async function uninstallPackageOperation(request, lifecycle = null) {
    const { source, managedRoot: root } = resolveManagedSource()
    const plugins = [
      ...distributedPlugins(dependencies),
      ...managedPackagePlugins(dependencies, root),
    ]
    const protectedPluginIds = protectedBuiltinPluginIds(source, plugins)
    assertUninstallSafe(dependencies, request.pluginId, plugins, protectedPluginIds)
    lifecycle?.heartbeat('mutating')
    let mutation
    try {
      mutation = await dependencies.uninstallLocalPluginPackage({
        pluginId: request.pluginId,
        managedRoot: root,
        expectedRevision: request.expectedRevision,
      })
    } catch (error) {
      throw safeDependencyError(error)
    }

    // The package store has committed. From this point onward, any validation,
    // database cleanup, heartbeat, or refresh failure must retain the durable
    // barrier: disk and the live registry may no longer describe the same
    // installation state.
    try {
      const store = storeView(mutation?.store)
      const result = mutationResultView(mutation)
      dependencies.cleanupUninstalledRuntimePluginSecurityState(request.pluginId, {
        db: dependencies.getDb(),
      })
      lifecycle?.heartbeat('refreshing')
      const refresh = await refreshAfterMutation(result)
      if (refresh.refreshPending) lifecycle?.retainForRecovery()
      return deepFreeze({
        schemaVersion: LOCAL_PLUGIN_PACKAGE_SERVICE_SCHEMA_VERSION,
        store,
        result,
        refreshPending: refresh.refreshPending,
        restartRequired: refresh.restartRequired,
        ...(refresh.refreshError ? { refreshError: refresh.refreshError } : {}),
      })
    } catch (error) {
      try {
        lifecycle?.retainForRecovery()
      } catch {
        // retainForRecovery marks the in-memory lifecycle as retained before
        // touching SQLite, so the coordinator still refuses to release an
        // unknown post-commit barrier if marking recovery itself fails.
      }
      throw safeDependencyError(error, 'PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE')
    }
  }

  async function uninstallPackage(input) {
    const request = normalizeUninstallRequest(input)
    return dependencies.runRuntimePluginLifecycleOperation(
      request.pluginId,
      (lifecycle) => uninstallPackageOperation(request, lifecycle),
      { exclusive: true, storeRevision: request.expectedRevision },
    )
  }

  function verifiedRecoveryRegistryTarget(plugins, pluginId) {
    const matches = plugins.filter((plugin) => plugin?.id === pluginId)
    if (matches.length > 1) {
      throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
    }
    return matches[0] || null
  }

  function assertInstalledRecoveryTarget(target, installed) {
    if (
      !target
      || target.version !== installed.pluginVersion
      || target.distribution?.sourceKind !== MANAGED_USER_PLUGIN_SOURCE
      || target.distribution?.verifiedPackage !== true
      || target.distribution?.installReceipt?.pluginId !== installed.pluginId
      || target.distribution?.installReceipt?.pluginVersion !== installed.pluginVersion
      || target.distribution?.installReceipt?.packageDigest !== installed.packageDigest
    ) {
      throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
    }
  }

  async function recoverPackage(input) {
    const request = normalizeRecoveryRequest(input)
    const barrier = dependencies.getRuntimePluginMutationBarrier(request.pluginId, {
      db: dependencies.getDb(),
    })
    if (!barrier) throw serviceError('PLUGIN_PACKAGE_RECOVERY_NOT_REQUIRED', 409)
    const orphanedOwner = !barrier.recoveryRequired
    if (orphanedOwner && dependencies.isLocalProcessAlive(barrier.ownerPid)) {
      throw serviceError('PLUGIN_PACKAGE_RECOVERY_OWNER_ACTIVE', 409, {
        pluginId: request.pluginId,
      })
    }
    if (barrier.generation !== request.expectedGeneration) {
      throw serviceError('PLUGIN_PACKAGE_REVISION_CONFLICT', 409, {
        pluginId: request.pluginId,
      })
    }

    const { source, managedRoot: root } = resolveManagedSource()
    let refreshed
    try {
      refreshed = await dependencies.refreshPlugins()
      if (
        !refreshed
        || !Number.isSafeInteger(refreshed.revision)
        || refreshed.revision < 0
        || !Array.isArray(refreshed.distributedPlugins)
        || !Array.isArray(refreshed.errors)
        || refreshed.errors.length > 0
      ) {
        throw new TypeError('plugin registry refresh is incomplete')
      }
    } catch {
      throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
    }

    try {
      return await dependencies.runWithLockedLocalPluginPackageStoreSnapshot({
        managedRoot: root,
        expectedRevision: request.expectedRevision,
        operation: (diskStore) => {
          const installed = diskStore.packages.find(({ pluginId }) => (
            pluginId === request.pluginId
          )) || null
          const livePlugins = distributedPlugins(dependencies)
          const refreshedTarget = verifiedRecoveryRegistryTarget(
            refreshed.distributedPlugins,
            request.pluginId,
          )
          const liveTarget = verifiedRecoveryRegistryTarget(livePlugins, request.pluginId)
          if (installed) {
            assertInstalledRecoveryTarget(refreshedTarget, installed)
            assertInstalledRecoveryTarget(liveTarget, installed)
          } else {
            if (refreshedTarget || liveTarget) {
              throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
            }
            const protectedIds = protectedBuiltinPluginIds(source, livePlugins)
            if (protectedIds.includes(request.pluginId)) {
              throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
            }
            if (dependantPluginIds(livePlugins, request.pluginId).length > 0) {
              throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 409)
            }
            dependencies.cleanupUninstalledRuntimePluginSecurityState(request.pluginId, {
              db: dependencies.getDb(),
            })
          }

          const runtime = runtimeBlocker(dependencies, request.pluginId)
          const releases = releaseBlocker(dependencies, request.pluginId)
          if (runtime.reasons.length > 0 || releases.reasons.length > 0) {
            throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 409)
          }
          const db = dependencies.getDb()
          const permissionGrantPresent = Boolean(db.prepare(`
            SELECT 1 FROM runtime_plugin_permission_grants WHERE plugin_id = ?
          `).get(request.pluginId))
          if (!installed && (
            runtime.inventoryPresent
            || runtime.statePresent
            || permissionGrantPresent
          )) {
            throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
          }
          if (!SHA256_RE.test(String(releases.referenceDigest || ''))) {
            throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
          }
          if (orphanedOwner && dependencies.isLocalProcessAlive(barrier.ownerPid)) {
            throw serviceError('PLUGIN_PACKAGE_RECOVERY_OWNER_ACTIVE', 409, {
              pluginId: request.pluginId,
            })
          }
          const evidence = Object.freeze({
            outcome: installed ? 'installed' : 'uninstalled',
            recoveryAuthorization: barrier.recoveryRequired
              ? 'explicit_recovery_required'
              : 'owner_process_not_alive',
            barrierPhase: barrier.phase,
            barrierOwnerPid: barrier.ownerPid,
            barrierHeartbeatAt: barrier.heartbeatAt,
            barrierStoreRevision: barrier.storeRevision,
            barrierRecoveryRequired: barrier.recoveryRequired,
            observedStoreRevision: diskStore.revision,
            registryRevision: refreshed.revision,
            packageDigest: installed?.packageDigest || null,
            diskInstalled: Boolean(installed),
            registryPresent: Boolean(liveTarget),
            runtimeInventoryPresent: runtime.inventoryPresent,
            runtimeStatePresent: runtime.statePresent,
            permissionGrantPresent,
            runtimeEnabled: runtime.enabled,
            runtimeActive: runtime.active,
            runtimeState: runtime.runtimeState,
            releaseCount: releases.releaseCount,
            pinCount: releases.pinCount,
            checkpointCount: releases.checkpointCount,
            referenceCount: releases.referenceCount,
            referenceDigest: releases.referenceDigest,
          })
          const receipt = dependencies.completeRuntimePluginMutationBarrierRecovery({
            pluginId: request.pluginId,
            generation: request.expectedGeneration,
            evidence,
            db,
          })
          return deepFreeze({
            schemaVersion: LOCAL_PLUGIN_PACKAGE_SERVICE_SCHEMA_VERSION,
            recovered: true,
            outcome: evidence.outcome,
            store: storeView(diskStore),
            receipt,
          })
        },
      })
    } catch (error) {
      throw safeDependencyError(error, 'PLUGIN_PACKAGE_RECOVERY_UNSAFE')
    }
  }

  return Object.freeze({
    listLocalPluginPackages: listPackages,
    importLocalPluginPackage: importPackage,
    uninstallManagedLocalPluginPackage: uninstallPackage,
    recoverManagedLocalPluginPackage: recoverPackage,
  })
}

const DEFAULT_SERVICE = createLocalPluginPackageService()

export const listLocalPluginPackages = DEFAULT_SERVICE.listLocalPluginPackages
export const importLocalPluginPackage = DEFAULT_SERVICE.importLocalPluginPackage
export const uninstallManagedLocalPluginPackage = DEFAULT_SERVICE.uninstallManagedLocalPluginPackage
export const recoverManagedLocalPluginPackage = DEFAULT_SERVICE.recoverManagedLocalPluginPackage
