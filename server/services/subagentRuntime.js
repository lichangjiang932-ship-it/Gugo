/**
 * 隔离子代理运行时的稳定入口。
 *
 * 策略、工具循环、持久化状态和批处理编排分别位于相邻模块；这里保留
 * 工具派发、单次运行编排以及向后兼容的公共导出。
 */

import {
  callBackgroundModel,
  callBackgroundModelWithTools,
} from '../adapters/modelProxy.js'
import { dispatchFsShellTool } from '../adapters/fsShellTools.js'
import { fetchAndExtract } from '../adapters/toolProxy.js'
import { dispatchAgenticTool } from '../utils/agenticTools.js'
import { dispatchApplyPatchTool } from '../utils/applyPatch.js'
import { dispatchCodeSearchTool } from '../utils/codeSearch.js'
import { createJobBudget } from '../utils/jobBudget.js'
import { dispatchLspTool } from '../utils/lspTool.js'
import { dispatchMemoryTool } from '../utils/memoryTools.js'
import { requestApproval } from './approvalGate.js'
import { dispatchHooks } from './hooksService.js'
import { hasConfiguredLspProvider } from './lspRuntime.js'
import {
  normalizePromptContextIds,
  prepareOptionalPromptContext,
} from './optionalPromptContext.js'
import { buildSafetyBlock, prepareInlineSkillsForPrompt } from './promptCompiler.js'
import {
  approvalCacheKey,
  createSubagentApprovalContext,
  rememberApprovedSubagentCall,
} from './subagentApprovalContext.js'
import {
  configureSubagentBatchRunner,
  normalizeSubagentTasks,
  runSubagentBatch,
} from './subagentBatchRuntime.js'
import { SUBAGENT_MAX_PER_BATCH } from './subagentBatchConfig.js'
import { resolveSubagentModelBinding } from './subagentModelBindingRuntime.js'
import { invokeRuntimeSubagentProvider } from './subagentProvider.js'
import {
  MAX_CONCURRENT_PER_USER,
  MAX_SUBAGENT_DEPTH,
  RESUMABLE_SUBAGENT_STATUSES,
  SUBAGENT_BUDGET,
  SUBAGENT_NEEDS_VERIFICATION,
  SUBAGENT_RECOVERY_EVENT,
  SUBAGENT_TYPES,
  boundedTranscriptValue,
  configureSubagentLoopRunner,
  createSlotLease,
  getDefaultSubagentLoopRunner,
  getSubagentLimiterSnapshot,
  requestTreeApproval,
  withYieldedSlot,
} from './subagentRuntimePolicy.js'
import {
  appendProviderProvenance,
  checkpointFromTrace,
  getSubagentRun,
  insertRun,
  makeCheckpointResumable,
  markRunRunning,
  newSubagentRunId,
  now,
  parseTrace,
  providerProvenanceFromTrace,
  recoverInterruptedSubagentRuns,
  resolveRunPersistencePort,
  saveRunCheckpoint,
  saveRunTrace,
  sideEffectRecoveryError,
  sideEffectRecoveryFields,
  subagentProviderError,
  subagentStatusForLoopResult,
  toRun,
  traceWithCheckpoint,
  updateRun,
} from './subagentRunState.js'
import { runSubagentToolLoop } from './subagentToolLoop.js'
import { searchWeb } from './webSearchService.js'

export {
  SUBAGENT_TYPES,
  configureSubagentLoopRunner,
  createSubagentApprovalContext,
  getSubagentRun,
  newSubagentRunId,
  recoverInterruptedSubagentRuns,
  rememberApprovedSubagentCall,
  runSubagentBatch,
}

export function listSubagentTypes() {
  return Object.entries(SUBAGENT_TYPES).map(([id, info]) => ({ id, label: info.label }))
}

