import { AGENTIC_TOOL_SPECS } from '../utils/agenticTools.js'
import { APPLY_PATCH_TOOL_SPECS } from '../utils/applyPatch.js'
import { CODE_SEARCH_TOOL_SPECS } from '../utils/codeSearch.js'
import { LSP_TOOL_SPECS } from '../utils/lspTool.js'
import { MEMORY_TOOL_SPECS } from '../utils/memoryTools.js'
import { requestApproval } from './approvalGate.js'
import {
  approvalCacheKey,
  rememberApprovedSubagentCall,
} from './subagentApprovalContext.js'
import { getBuiltinSpec } from './toolRegistry.js'

/** 读一个正整数 env,不合法就用默认值。 */
function envInt(name, fallback) {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

const MAX_CONCURRENT_PER_USER = envInt('SUBAGENT_MAX_CONCURRENT', 8)
// ★ 2 → 3。深度 2 意味着「主任务 → 子代理 → 孙代理」就到顶了,
// 复杂任务里子代理想再拆一层就被拒。3 层仍然远离失控。
const MAX_SUBAGENT_DEPTH = envInt('SUBAGENT_MAX_DEPTH', 3)
const MAX_TRANSCRIPT_EVENT_CHARS = 12_000
const SUBAGENT_CHECKPOINT_EVENT = 'runtime_checkpoint'
const SUBAGENT_RECOVERY_EVENT = 'side_effect_recovery'
const SUBAGENT_NEEDS_VERIFICATION = 'needs_verification'
const SUBAGENT_SIDE_EFFECT_RECOVERY_KIND = 'side_effect_outcome_unknown'
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
  ...LSP_TOOL_SPECS,
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

export function getDefaultSubagentLoopRunner() {
  return defaultRunToolLoop
}

export function getSubagentLimiterSnapshot(userId) {
  const state = concurrencyByUser.get(userId)
  return { active: state?.active || 0, queued: state?.queue.length || 0 }
}

export {
  MAX_CONCURRENT_PER_USER,
  MAX_SUBAGENT_DEPTH,
  RESUMABLE_SUBAGENT_STATUSES,
  SUBAGENT_BUDGET,
  SUBAGENT_CHECKPOINT_EVENT,
  SUBAGENT_MAX_ITERS,
  SUBAGENT_NEEDS_VERIFICATION,
  SUBAGENT_RECOVERY_EVENT,
  SUBAGENT_SIDE_EFFECT_RECOVERY_KIND,
  boundedTranscriptValue,
  createSlotLease,
  requestTreeApproval,
  withYieldedSlot,
}
