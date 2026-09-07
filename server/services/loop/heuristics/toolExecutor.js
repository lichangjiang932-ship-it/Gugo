import { CONNECTOR_TOOL_NAMES, CONNECTOR_WRITE_TOOL_NAMES, executeConnectorTool } from '../../connectorTools.js'
import { callTool as callMcpTool } from '../../../mcp/mcpManager.js'
import { dispatchAgenticTool } from '../../../utils/agenticTools.js'
import { dispatchApplyPatchTool } from '../../../utils/applyPatch.js'
import { dispatchBatchFileTool } from '../../../adapters/batchFileTools.js'
import { dispatchCodeSearchTool } from '../../../utils/codeSearch.js'
import { dispatchCodingAgentTool } from '../../../adapters/codingAgentTools.js'
import { dispatchFsShellTool } from '../../../adapters/fsShellTools.js'
import { dispatchGitTool } from '../../../adapters/gitWorkbench.js'
import { dispatchImageTool } from '../../../adapters/imageTools.js'
import { dispatchMediaTool } from '../../../adapters/mediaTools.js'
import { dispatchMemoryTool } from '../../../utils/memoryTools.js'
import { dispatchSkillResourceTool, SKILL_RESOURCE_TOOL_NAME } from '../../../utils/skillResourceTools.js'
import { dispatchPdfTool } from '../../../adapters/pdfTools.js'
import { executeBrowserTool } from '../../browserToolExecutor.js'
import { executeSubagentBatch } from '../../subagentBatchBridge.js'
import { fetchAndExtract } from '../../../adapters/toolProxy.js'
import { getTurnArtifactById } from '../../turnArtifactStore.js'
import { isFileArtifactTool } from '../../artifactIntent.js'
import { killBackgroundProcess, listBackgroundProcesses, startBackgroundProcess } from '../../backgroundProcessStore.js'
import { normalizeToolError } from '../../../utils/toolCallHarness.js'
import { getBoundRuntimeTool } from '../../../core/runtimeCapabilityState.js'
import { getDynamicTool } from '../../../utils/toolSchemaCatalog.js'
import { publishTurnActivity } from '../../turnActivityBus.js'
import { readArtifactSourcePage } from '../../artifactSourceStore.js'
import { rewindFromToolCall } from '../../fileSnapshotStore.js'
import { searchWeb } from '../../webSearchService.js'
import { buildSubagentRequest, inheritedJobSkillIds } from './directoryReview.js'
import { executeGeneratedArtifactTool, isGeneratedArtifactTool } from './generatedArtifactExecutor.js'
import { executeLocalCodeCapabilityTool } from './localCodeCapabilityExecutor.js'
import { CODEX_MODELS_TOOL_NAME, dispatchCodexAppServerTool } from '../../codexAppServerTool.js'
import {
  BATCH_FILE_TOOL_NAMES,
  CODING_AGENT_TOOL_NAMES,
  FS_SHELL_TOOL_NAMES,
  IMAGE_TOOL_NAMES,
  MEDIA_TOOL_NAMES,
  PDF_TOOL_NAMES,
} from './htmlArtifactInput.js'
import { finalizePreMutationSnapshot, recordPreMutationSnapshot } from './preMutationSnapshot.js'
import { attachVisionFeedback } from './visionFeedback.js'

const UNHANDLED = Symbol('unhandled-tool')

function publishLiveToolOutput(context, delta) {
  const { job, name, toolCallId } = context
  if (job?.origin !== 'chat' || !job?.sessionId || !job?.id) return
  try {
    publishTurnActivity({
      userId: job.userId,
      activity: {
        sessionId: job.sessionId,
        turnId: job.id,
        kind: 'tool_output_delta',
        toolName: name,
        toolCallId: toolCallId || null,
        stream: delta?.stream || null,
        chunk: typeof delta?.chunk === 'string' ? delta.chunk.slice(0, 64 * 1024) : null,
      },
    })
  } catch { /* live output is best-effort */ }
}

async function executeBoundTool(context, boundTool) {
  const { name, args, job, step, signal, budget, skillId,
    approvalContext, toolCallId, idempotencyKey } = context
  try {
    const result = await boundTool.exec(args || {}, {
      name,
      userId: job?.userId || null,
      job,
      step,
      signal,
      budget,
      skillId,
      approvalContext,
      toolCallId,
      idempotencyKey,
      origin: boundTool.origin,
      source: boundTool.source,
    })
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return Object.hasOwn(result, 'ok') ? result : { ok: true, ...result }
    }
    return { ok: true, result }
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error
    return normalizeToolError(error, { fallbackCode: 'plugin_tool_failed' })
  }
}

