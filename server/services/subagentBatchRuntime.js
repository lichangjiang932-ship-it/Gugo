import { randomUUID } from 'node:crypto'
import { createJobBudget } from '../utils/jobBudget.js'
import { requestApproval } from './approvalGate.js'
import {
  normalizePromptContextIds,
} from './optionalPromptContext.js'
import { prepareInlineSkillsForPrompt } from './promptCompiler.js'
import {
  createSubagentApprovalContext,
} from './subagentApprovalContext.js'
import { SUBAGENT_MAX_PER_BATCH } from './subagentBatchConfig.js'
import { resolveSubagentModelBinding } from './subagentModelBindingRuntime.js'
import { invokeRuntimeSubagentProvider } from './subagentProvider.js'
import {
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_BUDGET,
  SUBAGENT_NEEDS_VERIFICATION,
  SUBAGENT_SIDE_EFFECT_RECOVERY_KIND,
  SUBAGENT_TYPES,
} from './subagentRuntimePolicy.js'
import { boundedRecoveryId } from './subagentRunState.js'

let runSubagentImpl = null

export function configureSubagentBatchRunner(runSubagent) {
  if (typeof runSubagent !== 'function') {
    throw new TypeError('subagent batch runner must be a function')
  }
  runSubagentImpl = runSubagent
}

function normalizeSubagentTasks(request = {}) {
  const rawTasks = Array.isArray(request?.tasks) && request.tasks.length
    ? request.tasks
    : [request]
  if (rawTasks.length > SUBAGENT_MAX_PER_BATCH) {
    throw new Error(`a subagent batch may contain at most ${SUBAGENT_MAX_PER_BATCH} tasks`)
  }
  return rawTasks.map((task, index) => {
    const type = String(task?.subagent_type || task?.type || 'general').trim()
    const prompt = String(task?.prompt || '').trim()
    const description = String(task?.description || `subtask ${index + 1}`).trim().slice(0, 120)
    if (!SUBAGENT_TYPES[type]) throw new Error(`unknown subagent type: ${type}`)
    if (!prompt) throw new Error(`subagent task ${index + 1} requires prompt`)
    if (prompt.length > 20_000) throw new Error(`subagent task ${index + 1} prompt exceeds 20000 characters`)
    const role = String(task?.role || description).trim().slice(0, 120)
    const agentId = String(task?.agentId || task?.agent_id || request?.agentId || request?.agent_id || '').trim() || null
    const skillIds = normalizePromptContextIds(task?.skillIds || task?.skill_ids || request?.skillIds || request?.skill_ids)
    const skillDefinitions = prepareInlineSkillsForPrompt({
      skillIds,
      skillDefinitions: request?.skillDefinitions,
    })
    const modelName = String(task?.modelName || task?.model_name || request?.modelName || request?.model_name || '').trim() || undefined
    const modelProviderId = String(
      task?.modelProviderId || task?.model_provider_id
      || request?.modelProviderId || request?.model_provider_id || '',
    ).trim() || null
    const rawConfigRevision = task?.modelConfigRevision ?? task?.model_config_revision
      ?? request?.modelConfigRevision ?? request?.model_config_revision
    const modelConfigRevision = Number(rawConfigRevision)
    return {
      type, prompt, description, role, agentId, skillIds, skillDefinitions, modelName,
      modelProviderId,
      modelConfigRevision: Number.isInteger(modelConfigRevision) && modelConfigRevision > 0
        ? modelConfigRevision
        : null,
    }
  })
}

export async function runSubagentBatch({
  userId,
  request,
  locale = 'zh',
  depth = 0,
  parentSessionId = null,
  parentMessageId = null,
  signal,
  budget = null,
  approvalContext = null,
  approveTool = requestApproval,
  callModel = undefined,
  executeTool = undefined,
  preparePromptContext,
  runToolLoop = undefined,
  sideEffectLedger = null,
  persistencePort = null,
  resolveModelBinding = resolveSubagentModelBinding,
  invokeSubagentProvider = invokeRuntimeSubagentProvider,
} = {}) {
  if (!userId) throw new Error('userId is required')
  if (depth >= MAX_SUBAGENT_DEPTH) {
    return {
      ok: false,
      code: 'subagent_depth_exceeded',
      error: `general subagents may nest at most ${MAX_SUBAGENT_DEPTH} levels`,
      retryable: false,
    }
  }
  const tasks = normalizeSubagentTasks(request)
  const team = {
    id: String(request?.team_id || `team-${randomUUID()}`),
    name: String(request?.team_name || (tasks.length > 1 ? 'Subagent swarm' : 'Subagent run')).slice(0, 120),
    mode: tasks.length > 1 ? 'swarm' : 'solo',
    size: tasks.length,
  }
  const effectiveBudget = budget || createJobBudget({ ...SUBAGENT_BUDGET })
  const effectiveApprovalContext = approvalContext || createSubagentApprovalContext()
  const settled = await Promise.allSettled(tasks.map((task) => runSubagentImpl({
    userId,
    locale,
    type: task.type,
    prompt: task.prompt,
    description: task.description,
    agentId: task.agentId,
    skillIds: task.skillIds,
    skillDefinitions: task.skillDefinitions,
    modelName: task.modelName,
    modelProviderId: task.modelProviderId,
    modelConfigRevision: task.modelConfigRevision,
    team: { ...team, role: task.role, memberIndex: tasks.indexOf(task) },
    parentSessionId,
    parentMessageId,
    depth: depth + 1,
    signal,
    budget: effectiveBudget,
    approvalContext: effectiveApprovalContext,
    approveTool,
    callModel,
    executeTool,
    preparePromptContext,
    runToolLoop,
    sideEffectLedger,
    persistencePort,
    resolveModelBinding,
    invokeSubagentProvider,
  })))
  const runs = settled.map((result, index) => result.status === 'fulfilled'
    ? {
        ok: result.value.status === 'completed',
        id: result.value.id,
        type: tasks[index].type,
        description: tasks[index].description,
        status: result.value.status,
        result: result.value.resultText,
      }
    : (() => {
        const recovery = result.reason?.recoveryKind === SUBAGENT_SIDE_EFFECT_RECOVERY_KIND
          && result.reason?.requiresUserVerification === true
          ? {
              runId: boundedRecoveryId(result.reason.runId),
              toolCallId: boundedRecoveryId(result.reason.toolCallId),
              requiresUserVerification: true,
              recoveryKind: SUBAGENT_SIDE_EFFECT_RECOVERY_KIND,
            }
          : null
        return {
          ok: false,
          ...(recovery?.runId ? { id: recovery.runId } : {}),
          type: tasks[index].type,
          description: tasks[index].description,
          status: recovery ? SUBAGENT_NEEDS_VERIFICATION : 'failed',
          error: recovery
            ? 'Subagent side-effect outcome requires manual verification before explicit resume.'
            : result.reason?.message || String(result.reason),
          ...(recovery || {}),
        }
      })())
  return {
    ok: runs.some((run) => run.ok),
    parallel: tasks.length > 1,
    team: {
      ...team,
      members: runs.map((run, index) => ({
        runId: run.id || null,
        role: tasks[index].role,
        type: tasks[index].type,
        status: run.status,
        transcriptRef: run.id ? `subagent:${run.id}` : null,
      })),
    },
    runs,
  }
}

export { normalizeSubagentTasks }
