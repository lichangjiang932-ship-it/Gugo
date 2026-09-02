import { randomUUID } from 'node:crypto'
import { normalizeTurnLocale } from '../../shared/turnLocale.js'
import {
  callBackgroundModelWithTools,
  getModelContextWindow,
} from '../adapters/modelProxy.js'
import { createJobBudget } from '../utils/jobBudget.js'
import { getSideEffectExecutionLedger } from './sideEffectExecutionLedger.js'
import { buildUserModelEnv } from './modelProviderStore.js'
import {
  normalizePromptContextIds,
} from './optionalPromptContext.js'
import { createPartialResultFallback } from './partialResultFallback.js'
import { localizedTerminalModelText } from './loop/incompleteTerminalPresentation.js'
import { prepareInlineSkillsForPrompt } from './promptCompiler.js'
import { requestApproval } from './approvalGate.js'
import { createSubagentApprovalContext } from './subagentApprovalContext.js'
import {
  SUBAGENT_BUDGET,
  SUBAGENT_MAX_ITERS,
  boundedTranscriptValue,
  requestTreeApproval,
} from './subagentRuntimePolicy.js'

function now() {
  return Date.now()
}

function subagentTerminalCopy(locale) {
  return normalizeTurnLocale(locale) === 'zh'
    ? {
        interruptedHeading: '探索中断',
        resultLabel: '已经查到的信息',
        clarificationPrefix: '⚠ 需要澄清',
        optionsLabel: '选项',
        reasonLabel: '原因',
        defaultBlockerKind: '未说明',
        defaultQuestion: '需要补充信息后才能继续。',
      }
    : {
        interruptedHeading: 'Exploration interrupted',
        resultLabel: 'Information found',
        clarificationPrefix: '⚠ Clarification required',
        optionsLabel: 'Options',
        reasonLabel: 'Reason',
        defaultBlockerKind: 'unspecified',
        defaultQuestion: 'More information is required before this subagent can continue.',
      }
}

/* ─── 子代理工具循环（隔离执行） ─── */

/**
 * 子代理的独立 tool call 循环。
 * 所有 tool call 结果只在子代理上下文中流转，不会污染父 session。
 *
 * @param {Object} options
 * @param {Array} options.messages - 初始消息列表
 * @param {Array} options.tools - OpenAI function-calling 工具规格
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.maxIters=SUBAGENT_MAX_ITERS]
 * @returns {Promise<Object>} 保留 completed / paused / interrupted / incomplete 等终态的 loop 结果
 */
