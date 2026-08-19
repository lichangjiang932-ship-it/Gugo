/**
 * 隔离子代理运行时。
 *
 * 借鉴 Reasonix 的 subagent 设计：
 *  - 子代理有独立 tool call 循环（不与父 session 共享执行上下文）
 *  - 子代理可以调任意工具，但结果不写入父 session
 *  - 只返回最终文本答案
 *  - 不同类型的子代理获得不同工具集
 */

import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import {
  callBackgroundModel,
  callBackgroundModelWithTools,
  getModelContextWindow,
} from '../adapters/modelProxy.js'

import { fetchAndExtract } from '../adapters/toolProxy.js'
import { searchWeb } from './webSearchService.js'
import { dispatchFsShellTool } from '../adapters/fsShellTools.js'
import { CODE_SEARCH_TOOL_SPECS, dispatchCodeSearchTool } from '../utils/codeSearch.js'
import { APPLY_PATCH_TOOL_SPECS, dispatchApplyPatchTool } from '../utils/applyPatch.js'
import { AGENTIC_TOOL_SPECS, dispatchAgenticTool } from '../utils/agenticTools.js'
import { MEMORY_TOOL_SPECS, dispatchMemoryTool } from '../utils/memoryTools.js'
import { createJobBudget } from '../utils/jobBudget.js'
import { requestApproval } from './approvalGate.js'
import { dispatchHooks } from './hooksService.js'
import { buildSafetyBlock, prepareInlineSkillsForPrompt } from './promptCompiler.js'
import { getBuiltinSpec } from './toolRegistry.js'
import { normalizePromptContextIds, prepareOptionalPromptContext } from './optionalPromptContext.js'
import { createPartialResultFallback } from './partialResultFallback.js'
import {
  approvalCacheKey,
  createSubagentApprovalContext,
  rememberApprovedSubagentCall,
} from './subagentApprovalContext.js'

export { createSubagentApprovalContext, rememberApprovedSubagentCall }

/** 读一个正整数 env,不合法就用默认值。 */
function envInt(name, fallback) {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

const MAX_CONCURRENT_PER_USER = envInt('SUBAGENT_MAX_CONCURRENT', 8)
// ★ 2 → 3。深度 2 意味着「主任务 → 子代理 → 孙代理」就到顶了,
// 复杂任务里子代理想再拆一层就被拒。3 层仍然远离失控。
const MAX_SUBAGENT_DEPTH = envInt('SUBAGENT_MAX_DEPTH', 3)
// ★ 3 → 8。一次只能并行 3 个子任务,对「同时看 6 个模块」这类
// 请求会被硬拆成两批,慢一倍。
const MAX_SUBAGENTS_PER_BATCH = envInt('SUBAGENT_MAX_PER_BATCH', 8)
const MAX_TRANSCRIPT_EVENT_CHARS = 12_000
const SUBAGENT_CHECKPOINT_EVENT = 'runtime_checkpoint'
const RESUMABLE_SUBAGENT_STATUSES = new Set(['interrupted'])

/**
 * 独立跑的子代理默认预算。
 * ★ 120 次 / 10 分钟 → 1000 次 / 2 小时,和 job 侧的放宽保持同一口径。
 * 墙钟同样不含模型延迟(见 jobBudget.trackModelMs)。
 */
const SUBAGENT_BUDGET = Object.freeze({
  maxTotalCalls: envInt('SUBAGENT_MAX_TOOL_CALLS', 1000),
  maxWallMs: envInt('SUBAGENT_MAX_WALL_MS', 2 * 60 * 60 * 1000),
})

const concurrencyByUser = new Map()
let defaultRunToolLoop = null

export function configureSubagentLoopRunner(runToolLoop) {
  if (typeof runToolLoop !== 'function') {
    throw new TypeError('subagent loop runner must be a function')
  }
  defaultRunToolLoop = runToolLoop
}

// 同 jobTools:死循环护栏而非工作预算,收敛靠 jobBudget。
// ★ 150 → 1000 并可配。子代理常被派去「把整个模块读一遍」,
// 150 轮在中型项目上不够用,碰到就只能交半份答案回去。
const SUBAGENT_MAX_ITERS = (() => {
  const raw = Number(process.env.SUBAGENT_MAX_ITERS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1000
})()
function abortError() {
  const error = new Error('subagent run aborted while waiting for a concurrency slot')
  error.name = 'AbortError'
  return error
}

function limiterState(userId) {
  let state = concurrencyByUser.get(userId)
  if (!state) {
    state = { active: 0, queue: [] }
    concurrencyByUser.set(userId, state)
  }
  return state
}

function cleanupLimiter(userId, state) {
  if (state.active === 0 && state.queue.length === 0) concurrencyByUser.delete(userId)
}

function drainLimiter(userId, state) {
  while (state.active < MAX_CONCURRENT_PER_USER && state.queue.length) {
    const waiter = state.queue.shift()
    if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort)
    if (waiter.signal?.aborted) {
      waiter.reject(abortError())
      continue
    }
    state.active += 1
    waiter.resolve(() => releaseUserSlot(userId, state))
  }
  cleanupLimiter(userId, state)
}

function releaseUserSlot(userId, expectedState) {
  const state = concurrencyByUser.get(userId)
  if (!state || state !== expectedState) return
  state.active = Math.max(0, state.active - 1)
  drainLimiter(userId, state)
}

function acquireUserSlot(userId, signal = null) {
  if (signal?.aborted) return Promise.reject(abortError())
  const state = limiterState(userId)
  if (state.active < MAX_CONCURRENT_PER_USER) {
    state.active += 1
    return Promise.resolve(() => releaseUserSlot(userId, state))
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: null }
    waiter.onAbort = () => {
      const index = state.queue.indexOf(waiter)
      if (index >= 0) state.queue.splice(index, 1)
      if (signal) signal.removeEventListener('abort', waiter.onAbort)
      cleanupLimiter(userId, state)
      reject(abortError())
    }
    state.queue.push(waiter)
    if (signal) signal.addEventListener('abort', waiter.onAbort, { once: true })
  })
}

