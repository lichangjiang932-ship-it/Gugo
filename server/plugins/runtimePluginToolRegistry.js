import { CONNECTOR_TOOL_NAMES } from '../services/connectorTools.js'
import { assertHostManagedArtifactToolNotReplaced } from '../services/artifactHarnessBoundary.js'
import { getBuiltinSpec } from '../utils/toolSchemaCatalog.js'
import {
  snapshotContributionDefinition,
  snapshotOptionalContributionDefinition,
} from './pluginContributionDefinition.js'
import { createRuntimePluginToolExecutor } from './pluginToolInvocation.js'
import { snapshotPluginToolSpec } from './runtimePluginToolSpec.js'

const CONNECTOR_TOOL_NAME_SET = new Set(CONNECTOR_TOOL_NAMES)
const HOST_BOUND_EXECUTION_TOOL_NAMES = new Set(['run_code'])
const PLUGIN_CAPABILITY_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const PLUGIN_TOOL_RISK_METADATA = Object.freeze({
  riskClass: 'external',
  category: 'external',
  riskLevel: 'high',
  requiredApproval: true,
  requiresApproval: true,
  isReadOnly: false,
  readOnly: false,
  isConcurrencySafe: false,
  isIdempotent: false,
  interruptBehavior: 'block',
  isDestructive: true,
  source: 'fallback',
  reason: 'Runtime plugin tools require explicit host approval.',
})

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function reservedToolOwner(name) {
  if (getBuiltinSpec(name)) return 'builtin'
  if (CONNECTOR_TOOL_NAME_SET.has(name)) return 'connector'
  if (name.startsWith('mcp__')) return 'MCP'
  if (name.startsWith('browser_')) return 'browser'
  return null
}

function assertHostBoundExecutionToolNotReplaced(name, builtinCapabilityId) {
  if (!builtinCapabilityId || !HOST_BOUND_EXECUTION_TOOL_NAMES.has(name)) return
  const error = new Error(`plugin tool cannot replace host-bound execution tool: ${name}`)
  error.code = 'PLUGIN_TOOL_HOST_BOUND'
  error.retryable = false
  throw error
}

function validateToolRegistryDependencies(dependencies, supportsRuntimeCapabilityReplacement) {
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (typeof dependency === 'function') continue
    const error = new TypeError(`runtime plugin Tool registry dependency must be a function: ${name}`)
    error.code = 'PLUGIN_TOOL_REGISTRY_DEPENDENCY_INVALID'
    error.retryable = false
    throw error
  }
  if (typeof supportsRuntimeCapabilityReplacement !== 'boolean') {
    const error = new TypeError(
      'runtime plugin Tool registry dependency must be a boolean: supportsRuntimeCapabilityReplacement',
    )
    error.code = 'PLUGIN_TOOL_REGISTRY_DEPENDENCY_INVALID'
    error.retryable = false
    throw error
  }
}