async function executeProcessOrSourceTool(context) {
  const { name, args, job, toolCallId } = context
  if (name === 'bash_background') {
    try {
      const process = startBackgroundProcess({
        userId: job?.userId || null, sessionId: job?.sessionId || null,
        turnId: job?.id || null, toolCallId: toolCallId || null,
        command: args?.command, cwd: args?.cwd || undefined,
      })
      return {
        ok: true, processId: process.id, pid: process.pid,
        logPath: process.logPath, status: process.status,
      }
    } catch (error) { return normalizeToolError(error, { fallbackCode: 'bash_background_failed' }) }
  }
  if (name === 'process_list') {
    try { return { ok: true, processes: listBackgroundProcesses({ userId: job?.userId || null }) } }
    catch (error) { return normalizeToolError(error, { fallbackCode: 'process_list_failed' }) }
  }
  if (name === 'process_kill') {
    try {
      const process = await killBackgroundProcess({
        userId: job?.userId || null, id: args?.process_id,
      })
      if (!process) {
        return { ok: false, code: 'PROCESS_NOT_FOUND', error: '后台进程不存在', retryable: false }
      }
      if (process.status === 'orphaned') {
        return {
          ok: false,
          code: 'PROCESS_CONTROL_LOST',
          error: '后台进程由先前的服务实例启动，当前实例无法证明或控制其进程句柄；未伪报为已终止。',
          retryable: false,
          process,
        }
      }
      return process.status === 'killed'
        ? { ok: true, process }
        : {
            ok: false, code: 'PROCESS_NOT_RUNNING',
            error: `后台进程当前状态为 ${process.status}，没有执行终止操作。`,
            retryable: false, process,
          }
    } catch (error) { return normalizeToolError(error, { fallbackCode: 'process_kill_failed' }) }
  }
  if (name === 'rewind_files') {
    if (!job?.sessionId || !job?.id) {
      return { ok: false, code: 'REWIND_TARGET_UNAVAILABLE', error: '回退目标上下文不可用' }
    }
    try {
      const result = rewindFromToolCall({
        userId: job.userId,
        sessionId: job.sessionId,
        turnId: job.id,
        toolCallId: typeof args?.tool_call_id === 'string' && args.tool_call_id.trim()
          ? args.tool_call_id.trim()
          : null,
      })
      if (!result.found) {
        return {
          ok: false, code: 'REWIND_SNAPSHOT_NOT_FOUND',
          error: '本轮没有可回退的文件变更快照', retryable: false,
        }
      }
      return {
        ok: true,
        rewound: result.count,
        files: result.rewound.map((entry) => ({ path: entry.snapshot.filePath, action: entry.action })),
        changedPaths: result.rewound.map((entry) => entry.snapshot.filePath),
      }
    } catch (error) {
      return {
        ...normalizeToolError(error, { fallbackCode: 'rewind_files_failed' }),
        ...(Number.isInteger(error?.partialCount)
          ? { partialCount: error.partialCount, partialRewind: error.partialRewind || [] }
          : {}),
        ...(error?.recoveryPath ? { recoveryPath: error.recoveryPath } : {}),
      }
    }
  }
  if (name === 'web_search') {
    try {
      return await searchWeb({
        userId: job.userId, query: args?.query, maxResults: args?.max_results ?? args?.maxResults,
      })
    } catch (error) { return normalizeToolError(error, { fallbackCode: 'WEB_SEARCH_ERROR' }) }
  }
  if (name === 'read_artifact_source') {
    if (job?.origin !== 'chat' || !job?.userId || !job?.sessionId) {
      return {
        ok: false, code: 'artifact_source_scope_unavailable',
        error: 'Managed artifact source can only be read from its owning chat session.',
        retryable: false,
      }
    }
    const artifact = getTurnArtifactById({
      id: String(args?.artifact_id || '').trim(), userId: job.userId, sessionId: job.sessionId,
    })
    if (!artifact) {
      return {
        ok: false, code: 'artifact_source_not_found',
        error: 'The artifact does not exist in this user and session scope.', retryable: false,
      }
    }
    try { return readArtifactSourcePage({ artifact, offset: args?.offset, limit: args?.limit }) }
    catch (error) { return normalizeToolError(error, { fallbackCode: 'artifact_source_read_failed' }) }
  }
  if (name === 'fetch_url') {
    try { return await fetchAndExtract({ url: args?.url }) }
    catch (error) { return { ok: false, error: error?.message || String(error) } }
  }
  return UNHANDLED
}