function createSlotLease(userId) {
  let releaseCurrent = null
  return {
    get held() {
      return typeof releaseCurrent === 'function'
    },
    async acquire(signal = null) {
      if (releaseCurrent) return
      releaseCurrent = await acquireUserSlot(userId, signal)
    },
    release() {
      if (!releaseCurrent) return
      const release = releaseCurrent
      releaseCurrent = null
      release()
    },
  }
}

async function withYieldedSlot(slotLease, signal, callback) {
  if (!slotLease?.held) return callback()
  slotLease.release()
  try {
    return await callback()
  } finally {
    await slotLease.acquire(signal)
  }
}

function boundedTranscriptValue(value, maxChars = MAX_TRANSCRIPT_EVENT_CHARS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[transcript event truncated]`
}

async function requestTreeApproval({ context, approveTool = requestApproval, ...request }) {
  if (!context?.approved || !context?.pending) return approveTool(request)
  const key = approvalCacheKey(request.toolName, request.args)
  const approved = context.approved.get(key)
  if (approved) return { ...approved, reused: true }
  const existing = context.pending.get(key)
  if (existing) return existing
  const pending = Promise.resolve(approveTool(request))
    .then((gate) => {
      rememberApprovedSubagentCall(context, request.toolName, request.args, gate)
      return gate
    })
    .finally(() => context.pending.delete(key))
  context.pending.set(key, pending)
  return pending
}

/* ─── 子代理工具定义 ─── */

/**
 * 只读工具规格 — 用于 explore/plan 类型（不能修改文件）。
 */
const READONLY_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索互联网，获取最新信息。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          maxResults: { type: 'number', description: '返回结果数量（默认 5）' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '抓取 URL 内容并提取正文为 Markdown。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的网页 URL' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: '列出目录内容。探索一个陌生项目时先用它看结构,再决定读哪些文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径(绝对路径,或已授权的本地路径)' },
          limit: { type: 'number', description: '最多返回多少项(默认 200)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作区文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
        },
        required: ['path'],
      },
    },
  },
  // ★ M1:代码搜索三件套(全只读,适合 explore/plan)
  ...CODE_SEARCH_TOOL_SPECS,
  // ★ M3:反思 / 请求澄清(纯思维型,无副作用)
  ...AGENTIC_TOOL_SPECS,
  // ★ 长期记忆:探索到的项目背景值得跨会话留下来
  ...MEMORY_TOOL_SPECS,
]

/**
 * 完整工具规格 — 用于 general 类型（可读写）。
 */
const FULL_TOOL_SPECS = [
  ...READONLY_TOOL_SPECS,
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写文件到工作区。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '编辑文件中的指定内容（SEARCH/REPLACE）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          oldText: { type: 'string', description: '要替换的原文' },
          newText: { type: 'string', description: '替换后的新内容' },
        },
        required: ['path', 'oldText', 'newText'],
      },
    },
  },
  // ★ M2: Codex 风格多文件原子 patch
  ...APPLY_PATCH_TOOL_SPECS,
  getBuiltinSpec('Agent'),
]

/* ─── 子代理类型 ─── */

export const SUBAGENT_TYPES = {
  explore: {
    label: 'Explore',
    system: 'You are an isolated explore sub-agent. Read the task, investigate carefully, and return concise findings with concrete file paths, commands, risks, and next actions. Do not claim to edit files. Issue independent read/search tool calls together in one response so they can run in parallel.',
    tools: READONLY_TOOL_SPECS,
  },
  plan: {
    label: 'Plan',
    system: 'You are an isolated planning sub-agent. Produce a practical implementation plan with acceptance checks. Stay read-only and avoid write instructions unless asked by the parent. Issue independent read/search tool calls together in one response so they can run in parallel.',
    tools: READONLY_TOOL_SPECS,
  },
  general: {
    label: 'General',
    system: 'You are an isolated general sub-agent. Complete the focused sub-task and return the final answer only; keep it compact and actionable.',
    tools: FULL_TOOL_SPECS,
  },
}

/* ─── 子代理工具执行器 ─── */

/**
 * 在子代理沙箱中执行一个工具调用。
 * 结果只返回给子代理自己的上下文，不会写入父 session 或 DB。
 */
async function executeSubagentTool(toolName, args, {
  userId = null,
  modelName = undefined,
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
      return dispatchFsShellTool(toolName, args, { userId })
    case 'grep_code':
    case 'find_symbol':
    case 'list_imports':
      return dispatchCodeSearchTool(toolName, args, { userId })
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
        }))
    }
    default:
      return { ok: false, error: `unknown subagent tool: ${toolName}` }
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
async function subagentToolsLoop({ messages, tools, signal, maxIters = SUBAGENT_MAX_ITERS, userId = null, modelName = undefined, skillIds = [], skillDefinitions = [], sessionId = null, runId = null, depth = 0, callModel = callBackgroundModelWithTools, executeTool = executeSubagentTool, budget = null, approvalContext = null, slotLease = null, approveTool = requestApproval, runToolLoop = defaultRunToolLoop, onTranscriptEvent = null, loadCheckpoint = null, saveCheckpoint = null }) {
  const effectiveBudget = budget || createJobBudget({ ...SUBAGENT_BUDGET })
  const effectiveApprovalContext = approvalContext || createSubagentApprovalContext()
  const selectedModel = String(modelName || '').trim() || undefined
  const partialResultFallback = createPartialResultFallback({
    heading: '探索中断',
    resultLabel: '已经查到的信息',
  })
  const contextWindow = getModelContextWindow({ userId, modelName: selectedModel })
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
  }
  const loopStep = { id: runId || 'subagent-step' }
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
      userId,
      modelName: selectedModel,
      skillIds: normalizePromptContextIds(skillIds),
      skillDefinitions: prepareInlineSkillsForPrompt({ skillIds, skillDefinitions }),
    }),
    executeTool: ({ name, args, signal: toolSignal, budget: loopBudget }) => executeTool(name, args, {
      userId,
      modelName: selectedModel,
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
    }),
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
    return {
      ...result,
      text: `⚠ 需要澄清(${clarification.blocker_kind}):${clarification.question}` +
      (clarification.options ? `\n选项:${clarification.options.join(' / ')}` : '') +
      (clarification.why ? `\n原因:${clarification.why}` : ''),
    }
  }
  return partialResultFallback.apply(result)
}

/* ─── DB CRUD ─── */

function now() {
  return Date.now()
}

function parseTrace(value) {
  if (!value) return []
  try {
    const trace = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(trace) ? trace : []
  } catch {
    return []
  }
}

function publicTrace(trace) {
  return parseTrace(trace).filter((event) => event?.type !== SUBAGENT_CHECKPOINT_EVENT)
}

function checkpointFromTrace(trace) {
  return parseTrace(trace).findLast((event) => (
    event?.type === SUBAGENT_CHECKPOINT_EVENT
    && event.state
    && typeof event.state === 'object'
  ))?.state || null
}

function traceWithCheckpoint(trace, state) {
  return [
    ...publicTrace(trace),
    { type: SUBAGENT_CHECKPOINT_EVENT, state, at: now() },
  ]
}

function subagentStatusForLoopResult(result) {
  if (result?.paused) return 'paused'
  if (result?.interrupted || result?.incomplete || result?.budgetExceeded || result?.noProgress) {
    return 'interrupted'
  }
  return 'completed'
}

export function newSubagentRunId() {
  return `subagent-${randomUUID()}`
}

function toRun(row) {
  if (!row) return null
  const trace = publicTrace(row.trace_json)
  return {
    id: row.id,
    userId: row.user_id,
    parentSessionId: row.parent_session_id,
    parentMessageId: row.parent_message_id,
    agentType: row.agent_type,
    prompt: row.prompt,
    status: row.status,
    resultText: row.result_text || '',
    trace,
    team: trace.find((event) => event?.type === 'team')?.team || null,
    transcript: trace.filter((event) => event?.type === 'transcript'),
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }
}

function insertRun({ id, userId, type, prompt, parentSessionId = null, parentMessageId = null, trace = [] }) {
  const db = getDb()
  db.prepare(
    `INSERT INTO subagent_runs (id, user_id, parent_session_id, parent_message_id, agent_type, prompt, status, trace_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`
  ).run(id, userId, parentSessionId, parentMessageId, type, prompt, JSON.stringify(trace), now())
}

function getStoredRun({ id, userId }) {
  return getDb().prepare('SELECT * FROM subagent_runs WHERE user_id = ? AND id = ?').get(userId, id) || null
}

function markRunRunning({ id, userId, trace }) {
  const changed = getDb().prepare(
    `UPDATE subagent_runs
        SET status = 'running', trace_json = ?, finished_at = NULL
      WHERE id = ? AND user_id = ?`
  ).run(JSON.stringify(trace), id, userId).changes
  if (!changed) throw new Error('subagent run not found')
}

function saveRunCheckpoint({ id, userId, trace, state }) {
  if (!state || typeof state !== 'object') throw new Error('checkpoint state must be an object')
  const checkpointTrace = traceWithCheckpoint(trace, state)
  const changed = getDb().prepare(
    `UPDATE subagent_runs SET trace_json = ? WHERE id = ? AND user_id = ? AND status = 'running'`
  ).run(JSON.stringify(checkpointTrace), id, userId).changes
  if (!changed) return null
  trace.splice(0, trace.length, ...checkpointTrace)
  return { state }
}

function makeCheckpointResumable(state) {
  if (!state || typeof state !== 'object') return state || null
  const iterations = Math.max(0, Number(state.iterations) || 0)
  return {
    ...state,
    final: null,
    iterationWindowStart: iterations,
  }
}

function updateRun({ id, userId, status, resultText = '', trace = [] }) {
  const db = getDb()
  db.prepare(
    `UPDATE subagent_runs SET status = ?, result_text = ?, trace_json = ?, finished_at = ? WHERE id = ? AND user_id = ?`
  ).run(status, resultText, JSON.stringify(trace), now(), id, userId)
  return getSubagentRun({ userId, id })
}

export function getSubagentRun({ userId, id }) {
  const row = getDb().prepare('SELECT * FROM subagent_runs WHERE user_id = ? AND id = ?').get(userId, id)
  return toRun(row)
}

export function recoverInterruptedSubagentRuns({ at = now() } = {}) {
  const db = getDb()
  const rows = db.prepare("SELECT id, user_id, trace_json FROM subagent_runs WHERE status = 'running'").all()
  if (!rows.length) return 0
  const update = db.prepare(`
    UPDATE subagent_runs
       SET status = 'interrupted', result_text = ?, trace_json = ?, finished_at = ?
     WHERE id = ? AND user_id = ? AND status = 'running'
  `)
  const recover = db.transaction(() => {
    let changed = 0
    for (const row of rows) {
      const trace = parseTrace(row.trace_json)
      trace.push({
        type: 'interrupted',
        reason: 'service_restart',
        resumable: Boolean(checkpointFromTrace(trace)),
        at,
      })
      changed += update.run(
        '子代理因服务重启而中断；可使用原运行 ID 重试并从 checkpoint 继续。',
        JSON.stringify(trace),
        at,
        row.id,
        row.user_id,
      ).changes
    }
    return changed
  })
  return recover()
}

export function listSubagentTypes() {
  return Object.entries(SUBAGENT_TYPES).map(([id, info]) => ({ id, label: info.label }))
}

function normalizeSubagentTasks(request = {}) {
  const rawTasks = Array.isArray(request?.tasks) && request.tasks.length
    ? request.tasks
    : [request]
  if (rawTasks.length > MAX_SUBAGENTS_PER_BATCH) {
    throw new Error(`a subagent batch may contain at most ${MAX_SUBAGENTS_PER_BATCH} tasks`)
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
    return { type, prompt, description, role, agentId, skillIds, skillDefinitions, modelName }
  })
}

export async function runSubagentBatch({
  userId,
  request,
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
  runToolLoop = defaultRunToolLoop,
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
  const settled = await Promise.allSettled(tasks.map((task) => runSubagent({
    userId,
    type: task.type,
    prompt: task.prompt,
    description: task.description,
    agentId: task.agentId,
    skillIds: task.skillIds,
    skillDefinitions: task.skillDefinitions,
    modelName: task.modelName,
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
    : {
        ok: false,
        type: tasks[index].type,
        description: tasks[index].description,
        status: 'failed',
        error: result.reason?.message || String(result.reason),
      })
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

/* ─── 主入口 ─── */

/**
 * 运行一个隔离子代理。
 *
 * 子代理拥有独立的 tool call 循环 —— 所有工具调用结果只在子代理
 * 上下文内流转，不会写入父 session 或父空间。
 *
 * 返回结果只包含最终文本，中间步骤不暴露给调用方。
 */
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
  signal,
  depth = 0,
  budget = null,
  approvalContext = null,
  callModel = callBackgroundModelWithTools,
  executeTool = executeSubagentTool,
  approveTool = requestApproval,
  preparePromptContext,
  runToolLoop = defaultRunToolLoop,
} = {}) {
  if (!userId) throw new Error('userId is required')
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is required')
  if (!SUBAGENT_TYPES[type]) throw new Error(`unknown subagent type: ${type}`)
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_SUBAGENT_DEPTH) {
    throw new Error(`subagent depth must be between 0 and ${MAX_SUBAGENT_DEPTH}`)
  }
  const normalizedPrompt = String(prompt).trim()

  const storedRun = getStoredRun({ id, userId })
  if (storedRun) {
    if (storedRun.agent_type !== type || storedRun.prompt !== normalizedPrompt) {
      throw new Error('subagent run id belongs to a different task')
    }
    if (!RESUMABLE_SUBAGENT_STATUSES.has(storedRun.status)) {
      if (storedRun.status === 'running') throw new Error('subagent run is already running')
      return toRun(storedRun)
    }
  }

  const slotLease = createSlotLease(userId)
  await slotLease.acquire(signal)
  const effectiveBudget = budget || createJobBudget({ ...SUBAGENT_BUDGET })
  const effectiveApprovalContext = approvalContext || createSubagentApprovalContext()

  const trace = storedRun
    ? parseTrace(storedRun.trace_json)
    : [
        { type: 'start', description, at: now() },
        ...(team ? [{ type: 'team', team, at: now() }] : []),
      ]
  if (storedRun) trace.push({ type: 'resume', fromStatus: storedRun.status, at: now() })
  const onTranscriptEvent = (event) => trace.push({ ...event, type: 'transcript', eventType: event.type })

  try {
    if (storedRun) markRunRunning({ id, userId, trace })
    else insertRun({ id, userId, type, prompt: normalizedPrompt, parentSessionId, parentMessageId, trace })
    const { system, tools } = SUBAGENT_TYPES[type]
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
          ? `${system}\nYou may call Agent with up to ${MAX_SUBAGENTS_PER_BATCH} independent tasks to run them in parallel. Nested delegation is bounded to ${MAX_SUBAGENT_DEPTH} levels.`
          : system,
      },
      ...(team ? [{
        role: 'system',
        content: `# Team Context\nTeam: ${team.name} (${team.id})\nMode: ${team.mode}\nYour role: ${team.role || description || type}\nWork only on your assigned scope. Your transcript is isolated from other members; return a concise result for the leader to merge.`,
      }] : []),
      { role: 'user', content: normalizedPrompt },
    ]

    let checkpointState = checkpointFromTrace(trace)
    if (storedRun && checkpointState) {
      checkpointState = makeCheckpointResumable(checkpointState)
      const resumedTrace = traceWithCheckpoint(trace, checkpointState)
      trace.splice(0, trace.length, ...resumedTrace)
      markRunRunning({ id, userId, trace })
    }
    const loopResult = tools?.length
      ? await subagentToolsLoop({
          messages,
          tools,
          signal,
          userId,
          modelName,
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
          onTranscriptEvent,
          loadCheckpoint: () => checkpointState ? { state: checkpointState } : null,
          saveCheckpoint: (state) => {
            const saved = saveRunCheckpoint({ id, userId, trace, state })
            if (saved) checkpointState = state
            return saved
          },
        })
      : await callBackgroundModel({ modelName, signal, messages, userId }).then((result) => {
          onTranscriptEvent({ type: 'model_response', content: boundedTranscriptValue(result), at: now() })
          return { text: result }
        })

    const status = subagentStatusForLoopResult(loopResult)
    const resultText = String(loopResult?.text || '')
    if (status === 'interrupted' && checkpointState) {
      checkpointState = makeCheckpointResumable(checkpointState)
      saveRunCheckpoint({ id, userId, trace, state: checkpointState })
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
    }).catch(() => { /* subagent_stop hook is best-effort */ })
    return updateRun({
      id,
      userId,
      status,
      resultText,
      trace: status === 'completed' ? publicTrace(trace) : trace,
    })
  } catch (err) {
    trace.push({ type: 'error', error: err?.message || String(err), at: now() })
    const status = err?.name === 'AbortError' ? 'interrupted' : 'failed'
    void dispatchHooks({
      userId,
      event: 'subagent_stop',
      tool: type,
      args: { error: err?.message || String(err), status },
      sessionId: parentSessionId || null,
    }).catch(() => { /* subagent_stop hook is best-effort */ })
    const run = updateRun({ id, userId, status, resultText: err?.message || String(err), trace })
    throw Object.assign(err, { run })
  } finally {
    slotLease.release()
  }
}

// 测试入口:注入假的上游模型,验证 wire 形状归一化与工具派发。
// 生产代码不用它,但 runSubagent 走的是同一个 subagentToolsLoop。
export const _testing = {
  subagentToolsLoop,
  executeSubagentTool,
  normalizeSubagentTasks,
  MAX_SUBAGENT_DEPTH,
  MAX_SUBAGENTS_PER_BATCH,
  MAX_CONCURRENT_PER_USER,
  createSlotLease,
  withYieldedSlot,
  requestTreeApproval,
  approvalCacheKey,
  subagentStatusForLoopResult,
  getLimiterSnapshot(userId) {
    const state = concurrencyByUser.get(userId)
    return { active: state?.active || 0, queued: state?.queue.length || 0 }
  },
}
