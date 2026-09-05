import { normalizeTurnIntentMode } from '../utils/executionIntent.js'
import {
  applyDirectoryAuthorizationToolsConfig,
  projectToolSpecsForRuntimePolicy,
  restoreDirectoryAuthorizationToolSpecs,
} from './turnToolSpecs.js'
import {
  normalizeTurnApprovalMode,
  normalizeTurnIds,
  normalizeTurnModelMode,
} from './turnStartRuntime.js'

function checkpointToolSpecs(executionEnvironment) {
  const catalog = executionEnvironment?.toolCatalog
  if (!Array.isArray(catalog)) return null
  const specs = []
  for (const entry of catalog) {
    const name = String(entry?.name || '').trim()
    const specName = String(entry?.spec?.function?.name || '').trim()
    if (!name || specName !== name) return null
    specs.push(entry.spec)
  }
  return specs
}

function projectHostToolCatalog({
  resolvedToolSpecs,
  directoryAuthorizationCatalogNames,
  toolResolutionDecision,
  userId,
  effectiveToolsConfig,
  effectiveApprovalMode,
  modelToolFileAccessStatus,
}) {
  const hostExcluded = []
  let resolverSpecs = Array.isArray(resolvedToolSpecs) ? resolvedToolSpecs : []
  if (directoryAuthorizationCatalogNames) {
    resolverSpecs = resolverSpecs.filter((spec) => {
      const name = String(spec?.function?.name || '').trim()
      if (directoryAuthorizationCatalogNames.has(name)) return true
      if (name) {
        hostExcluded.push({
          name,
          stage: 'permission',
          reason: 'directory_authorization_catalog_frozen',
        })
      }
      return false
    })
  }
  const projected = projectToolSpecsForRuntimePolicy(resolverSpecs, {
    userId,
    toolsConfig: effectiveToolsConfig,
    permissionMode: effectiveApprovalMode,
    fileAccessStatus: modelToolFileAccessStatus,
    onExcluded: (entry) => hostExcluded.push(entry),
  })
  const eligibleToolNames = projected
    .map((spec) => String(spec?.function?.name || '').trim())
    .filter(Boolean)
    .sort()
    .slice(0, 256)
  const existingExcluded = Array.isArray(toolResolutionDecision?.excludedTools)
    ? toolResolutionDecision.excludedTools
    : []
  const excludedTools = []
  const excludedKeys = new Set()
  for (const entry of [...existingExcluded, ...hostExcluded]) {
    const key = `${String(entry?.name || '')}\u0000${String(entry?.stage || '')}\u0000${String(entry?.reason || '')}`
    if (!entry?.name || excludedKeys.has(key)) continue
    excludedKeys.add(key)
    excludedTools.push(entry)
  }
  return {
    resolvedToolSpecs: projected,
    toolResolutionDecision: {
      version: 1,
      ...toolResolutionDecision,
      eligibleToolNames,
      excludedTools,
      discoveryIssues: Array.isArray(toolResolutionDecision?.discoveryIssues)
        ? toolResolutionDecision.discoveryIssues
        : [],
    },
  }
}

/**
 * Resolve the host-owned tool and permission context passed to one Turn loop.
 *
 * Discovery remains an injected host capability. The runtime always applies
 * the host projection after discovery, so an injected or stale resolver is
 * not itself a permission boundary.
 */
