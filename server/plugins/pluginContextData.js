import { snapshotPluginData } from './pluginServiceData.js'

const PLUGIN_AUDIT_EVENT_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/i
const CONTEXT_MAX_DEPTH = 32
const CONTEXT_MAX_NODES = 8_192
const CONTEXT_MAX_BYTES = 1024 * 1024
const AUDIT_MAX_DEPTH = 16
const AUDIT_MAX_NODES = 4_096
const AUDIT_MAX_BYTES = 256 * 1024

function boundaryError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function snapshotBoundaryData(input, {
  code,
  label,
  maxDepth,
  maxNodes,
  maxBytes,
}) {
  try {
    return snapshotPluginData(input, {
      code,
      label,
      maxDepth,
      maxNodes,
      maxBytes,
    })
  } catch {
    throw boundaryError(code, `${label} must contain bounded plain data`)
  }
}

export function snapshotPluginContextConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw boundaryError(
      'PLUGIN_CONTEXT_CONFIG_INVALID',
      'plugin context config must be a plain data object',
    )
  }
  return snapshotBoundaryData(config, {
    code: 'PLUGIN_CONTEXT_CONFIG_INVALID',
    label: 'plugin context config',
    maxDepth: CONTEXT_MAX_DEPTH,
    maxNodes: CONTEXT_MAX_NODES,
    maxBytes: CONTEXT_MAX_BYTES,
  })
}

export function snapshotPluginAuditEntry(event, details) {
  if (typeof event !== 'string') {
    throw boundaryError(
      'PLUGIN_AUDIT_EVENT_INVALID',
      'plugin audit event must be a bounded string',
    )
  }
  const normalizedEvent = event.trim()
  if (!PLUGIN_AUDIT_EVENT_RE.test(normalizedEvent)) {
    throw boundaryError(
      'PLUGIN_AUDIT_EVENT_INVALID',
      'plugin audit event must match [a-z0-9][a-z0-9._:-]{0,127}',
    )
  }
  const snapshot = snapshotBoundaryData(details, {
    code: 'PLUGIN_AUDIT_DATA_INVALID',
    label: 'plugin audit details',
    maxDepth: AUDIT_MAX_DEPTH,
    maxNodes: AUDIT_MAX_NODES,
    maxBytes: AUDIT_MAX_BYTES,
  })
  return Object.freeze({ event: normalizedEvent, details: snapshot })
}
