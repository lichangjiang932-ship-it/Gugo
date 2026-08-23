import {
  CONNECTOR_TOOL_NAMES,
  CONNECTOR_WRITE_TOOL_NAMES,
  executeConnectorTool,
} from '../../connectorTools.js'
import {
  callTool as callMcpTool,
} from '../../../mcp/mcpManager.js'
import {
  dispatchAgenticTool,
} from '../../../utils/agenticTools.js'
import {
  dispatchApplyPatchTool,
} from '../../../utils/applyPatch.js'
import {
  dispatchBatchFileTool,
} from '../../../adapters/batchFileTools.js'
import {
  dispatchCodeSearchTool,
} from '../../../utils/codeSearch.js'
import {
  dispatchCodingAgentTool,
} from '../../../adapters/codingAgentTools.js'
import {
  dispatchFsShellTool,
} from '../../../adapters/fsShellTools.js'
import {
  dispatchGitTool,
} from '../../../adapters/gitWorkbench.js'
import {
  dispatchImageTool,
} from '../../../adapters/imageTools.js'
import {
  dispatchMediaTool,
} from '../../../adapters/mediaTools.js'
import {
  dispatchMemoryTool,
} from '../../../utils/memoryTools.js'
import {
  dispatchPdfTool,
} from '../../../adapters/pdfTools.js'
import {
  executeBrowserTool,
} from '../../browserToolExecutor.js'
import {
  executeSubagentBatch,
} from '../../subagentBatchBridge.js'
import {
  fetchAndExtract,
} from '../../../adapters/toolProxy.js'
import {
  getTurnArtifactById,
} from '../../turnArtifactStore.js'
import {
  isFileArtifactTool,
} from '../../artifactIntent.js'
import {
  killBackgroundProcess,
  listBackgroundProcesses,
  startBackgroundProcess,
} from '../../backgroundProcessStore.js'
import {
  normalizeToolError,
} from '../../../utils/toolCallHarness.js'
import { getBoundRuntimeTool } from '../../../core/runtimeCapabilityState.js'
import {
  getDynamicTool,
} from '../../../utils/toolSchemaCatalog.js'
import {
  publishTurnActivity,
} from '../../turnActivityBus.js'
import {
  readArtifactSourcePage,
} from '../../artifactSourceStore.js'
import {
  rewindFromToolCall,
} from '../../fileSnapshotStore.js'
import {
  searchWeb,
} from '../../webSearchService.js'
import {
  buildSubagentRequest,
  inheritedJobSkillIds,
} from './directoryReview.js'
import {
  executeGeneratedArtifactTool,
  isGeneratedArtifactTool,
} from './generatedArtifactExecutor.js'
import {
  BATCH_FILE_TOOL_NAMES,
  CODING_AGENT_TOOL_NAMES,
  FS_SHELL_TOOL_NAMES,
  IMAGE_TOOL_NAMES,
  MEDIA_TOOL_NAMES,
  PDF_TOOL_NAMES,
} from './htmlArtifactInput.js'
import {
  finalizePreMutationSnapshot,
  recordPreMutationSnapshot,
} from './preMutationSnapshot.js'
import {
  attachVisionFeedback,
} from './visionFeedback.js'

