import { createHash, randomUUID } from 'node:crypto'

import {
  assertPluginCompatibility,
  PLUGIN_API_VERSION,
  PLUGIN_HOST_VERSION,
} from '../../shared/pluginCompatibility.js'
import {
  getPluginDefinition,
  getRuntimePlugin,
  registerPluginDefinition,
  unregisterPlugin,
} from '../plugins/pluginRegistry.js'
import {
  createDistributedPluginDefinition,
  distributedPluginFromDefinition,
  releasePluginSnapshotFromDefinition,
  runtimeTransformerToolName,
} from '../plugins/pluginDefinition.js'
import {
  createRuntimePluginDurableIdentity,
  trustVerifiedRuntimePluginRelease,
} from '../plugins/runtimePluginDurableIdentity.js'
import { verifyRuntimePluginReleaseContentIdentity } from '../plugins/runtimePluginReleaseIdentity.js'
import { verifyPluginEntryIntegrity } from '../plugins/pluginIntegrity.js'
import { readPluginEntryFile } from '../plugins/pluginEntryFile.js'
import {
  buildRuntimePluginPermissionRequest,
  isRuntimePluginPermissionApproval,
} from '../plugins/runtimePluginPermissions.js'
import { runTransformer, validateTransformer } from '../plugins/pluginSandbox.js'
import {
  grantRuntimePluginPermissions,
  runtimePluginPermissionGrantMatches,
} from './runtimePluginPermissionGrantStore.js'
import {
  createRuntimePluginRelease,
  getRuntimePluginState,
  setRuntimePluginState,
} from './runtimePluginStateStore.js'

const MAX_TRANSFORMER_SOURCE_BYTES = 512 * 1024
const MAX_TRANSFORMER_INPUT_BYTES = 64 * 1024
const TRANSFORMER_HEALTH_INPUT = null
const activeTransformerSlots = new Map()

