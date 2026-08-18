import path from 'node:path'
import { isFileArtifactTool } from '../artifactIntent.js'
import { getToolMetadata } from '../toolRegistry.js'
import { normalizeServerToolsConfig } from '../turnToolSpecs.js'
import {
  PROJECT_SCOPE_TARGET,
  extractMutationTargets,
  isCommandExecutionTool,
  isLocalMutationCall,
  targetsMatch,
} from '../toolLoopHeuristics.js'

export function createArtifactReplacementGuard({
  revisionMode = 'unspecified',
  priorArtifacts = [],
} = {}) {
  const artifacts = Array.isArray(priorArtifacts) ? priorArtifacts : []
  const matchingArtifacts = (name) => artifacts.filter((artifact) => artifact.toolName === name)

  function normalizeCall(call) {
    const name = String(call?.name || '').trim()
    if (!isFileArtifactTool(name) || revisionMode !== 'replace_original') return call
    const matching = matchingArtifacts(name)
    const args = call?.args && typeof call.args === 'object' && !Array.isArray(call.args)
      ? call.args
      : {}
    if (matching.length !== 1) return call
    const replacementId = String(args.replace_artifact_id || '').trim()
    // Preserve a non-empty wrong ID so validation can reject it rather than
    // silently retargeting the call.
    if (replacementId && replacementId !== String(matching[0].id)) return call
    const inheritedLocalPath = String(matching[0].localPath || '').trim()
    const normalizedArgs = {
      ...args,
      ...(replacementId ? {} : { replace_artifact_id: matching[0].id }),
      ...(!String(args.output_directory || '').trim() && inheritedLocalPath
        ? { output_directory: path.dirname(inheritedLocalPath) }
        : {}),
    }
    if (JSON.stringify(normalizedArgs) === JSON.stringify(args)) return call
    return {
      ...call,
      args: normalizedArgs,
      argumentsText: JSON.stringify(normalizedArgs),
    }
  }

  function validate(name, args) {
    if (!isFileArtifactTool(name)) return null
    const replacementId = String(args?.replace_artifact_id || '').trim()
    const matching = matchingArtifacts(name)
    const authorizedIds = new Set(matching.map((artifact) => String(artifact.id)))
    if (revisionMode === 'conflict') {
      return {
        ok: false,
        code: 'artifact_revision_mode_conflict',
        error: 'The user gave conflicting instructions about replacing the original versus creating a new file.',
        retryable: false,
        hint: 'Call request_clarification before any artifact generator.',
      }
    }
    if (revisionMode === 'replace_original') {
      if (!replacementId && matching.length > 1) {
        return {
          ok: false,
          code: 'artifact_replacement_target_ambiguous',
          error: `More than one authorized ${name} artifact could be replaced in place.`,
          retryable: false,
          hint: 'Call request_clarification so the user can identify the exact original file.',
        }
      }
      if (!replacementId && matching.length === 1) {
        return {
          ok: false,
          code: 'artifact_replacement_required',
          error: `This in-place revision must set replace_artifact_id to the exact authorized artifact ID: ${matching[0].id}.`,
          retryable: true,
          requiredArtifactId: matching[0].id,
        }
      }
      if (!replacementId || !authorizedIds.has(replacementId)) {
        return {
          ok: false,
          code: 'artifact_replacement_not_authorized',
          error: 'The requested replacement target was not explicitly authorized by the current user request.',
          retryable: false,
          authorizedArtifactIds: [...authorizedIds],
        }
      }
      return null
    }
    if (replacementId) {
      return {
        ok: false,
        code: 'artifact_replacement_not_authorized',
        error: revisionMode === 'create_copy'
          ? 'The user explicitly requested a new file, so the original artifact must not be replaced.'
          : 'In-place replacement was not explicitly authorized by the current user request.',
        retryable: false,
        hint: 'Omit replace_artifact_id and create a new artifact.',
      }
    }
    return null
  }

  return Object.freeze({ normalizeCall, validate })
}