export async function runSubagentToolLoop({ messages, tools, signal, maxIters = SUBAGENT_MAX_ITERS, userId = null, modelName = undefined, modelProviderId = null, modelConfigRevision = null, modelRuntimeEnv = null, skillIds = [], skillDefinitions = [], sessionId = null, runId = null, depth = 0, locale = 'zh', callModel = callBackgroundModelWithTools, executeTool = undefined, budget = null, approvalContext = null, slotLease = null, approveTool = requestApproval, runToolLoop = undefined, sideEffectLedger = null, onTranscriptEvent = null, loadCheckpoint = null, saveCheckpoint = null }) {
  const effectiveBudget = budget || createJobBudget({ ...SUBAGENT_BUDGET })
  const effectiveApprovalContext = approvalContext || createSubagentApprovalContext()
  const effectiveSideEffectLedger = sideEffectLedger
    || getSideEffectExecutionLedger()
  const selectedModel = String(modelName || '').trim() || undefined
  const normalizedLocale = normalizeTurnLocale(locale)
  const terminalCopy = subagentTerminalCopy(normalizedLocale)
  const partialResultFallback = createPartialResultFallback({
    locale: normalizedLocale,
    heading: terminalCopy.interruptedHeading,
    resultLabel: terminalCopy.resultLabel,
  })
  const contextRuntimeEnv = modelRuntimeEnv || buildUserModelEnv({ userId })
  const contextWindow = getModelContextWindow({
    modelName: selectedModel,
    modelProviderId: modelRuntimeEnv ? '' : modelProviderId,
    env: contextRuntimeEnv,
  })
  const emitTranscript = (event) => {
    if (typeof onTranscriptEvent !== 'function') return
    onTranscriptEvent({ ...event, at: now() })
  }
  if (typeof runToolLoop !== 'function') {
    throw new TypeError('subagent tool loop requires an injected runToolLoop function')
  }
  const loopJob = {
    id: runId || sessionId || `subagent-${randomUUID()}`,
    userId,
    prompt: messages.findLast?.((message) => message?.role === 'user')?.content || '',
    origin: 'subagent',
    modelName: selectedModel || null,
    modelProviderId: modelProviderId || null,
    modelConfigRevision: modelConfigRevision || null,
    locale: normalizedLocale,
  }
  const loopStep = { id: runId || 'subagent-step' }
  const executeLoopTool = ({
    name,
    args,
    signal: toolSignal,
    budget: loopBudget,
    toolCallId,
    idempotencyKey,
    idempotentResume,
    sideEffectRecoveryPlan,
  }) => executeTool(name, args, {
    userId,
    modelName: selectedModel,
    modelProviderId,
    modelConfigRevision,
    locale: normalizedLocale,
    skillIds: normalizePromptContextIds(skillIds),
    skillDefinitions: prepareInlineSkillsForPrompt({ skillIds, skillDefinitions }),
    depth,
    parentRunId: runId,
    parentSessionId: sessionId,
    signal: toolSignal,
    budget: loopBudget,
    approvalContext: effectiveApprovalContext,
    slotLease,
    approveTool,
    runToolLoop,
    sideEffectLedger: effectiveSideEffectLedger,
    toolCallId,
    idempotencyKey,
    idempotentResume,
    sideEffectRecoveryPlan,
  })
  executeLoopTool.supportsIdempotentResume = (callContext) => {
    const capability = executeTool?.supportsIdempotentResume
    if (typeof capability === 'function') return capability(callContext) === true
    return capability === true
  }
  const result = await runToolLoop({
    job: loopJob,
    step: loopStep,
    messages,
    toolSpecs: tools,
    signal,
    maxIters,
    contextWindow,
    skillId: normalizePromptContextIds(skillIds).at(0) || undefined,
    runtimeBudget: effectiveBudget,
    approvalContext: effectiveApprovalContext,
    approvalOrigin: 'subagent',
    approvalSessionId: sessionId,
    sideEffectLedger: effectiveSideEffectLedger,
    loadCheckpoint,
    saveCheckpoint,
    enableToolHooks: false,
    requestToolApproval: ({ toolName, args, signal: approvalSignal }) => requestTreeApproval({
      context: effectiveApprovalContext,
      approveTool,
      userId,
      origin: 'subagent',
      toolName,
      args,
      signal: approvalSignal,
    }),
    runModel: (request) => callModel({
      ...request,
      userId: modelRuntimeEnv ? null : userId,
      usageOwnerId: userId,
      modelName: selectedModel,
      modelProviderId: modelRuntimeEnv ? undefined : (modelProviderId || undefined),
      ...(modelRuntimeEnv ? { env: modelRuntimeEnv } : {}),
      skillIds: normalizePromptContextIds(skillIds),
      skillDefinitions: prepareInlineSkillsForPrompt({ skillIds, skillDefinitions }),
    }),
    executeTool: executeLoopTool,
    onModelPhase: (event) => {
      if (event.phase === 'started') {
        emitTranscript({ type: 'model_request', iteration: event.iteration, toolCount: tools?.length || 0 })
      } else if (event.phase === 'completed') {
        emitTranscript({
          type: 'model_response',
          content: boundedTranscriptValue(event.content || ''),
          toolCalls: (event.toolCalls || []).map((call) => ({
            id: call?.id || null,
            name: call?.function?.name || call?.name || null,
          })),
          usage: event.usage || null,
        })
      } else if (event.phase === 'failed') {
        emitTranscript({ type: 'model_error', error: event.error || 'model request failed' })
      }
    },
    onToolStarted: (call) => emitTranscript({
      type: 'tool_start',
      toolCallId: call.id,
      name: call.name,
      args: boundedTranscriptValue(call.args),
    }),
    onToolCompleted: (outcome) => {
      partialResultFallback.record(outcome.call, outcome.result)
      emitTranscript({
        type: 'tool_result',
        toolCallId: outcome.call.id,
        name: outcome.call.name,
        ok: outcome.result?.ok !== false,
        result: boundedTranscriptValue(outcome.result),
      })
    },
  })

  if (result.paused && result.clarification) {
    const clarification = result.clarification
    const blockerKind = localizedTerminalModelText(
      normalizedLocale,
      clarification.blocker_kind,
      { strictLocale: true },
    )
      || terminalCopy.defaultBlockerKind
    const question = localizedTerminalModelText(
      normalizedLocale,
      clarification.question,
      { strictLocale: true },
    )
      || terminalCopy.defaultQuestion
    const options = (Array.isArray(clarification.options) ? clarification.options : [])
      .map((option) => localizedTerminalModelText(
        normalizedLocale,
        option,
        { strictLocale: true },
      ))
      .filter(Boolean)
    const why = localizedTerminalModelText(
      normalizedLocale,
      clarification.why,
      { strictLocale: true },
    )
    return {
      ...result,
      text: normalizeTurnLocale(normalizedLocale) === 'zh'
        ? `${terminalCopy.clarificationPrefix}(${blockerKind}):${question}` +
          (options.length ? `\n${terminalCopy.optionsLabel}:${options.join(' / ')}` : '') +
          (why ? `\n${terminalCopy.reasonLabel}:${why}` : '')
        : `${terminalCopy.clarificationPrefix} (${blockerKind}): ${question}` +
          (options.length ? `\n${terminalCopy.optionsLabel}: ${options.join(' / ')}` : '') +
          (why ? `\n${terminalCopy.reasonLabel}: ${why}` : ''),
    }
  }
  return partialResultFallback.apply(result)
}
