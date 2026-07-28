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
import { callBackgroundModel, callBackgroundModelWithTools } from '../adapters/modelProxy.js'

import { fetchAndExtract, searchDuckDuckGo } from '../adapters/toolProxy.js'
import { dispatchFsShellTool } from '../adapters/fsShellTools.js'
import { CODE_SEARCH_TOOL_SPECS, dispatchCodeSearchTool } from '../utils/codeSearch.js'
import { APPLY_PATCH_TOOL_SPECS, dispatchApplyPatchTool } from '../utils/applyPatch.js'
import { AGENTIC_TOOL_SPECS, dispatchAgenticTool, isLoopPauseResult } from '../utils/agenticTools.js'
import { requestApproval } from './approvalGate.js'

const MAX_CONCURRENT_PER_USER = 3
const activeByUser = new Map()

const SUBAGENT_MAX_ITERS = 8

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
]

/* ─── 子代理类型 ─── */

export const SUBAGENT_TYPES = {
  explore: {
    label: 'Explore',
    system: 'You are an isolated explore sub-agent. Read the task, investigate carefully, and return concise findings with concrete file paths, commands, risks, and next actions. Do not claim to edit files.',
    tools: READONLY_TOOL_SPECS,
  },
  plan: {
    label: 'Plan',
    system: 'You are an isolated planning sub-agent. Produce a practical implementation plan with acceptance checks. Stay read-only and avoid write instructions unless asked by the parent.',
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
async function executeSubagentTool(toolName, args, { userId = null } = {}) {
  switch (toolName) {
    case 'web_search':
      return searchDuckDuckGo({ query: args.query, maxResults: args.maxResults })
    case 'fetch_url':
      return fetchAndExtract({ url: args.url })
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return dispatchFsShellTool(toolName, args, { userId })
    case 'grep_code':
    case 'find_symbol':
    case 'list_imports':
      return dispatchCodeSearchTool(toolName, args)
    case 'apply_patch':
      return dispatchApplyPatchTool(toolName, args)
    case 'reflect':
    case 'request_clarification':
      return dispatchAgenticTool(toolName, args)
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
 * @returns {Promise<string>} 最终文本回答
 */
async function subagentToolsLoop({ messages, tools, signal, maxIters = SUBAGENT_MAX_ITERS, userId = null }) {
  let currentMessages = [...messages]

  for (let iter = 0; iter < maxIters; iter++) {
    const response = await callBackgroundModelWithTools({
      messages: currentMessages,
      tools,
      signal,
      userId,
    })

    const text = response?.content || ''
    const toolCalls = response?.toolCalls || []

    // 没有工具调用 → 这就是最终答案
    if (!toolCalls.length) return text

    currentMessages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    })

    let pausedClarif = null
    for (const call of toolCalls) {
      let result
      try {
        // ★ 审批门控:子代理同样是无人值守路径,必须过门。
        const gate = await requestApproval({
          userId,
          origin: 'subagent',
          toolName: call.name,
          args: call.arguments,
          signal,
        })
        if (!gate.proceed) {
          result = { ok: false, denied: true, error: gate.reason || '用户拒绝了这次调用' }
        } else {
          result = await executeSubagentTool(call.name, gate.args ?? call.arguments, { userId })
          if (isLoopPauseResult(result)) pausedClarif = result.clarification
        }
      } catch (err) {
        result = { ok: false, error: err?.message || String(err) }
      }
      currentMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      })
    }
    if (pausedClarif) {
      // ★ M3:子代理调 request_clarification → 中断并把问题当作最终输出返回
      return `⚠ 需要澄清(${pausedClarif.blocker_kind}):${pausedClarif.question}` +
        (pausedClarif.options ? `\n选项:${pausedClarif.options.join(' / ')}` : '') +
        (pausedClarif.why ? `\n原因:${pausedClarif.why}` : '')
    }
  }

  // 达到最大迭代次数后，让模型做一次总结
  currentMessages.push({
    role: 'system',
    content: `你已经达到工具调用上限（${maxIters} 次）。请基于已有信息给出最终回答。不要进一步调工具。`,
  })
  const finalResponse = await callBackgroundModelWithTools({
    messages: currentMessages,
    tools, // 仍然传入 tools 但不期望模型再调
    signal,
    userId,
    toolChoice: 'none', // 强制不调工具
  })
  return finalResponse?.content || '(工具循环已达上限)'
}

/* ─── DB CRUD ─── */

function now() {
  return Date.now()
}

export function newSubagentRunId() {
  return `subagent-${randomUUID()}`
}

function toRun(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    parentSessionId: row.parent_session_id,
    parentMessageId: row.parent_message_id,
    agentType: row.agent_type,
    prompt: row.prompt,
    status: row.status,
    resultText: row.result_text || '',
    trace: row.trace_json ? JSON.parse(row.trace_json) : [],
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    credits: row.credits,
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

export function listSubagentTypes() {
  return Object.entries(SUBAGENT_TYPES).map(([id, info]) => ({ id, label: info.label }))
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
  parentSessionId = null,
  parentMessageId = null,
  modelName,
  signal,
} = {}) {
  if (!userId) throw new Error('userId is required')
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is required')
  if (!SUBAGENT_TYPES[type]) throw new Error(`unknown subagent type: ${type}`)

  const active = activeByUser.get(userId) || 0
  if (active >= MAX_CONCURRENT_PER_USER) {
    const err = new Error('too many concurrent subagents')
    err.statusCode = 429
    throw err
  }
  activeByUser.set(userId, active + 1)

  const trace = [{ type: 'start', description, at: now() }]
  insertRun({ id, userId, type, prompt, parentSessionId, parentMessageId, trace })

  try {
    const { system, tools } = SUBAGENT_TYPES[type]
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: String(prompt).trim() },
    ]

    const resultText = tools?.length
      ? await subagentToolsLoop({ messages, tools, signal, userId })
      : await callBackgroundModel({ modelName, signal, messages, userId })

    trace.push({ type: 'done', at: now() })
    return updateRun({ id, userId, status: 'completed', resultText, trace })
  } catch (err) {
    trace.push({ type: 'error', error: err?.message || String(err), at: now() })
    const run = updateRun({ id, userId, status: 'failed', resultText: err?.message || String(err), trace })
    throw Object.assign(err, { run })
  } finally {
    const next = Math.max(0, (activeByUser.get(userId) || 1) - 1)
    if (next) activeByUser.set(userId, next)
    else activeByUser.delete(userId)
  }
}