async function executeFileOrMediaTool(context) {
  const { name, args, job, signal, toolCallId, idempotencyKey,
    idempotentResume, sideEffectRecoveryPlan } = context
  if (FS_SHELL_TOOL_NAMES.has(name)) {
    try {
      const snapshot = !idempotentResume
        ? await recordPreMutationSnapshot({ name, args, job, toolCallId })
        : null
      const result = await dispatchFsShellTool(name, args || {}, {
        userId: job?.userId || null,
        signal,
        toolCallId,
        idempotencyKey,
        idempotentResume,
        sideEffectRecoveryPlan,
        onOutput: (delta) => publishLiveToolOutput(context, delta),
      })
      finalizePreMutationSnapshot({ snapshot, result })
      return result
    } catch (error) {
      return {
        ...normalizeToolError(error, { fallbackCode: 'fs_tool_failed' }),
        ...(error?.path ? { path: error.path } : {}),
      }
    }
  }
  if (IMAGE_TOOL_NAMES.has(name) || MEDIA_TOOL_NAMES.has(name)) {
    try {
      const dispatch = IMAGE_TOOL_NAMES.has(name) ? dispatchImageTool : dispatchMediaTool
      const result = await dispatch(name, args || {}, {
        userId: job?.userId || null,
        signal,
        ...(MEDIA_TOOL_NAMES.has(name)
          ? { onOutput: (delta) => publishLiveToolOutput(context, delta) }
          : {}),
      })
      return await attachVisionFeedback({ name, result })
    } catch (error) {
      return normalizeToolError(error, {
        fallbackCode: IMAGE_TOOL_NAMES.has(name) ? 'image_tool_failed' : 'media_tool_failed',
      })
    }
  }
  const dispatchers = [
    [PDF_TOOL_NAMES, dispatchPdfTool, 'pdf_tool_failed'],
    [BATCH_FILE_TOOL_NAMES, dispatchBatchFileTool, 'batch_file_tool_failed'],
  ]
  for (const [names, dispatch, fallbackCode] of dispatchers) {
    if (!names.has(name)) continue
    try { return await dispatch(name, args || {}, { userId: job?.userId || null, signal }) }
    catch (error) { return normalizeToolError(error, { fallbackCode }) }
  }
  if (CODING_AGENT_TOOL_NAMES.has(name)) {
    try {
      return await dispatchCodingAgentTool(name, args || {}, {
        userId: job?.userId || null, signal, toolCallId, idempotencyKey,
      })
    } catch (error) {
      return {
        ...normalizeToolError(error, { fallbackCode: 'coding_tool_failed' }),
        ...(error?.path ? { path: error.path } : {}),
        ...(error?.hint ? { hint: error.hint } : {}),
      }
    }
  }
  if (['grep_code', 'find_symbol', 'list_imports'].includes(name)) {
    try { return await dispatchCodeSearchTool(name, args || {}, { userId: job?.userId || null }) }
    catch (error) { return { ok: false, error: error?.message || String(error) } }
  }
  if (name === 'lsp' || name === 'run_code') {
    return executeLocalCodeCapabilityTool({
      name, args, userId: job?.userId || null, signal, toolCallId,
    })
  }
  if (name === CODEX_MODELS_TOOL_NAME) {
    return dispatchCodexAppServerTool(name, args || {}, { userId: job?.userId || null, signal })
  }
  if (name === 'apply_patch') {
    try { return await dispatchApplyPatchTool(name, args || {}, { userId: job?.userId || null }) }
    catch (error) {
      return {
        ok: false,
        code: error?.code || 'apply_patch_failed',
        error: error?.message || String(error),
        retryable: error?.retryable ?? ![401, 403, 404].includes(error?.statusCode),
        ...(error?.path ? { path: error.path } : {}),
        ...(error?.hint ? { hint: error.hint } : {}),
      }
    }
  }
  return UNHANDLED
}

function normalizedTodos(args) {
  return (Array.isArray(args?.todos) ? args.todos : [])
    .filter((todo) => todo && typeof todo === 'object')
    .slice(0, 50)
    .map((todo) => ({
      content: String(todo.content || '').slice(0, 300),
      status: ['pending', 'in_progress', 'completed'].includes(todo.status)
        ? todo.status
        : 'pending',
      activeForm: String(todo.activeForm || '').slice(0, 300),
    }))
}