/** 在子代理隔离上下文中派发一个工具调用。 */
async function executeSubagentTool(toolName, args, {
  userId = null,
  modelName = undefined,
  modelProviderId = null,
  modelConfigRevision = null,
  skillIds = [],
  skillDefinitions = [],
  depth = 0,
  parentRunId = null,
  parentSessionId = null,
  signal = null,
  budget = null,
  approvalContext = null,
  slotLease = null,
  approveTool = requestApproval,
  runToolLoop = null,
  sideEffectLedger = null,
  toolCallId = null,
  idempotencyKey = null,
  idempotentResume = false,
  sideEffectRecoveryPlan = null,
} = {}) {
  switch (toolName) {
    case 'web_search':
      return searchWeb({ userId, query: args.query, maxResults: args.max_results ?? args.maxResults })
    case 'fetch_url':
      return fetchAndExtract({ url: args.url })
    case 'read_file':
    case 'list_directory':
    case 'write_file':
    case 'edit_file':
      return dispatchFsShellTool(toolName, args, {
        userId,
        signal,
        toolCallId,
        idempotencyKey,
        idempotentResume,
        sideEffectRecoveryPlan,
      })
    case 'grep_code':
    case 'find_symbol':
    case 'list_imports':
      return dispatchCodeSearchTool(toolName, args, { userId })
    case 'lsp':
      return dispatchLspTool(args, { userId, signal })
    case 'apply_patch':
      return dispatchApplyPatchTool(toolName, args, { userId })
    case 'remember':
      return dispatchMemoryTool(toolName, args, { userId })
    case 'reflect':
    case 'request_clarification':
    case 'request_directory':
    case 'sleep_until':
      return dispatchAgenticTool(toolName, args, { userId })
    case 'Agent': {
      const rawRequest = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
      const request = { ...rawRequest }
      delete request.skillDefinitions
      delete request.skill_definitions
      const inheritedSkillIds = normalizePromptContextIds(request.skillIds || request.skill_ids || skillIds)
      const inheritedSkillDefinitions = prepareInlineSkillsForPrompt({
        skillIds: inheritedSkillIds,
        skillDefinitions,
      })
      return withYieldedSlot(slotLease, signal, () => runSubagentBatch({
        userId,
        request: {
          ...request,
          modelName: String(request.modelName || request.model_name || modelName || '').trim() || undefined,
          ...(modelProviderId ? { modelProviderId } : {}),
          ...(modelConfigRevision ? { modelConfigRevision } : {}),
          skillIds: inheritedSkillIds,
          ...(inheritedSkillDefinitions.length ? { skillDefinitions: inheritedSkillDefinitions } : {}),
        },
        depth,
        parentSessionId: parentSessionId || (parentRunId ? `subagent:${parentRunId}` : null),
        parentMessageId: parentRunId,
        signal,
        budget,
        approvalContext,
        approveTool,
        runToolLoop,
        sideEffectLedger,
      }))
    }
    default:
      return { ok: false, error: `unknown subagent tool: ${toolName}` }
  }
}

executeSubagentTool.supportsIdempotentResume = ({ name, idempotencyKey } = {}) => (
  name === 'write_file' && Boolean(idempotencyKey)
)

async function subagentToolsLoop(options = {}) {
  return runSubagentToolLoop({
    ...options,
    executeTool: options.executeTool === undefined ? executeSubagentTool : options.executeTool,
    runToolLoop: options.runToolLoop === undefined
      ? getDefaultSubagentLoopRunner()
      : options.runToolLoop,
  })
}