export function createTurnExecutionToolContextRuntime({
  readApprovalMode,
  readFileAccessStatus,
  resolveToolSpecs,
} = {}) {
  return {
    async resolve({
      userId,
      content,
      modelMode,
      toolsConfig,
      intentMode,
      approvalMode,
      resumeResolution = null,
      restoredCheckpointState = null,
      fileAccessStatus = undefined,
      promptContextSkillIds = [],
      fallbackSkillIds = [],
      toolResolutionMessages = [],
      baseToolSpecs = [],
      directoryAuthorizationToolSpecs = baseToolSpecs,
    } = {}) {
      const normalizedModelMode = normalizeTurnModelMode(modelMode)
      const chatOnlyMode = normalizedModelMode === 'chat_only'
      const effectiveToolsConfig = chatOnlyMode
        ? { enabled: [], disabled: [] }
        : applyDirectoryAuthorizationToolsConfig(toolsConfig, resumeResolution)
      const effectiveIntentMode = chatOnlyMode
        ? 'answer'
        : resumeResolution?.type === 'directory_authorization'
          && resumeResolution.access_mode === 'read_write'
          ? 'execute'
          : normalizeTurnIntentMode(intentMode)
      const preparedSkillIds = normalizeTurnIds(promptContextSkillIds)
      const effectiveSkillIds = preparedSkillIds.length
        ? preparedSkillIds
        : normalizeTurnIds(fallbackSkillIds)
      const configuredApprovalMode = String(readApprovalMode({ userId }) || '').trim()
      const turnApprovalMode = normalizeTurnApprovalMode(approvalMode)
      const checkpointApprovalMode = normalizeTurnApprovalMode(
        restoredCheckpointState?.approvalMode,
      )
      const currentApprovalMode = turnApprovalMode
        || configuredApprovalMode
        || checkpointApprovalMode
        || 'normal'
      const effectiveApprovalMode = checkpointApprovalMode
        || turnApprovalMode
        || configuredApprovalMode
        || 'normal'
      let resolvedToolSpecs = chatOnlyMode ? [] : baseToolSpecs
      let directoryAuthorizationCatalogNames = null
      let toolResolutionDecision = chatOnlyMode ? {
        version: 1,
        eligibleToolNames: [],
        excludedTools: [],
        discoveryIssues: [],
      } : null
      let modelToolFileAccessStatus
      if (!chatOnlyMode) {
        if (fileAccessStatus !== undefined) {
          modelToolFileAccessStatus = fileAccessStatus
        } else {
          try {
            modelToolFileAccessStatus = readFileAccessStatus({ userId })
          } catch {
            // An unreadable authorization state is not permission to advertise
            // workspace tools. The host projection below treats null as no access.
            modelToolFileAccessStatus = null
          }
        }
      }
      if (!chatOnlyMode) try {
        const restoredCatalogSpecs = resumeResolution?.type === 'directory_authorization'
          ? checkpointToolSpecs(restoredCheckpointState?.executionEnvironment)
          : null
        const authorizationAwareBaseSpecs = restoreDirectoryAuthorizationToolSpecs(
          restoredCatalogSpecs ?? baseToolSpecs,
          resumeResolution,
          directoryAuthorizationToolSpecs,
        )
        if (restoredCatalogSpecs !== null) {
          directoryAuthorizationCatalogNames = new Set(authorizationAwareBaseSpecs
            .map((spec) => String(spec?.function?.name || '').trim())
            .filter(Boolean))
        }
        const resolved = await resolveToolSpecs({
          userId,
          baseSpecs: authorizationAwareBaseSpecs,
          toolsConfig: effectiveToolsConfig,
          permissionMode: effectiveApprovalMode,
          fileAccessStatus: modelToolFileAccessStatus,
          prompt: content,
          messages: toolResolutionMessages,
          skillIds: effectiveSkillIds,
          onDecision: (decision) => { toolResolutionDecision = decision },
        })
        if (Array.isArray(resolved)) resolvedToolSpecs = resolved
      } catch {
        // MCP/browser discovery is optional. The host-level permission projection
        // below still applies when discovery itself fails.
        toolResolutionDecision = {
          version: 1,
          eligibleToolNames: [],
          excludedTools: [],
          discoveryIssues: [{ source: 'tool_resolution', reason: 'discovery_failed' }],
        }
      }
      if (!chatOnlyMode) {
        ;({ resolvedToolSpecs, toolResolutionDecision } = projectHostToolCatalog({
          resolvedToolSpecs,
          directoryAuthorizationCatalogNames,
          toolResolutionDecision,
          userId,
          effectiveToolsConfig,
          effectiveApprovalMode,
          modelToolFileAccessStatus,
        }))
      }
      return {
        normalizedModelMode,
        chatOnlyMode,
        effectiveToolsConfig,
        effectiveIntentMode,
        effectiveSkillIds,
        activeSkillId: effectiveSkillIds.at(0) || null,
        currentApprovalMode,
        effectiveApprovalMode,
        resolvedToolSpecs,
        toolResolutionDecision,
        modelToolFileAccessStatus,
      }
    },
  }
}