async function executeAgentOrExternalTool(context, registeredTool) {
  const { name, args, job, step, signal, budget, skillId,
    approvalContext, toolCallId, idempotencyKey, dynamicToolRegistrationId } = context
  if (name === 'remember') return dispatchMemoryTool(name, args || {}, {
    userId: job?.userId || null,
    agentId: job?.agentId || null,
    sessionId: job?.sessionId || null,
  })
  if (['reflect', 'request_clarification', 'request_directory', 'sleep_until'].includes(name)) {
    try {
      const result = await dispatchAgenticTool(name, args || {}, { userId: job?.userId || null })
      return result && typeof result === 'object' ? { ok: true, ...result } : { ok: true, result }
    } catch (error) { return normalizeToolError(error, { fallbackCode: 'fetch_url_failed' }) }
  }
  if (name === 'Agent') {
    try {
      return await executeSubagentBatch({
        userId: job?.userId || null,
        locale: job?.locale || 'zh',
        request: buildSubagentRequest(
          args, job?.modelName, inheritedJobSkillIds(job, skillId),
          job?.skillDefinitions, job?.modelProviderId, job?.modelConfigRevision,
        ),
        depth: -1,
        parentSessionId: job?.id || null,
        parentMessageId: step?.id || null,
        signal,
        budget,
        approvalContext,
      })
    } catch (error) { return { ok: false, error: error?.message || String(error) } }
  }
  if (['git_status', 'git_diff', 'run_project_check', 'git_commit', 'git_push', 'git_rollback', 'git_write'].includes(name)) {
    try {
      return await dispatchGitTool(name, args || {}, {
        userId: job?.userId || null, signal, toolCallId, idempotencyKey,
      })
    } catch (error) { return { ok: false, error: error?.message || String(error) } }
  }
  if (name === 'manage_todos') {
    const todos = normalizedTodos(args)
    return {
      ok: true,
      todos,
      summary: `共 ${todos.length} 项,已完成 ${todos.filter((todo) => todo.status === 'completed').length} 项`,
    }
  }
  if (CONNECTOR_TOOL_NAMES.includes(name)) {
    return executeConnectorTool(name, args || {}, {
      userId: job?.userId || null, toolCallId, idempotencyKey,
    })
  }
  if (name.startsWith('browser_')) {
    try {
      const result = await executeBrowserTool(name, args || {}, {
        userId: job?.userId || null, toolCallId, idempotencyKey, signal,
      })
      return result && typeof result === 'object' ? { ok: true, ...result } : { ok: true, result }
    } catch (error) {
      return {
        ok: false,
        code: error?.code || (error?.name === 'AbortError' ? 'browser_cancelled' : 'browser_tool_failed'),
        cancelled: error?.name === 'AbortError',
        error: error?.message || String(error),
        retryable: error?.name !== 'AbortError',
      }
    }
  }
  if (name.startsWith('mcp__')) {
    try {
      const result = await callMcpTool({
        userId: job?.userId || null,
        fullToolName: name,
        args: args || {},
        toolCallId,
        idempotencyKey,
        dynamicToolRegistrationId,
        signal,
      })
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        return { ok: !result.isError, ...result }
      }
      return { ok: true, result }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error
      return normalizeToolError(error, { fallbackCode: 'mcp_tool_failed' })
    }
  }
  if (typeof registeredTool?.exec === 'function') return executeBoundTool(context, registeredTool)
  return UNHANDLED
}

export async function executeServerTool(context) {
  const { name, args, job, step, signal, allowedArtifactTools,
    requiresLocalArtifactDelivery, dynamicToolRegistrationId } = context
  if (isFileArtifactTool(name) && !allowedArtifactTools?.has(name)) {
    return {
      ok: false, code: 'artifact_tool_not_requested',
      error: `用户没有明确要求生成 ${name} 文件，本轮拒绝执行。`, retryable: false,
    }
  }
  const registeredTool = getDynamicTool(name, { userId: job?.userId || null })
  if (dynamicToolRegistrationId && registeredTool?.registrationId !== dynamicToolRegistrationId) {
    return {
      ok: false, code: 'runtime_tool_binding_changed',
      error: `The capability binding for ${name} changed before execution. The stale call was not executed.`,
      retryable: false, refreshToolCatalog: true,
    }
  }
  if (isGeneratedArtifactTool(name)) {
    return executeGeneratedArtifactTool({
      name, args, job, step, signal, requiresLocalArtifactDelivery,
    })
  }
  const boundTool = getBoundRuntimeTool(name)
  if (typeof boundTool?.exec === 'function') {
    if (registeredTool?.exec !== boundTool.exec) {
      return {
        ok: false, code: 'runtime_tool_binding_changed',
        error: `The capability binding for ${name} changed before execution. The stale call was not executed.`,
        retryable: false, refreshToolCatalog: true,
      }
    }
    return executeBoundTool(context, boundTool)
  }
  if (name === SKILL_RESOURCE_TOOL_NAME) return dispatchSkillResourceTool(args || {}, context)
  for (const execute of [executeProcessOrSourceTool, executeFileOrMediaTool]) {
    const result = await execute(context)
    if (result !== UNHANDLED) return result
  }
  const external = await executeAgentOrExternalTool(context, registeredTool)
  return external === UNHANDLED ? { ok: false, error: `unknown tool: ${name}` } : external
}

executeServerTool.supportsIdempotentResume = ({ name, idempotencyKey } = {}) => (
  Boolean(idempotencyKey) && (name === 'write_file' || CONNECTOR_WRITE_TOOL_NAMES.includes(name))
)