export function serviceError(code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

export function safeErrorDetails(error) {
  const code = String(error?.code || 'RUNTIME_PLUGIN_ACTIVATION_FAILED')
    .replace(/[^A-Z0-9_]/gi, '_')
    .slice(0, 80)
  const message = String(error?.message || '运行时插件激活失败')
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, '[LOCAL_PATH]')
    .replace(/\/(?:[^\s/]+\/){2,}[^\s"']*/g, '[LOCAL_PATH]')
    .slice(0, 1_000)
  return { code, message }
}

export function safeErrorSummary(error) {
  const { code, message } = safeErrorDetails(error)
  return `${code}: ${message}`
}

export async function runRuntimePluginSandbox(
  pluginId,
  input,
  { permissionApproval = null } = {},
) {
  const definition = requireTransformerPluginDefinition(pluginId)
  const plugin = distributedPluginFromDefinition(definition)
  const source = await readTransformerSource(plugin)
  const candidate = newReleaseCandidate(definition, source)
  const permissionRequest = permissionRequestForRelease(candidate)
  const shouldPersistPermissionGrant = authorizePermissionRequest(
    permissionRequest,
    permissionApproval,
  )
  if (shouldPersistPermissionGrant) {
    if (!getRuntimePluginState(plugin.id)) {
      setRuntimePluginState({ pluginId: plugin.id, enabled: false })
    }
    grantRuntimePluginPermissions({ request: permissionRequest })
  }
  return runTransformer({
    plugin: { source },
    input,
    capabilities: plugin.capabilities || [],
  })
}

function transformerToolSpec(plugin, toolName) {
  return {
    type: 'function',
    function: {
      name: toolName,
      description: String(plugin.description || `Run local transformer plugin ${plugin.name}`).slice(0, 1_000),
      parameters: {
        type: 'object',
        properties: {
          input: {
            description: 'JSON-serializable input for the local transformer plugin.',
          },
        },
        required: ['input'],
        additionalProperties: false,
      },
    },
  }
}

function serializedInputSize(input) {
  try {
    return Buffer.byteLength(JSON.stringify(input), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

async function readTransformerSource(plugin) {
  try {
    const { bytes } = await readPluginEntryFile({
      rootDir: plugin.rootDir,
      entryPath: plugin.entryPath,
      maxBytes: MAX_TRANSFORMER_SOURCE_BYTES,
    })
    verifyPluginEntryIntegrity({ integrity: plugin.integrity, bytes })
    return bytes.toString('utf8')
  } catch (error) {
    if (String(error?.code || '').startsWith('PLUGIN_INTEGRITY_')) throw error
    if (error?.code === 'PLUGIN_ENTRY_TOO_LARGE') {
      throw serviceError('PLUGIN_ENTRY_TOO_LARGE', '插件入口超过 512KB 限制', 400)
    }
    if (String(error?.code || '').startsWith('PLUGIN_ENTRY_')) throw error
    throw serviceError('PLUGIN_ENTRY_READ_FAILED', '插件入口无法读取', 400)
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function releaseDigest(source) {
  return `sha256-${createHash('sha256').update(source, 'utf8').digest('hex')}`
}

function permissionApprovalRequired(request) {
  const error = serviceError(
    'PLUGIN_PERMISSION_APPROVAL_REQUIRED',
    '插件源码或权限已变化，需要本机所有者明确授权',
    409,
  )
  error.retryable = false
  error.permissionApproval = request
  return error
}

export function authorizePermissionRequest(request, approvalDigest) {
  if (runtimePluginPermissionGrantMatches(request)) return false
  if (!isRuntimePluginPermissionApproval(request, approvalDigest)) {
    throw permissionApprovalRequired(request)
  }
  return true
}

export function permissionRequestForRelease(release) {
  return buildRuntimePluginPermissionRequest({
    plugin: release.plugin,
    sourceDigest: release.sourceDigest,
  })
}

function assertStoredPermissionGrant(release) {
  const request = permissionRequestForRelease(release)
  if (!runtimePluginPermissionGrantMatches(request)) throw permissionApprovalRequired(request)
  return request
}

function newReleaseCandidate(definition, source) {
  const plugin = distributedPluginFromDefinition(definition)
  const createdAt = Date.now()
  return {
    releaseId: `rel-${createdAt.toString(36)}-${randomUUID()}`,
    pluginId: plugin.id,
    sourceDigest: releaseDigest(source),
    source,
    plugin: releasePluginSnapshotFromDefinition(definition),
    createdAt,
  }
}

export function hydrateStoredRelease(row) {
  if (!row) return null
  const verified = verifyRuntimePluginReleaseContentIdentity(row)
  const plugin = verified.plugin
  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)
    || plugin.id !== verified.pluginId || plugin.type !== 'transformer') {
    throw serviceError('PLUGIN_RELEASE_CORRUPT', '插件 Release 身份不匹配', 500)
  }
  return trustVerifiedRuntimePluginRelease(deepFreeze({
    releaseId: verified.releaseId,
    pluginId: verified.pluginId,
    sourceDigest: verified.sourceDigest,
    releaseContentDigest: verified.releaseContentDigest,
    digestVersion: verified.digestVersion,
    source: verified.source,
    plugin,
    validationStatus: verified.validationStatus,
    healthStatus: verified.healthStatus,
    failure: verified.failure,
    createdAt: verified.createdAt,
  }))
}

function persistCandidate(candidate, { validationStatus, healthStatus, failure = null }) {
  return hydrateStoredRelease(createRuntimePluginRelease({
    pluginId: candidate.pluginId,
    releaseId: candidate.releaseId,
    sourceDigest: candidate.sourceDigest,
    source: candidate.source,
    pluginSnapshotJson: JSON.stringify(candidate.plugin),
    validationStatus,
    healthStatus,
    failure,
    now: candidate.createdAt,
  }))
}

async function transformerHealthResult({ source, plugin }) {
  try {
    return await runTransformer({
      plugin: { source },
      input: TRANSFORMER_HEALTH_INPUT,
      capabilities: plugin.capabilities || [],
    })
  } catch (error) {
    return { ok: false, error: safeErrorSummary(error) }
  }
}

export async function prepareTransformerRelease(definition, {
  validationErrorCode,
  permissionApproval = null,
}) {
  const plugin = distributedPluginFromDefinition(definition)
  const source = await readTransformerSource(plugin)
  const candidate = newReleaseCandidate(definition, source)
  const permissionRequest = permissionRequestForRelease(candidate)
  const shouldPersistPermissionGrant = authorizePermissionRequest(
    permissionRequest,
    permissionApproval,
  )
  let validation
  try {
    validation = await validateTransformer({
      plugin: { source },
      capabilities: plugin.capabilities || [],
    })
  } catch (error) {
    validation = { ok: false, error: safeErrorSummary(error) }
  }
  if (!validation.ok) {
    const error = serviceError(
      validationErrorCode,
      `插件源码预检失败：${String(validation.error || 'plugin_error').slice(0, 500)}`,
      400,
    )
    persistCandidate(candidate, {
      validationStatus: 'failed',
      healthStatus: 'not_run',
      failure: safeErrorSummary(error),
    })
    throw error
  }

  const health = await transformerHealthResult({ source, plugin })
  if (!health.ok) {
    const error = serviceError(
      'PLUGIN_RELEASE_HEALTH_CHECK_FAILED',
      `插件健康检查失败：${String(health.error || health.code || 'plugin_error').slice(0, 500)}`,
      400,
    )
    persistCandidate(candidate, {
      validationStatus: 'passed',
      healthStatus: 'failed',
      failure: safeErrorSummary(error),
    })
    throw error
  }
  const release = persistCandidate(candidate, {
    validationStatus: 'passed',
    healthStatus: 'passed',
  })
  return Object.freeze({
    release,
    permissionRequest,
    persistPermissionGrant: shouldPersistPermissionGrant,
  })
}

export async function assertStoredReleaseHealthy(release, { beforeHealth = null } = {}) {
  if (release.validationStatus !== 'passed' || release.healthStatus !== 'passed') {
    throw serviceError('PLUGIN_RELEASE_NOT_HEALTHY', '插件 Release 未通过发布门禁', 500)
  }
  assertStoredPermissionGrant(release)
  const validation = await validateTransformer({
    plugin: { source: release.source },
    capabilities: release.plugin.capabilities || [],
  })
  if (!validation.ok) {
    throw serviceError(
      'PLUGIN_RELEASE_RESTORE_VALIDATION_FAILED',
      `插件 Release 恢复预检失败：${String(validation.error || 'plugin_error').slice(0, 500)}`,
      500,
    )
  }
  if (beforeHealth) beforeHealth()
  const health = await transformerHealthResult({ source: release.source, plugin: release.plugin })
  if (!health.ok) {
    throw serviceError(
      'PLUGIN_RELEASE_RESTORE_HEALTH_CHECK_FAILED',
      `插件 Release 恢复健康检查失败：${String(health.error || health.code || 'plugin_error').slice(0, 500)}`,
      500,
    )
  }
}

export function assertReleaseDependenciesAvailable(plugin) {
  return assertPluginCompatibility(plugin, {
    hostVersion: PLUGIN_HOST_VERSION,
    apiVersion: PLUGIN_API_VERSION,
    resolveDependencyVersion: (dependencyId) => {
      const dependency = getRuntimePlugin(dependencyId)
      return dependency?.state === 'active' ? dependency.version : null
    },
  })
}

export function requireTransformerPluginDefinition(pluginId) {
  const definition = getPluginDefinition(pluginId)
  if (!definition) throw serviceError('PLUGIN_NOT_FOUND', '插件不存在', 404)
  const plugin = distributedPluginFromDefinition(definition)
  if (plugin.type !== 'transformer') {
    throw serviceError('PLUGIN_RUNTIME_TYPE_UNSUPPORTED', '仅 transformer 插件支持运行时启停', 400)
  }
  return definition
}

function runtimeStateConflict() {
  return serviceError('PLUGIN_RUNTIME_STATE_CONFLICT', '同 ID runtime 不属于目标 transformer Release', 409)
}

export async function installTransformerRelease(release, {
  resetDurableAgentEventSubscriptions = false,
} = {}) {
  const plugin = release.plugin
  const durableIdentity = createRuntimePluginDurableIdentity(release)
  const existing = getRuntimePlugin(plugin.id)
  const ownedSlot = activeTransformerSlots.get(plugin.id)
  if (existing?.state === 'active'
    && ownedSlot?.release?.releaseId === release.releaseId) {
    return Object.freeze({ runtime: existing, slot: ownedSlot, installed: false })
  }
  if (existing || ownedSlot) throw runtimeStateConflict()

  const definition = createDistributedPluginDefinition(plugin, {
    distribution: plugin.distribution || null,
  })
  const toolName = runtimeTransformerToolName(plugin.id)
  const slot = Object.seal({ release, ownershipToken: Symbol(plugin.id) })
  activeTransformerSlots.set(plugin.id, slot)
  try {
    const runtime = await registerPluginDefinition(definition, (context) => {
      context.lifecycle.onDispose(() => {
        if (activeTransformerSlots.get(plugin.id) === slot) activeTransformerSlots.delete(plugin.id)
      })
      context.tools.register({
        name: toolName,
        spec: transformerToolSpec(plugin, toolName),
        exec: async (args = {}) => {
          if (!Object.hasOwn(args, 'input')) {
            return { ok: false, code: 'PLUGIN_INPUT_REQUIRED', error: 'input is required' }
          }
          if (serializedInputSize(args.input) > MAX_TRANSFORMER_INPUT_BYTES) {
            return { ok: false, code: 'PLUGIN_INPUT_TOO_LARGE', error: 'input exceeds 64KB' }
          }
          const capturedRelease = slot.release
          assertStoredPermissionGrant(capturedRelease)
          return runTransformer({
            plugin: { source: capturedRelease.source },
            input: args.input,
            capabilities: capturedRelease.plugin.capabilities || [],
          })
        },
      })
    }, durableIdentity, { resetDurableAgentEventSubscriptions })
    return Object.freeze({ runtime, slot, installed: true })
  } catch (error) {
    if (activeTransformerSlots.get(plugin.id) === slot) activeTransformerSlots.delete(plugin.id)
    throw error
  }
}

export function getActiveTransformerSlot(pluginId) {
  return activeTransformerSlots.get(pluginId) || null
}

export function hasActiveTransformerSlot(pluginId) {
  return activeTransformerSlots.has(pluginId)
}

export async function removeFailedInitialActivation(installation) {
  if (!installation?.installed) return
  const pluginId = installation.slot?.release?.pluginId
  if (!pluginId || activeTransformerSlots.get(pluginId) !== installation.slot) return
  try {
    if (getRuntimePlugin(pluginId)) await unregisterPlugin(pluginId)
  } catch {
    // Preserve the original activation error. Registry shutdown still owns its
    // own reversible side-effect cleanup and the slot is cleared on dispose.
  }
}

export { runtimeTransformerToolName }