export function createWorkspaceTargetGuard({
  enabled = false,
  exactTargetPaths = [],
} = {}) {
  const allowedPaths = Array.isArray(exactTargetPaths) ? [...exactTargetPaths] : []
  const isManagedArtifactStorePath = (candidate) => (
    /(?:^|[\\/])\.artifacts(?:[\\/]|$)/i.test(String(candidate || '').trim())
  )
  const isAllowedTarget = (candidate) => allowedPaths.some((target) => targetsMatch(candidate, target))

  function validate(name, args = {}) {
    if (!enabled) return null
    const call = { name, args }
    const fileMutationTool = ['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'patch_file'].includes(name)
    const commandMutationTool = isCommandExecutionTool(call) && isLocalMutationCall(call)
    if (!fileMutationTool && !commandMutationTool) return null

    const candidatePaths = fileMutationTool
      ? [
        args?.path,
        args?.file_path,
        args?.filePath,
        ...(Array.isArray(args?.edits)
          ? args.edits.flatMap((edit) => [edit?.path, edit?.file_path, edit?.filePath])
          : []),
      ]
      : [...extractMutationTargets(call, null)]
    if (fileMutationTool && (name === 'apply_patch' || name === 'patch_file')) {
      const patchText = String(args?.patch || args?.diff || '')
      for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
        candidatePaths.push(match[1])
      }
    }
    const concretePaths = [...new Set(candidatePaths
      .map((candidate) => String(candidate || '').trim())
      .filter(Boolean))]
    const unprovenCommandTarget = commandMutationTool && (
      concretePaths.length === 0 || concretePaths.includes(PROJECT_SCOPE_TARGET)
    )
    const disallowedPaths = concretePaths.filter((candidate) => (
      candidate === PROJECT_SCOPE_TARGET || !isAllowedTarget(candidate)
    ))
    if (!unprovenCommandTarget && disallowedPaths.length === 0) return null
    const managedStoreMismatch = disallowedPaths.some(isManagedArtifactStorePath)
    return {
      ok: false,
      code: managedStoreMismatch
        ? 'workspace_target_managed_store_mismatch'
        : unprovenCommandTarget
          ? 'workspace_mutation_target_unproven'
          : 'workspace_target_mismatch',
      error: managedStoreMismatch
        ? 'The user requested an exact local/workspace file, but this call would write to Gugo managed artifact storage instead.'
        : unprovenCommandTarget
          ? 'The user requested an exact local/workspace file, but this command does not statically prove every file it may modify.'
          : 'The user requested an exact local/workspace file, but this call would modify a different path.',
      retryable: true,
      allowedPaths,
      rejectedPaths: disallowedPaths,
      hint: commandMutationTool
        ? 'Use expected_outputs or a statically recognizable literal write target, and make every target exactly match the requested local/workspace file.'
        : 'Use only the exact requested local/workspace path. Do not create a sibling copy or substitute a same-named file from .artifacts.',
    }
  }

  return Object.freeze({ validate })
}

export function createDisabledToolGuard({ toolsConfig, restoredDisabledToolNames = [] } = {}) {
  const hasCurrentConfig = toolsConfig && typeof toolsConfig === 'object'
  const executionToolsConfig = normalizeServerToolsConfig(
    hasCurrentConfig ? toolsConfig : { disabled: restoredDisabledToolNames },
  )
  const disabledToolNames = new Set(
    executionToolsConfig.disabled.filter((name) => name !== 'set_deliverables'),
  )

  function validate(name) {
    const normalizedName = String(name || '').trim()
    if (!normalizedName || !disabledToolNames.has(normalizedName)) return null
    return {
      ok: false,
      denied: true,
      policyDenied: true,
      code: 'tool_disabled_by_config',
      error: `工具 ${normalizedName} 已加载，但在当前工具配置中被禁用，因此本次调用被策略拒绝。`,
      retryable: false,
      tool: normalizedName,
      hint: '如需执行，请先在工具设置中启用该工具；不要把此结果描述为工具不存在或本轮不可用。',
    }
  }

  return Object.freeze({ disabledToolNames, validate })
}

export function createExplicitReadOnlyGuard({ enabled = false, userId = null } = {}) {
  function validate(name, args) {
    if (!enabled) return null
    const metadata = getToolMetadata(name, { args, userId })
    if (metadata?.isReadOnly === true) return null
    return {
      ok: false,
      denied: true,
      policyDenied: true,
      code: 'explicit_read_only_constraint',
      error: '用户明确要求本轮只读。该工具已加载，但这次调用可能修改数据或产生副作用，因此已被策略拒绝；这不是缺少写入或执行工具。',
      retryable: false,
      hint: '本轮仅使用只读检查工具。需要修改时，请让用户在新的消息中明确授权执行。',
    }
  }

  return Object.freeze({ validate })
}

export function createRedundantImageGuard({
  patchOnlyWorkspaceIntent = false,
  independentImageCreationRequested = false,
  hasSuccessfulExpectedPathWrite = () => false,
} = {}) {
  function validate(name) {
    return name === 'generate_image'
      && hasSuccessfulExpectedPathWrite()
      && patchOnlyWorkspaceIntent
      && !independentImageCreationRequested
      ? {
          ok: false,
          code: 'image_generation_not_requested_after_file_patch',
          error: '已有修复写入成功，无需重新生成图像。',
          retryable: false,
          suppressed: true,
          hint: '继续验证用户指定的已修改文件，或直接说明修复已完成；不要创建无关的新图片。',
        }
      : null
  }

  return Object.freeze({ validate })
}

export function resolveIterationWindow({
  restoredStart = 0,
  currentIteration = Number.MAX_SAFE_INTEGER,
  requestedSize,
  defaultSize,
} = {}) {
  const start = Math.min(
    Number(currentIteration),
    Math.max(0, Number(restoredStart) || 0),
  )
  const size = Math.max(1, Math.floor(Number(requestedSize) || defaultSize))
  return Object.freeze({ start, size, limit: start + size })
}
