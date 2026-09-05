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
import { normalizeTurnLocale } from '../../shared/turnLocale.js'
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
  locale = 'zh',
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
        locale: normalizeTurnLocale(locale),
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
function normalizeSubagentInput(options = {}) {
  const input = {
    id: options.id || newSubagentRunId(),
    userId: options.userId,
    type: options.type || 'general',
    prompt: options.prompt,
    description: options.description || '',
    agentId: options.agentId || null,
    skillIds: options.skillIds || [],
    skillDefinitions: options.skillDefinitions || [],
    team: options.team || null,
    parentSessionId: options.parentSessionId || null,
    parentMessageId: options.parentMessageId || null,
    modelName: options.modelName,
    modelProviderId: options.modelProviderId || null,
    modelConfigRevision: options.modelConfigRevision ?? null,
    locale: options.locale || 'zh',
    signal: options.signal,
    depth: options.depth ?? 0,
    budget: options.budget || null,
    approvalContext: options.approvalContext || null,
    callModel: options.callModel || callBackgroundModelWithTools,
    executeTool: options.executeTool || executeSubagentTool,
    approveTool: options.approveTool || requestApproval,
    preparePromptContext: options.preparePromptContext,
    runToolLoop: options.runToolLoop || getDefaultSubagentLoopRunner(),
    sideEffectLedger: options.sideEffectLedger || null,
    persistencePort: options.persistencePort || null,
    resolveModelBinding: options.resolveModelBinding || resolveSubagentModelBinding,
    invokeSubagentProvider: options.invokeSubagentProvider || invokeRuntimeSubagentProvider,
    resumeBlocked: options.resumeBlocked === true,
  }
  if (!input.userId) throw new Error('userId is required')
  if (!input.prompt || !String(input.prompt).trim()) throw new Error('prompt is required')
  if (!SUBAGENT_TYPES[input.type]) throw new Error(`unknown subagent type: ${input.type}`)
  if (!Number.isInteger(input.depth) || input.depth < 0 || input.depth > MAX_SUBAGENT_DEPTH) {
    throw new Error(`subagent depth must be between 0 and ${MAX_SUBAGENT_DEPTH}`)
  }
  input.normalizedPrompt = String(input.prompt).trim()
  return input
}
async function prepareSubagentRuntime(input) {
  const runPersistence = resolveRunPersistencePort(input.persistencePort)
  const storedRun = await runPersistence.getRun({ id: input.id, userId: input.userId })
  const storedTrace = storedRun ? parseTrace(storedRun.trace) : []
  const normalizedLocale = normalizeTurnLocale(
    storedTrace.find((event) => event?.type === 'start')?.locale || input.locale,
  )
  const explicitBlockedResume = storedRun?.status === SUBAGENT_NEEDS_VERIFICATION
    && input.resumeBlocked
  if (storedRun) {
    if (storedRun.agentType !== input.type || storedRun.prompt !== input.normalizedPrompt) {
      throw new Error('subagent run id belongs to a different task')
    }
    if (!RESUMABLE_SUBAGENT_STATUSES.has(storedRun.status) && !explicitBlockedResume) {
      if (storedRun.status === 'running') throw new Error('subagent run is already running')
      return { terminal: toRun(storedRun) }
    }
  }
  const requestedModelName = String(
    storedRun ? (storedRun.modelName || '') : (input.modelName || ''),
  ).trim() || null
  const requestedProviderId = String(
    storedRun ? (storedRun.modelProviderId || '') : (input.modelProviderId || ''),
  ).trim() || null
  const requestedRevision = Number(
    storedRun ? storedRun.modelConfigRevision : input.modelConfigRevision,
  )
  const normalizedConfigRevision = Number.isInteger(requestedRevision) && requestedRevision > 0
    ? requestedRevision
    : null
  const modelBinding = input.resolveModelBinding({
    userId: input.userId,
    providerId: requestedProviderId || '',
    modelName: requestedModelName || '',
    configRevision: normalizedConfigRevision,
    requirePersistedBinding: Boolean(storedRun),
  })
  if (storedRun) {
    const callerProviderId = String(input.modelProviderId || '').trim()
    const callerModelName = String(input.modelName || '').trim()
    if ((callerProviderId && callerProviderId !== requestedProviderId)
      || (callerModelName && callerModelName !== requestedModelName)
      || (input.modelConfigRevision != null
        && Number(input.modelConfigRevision) !== normalizedConfigRevision)) {
      throw new Error('subagent run model binding does not match the persisted snapshot')
    }
  }
  const slotLease = createSlotLease(input.userId)
  await slotLease.acquire(input.signal)
  const trace = storedRun
    ? storedTrace
    : [
        { type: 'start', description: input.description, locale: normalizedLocale, at: now() },
        ...(input.team ? [{ type: 'team', team: input.team, at: now() }] : []),
      ]
  if (storedRun) trace.push({ type: 'resume', fromStatus: storedRun.status, at: now() })
  const state = {
    checkpointState: checkpointFromTrace(trace),
    ownsRunAttempt: false,
    terminalWriteStarted: false,
  }
  return {
    input,
    runPersistence,
    storedRun,
    normalizedLocale,
    explicitBlockedResume,
    modelBinding,
    slotLease,
    effectiveBudget: input.budget || createJobBudget({ ...SUBAGENT_BUDGET }),
    effectiveApprovalContext: input.approvalContext || createSubagentApprovalContext(),
    trace,
    state,
    onTranscriptEvent(event) {
      trace.push({ ...event, type: 'transcript', eventType: event.type })
    },
  }
}
function dispatchSubagentStop(runtime, status, args) {
  const { input } = runtime
  void dispatchHooks({
    userId: input.userId,
    event: 'subagent_stop',
    tool: input.type,
    args,
    sessionId: input.parentSessionId || null,
    requestId: input.id,
    hookInvocationId: `subagent:${input.id}:stop:${status}`,
  }).catch(() => { /* subagent_stop hook is best-effort */ })
}
async function persistSubagentRunStart(runtime) {
  const { input, storedRun, runPersistence, trace, modelBinding, state } = runtime
  if (storedRun) {
    await markRunRunning(runPersistence, { id: input.id, userId: input.userId, trace })
  } else {
    await insertRun(runPersistence, {
      id: input.id,
      userId: input.userId,
      type: input.type,
      prompt: input.normalizedPrompt,
      parentSessionId: input.parentSessionId,
      parentMessageId: input.parentMessageId,
      modelName: modelBinding.modelName || null,
      modelProviderId: modelBinding.providerId || null,
      modelConfigRevision: modelBinding.configRevision || null,
      trace,
    })
  }
  state.ownsRunAttempt = true
}
async function invokeSubagentProviderPhase(runtime) {
  const { input, storedRun, trace, modelBinding, runPersistence } = runtime
  if (runtime.explicitBlockedResume) return null
  const previousProvider = providerProvenanceFromTrace(trace)
  appendProviderProvenance(trace, { decision: 'invoking' })
  await saveRunTrace(runPersistence, { id: input.id, userId: input.userId, trace })
  let resolution
  try {
    const initialDescription = storedRun
      ? parseTrace(storedRun.trace).find((event) => event?.type === 'start')?.description
      : input.description
    const initialTeam = storedRun
      ? parseTrace(storedRun.trace).find((event) => event?.type === 'team')?.team
      : input.team
    resolution = await input.invokeSubagentProvider({
      runId: input.id,
      resume: Boolean(storedRun),
      type: input.type,
      prompt: input.normalizedPrompt,
      description: initialDescription || '',
      depth: input.depth,
      model: {
        name: modelBinding.modelName || null,
        providerId: modelBinding.providerId || null,
        configRevision: modelBinding.configRevision || null,
      },
      team: initialTeam || null,
    }, { signal: input.signal, timeoutMs: SUBAGENT_BUDGET.maxWallMs })
    const decision = resolution?.provenance?.decision
    const validBuiltin = resolution?.kind === 'builtin'
      && (decision === 'absent' || decision === 'decline')
    const validHandled = resolution?.kind === 'handled'
      && decision === 'handled'
      && resolution.terminal
      && typeof resolution.terminal === 'object'
    if (!validBuiltin && !validHandled) {
      throw subagentProviderError(
        'SUBAGENT_PROVIDER_RESULT_INVALID',
        'runtime subagent provider returned an invalid resolution',
      )
    }
    if (storedRun
      && (previousProvider?.decision === 'handled' || previousProvider?.decision === 'invoking')
      && resolution.kind === 'builtin'
      && decision === 'absent') {
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
  appendProviderProvenance(trace, resolution?.provenance)
  if (resolution?.kind !== 'handled') return null
  const status = resolution.terminal.status
  const reason = resolution.terminal.reason
  const resultText = resolution.terminal.text || reason || ''
  trace.push({ type: status === 'completed' ? 'done' : status, ...(reason ? { reason } : {}), at: now() })
  dispatchSubagentStop(runtime, status, { resultText: boundedTranscriptValue(resultText), status })
  runtime.state.terminalWriteStarted = true
  return updateRun(runPersistence, {
    id: input.id, userId: input.userId, status, resultText, trace,
  })
}
function buildSubagentMessages(runtime) {
  const { input } = runtime
  const { system, tools } = SUBAGENT_TYPES[input.type]
  const effectiveTools = tools.filter((spec) => (
    spec?.function?.name !== 'lsp' || hasConfiguredLspProvider()
  ))
  const promptContextMessages = prepareOptionalPromptContext({
    preparePromptContext: input.preparePromptContext,
    input: {
      userId: input.userId,
      agentId: input.agentId,
      skillIds: normalizePromptContextIds(input.skillIds),
      skillDefinitions: prepareInlineSkillsForPrompt({
        skillIds: input.skillIds,
        skillDefinitions: input.skillDefinitions,
      }),
      query: input.normalizedPrompt,
    },
    scope: 'subagent.prompt',
  }).messages
  return {
    effectiveTools,
    messages: [
      { role: 'system', content: buildSafetyBlock().text },
      ...promptContextMessages,
      {
        role: 'system',
        content: input.type === 'general'
          ? `${system}\nYou may call Agent with up to ${SUBAGENT_MAX_PER_BATCH} independent tasks to run them in parallel. Nested delegation is bounded to ${MAX_SUBAGENT_DEPTH} levels.`
          : system,
      },
      ...(input.team ? [{
        role: 'system',
        content: `# Team Context\nTeam: ${input.team.name} (${input.team.id})\nMode: ${input.team.mode}\nYour role: ${input.team.role || input.description || input.type}\nWork only on your assigned scope. Your transcript is isolated from other members; return a concise result for the leader to merge.`,
      }] : []),
      { role: 'user', content: input.normalizedPrompt },
    ],
  }
}
async function executeBuiltinSubagent(runtime) {
  const { input, modelBinding, state, trace, runPersistence } = runtime
  const { effectiveTools, messages } = buildSubagentMessages(runtime)
  if (runtime.storedRun && state.checkpointState) {
    state.checkpointState = makeCheckpointResumable(state.checkpointState)
    trace.splice(0, trace.length, ...traceWithCheckpoint(trace, state.checkpointState))
    await saveRunTrace(runPersistence, { id: input.id, userId: input.userId, trace })
  }
  const loopResult = effectiveTools.length
    ? await subagentToolsLoop({
        messages,
        tools: effectiveTools,
        signal: input.signal,
        userId: input.userId,
        modelName: modelBinding.modelName || undefined,
        modelProviderId: modelBinding.providerId || null,
        modelConfigRevision: modelBinding.configRevision || null,
        modelRuntimeEnv: modelBinding.env || null,
        locale: runtime.normalizedLocale,
        skillIds: normalizePromptContextIds(input.skillIds),
        skillDefinitions: prepareInlineSkillsForPrompt({
          skillIds: input.skillIds,
          skillDefinitions: input.skillDefinitions,
        }),
        sessionId: `subagent:${input.id}`,
        runId: input.id,
        depth: input.depth,
        budget: runtime.effectiveBudget,
        approvalContext: runtime.effectiveApprovalContext,
        slotLease: runtime.slotLease,
        callModel: input.callModel,
        executeTool: input.executeTool,
        approveTool: input.approveTool,
        runToolLoop: input.runToolLoop,
        sideEffectLedger: input.sideEffectLedger,
        onTranscriptEvent: runtime.onTranscriptEvent,
        loadCheckpoint: () => state.checkpointState ? { state: state.checkpointState } : null,
        saveCheckpoint: async (checkpoint) => {
          const saved = await saveRunCheckpoint(runPersistence, {
            id: input.id, userId: input.userId, trace, state: checkpoint,
          })
          if (saved?.state) state.checkpointState = saved.state
          return saved
        },
      })
    : await callBackgroundModel({
        modelName: modelBinding.modelName || undefined,
        modelProviderId: modelBinding.env ? undefined : (modelBinding.providerId || undefined),
        signal: input.signal,
        messages,
        userId: modelBinding.env ? null : input.userId,
        usageOwnerId: input.userId,
        ...(modelBinding.env ? { env: modelBinding.env } : {}),
      }).then((result) => {
        runtime.onTranscriptEvent({
          type: 'model_response', content: boundedTranscriptValue(result), at: now(),
        })
        return { text: result }
      })
  const status = subagentStatusForLoopResult(loopResult)
  const resultText = String(loopResult?.text || '')
  if (status === 'interrupted' && state.checkpointState) {
    state.checkpointState = makeCheckpointResumable(state.checkpointState)
    await saveRunCheckpoint(runPersistence, {
      id: input.id, userId: input.userId, trace, state: state.checkpointState,
    })
  }
  trace.push({
    type: status === 'completed' ? 'done' : status,
    ...(loopResult?.reason ? { reason: loopResult.reason } : {}),
    at: now(),
  })
  dispatchSubagentStop(runtime, status, { resultText: boundedTranscriptValue(resultText), status })
  state.terminalWriteStarted = true
  return updateRun(runPersistence, {
    id: input.id, userId: input.userId, status, resultText, trace,
  })
}
async function handleSubagentFailure(runtime, error) {
  const { input, state, trace, runPersistence } = runtime
  if (!state.ownsRunAttempt || state.terminalWriteStarted) throw error
  const recovery = sideEffectRecoveryFields(error, {
    runId: input.id,
    checkpointState: state.checkpointState,
  })
  const status = recovery
    ? SUBAGENT_NEEDS_VERIFICATION
    : error?.name === 'AbortError' ? 'interrupted' : 'failed'
  trace.push(recovery
    ? { type: SUBAGENT_RECOVERY_EVENT, ...recovery, at: now() }
    : { type: 'error', error: error?.message || String(error), at: now() })
  const publicError = recovery ? sideEffectRecoveryError(recovery) : error
  dispatchSubagentStop(runtime, status, recovery
    ? { status, ...recovery }
    : { error: error?.message || String(error), status })
  try {
    state.terminalWriteStarted = true
    await updateRun(runPersistence, {
      id: input.id, userId: input.userId, status, resultText: publicError.message, trace,
    })
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
}
/** Run one isolated subagent with durable recovery and bounded delegation. */
export async function runSubagent(options = {}) {
  const input = normalizeSubagentInput(options)
  const runtime = await prepareSubagentRuntime(input)
  if (runtime.terminal) return runtime.terminal
  try {
    await persistSubagentRunStart(runtime)
    const providerResult = await invokeSubagentProviderPhase(runtime)
    if (providerResult) return providerResult
    return await executeBuiltinSubagent(runtime)
  } catch (error) {
    return handleSubagentFailure(runtime, error)
  } finally {
    runtime.slotLease.release()
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
