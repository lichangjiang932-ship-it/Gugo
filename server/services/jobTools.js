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
import { FS_SHELL_TOOL_SPECS, dispatchFsShellTool } from '../adapters/fsShellTools.js'
import { GIT_TOOL_SPECS, dispatchGitTool } from '../adapters/gitWorkbench.js'
import { CODE_SEARCH_TOOL_SPECS, dispatchCodeSearchTool } from '../utils/codeSearch.js'
import { APPLY_PATCH_TOOL_SPECS, dispatchApplyPatchTool } from '../utils/applyPatch.js'
import { AGENTIC_TOOL_SPECS, dispatchAgenticTool, isLoopPauseResult } from '../utils/agenticTools.js'
import { attachJobBudget, getJobBudget, createJobBudget } from '../utils/jobBudget.js'
import { writeToolAudit } from '../utils/audit.js'
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
      description: [
        '生成高级 PowerPoint(.pptx)。系统已经控制色彩、版式、字体——你只负责给"内容"。',
        '【铁律】',
        '- 标题 ≤ 14 字, 结论式而非疑问式(如「营收 Q1 涨 23%」而非「Q1 业绩」)',
        '- bullet ≤ 30 字, 动词开头, 含具体数字',
        '- 单页 bullet ≤ 4 条; 超出请拆页',
        '- 至少 1 页用 layout="kpi" (传 kpi 字段) 或 layout="chart" (传 chart 字段) 展示数据',
        '- 6 页以上 deck 至少含 1 张 layout="section" 作章节分割',
        '【layout 取值】cover / section / kpi / chart / statement / split / process / quote / bullets / end',
        '不指定 layout 时系统按内容自动挑选; 想要特定样式时明确传 layout。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '演示文稿标题(用于封面大字 + 文件名)' },
          subtitle: { type: 'string', description: '封面副标题(可选,一句话提示主题)' },
          theme: { type: 'string', enum: ['noir', 'paper', 'ocean', 'forest'], description: '色系: noir 编辑暗(默认科技/通用) / paper 暖纸(文档/品牌) / ocean 深蓝(金融/咨询) / forest 墨绿(可持续/医疗)' },
          brand: { type: 'string', description: '页脚 brand 字(可选,默认 Your Model Atelier)' },
          slides: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                layout: { type: 'string', enum: ['cover', 'section', 'kpi', 'chart', 'statement', 'split', 'process', 'quote', 'bullets', 'end'] },
                eyebrow: { type: 'string', description: '标题上方小字(章节/分类),仅 bullets/kpi/chart/split/process layout 显示' },
                bullets: { type: 'array', items: { type: 'string' } },
                body: { type: 'string', description: '替代 bullets 的整段文本(用换行分隔)' },
                subtitle: { type: 'string', description: 'cover 副标题(若不在外层指定)' },
                kpi: {
                  type: 'array',
                  description: '2-4 个数据卡: {value, label, unit?, delta?}',
                  items: {
                    type: 'object',
                    properties: {
                      value: { type: 'string', description: '主数字(可含单位符号,如 "23.4" 或 "¥4.7M")' },
                      label: { type: 'string' },
                      unit: { type: 'string', description: '小字单位/口径(如 "% YoY" / "亿元")' },
                      delta: { type: 'string', description: '同比/环比,如 "+12.3%"' },
                    },
                    required: ['value'],
                  },
                },
                chart: {
                  type: 'object',
                  description: '图表(layout=chart 必填)',
                  properties: {
                    type: { type: 'string', enum: ['bar', 'line', 'pie'] },
                    categories: { type: 'array', items: { type: 'string' } },
                    series: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          values: { type: 'array', items: { type: 'number' } },
                        },
                        required: ['values'],
                      },
                    },
                  },
                  required: ['type', 'series'],
                },
                quote: {
                  description: '引用 layout=quote 用,字符串或 {text, source}',
                  oneOf: [
                    { type: 'string' },
                    {
                      type: 'object',
                      properties: { text: { type: 'string' }, source: { type: 'string' } },
                      required: ['text'],
                    },
                  ],
                },
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
    const artifact = await createPptx({
      title: args.title,
      subtitle: args.subtitle,
      theme: args.theme,
      brand: args.brand,
      slides: args.slides || [],
    })
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
