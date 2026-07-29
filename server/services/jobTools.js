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
import { getBuiltinSpec } from './toolRegistry.js'
import { attachJobBudget, getJobBudget, createJobBudget } from '../utils/jobBudget.js'
import { requestApproval } from './approvalGate.js'
import { writeToolAudit } from '../utils/audit.js'
import crypto from 'node:crypto'

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

// 防失控的安全阀,不是「给模型的预算」—— 循环本来就会在模型停止调工具时自然退出。
// 真正和成本挂钩的收敛交给 jobBudget(累积调用数 + 挂钟时间)。
// 以前是 6,读一个中等项目光探索就能吃满,任务被硬切在半路。
const MAX_ITERS = 30
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
          brand: { type: 'string', description: '页脚 brand 字(可选,默认 Gugo)' },
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
  // ★ Harness: system prompt 明确让模型「多步任务先 manage_todos 拆分」,
  // 但这个工具以前根本不在 job 循环的工具集里 —— 模型照做就必然撞 unknown tool。
  // 从 toolRegistry 取同一份 spec,避免两处定义漂移。
  getBuiltinSpec('manage_todos'),
].filter(Boolean)

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
      return await dispatchCodeSearchTool(name, args || {}, { userId: job?.userId || null })
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
  return { ok: false, error: `unknown tool: ${name}` }
}

function safeParseArgs(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return {} }
}

/**
 * 把工具结果序列化给模型看。
 *
 * ★ Harness: 以前是 JSON.stringify 后直接 slice —— 会把 JSON 从中间切断,
 * 模型收到的是语法坏掉的片段(可能停在 `"na` 这种地方),既解析不了,
 * 也看不出「这里被省略了」。现在:
 *   1. 优先只截断最长的那个字符串字段,保持整体仍是合法 JSON
 *   2. 实在不行才整体截断,但一定补一个显式的说明对象
 */
function clipToolOutput(value) {
  const json = JSON.stringify(value)
  if (json == null) return 'null'
  if (json.length <= MAX_TOOL_OUTPUT_CHARS) return json

  // 逐个截断长字符串字段,直到整体进预算 —— 结果仍是合法 JSON
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const clone = { ...value }
    const entries = Object.entries(clone)
      .filter(([, v]) => typeof v === 'string')
      .sort((a, b) => b[1].length - a[1].length)
    for (const [key, str] of entries) {
      if (JSON.stringify(clone).length <= MAX_TOOL_OUTPUT_CHARS) break
      const over = JSON.stringify(clone).length - MAX_TOOL_OUTPUT_CHARS
      const keep = Math.max(200, str.length - over - 64)
      if (keep < str.length) {
        clone[key] = `${str.slice(0, keep)}…[已截断 ${str.length - keep} 字符]`
      }
    }
    const clipped = JSON.stringify({ ...clone, _truncated: true })
    if (clipped.length <= MAX_TOOL_OUTPUT_CHARS * 1.1) return clipped
  }

  // 兜底:整体过长(比如超大数组),给模型一个合法且自解释的对象
  return JSON.stringify({
    _truncated: true,
    _originalChars: json.length,
    preview: json.slice(0, MAX_TOOL_OUTPUT_CHARS - 200),
    note: '工具输出过长已截断,如需完整内容请缩小查询范围或分批获取',
  })
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
export async function runToolsLoop({ job, step, messages, runModel, signal, maxIters = MAX_ITERS, executeTool = executeServerTool, onApprovalPending = null, onApprovalResolved = null }) {
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
        // ★ 审批门控:高风险工具执行前挂起等人批准/拒绝/改写参数。
        // 被拒不 throw —— 把拒绝结果喂回模型让它改道,而不是让整个 job 硬失败。
        const gate = await requestApproval({
          userId: job?.userId || null,
          origin: 'job',
          jobId: job?.id || null,
          stepId: step?.id || null,
          toolName: name,
          args,
          signal,
          onPending: onApprovalPending,
        })
        if (!gate.proceed) {
          result = { ok: false, denied: true, error: gate.reason || '用户拒绝了这次调用' }
        } else {
          // gate.args 可能被用户改写过,用它而不是原始 args
          result = await executeTool({ name, args: gate.args ?? args, job, step })
          if (result?.artifactId) artifactIds.push(result.artifactId)
          if (isLoopPauseResult(result)) pausedByClarification = result.clarification
        }
        // 决策已出(无论批准还是拒绝),把 job 从 awaiting_approval 放回 running
        if (gate.approvalId && typeof onApprovalResolved === 'function') {
          await onApprovalResolved(gate)
        }
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

  // ★ Harness: 到达迭代上限时,以前直接返回空 finalText —— 用户看到的是
  // "任务完成但什么都没说"。对齐 subagentRuntime 的做法:让模型基于已有信息
  // 收个尾,拿不到就至少说清楚是被上限截断的,不要静默空返回。
  if (!finalText) {
    try {
      const wrapUp = await runModel({
        messages: [
          ...convo,
          {
            role: 'system',
            content: `你已达到工具调用上限(${maxIters} 轮)。请基于目前已有的信息给出最终回答,不要再调用任何工具。`,
          },
        ],
        tools: [],
        signal,
      })
      finalText = wrapUp?.content || ''
    } catch {
      writeToolAudit?.({
        userId: job?.userId,
        origin: 'loop',
        toolName: 'wrap_up',
        args: { jobId: job?.id, stepId: step?.id },
        status: 'error',
        durationMs: 0,
      })
      finalText = ''
    }
    if (!finalText) {
      finalText = `(已达到 ${maxIters} 轮工具调用上限,任务未能自行收尾。上面的工具结果可能已包含部分进展。)`
    }
  }

  return { text: finalText, artifactIds, iterations: iter + 1 }
}
