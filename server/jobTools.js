/**
 * 服务端工具回调循环(server-side tools loop)。
 * 让后台任务的模型像 ChatSplit 前端一样会"自主调用"工具生成 pptx/docx/xlsx/html。
 *
 * 设计:
 *   - tool spec 与前端 src/lib/tools/index.js 对齐,但 executor 在服务端跑
 *   - 直接调 server/artifactGen.js 的 createPptx/Docx/Xlsx 生成 buffer + url
 *   - 每次工具调用产物立刻 appendJobArtifact 进 jobStore(归属 job.userId)
 *   - 循环最多 maxIters 轮,防失控
 */
import { appendJobArtifact } from './jobStore.js'
import { createDocx, createPptx, createXlsx } from './artifactGen.js'
import { FS_SHELL_TOOL_SPECS, dispatchFsShellTool } from './fsShellTools.js'
import { GIT_TOOL_SPECS, dispatchGitTool } from './gitWorkbench.js'
import { CODE_SEARCH_TOOL_SPECS, dispatchCodeSearchTool } from './utils/codeSearch.js'
import { APPLY_PATCH_TOOL_SPECS, dispatchApplyPatchTool } from './utils/applyPatch.js'
import { AGENTIC_TOOL_SPECS, dispatchAgenticTool, isLoopPauseResult } from './utils/agenticTools.js'
import { attachJobBudget, getJobBudget, createJobBudget } from './utils/jobBudget.js'
import { writeToolAudit } from './utils/audit.js'
import crypto from 'node:crypto'

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

const MAX_ITERS = 6
const MAX_TOOL_OUTPUT_CHARS = 2000

/**
 * 4 个内置工具的 OpenAI function-calling spec。
 * 与前端 src/lib/tools/index.js 同名同语义,便于双端文档一致。
 */
export const SERVER_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'create_pptx',
      description: '生成 PowerPoint(.pptx)演示文稿。slides 为数组,每页含 title + bullets/body。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '演示文稿标题(同时作为文件名)' },
          slides: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                bullets: { type: 'array', items: { type: 'string' } },
                body: { type: 'string' },
              },
              required: ['title'],
            },
          },
        },
        required: ['title', 'slides'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_docx',
      description: '生成 Word(.docx)文档。paragraphs 为段落数组,可含 heading 等级。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '文档标题(同时作为文件名)' },
          paragraphs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'integer', minimum: 1, maximum: 3 },
                text: { type: 'string' },
              },
              required: ['text'],
            },
          },
        },
        required: ['title', 'paragraphs'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_xlsx',
      description: '生成 Excel(.xlsx)表格。sheets 为工作表数组,每个含 name + rows(二维数组)。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '表格标题(同时作为文件名)' },
          sheets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                rows: {
                  type: 'array',
                  items: { type: 'array', items: {} },
                },
              },
              required: ['name', 'rows'],
            },
          },
        },
        required: ['title', 'sheets'],
      },
    },
  },
  // claude-code 风格的文件 / shell 工具.默认全部关闭,需要在 .env 里设
  // WORKSPACE_FS_ENABLED=1 / WORKSPACE_SHELL_ENABLED=1 才生效;
  // 路径沙箱在 WORKSPACE_ROOT(默认 process.cwd()).
  ...FS_SHELL_TOOL_SPECS,
  ...GIT_TOOL_SPECS,
  ...CODE_SEARCH_TOOL_SPECS,
  ...APPLY_PATCH_TOOL_SPECS,
  ...AGENTIC_TOOL_SPECS,
]

/**
 * 执行单个工具调用 → 落盘 artifact → appendJobArtifact → 返回给模型的简短结果。
 */