export async function executeServerTool({
  name,
  args,
  job,
  step,
  signal,
  budget,
  skillId,
  approvalContext,
  allowedArtifactTools,
  requiresLocalArtifactDelivery = false,
  toolCallId,
  idempotencyKey,
  idempotentResume = false,
  sideEffectRecoveryPlan = null,
  dynamicToolRegistrationId = null,
}) {
  const publishLiveOutput = (delta) => {
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
    } catch { /* Live output is best-effort and must never fail the tool. */ }
  }

  if (isFileArtifactTool(name) && !allowedArtifactTools?.has(name)) {
    return {
      ok: false,
      code: 'artifact_tool_not_requested',
      error: `用户没有明确要求生成 ${name} 文件，本轮拒绝执行。`,
      retryable: false,
    }
  }
  const registeredTool = getDynamicTool(name, { userId: job?.userId || null })
  if (dynamicToolRegistrationId
    && registeredTool?.registrationId !== dynamicToolRegistrationId) {
    return {
      ok: false,
      code: 'runtime_tool_binding_changed',
      error: `The capability binding for ${name} changed before execution. The stale call was not executed.`,
      retryable: false,
      refreshToolCatalog: true,
    }
  }
  // Artifact lifecycle authority never crosses the runtime-tool replacement
  // seam. Even a stale or manually injected plugin binding cannot mint a
  // successful artifact receipt without the host generator, validator,
  // persistence store, publication path, and delivery policy completing.
  if (isGeneratedArtifactTool(name)) {
    return executeGeneratedArtifactTool({
      name,
      args,
      job,
      step,
      signal,
      requiresLocalArtifactDelivery,
    })
  }
  const boundTool = getBoundRuntimeTool(name)
  if (typeof boundTool?.exec === 'function') {
    if (registeredTool?.exec !== boundTool.exec) {
      return {
        ok: false,
        code: 'runtime_tool_binding_changed',
        error: `The capability binding for ${name} changed before execution. The stale call was not executed.`,
        retryable: false,
        refreshToolCatalog: true,
      }
    }
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
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err
      return normalizeToolError(err, { fallbackCode: 'plugin_tool_failed' })
    }
  }
  if (name === 'bash_background') {
    try {
      const process = startBackgroundProcess({
        userId: job?.userId || null,
        sessionId: job?.sessionId || null,
        turnId: job?.id || null,
        toolCallId: toolCallId || null,
        command: args?.command,
        cwd: args?.cwd || undefined,
      })
      return { ok: true, processId: process.id, pid: process.pid, logPath: process.logPath, status: process.status }
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'bash_background_failed' })
    }
  }
  if (name === 'process_list') {
    try {
      const processes = listBackgroundProcesses({ userId: job?.userId || null })
      return { ok: true, processes }
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'process_list_failed' })
    }
  }
  if (name === 'process_kill') {
    try {
      const process = await killBackgroundProcess({ userId: job?.userId || null, id: args?.process_id })
      if (!process) return { ok: false, code: 'PROCESS_NOT_FOUND', error: '后台进程不存在', retryable: false }
      if (process.status === 'orphaned') {
        return {
          ok: false,
          code: 'PROCESS_CONTROL_LOST',
          error: '后台进程由先前的服务实例启动，当前实例无法证明或控制其进程句柄；未伪报为已终止。',
          retryable: false,
          process,
        }
      }
      if (process.status !== 'killed') {
        return {
          ok: false,
          code: 'PROCESS_NOT_RUNNING',
          error: `后台进程当前状态为 ${process.status}，没有执行终止操作。`,
          retryable: false,
          process,
        }
      }
      return { ok: true, process }
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'process_kill_failed' })
    }
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
          ok: false,
          code: 'REWIND_SNAPSHOT_NOT_FOUND',
          error: '本轮没有可回退的文件变更快照',
          retryable: false,
        }
      }
      return {
        ok: true,
        rewound: result.count,
        files: result.rewound.map((entry) => ({ path: entry.snapshot.filePath, action: entry.action })),
      }
    } catch (err) {
      return {
        ...normalizeToolError(err, { fallbackCode: 'rewind_files_failed' }),
        ...(Number.isInteger(err?.partialCount) ? {
          partialCount: err.partialCount,
          partialRewind: Array.isArray(err.partialRewind) ? err.partialRewind : [],
        } : {}),
        ...(err?.recoveryPath ? { recoveryPath: err.recoveryPath } : {}),
      }
    }
  }
  if (name === 'web_search') {
    try {
      return await searchWeb({
        userId: job.userId,
        query: args?.query,
        maxResults: args?.max_results ?? args?.maxResults,
      })
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'WEB_SEARCH_ERROR' })
    }
  }
  if (name === 'read_artifact_source') {
    if (job?.origin !== 'chat' || !job?.userId || !job?.sessionId) {
      return {
        ok: false,
        code: 'artifact_source_scope_unavailable',
        error: 'Managed artifact source can only be read from its owning chat session.',
        retryable: false,
      }
    }
    const artifact = getTurnArtifactById({
      id: String(args?.artifact_id || '').trim(),
      userId: job.userId,
      sessionId: job.sessionId,
    })
    if (!artifact) {
      return {
        ok: false,
        code: 'artifact_source_not_found',
        error: 'The artifact does not exist in this user and session scope.',
        retryable: false,
      }
    }
    try {
      return readArtifactSourcePage({
        artifact,
        offset: args?.offset,
        limit: args?.limit,
      })
    } catch (error) {
      return normalizeToolError(error, { fallbackCode: 'artifact_source_read_failed' })
    }
  }
  if (name === 'fetch_url') {
    try {
      return await fetchAndExtract({ url: args?.url })
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  // fs/shell 工具不落 artifact,执行结果直接回给模型.
  // 任意 fsShellTools 抛错(包括 env 未启用 / 路径越界)都返回 {ok:false,error}.
  if (FS_SHELL_TOOL_NAMES.has(name)) {
    try {
      // A resumed write_file call is a read-only state proof. Capturing a new
      // "before" image here would incorrectly snapshot the already-written
      // content and could make a later rewind preserve the mutation.
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
        onOutput: publishLiveOutput,
      })
      finalizePreMutationSnapshot({ snapshot, result })
      return result
    } catch (err) {
      return {
        ...normalizeToolError(err, { fallbackCode: 'fs_tool_failed' }),
        ...(err?.path ? { path: err.path } : {}),
      }
    }
  }
  if (IMAGE_TOOL_NAMES.has(name)) {
    try {
      const result = await dispatchImageTool(name, args || {}, { userId: job?.userId || null, signal })
      return await attachVisionFeedback({ name, result })
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'image_tool_failed' })
    }
  }
  if (MEDIA_TOOL_NAMES.has(name)) {
    try {
      const result = await dispatchMediaTool(name, args || {}, { userId: job?.userId || null, signal, onOutput: publishLiveOutput })
      return await attachVisionFeedback({ name, result })
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'media_tool_failed' })
    }
  }
  if (PDF_TOOL_NAMES.has(name)) {
    try {
      return await dispatchPdfTool(name, args || {}, { userId: job?.userId || null, signal })
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'pdf_tool_failed' })
    }
  }
  if (BATCH_FILE_TOOL_NAMES.has(name)) {
    try {
      return await dispatchBatchFileTool(name, args || {}, { userId: job?.userId || null, signal })
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'batch_file_tool_failed' })
    }
  }
  if (CODING_AGENT_TOOL_NAMES.has(name)) {
    try {
      return await dispatchCodingAgentTool(name, args || {}, {
        userId: job?.userId || null,
        signal,
        toolCallId,
        idempotencyKey,
      })
    } catch (err) {
      return {
        ...normalizeToolError(err, { fallbackCode: 'coding_tool_failed' }),
        ...(err?.path ? { path: err.path } : {}),
        ...(err?.hint ? { hint: err.hint } : {}),
      }
    }
  }
  if (['grep_code', 'find_symbol', 'list_imports'].includes(name)) {
    try {
      return await dispatchCodeSearchTool(name, args || {}, { userId: job?.userId || null })
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  if (name === 'apply_patch') {
    try {
      return await dispatchApplyPatchTool(name, args || {}, { userId: job?.userId || null })
    } catch (err) {
      return {
        ok: false,
        code: err?.code || 'apply_patch_failed',
        error: err?.message || String(err),
        retryable: err?.retryable ?? ![401, 403, 404].includes(err?.statusCode),
        ...(err?.path ? { path: err.path } : {}),
        ...(err?.hint ? { hint: err.hint } : {}),
      }
    }
  }
  if (name === 'remember') {
    return dispatchMemoryTool(name, args || {}, { userId: job?.userId || null })
  }
  if (['reflect', 'request_clarification', 'request_directory', 'sleep_until'].includes(name)) {
    try {
      const result = await dispatchAgenticTool(name, args || {}, { userId: job?.userId || null })
      return result && typeof result === 'object'
        ? { ok: true, ...result }
        : { ok: true, result }
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'fetch_url_failed' })
    }
  }
  if (name === 'Agent') {
    try {
      return await executeSubagentBatch({
        userId: job?.userId || null,
        request: buildSubagentRequest(
          args,
          job?.modelName,
          inheritedJobSkillIds(job, skillId),
          job?.skillDefinitions,
          job?.modelProviderId,
          job?.modelConfigRevision,
        ),
        depth: -1,
        parentSessionId: job?.id || null,
        parentMessageId: step?.id || null,
        signal,
        budget,
        approvalContext,
      })
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  if (['git_status', 'git_diff', 'run_project_check', 'git_commit', 'git_push', 'git_rollback', 'git_write'].includes(name)) {
    try {
      return await dispatchGitTool(name, args || {}, {
        userId: job?.userId || null,
        toolCallId,
        idempotencyKey,
      })
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  // ★ manage_todos: 无副作用的计划工具,把清单原样回执给模型,
  // 让它在后续轮次里看得到自己拆的步骤和完成进度。
  if (name === 'manage_todos') {
    const todos = Array.isArray(args?.todos) ? args.todos : []
    const normalized = todos
      .filter((t) => t && typeof t === 'object')
      .slice(0, 50)
      .map((t) => ({
        content: String(t.content || '').slice(0, 300),
        status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending',
        activeForm: String(t.activeForm || '').slice(0, 300),
      }))
    const done = normalized.filter((t) => t.status === 'completed').length
    return {
      ok: true,
      todos: normalized,
      summary: `共 ${normalized.length} 项,已完成 ${done} 项`,
    }
  }
  if (CONNECTOR_TOOL_NAMES.includes(name)) {
    return executeConnectorTool(name, args || {}, {
      userId: job?.userId || null,
      toolCallId,
      idempotencyKey,
    })
  }
  if (name.startsWith('browser_')) {
    try {
      const result = await executeBrowserTool(name, args || {}, {
        userId: job?.userId || null,
        toolCallId,
        idempotencyKey,
        signal,
      })
      return result && typeof result === 'object' ? { ok: true, ...result } : { ok: true, result }
    } catch (err) {
      return {
        ok: false,
        code: err?.code || (err?.name === 'AbortError' ? 'browser_cancelled' : 'browser_tool_failed'),
        cancelled: err?.name === 'AbortError',
        error: err?.message || String(err),
        retryable: err?.name !== 'AbortError',
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
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err
      return normalizeToolError(err, { fallbackCode: 'mcp_tool_failed' })
    }
  }
  const dynamicTool = registeredTool
  if (typeof dynamicTool?.exec === 'function') {
    try {
      const result = await dynamicTool.exec(args || {}, {
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
        origin: dynamicTool.origin,
        source: dynamicTool.source,
      })
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        return Object.hasOwn(result, 'ok') ? result : { ok: true, ...result }
      }
      return { ok: true, result }
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err
      return normalizeToolError(err, { fallbackCode: 'plugin_tool_failed' })
    }
  }
  return { ok: false, error: `unknown tool: ${name}` }
}

executeServerTool.supportsIdempotentResume = ({ name, idempotencyKey } = {}) => (
  Boolean(idempotencyKey) && (
    name === 'write_file'
    || CONNECTOR_WRITE_TOOL_NAMES.includes(name)
  )
)