/** 运行一个隔离子代理。 */
export async function runSubagent({
  id = newSubagentRunId(),
  userId,
  type = 'general',
  prompt,
  description = '',
  agentId = null,
  skillIds = [],
  skillDefinitions = [],
  team = null,
  parentSessionId = null,
  parentMessageId = null,
  modelName,
  modelProviderId = null,
  modelConfigRevision = null,
  signal,
  depth = 0,
  budget = null,
  approvalContext = null,
  callModel = callBackgroundModelWithTools,
  executeTool = executeSubagentTool,
  approveTool = requestApproval,
  preparePromptContext,
  runToolLoop = getDefaultSubagentLoopRunner(),
  sideEffectLedger = null,
  persistencePort = null,
  resolveModelBinding = resolveSubagentModelBinding,
  invokeSubagentProvider = invokeRuntimeSubagentProvider,
  resumeBlocked = false,
} = {}) {
  if (!userId) throw new Error('userId is required')
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is required')
  if (!SUBAGENT_TYPES[type]) throw new Error(`unknown subagent type: ${type}`)
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_SUBAGENT_DEPTH) {
    throw new Error(`subagent depth must be between 0 and ${MAX_SUBAGENT_DEPTH}`)
  }
  const normalizedPrompt = String(prompt).trim()
  const runPersistence = resolveRunPersistencePort(persistencePort)

  const storedRun = await runPersistence.getRun({ id, userId })
  const explicitBlockedResume = storedRun?.status === SUBAGENT_NEEDS_VERIFICATION
    && resumeBlocked === true
  if (storedRun) {
    if (storedRun.agentType !== type || storedRun.prompt !== normalizedPrompt) {
      throw new Error('subagent run id belongs to a different task')
    }
    if (!RESUMABLE_SUBAGENT_STATUSES.has(storedRun.status) && !explicitBlockedResume) {
      if (storedRun.status === 'running') throw new Error('subagent run is already running')
      return toRun(storedRun)
    }
  }

  // 恢复时只信任创建运行时持久化的不可变模型快照。
  const requestedModelName = String(storedRun ? (storedRun.modelName || '') : (modelName || '')).trim() || null
  const requestedProviderId = String(storedRun ? (storedRun.modelProviderId || '') : (modelProviderId || '')).trim() || null
  const requestedConfigRevision = Number(storedRun ? storedRun.modelConfigRevision : modelConfigRevision)
  const normalizedConfigRevision = Number.isInteger(requestedConfigRevision) && requestedConfigRevision > 0
    ? requestedConfigRevision
    : null
  const modelBinding = resolveModelBinding({
    userId,
    providerId: requestedProviderId || '',
    modelName: requestedModelName || '',
    configRevision: normalizedConfigRevision,
    requirePersistedBinding: Boolean(storedRun),
  })
  if (storedRun) {
    const callerProviderId = String(modelProviderId || '').trim()
    const callerModelName = String(modelName || '').trim()
    if ((callerProviderId && callerProviderId !== requestedProviderId)
      || (callerModelName && callerModelName !== requestedModelName)
      || (modelConfigRevision != null && Number(modelConfigRevision) !== normalizedConfigRevision)) {
      throw new Error('subagent run model binding does not match the persisted snapshot')
    }
  }

  const slotLease = createSlotLease(userId)
  await slotLease.acquire(signal)
  const effectiveBudget = budget || createJobBudget({ ...SUBAGENT_BUDGET })
  const effectiveApprovalContext = approvalContext || createSubagentApprovalContext()

  const trace = storedRun
    ? parseTrace(storedRun.trace)
    : [
        { type: 'start', description, at: now() },
        ...(team ? [{ type: 'team', team, at: now() }] : []),
      ]
  if (storedRun) trace.push({ type: 'resume', fromStatus: storedRun.status, at: now() })
  const onTranscriptEvent = (event) => trace.push({ ...event, type: 'transcript', eventType: event.type })
  let checkpointState = checkpointFromTrace(trace)
  let ownsRunAttempt = false
  let terminalWriteStarted = false

  try {
    if (storedRun) await markRunRunning(runPersistence, { id, userId, trace })
    else await insertRun(runPersistence, {
      id,
      userId,
      type,
      prompt: normalizedPrompt,
      parentSessionId,
      parentMessageId,
      modelName: modelBinding.modelName || null,
      modelProviderId: modelBinding.providerId || null,
      modelConfigRevision: modelBinding.configRevision || null,
      trace,
    })
    ownsRunAttempt = true

    if (!explicitBlockedResume) {
      const previousProvider = providerProvenanceFromTrace(trace)
      appendProviderProvenance(trace, { decision: 'invoking' })
      await saveRunTrace(runPersistence, { id, userId, trace })
      let providerResolution
      try {
        const initialDescription = storedRun
          ? parseTrace(storedRun.trace).find((event) => event?.type === 'start')?.description
          : description
        const initialTeam = storedRun
          ? parseTrace(storedRun.trace).find((event) => event?.type === 'team')?.team
          : team
        providerResolution = await invokeSubagentProvider({
          runId: id,
          resume: Boolean(storedRun),
          type,
          prompt: normalizedPrompt,
          description: initialDescription || '',
          depth,
          model: {
            name: modelBinding.modelName || null,
            providerId: modelBinding.providerId || null,
            configRevision: modelBinding.configRevision || null,
          },
          team: initialTeam || null,
        }, {
          signal,
          timeoutMs: SUBAGENT_BUDGET.maxWallMs,
        })
        const providerDecision = providerResolution?.provenance?.decision
        const validBuiltin = providerResolution?.kind === 'builtin'
          && (providerDecision === 'absent' || providerDecision === 'decline')
        const validHandled = providerResolution?.kind === 'handled'
          && providerDecision === 'handled'
          && providerResolution.terminal
          && typeof providerResolution.terminal === 'object'
        if (!validBuiltin && !validHandled) {
          throw subagentProviderError(
            'SUBAGENT_PROVIDER_RESULT_INVALID',
            'runtime subagent provider returned an invalid resolution',
          )
        }
        if (storedRun
          && (previousProvider?.decision === 'handled' || previousProvider?.decision === 'invoking')
          && providerResolution.kind === 'builtin'
          && providerDecision === 'absent') {
          throw subagentProviderError(
            'SUBAGENT_PROVIDER_UNAVAILABLE',
            'runtime subagent provider is unavailable for this durable run',
            previousProvider,
          )
        }
      } catch (error) {
        appendProviderProvenance(trace, error?.providerProvenance || {
          decision: 'error',
          error: error?.code || 'SUBAGENT_PROVIDER_INVOCATION_FAILED',
        })
        throw error
      }
      appendProviderProvenance(trace, providerResolution?.provenance)
      if (providerResolution?.kind === 'handled') {
        const status = providerResolution.terminal.status
        const reason = providerResolution.terminal.reason
        const resultText = providerResolution.terminal.text || reason || ''
        trace.push({
          type: status === 'completed' ? 'done' : status,
          ...(reason ? { reason } : {}),
          at: now(),
        })
        void dispatchHooks({
          userId,
          event: 'subagent_stop',
          tool: type,
          args: { resultText: boundedTranscriptValue(resultText), status },
          sessionId: parentSessionId || null,
          requestId: id,
          hookInvocationId: `subagent:${id}:stop:${status}`,
        }).catch(() => { /* subagent_stop hook is best-effort */ })
        terminalWriteStarted = true
        return await updateRun(runPersistence, {
          id,
          userId,
          status,
          resultText,
          trace,
        })
      }
    }
    const { system, tools } = SUBAGENT_TYPES[type]
    const effectiveTools = tools.filter((spec) => (
      spec?.function?.name !== 'lsp' || hasConfiguredLspProvider()
    ))
    const promptContextMessages = prepareOptionalPromptContext({
      preparePromptContext,
      input: {
        userId,
        agentId,
        skillIds: normalizePromptContextIds(skillIds),
        skillDefinitions: prepareInlineSkillsForPrompt({ skillIds, skillDefinitions }),
        query: normalizedPrompt,
      },
      scope: 'subagent.prompt',
    }).messages
    const messages = [
      { role: 'system', content: buildSafetyBlock().text },
      ...promptContextMessages,
      {
        role: 'system',
        content: type === 'general'
          ? `${system}\nYou may call Agent with up to ${SUBAGENT_MAX_PER_BATCH} independent tasks to run them in parallel. Nested delegation is bounded to ${MAX_SUBAGENT_DEPTH} levels.`
          : system,
      },
      ...(team ? [{
        role: 'system',
        content: `# Team Context\nTeam: ${team.name} (${team.id})\nMode: ${team.mode}\nYour role: ${team.role || description || type}\nWork only on your assigned scope. Your transcript is isolated from other members; return a concise result for the leader to merge.`,
      }] : []),
      { role: 'user', content: normalizedPrompt },
    ]

    if (storedRun && checkpointState) {
      checkpointState = makeCheckpointResumable(checkpointState)
      const resumedTrace = traceWithCheckpoint(trace, checkpointState)
      trace.splice(0, trace.length, ...resumedTrace)
      await saveRunTrace(runPersistence, { id, userId, trace })
    }
    const loopResult = effectiveTools.length
      ? await subagentToolsLoop({
          messages,
          tools: effectiveTools,
          signal,
          userId,
          modelName: modelBinding.modelName || undefined,
          modelProviderId: modelBinding.providerId || null,
          modelConfigRevision: modelBinding.configRevision || null,
          modelRuntimeEnv: modelBinding.env || null,
          skillIds: normalizePromptContextIds(skillIds),
          skillDefinitions: prepareInlineSkillsForPrompt({ skillIds, skillDefinitions }),
          sessionId: `subagent:${id}`,
          runId: id,
          depth,
          budget: effectiveBudget,
          approvalContext: effectiveApprovalContext,
          slotLease,
          callModel,
          executeTool,
          approveTool,
          runToolLoop,
          sideEffectLedger,
          onTranscriptEvent,
          loadCheckpoint: () => checkpointState ? { state: checkpointState } : null,
          saveCheckpoint: async (state) => {
            const saved = await saveRunCheckpoint(runPersistence, { id, userId, trace, state })
            if (saved?.state) checkpointState = saved.state
            return saved
          },
        })
      : await callBackgroundModel({
          modelName: modelBinding.modelName || undefined,
          modelProviderId: modelBinding.env ? undefined : (modelBinding.providerId || undefined),
          signal,
          messages,
          userId: modelBinding.env ? null : userId,
          usageOwnerId: userId,
          ...(modelBinding.env ? { env: modelBinding.env } : {}),
        }).then((result) => {
          onTranscriptEvent({ type: 'model_response', content: boundedTranscriptValue(result), at: now() })
          return { text: result }
        })

    const status = subagentStatusForLoopResult(loopResult)
    const resultText = String(loopResult?.text || '')
    if (status === 'interrupted' && checkpointState) {
      checkpointState = makeCheckpointResumable(checkpointState)
      await saveRunCheckpoint(runPersistence, { id, userId, trace, state: checkpointState })
    }
    trace.push({
      type: status === 'completed' ? 'done' : status,
      ...(loopResult?.reason ? { reason: loopResult.reason } : {}),
      at: now(),
    })
    void dispatchHooks({
      userId,
      event: 'subagent_stop',
      tool: type,
      args: { resultText: boundedTranscriptValue(resultText), status },
      sessionId: parentSessionId || null,
      requestId: id,
      hookInvocationId: `subagent:${id}:stop:${status}`,
    }).catch(() => { /* subagent_stop hook is best-effort */ })
    terminalWriteStarted = true
    return await updateRun(runPersistence, {
      id,
      userId,
      status,
      resultText,
      trace,
    })
  } catch (err) {
    if (!ownsRunAttempt || terminalWriteStarted) throw err
    const recovery = sideEffectRecoveryFields(err, { runId: id, checkpointState })
    const status = recovery
      ? SUBAGENT_NEEDS_VERIFICATION
      : err?.name === 'AbortError' ? 'interrupted' : 'failed'
    trace.push(recovery
      ? { type: SUBAGENT_RECOVERY_EVENT, ...recovery, at: now() }
      : { type: 'error', error: err?.message || String(err), at: now() })
    const publicError = recovery ? sideEffectRecoveryError(recovery) : err
    void dispatchHooks({
      userId,
      event: 'subagent_stop',
      tool: type,
      args: recovery
        ? { status, ...recovery }
        : { error: err?.message || String(err), status },
      sessionId: parentSessionId || null,
      requestId: id,
      hookInvocationId: `subagent:${id}:stop:${status}`,
    }).catch(() => { /* subagent_stop hook is best-effort */ })
    try {
      terminalWriteStarted = true
      await updateRun(runPersistence, { id, userId, status, resultText: publicError.message, trace })
    } catch (persistenceError) {
      const aggregate = new AggregateError(
        [publicError, persistenceError],
        'Subagent failed and its terminal state could not be persisted',
        { cause: publicError },
      )
      aggregate.code = 'SUBAGENT_TERMINAL_PERSISTENCE_FAILED'
      aggregate.retryable = false
      throw aggregate
    }
    throw publicError
  } finally {
    slotLease.release()
  }
}

configureSubagentBatchRunner(runSubagent)

// 保持测试注入 API 不变，避免拆分影响调用方。
export const _testing = {
  subagentToolsLoop,
  executeSubagentTool,
  normalizeSubagentTasks,
  MAX_SUBAGENT_DEPTH,
  MAX_SUBAGENTS_PER_BATCH: SUBAGENT_MAX_PER_BATCH,
  MAX_CONCURRENT_PER_USER,
  createSlotLease,
  withYieldedSlot,
  requestTreeApproval,
  approvalCacheKey,
  subagentStatusForLoopResult,
  getLimiterSnapshot: getSubagentLimiterSnapshot,
}