async function executeServerTool({ name, args, job, step }) {
  if (name === 'create_pptx') {
    const artifact = await createPptx({ title: args.title, slides: args.slides || [] })
    appendJobArtifact({
      id: artifact.id,
      jobId: job.id,
      userId: job.userId,
      stepId: step.id,
      type: artifact.type,
      title: artifact.title || args.title,
      url: artifact.url,
      filename: artifact.filename,
    })
    return { ok: true, artifactId: artifact.id, filename: artifact.filename, url: artifact.url }
  }
  if (name === 'create_docx') {
    const artifact = await createDocx({ title: args.title, paragraphs: args.paragraphs || [] })
    appendJobArtifact({
      id: artifact.id,
      jobId: job.id,
      userId: job.userId,
      stepId: step.id,
      type: artifact.type,
      title: artifact.title || args.title,
      url: artifact.url,
      filename: artifact.filename,
    })
    return { ok: true, artifactId: artifact.id, filename: artifact.filename, url: artifact.url }
  }
  if (name === 'create_xlsx') {
    const artifact = await createXlsx({ title: args.title, sheets: args.sheets || [] })
    appendJobArtifact({
      id: artifact.id,
      jobId: job.id,
      userId: job.userId,
      stepId: step.id,
      type: artifact.type,
      title: artifact.title || args.title,
      url: artifact.url,
      filename: artifact.filename,
    })
    return { ok: true, artifactId: artifact.id, filename: artifact.filename, url: artifact.url }
  }
  // fs/shell 工具不落 artifact,执行结果直接回给模型.
  // 任意 fsShellTools 抛错(包括 env 未启用 / 路径越界)都返回 {ok:false,error}.
  if (['read_file', 'write_file', 'edit_file', 'bash_exec'].includes(name)) {
    try {
      return await dispatchFsShellTool(name, args || {}, { userId: job?.userId || null })
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  if (['grep_code', 'find_symbol', 'list_imports'].includes(name)) {
    try {
      return await dispatchCodeSearchTool(name, args || {})
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  if (name === 'apply_patch') {
    try {
      return await dispatchApplyPatchTool(name, args || {})
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  if (['reflect', 'request_clarification'].includes(name)) {
    try {
      return await dispatchAgenticTool(name, args || {})
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  if (['git_status', 'git_diff', 'run_project_check'].includes(name)) {
    try {
      return await dispatchGitTool(name, args || {})
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  return { ok: false, error: `unknown tool: ${name}` }
}

function safeParseArgs(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return {} }
}

function clipToolOutput(value) {
  const json = JSON.stringify(value)
  if (json.length <= MAX_TOOL_OUTPUT_CHARS) return json
  return json.slice(0, MAX_TOOL_OUTPUT_CHARS) + '...[truncated]'
}

/**
 * Tools loop:给模型 SERVER_TOOL_SPECS,多轮直到模型停止调用工具或达 maxIters。
 *
 * @param {object} opts
 * @param {object} opts.job        当前 job(含 userId)
 * @param {object} opts.step       当前 step
 * @param {Array}  opts.messages   初始 messages([{role,content}, ...])
 * @param {Function} opts.runModel  ({messages,tools,signal}) => Promise<{content, toolCalls}>
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxIters=MAX_ITERS]
 * @returns {Promise<{text:string, artifactIds:string[], iterations:number}>}
 */
export async function runToolsLoop({ job, step, messages, runModel, signal, maxIters = MAX_ITERS, executeTool = executeServerTool }) {
  const convo = [...messages]
  const artifactIds = []
  let finalText = ''
  let iter = 0
  // ★ M3.5 + Lens-2 fix:任务级预算用 WeakMap 持有,模型/工具碰不到 job 的属性也无法绕过。
  const budget = job ? (getJobBudget(job) || attachJobBudget(job)) : createJobBudget()

  for (; iter < maxIters; iter += 1) {
    const { content, toolCalls } = await runModel({
      messages: convo,
      tools: SERVER_TOOL_SPECS,
      signal,
    })

    if (!toolCalls || toolCalls.length === 0) {
      finalText = content || ''
      break
    }

    // 把 assistant 的 tool_calls 消息回填进对话
    convo.push({
      role: 'assistant',
      content: content || '',
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id || newId('call'),
        type: 'function',
        function: { name: tc.function?.name || tc.name, arguments: tc.function?.arguments || tc.arguments || '' },
      })),
    })

    let pausedByClarification = null
    let budgetExceeded = null
    for (const tc of toolCalls) {
      const name = tc.function?.name || tc.name
      const args = safeParseArgs(tc.function?.arguments || tc.arguments)
      // ★ M3.5:预算检查(reflect/request_clarification 不计,鼓励复盘与澄清)
      const isFree = name === 'reflect' || name === 'request_clarification'
      if (!isFree) {
        const b = budget.consume(1)
        if (!b.ok) { budgetExceeded = b.reason; break }
      }
      let result
      try {
        result = await executeTool({ name, args, job, step })
        if (result?.artifactId) artifactIds.push(result.artifactId)
        if (isLoopPauseResult(result)) pausedByClarification = result.clarification
      } catch (err) {
        result = { ok: false, error: err?.message || String(err) }
      }
      convo.push({
        role: 'tool',
        tool_call_id: tc.id,
        name,
        content: clipToolOutput(result),
      })
    }
    if (budgetExceeded) {
      // ★ Lens-4 fix:预算超限写 audit,审计员能追查 job 为什么没跑完
      if (job?.userId) {
        writeToolAudit({
          userId: job.userId,
          origin: 'budget',
          toolName: 'job_budget',
          args: { jobId: job.id, stepId: step?.id, snapshot: budget.snapshot?.() },
          status: 'denied',
          durationMs: 0,
        })
      }
      return {
        text: finalText,
        artifactIds,
        iterations: iter + 1,
        budgetExceeded: true,
        reason: budgetExceeded,
      }
    }
    if (pausedByClarification) {
      // ★ M3: 模型主动调 request_clarification → 当轮 loop 中断交回用户
      return {
        text: finalText,
        artifactIds,
        iterations: iter + 1,
        paused: true,
        clarification: pausedByClarification,
      }
    }
  }

  return { text: finalText, artifactIds, iterations: iter + 1 }
}