export function createRuntimePluginToolRegistry({
  assertPluginWritable,
  assertContributionDeclared,
  createManagedContribution,
  invokePluginCallback,
  registerTool,
  registerRuntimeCapability,
  supportsRuntimeCapabilityReplacement,
} = {}) {
  const dependencies = {
    assertPluginWritable,
    assertContributionDeclared,
    createManagedContribution,
    invokePluginCallback,
    registerTool,
    registerRuntimeCapability,
  }
  validateToolRegistryDependencies(dependencies, supportsRuntimeCapabilityReplacement)

  const registerToolContribution = (record, definition) => {
    assertPluginWritable(record)
    const snapshot = snapshotContributionDefinition(
      definition,
      'plugin tool definition',
      ['name', 'spec', 'exec'],
    )
    const name = trimmedString(snapshot.name)
    const capabilityOptions = snapshotOptionalContributionDefinition(
      definition,
      'plugin tool definition',
      ['id', 'version', 'revision', 'priority', 'replaces'],
    )
    const spec = snapshotPluginToolSpec(snapshot.spec)
    const specName = trimmedString(spec.function.name)
    if (!name || name !== specName) {
      throw new TypeError('plugin tool name must match spec.function.name')
    }
    assertContributionDeclared(record, `tool:${name}`)
    const reservedOwner = reservedToolOwner(name)
    const builtinCapabilityId = getBuiltinSpec(name) ? `builtin.tool.${name.toLowerCase()}` : null
    const replaces = capabilityOptions.replaces == null
      ? null
      : trimmedString(capabilityOptions.replaces)
    if (reservedOwner && !builtinCapabilityId) {
      throw new Error(`plugin tool cannot shadow ${reservedOwner} tool: ${name}`)
    }
    assertHostManagedArtifactToolNotReplaced(name, builtinCapabilityId)
    assertHostBoundExecutionToolNotReplaced(name, builtinCapabilityId)
    if (builtinCapabilityId && !supportsRuntimeCapabilityReplacement) {
      throw new Error(`plugin tool cannot shadow builtin tool: ${name}`)
    }
    if (builtinCapabilityId && replaces !== builtinCapabilityId) {
      const error = new Error(
        `plugin tool cannot shadow builtin tool: ${name}; declare replaces: ${builtinCapabilityId}`,
      )
      error.code = 'PLUGIN_TOOL_REPLACEMENT_REQUIRED'
      error.retryable = false
      throw error
    }
    if (!builtinCapabilityId && replaces) {
      const error = new Error(`plugin tool cannot replace a non-builtin capability: ${name}`)
      error.code = 'PLUGIN_TOOL_REPLACEMENT_INVALID'
      error.retryable = false
      throw error
    }
    if (replaces && (!Number.isSafeInteger(capabilityOptions.priority) || capabilityOptions.priority <= 0)) {
      const error = new Error('plugin tool replacement priority must be a positive integer')
      error.code = 'PLUGIN_TOOL_REPLACEMENT_PRIORITY_INVALID'
      error.retryable = false
      throw error
    }
    const pluginExec = snapshot.exec
    if (typeof pluginExec !== 'function') {
      throw new TypeError('plugin tool exec must be a function')
    }
    const registration = {
      name,
      spec,
      exec: createRuntimePluginToolExecutor({
        record,
        name,
        exec: pluginExec,
        invoke: invokePluginCallback,
      }),
      // Runtime plugins have no authenticated request identity. User-scoped
      // tools must be registered by an authenticated host integration.
      userId: null,
      origin: 'plugin',
      source: record.manifest.id,
      metadata: PLUGIN_TOOL_RISK_METADATA,
    }
    const capabilityId = capabilityOptions.id === undefined
      ? `plugin.${record.manifest.id}.tool.${name.toLowerCase()}`
      : trimmedString(capabilityOptions.id)
    if (!PLUGIN_CAPABILITY_ID_RE.test(capabilityId)) {
      throw new TypeError('plugin tool capability id is invalid')
    }
    const capabilityDefinition = Object.freeze({
      id: capabilityId,
      type: 'tool',
      slot: name,
      owner: record.manifest.id,
      version: capabilityOptions.version === undefined
        ? record.manifest.version
        : capabilityOptions.version,
      revision: capabilityOptions.revision === undefined
        ? record.configRevision
        : capabilityOptions.revision,
      priority: capabilityOptions.priority === undefined ? 10 : capabilityOptions.priority,
      replaces,
      ...(record.manifest.integrity ? { releaseDigest: record.manifest.integrity } : {}),
      implementation: Object.freeze(registration),
      healthCheck: () => true,
    })
    let activationFailureHandles = null
    const lifecycleParts = (handles) => [
      ...(typeof handles?.capability === 'function'
        ? [{ id: `tool:${name}:capability`, handle: handles.capability }]
        : []),
      ...(typeof handles?.tool === 'function'
        ? [{ id: `tool:${name}:implementation`, handle: handles.tool }]
        : []),
    ]
    return createManagedContribution(record, {
      activate() {
        const handles = { capability: null, tool: null }
        activationFailureHandles = handles
        handles.capability = registerRuntimeCapability(capabilityDefinition)
        if (typeof handles.capability !== 'function') {
          throw new TypeError('runtime capability registration must return a disposer')
        }
        handles.tool = registerTool(registration)
        if (typeof handles.tool !== 'function') {
          throw new TypeError('tool registration must return a disposer')
        }
        activationFailureHandles = null
        return Object.freeze(handles)
      },
      parts: lifecycleParts,
      // If the second host registration fails, the first capability remains a
      // managed visible effect. The coordinator will revoke this exact handle
      // through the V2 lifecycle and retain cleanup debt if visibility cannot
      // be proved, instead of swallowing a disposer failure and losing it.
      activationFailureParts: () => lifecycleParts(activationFailureHandles),
    })
  }

  return Object.freeze({ registerToolContribution })
}
