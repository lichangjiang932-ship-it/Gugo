import { createHash } from 'node:crypto'

const SOURCE_DIGEST_RE = /^sha256-[a-f0-9]{64}$/
const PERMISSION_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/

export const RUNTIME_PLUGIN_PERMISSION_CONTRACT_VERSION = 1
export const RUNTIME_TRANSFORMER_TOOL_PERMISSION = 'runtime:tool'

function boundedString(value, field, maxLength) {
  const text = String(value || '').trim()
  if (!text || text.length > maxLength) {
    throw new TypeError(`${field} must be a non-empty string no longer than ${maxLength} characters`)
  }
  return text
}

export function listRuntimeTransformerPermissions(plugin) {
  const declared = Array.isArray(plugin?.permissions) ? plugin.permissions : []
  const capabilities = Array.isArray(plugin?.capabilities) ? plugin.capabilities : []
  const permissions = [
    RUNTIME_TRANSFORMER_TOOL_PERMISSION,
    ...declared,
    ...capabilities.map((capability) => `sandbox:${String(capability || '').trim()}`),
  ].map((permission) => String(permission || '').trim())

  if (permissions.some((permission) => !PERMISSION_RE.test(permission))) {
    throw new TypeError('runtime plugin permissions must use bounded lowercase permission identifiers')
  }
  return Object.freeze([...new Set(permissions)].sort())
}

function approvalPayload({ pluginId, pluginVersion, sourceDigest, permissions }) {
  return JSON.stringify({
    contractVersion: RUNTIME_PLUGIN_PERMISSION_CONTRACT_VERSION,
    pluginId,
    pluginVersion,
    sourceDigest,
    permissions,
  })
}

export function buildRuntimePluginPermissionRequest({ plugin, sourceDigest }) {
  const pluginId = boundedString(plugin?.id, 'plugin.id', 80)
  const pluginVersion = boundedString(plugin?.version, 'plugin.version', 128)
  const digest = String(sourceDigest || '').trim().toLowerCase()
  if (!SOURCE_DIGEST_RE.test(digest)) {
    throw new TypeError('sourceDigest must be a sha256 hex digest')
  }
  const permissions = listRuntimeTransformerPermissions(plugin)
  const approvalDigest = `sha256-${createHash('sha256')
    .update(approvalPayload({ pluginId, pluginVersion, sourceDigest: digest, permissions }), 'utf8')
    .digest('hex')}`
  return Object.freeze({
    contractVersion: RUNTIME_PLUGIN_PERMISSION_CONTRACT_VERSION,
    pluginId,
    pluginVersion,
    sourceDigest: digest,
    approvalDigest,
    permissions,
  })
}

export function isRuntimePluginPermissionApproval(request, approvalDigest) {
  return typeof approvalDigest === 'string'
    && approvalDigest.trim().toLowerCase() === request?.approvalDigest
}
