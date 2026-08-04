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
import { appendTurnArtifact } from './turnArtifactStore.js'
import { createDocx, createPptx, createXlsx } from './artifactGen.js'
import { FS_SHELL_TOOL_SPECS, dispatchFsShellTool } from '../adapters/fsShellTools.js'
import { GIT_TOOL_SPECS, dispatchGitTool } from '../adapters/gitWorkbench.js'
import { CODE_SEARCH_TOOL_SPECS, dispatchCodeSearchTool } from '../utils/codeSearch.js'
import { APPLY_PATCH_TOOL_SPECS, dispatchApplyPatchTool } from '../utils/applyPatch.js'
import { AGENTIC_TOOL_SPECS, dispatchAgenticTool, isLoopPauseResult } from '../utils/agenticTools.js'
import { getBuiltinSpec, getToolMetadata } from './toolRegistry.js'
import { CONNECTOR_TOOL_NAMES, CONNECTOR_TOOL_SPECS, executeConnectorTool } from './connectorTools.js'
import { MEMORY_TOOL_SPECS, dispatchMemoryTool } from '../utils/memoryTools.js'
import { attachJobBudget, getJobBudget, createJobBudget, runWithModelBudget } from '../utils/jobBudget.js'
import { formatDeniedToolResult, requestApproval, resumePersistedApproval } from './approvalGate.js'
import { writeToolAudit } from '../utils/audit.js'
import { isContextLengthError } from '../adapters/modelProxy.js'
import { callModelWithContextRecovery } from './contextCompactionRuntime.js'
import { ensureSafetySystemMessages } from './promptCompiler.js'
import { allowedArtifactTools, isFileArtifactTool } from './artifactIntent.js'
import {
  createSubagentApprovalContext,
  rememberApprovedSubagentCall,
  runSubagentBatch,
} from './subagentRuntime.js'
import {
  buildAssistantToolCallsMessage,
  buildToolResultMessage,
  createToolLoopGuard,
  mapWithConcurrency,
  normalizeToolCalls,
  validateToolCall,
} from '../utils/toolCallHarness.js'
import { callTool as callMcpTool } from '../mcp/mcpManager.js'
import { executeBrowserTool } from './browserToolExecutor.js'
import { fetchAndExtract, searchDuckDuckGo } from '../adapters/toolProxy.js'
import { dispatchHooks } from './hooksService.js'

// 死循环护栏,不是工作预算。后台任务无人盯着,不能真的无限跑 ——
// 但真正的收敛是 jobBudget(累积调用数 + 挂钟时间),那个和成本线性相关。
//
// ★ 从 200 提到 2000 并可配。200 轮对「读完一个中型项目再逐个文件改」
// 是够不到的:光探索就可能几十轮,真正动手改又是几十轮,
// 中间还要穿插验证。碰到上限时用户看到的是「做到一半停了」。
// 2000 是任何正常任务都碰不到、但仍能兜住死循环的量级。
const MAX_ITERS = (() => {
  const raw = Number(process.env.JOB_MAX_ITERS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2000
})()
const JOB_READ_CONCURRENCY = 4

function persistGeneratedArtifact({ artifact, args, job, step }) {
  const common = {
    id: artifact.id,
    userId: job.userId,
    type: artifact.type,
    title: artifact.title || args.title,
    url: artifact.url,
    filename: artifact.filename,
  }
  return job?.origin === 'chat'
    ? appendTurnArtifact({ ...common, sessionId: job.sessionId, turnId: job.id })
    : appendJobArtifact({ ...common, jobId: job.id, stepId: step?.id || null })
}

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
  getBuiltinSpec('web_search'),
  getBuiltinSpec('fetch_url'),
  getBuiltinSpec('Agent'),
  // ★ Harness: system prompt 明确让模型「多步任务先 manage_todos 拆分」,
  // 但这个工具以前根本不在 job 循环的工具集里 —— 模型照做就必然撞 unknown tool。
  // 从 toolRegistry 取同一份 spec,避免两处定义漂移。
  getBuiltinSpec('manage_todos'),
  ...MEMORY_TOOL_SPECS,
  ...CONNECTOR_TOOL_SPECS,
].filter(Boolean)

/**
 * 按本次任务的产物意图裁剪工具集。
 *
 * ★ SERVER_TOOL_SPECS 以前是原样整份丢给模型的 —— 修 bug 的任务里也躺着
 *   create_pptx,配上系统提示词那句「不要把内容写成纯文本回答」,模型就会
 *   把中期汇报做成一份 PPT 当交付物(2026-07-31 事故)。
 *
 *   文件工具现在默认对模型不可见:只有 `/ppt` 这类明确技能,或提示词里出现
 *   明确的产物关键词,对应工具才会出现在工具列表里。语义与前端
 *   chatFlowGuards.filterToolNamesForSkill 一致。
 *
 * @param {object} [opts]
 * @param {string} [opts.prompt]  用户原始提示词(保留 `/ppt` 前缀)
 * @param {string|null} [opts.skillId] 已解析的技能 id;不传则从 prompt 解析
 * @param {Array} [opts.specs]    待裁剪的 spec 列表,默认全量
 * @returns {Array} 过滤后的 spec 列表
 */
export function selectJobToolSpecs({ prompt = '', skillId = undefined, specs = SERVER_TOOL_SPECS } = {}) {
  const allowed = allowedArtifactTools(prompt, { skillId })
  return specs.filter((spec) => {
    const name = spec?.function?.name
    if (!name) return false
    return !isFileArtifactTool(name) || allowed.has(name)
  })
}

/**
 * 执行单个工具调用 → 落盘 artifact → appendJobArtifact → 返回给模型的简短结果。
 */
async function executeServerTool({
  name,
  args,
  job,
  step,
  signal,
  budget,
  approvalContext,
  allowedArtifactTools,
  toolCallId,
  idempotencyKey,
}) {
  if (isFileArtifactTool(name) && !allowedArtifactTools?.has(name)) {
    return {
      ok: false,
      code: 'artifact_tool_not_requested',
      error: `用户没有明确要求生成 ${name} 文件，本轮拒绝执行。`,
      retryable: false,
    }
  }
  if (name === 'web_search') {
    try {
      return await searchDuckDuckGo({
        query: args?.query,
        maxResults: args?.max_results ?? args?.maxResults,
      })
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  if (name === 'fetch_url') {
    try {
      return await fetchAndExtract({ url: args?.url })
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  if (name === 'create_pptx') {
    const artifact = await createPptx({
      title: args.title,
      subtitle: args.subtitle,
      theme: args.theme,
      brand: args.brand,
      slides: args.slides || [],
    })
    persistGeneratedArtifact({ artifact, args, job, step })
    return { ok: true, artifactId: artifact.id, filename: artifact.filename, url: artifact.url }
  }
  if (name === 'create_docx') {
    const artifact = await createDocx({ title: args.title, paragraphs: args.paragraphs || [] })
    persistGeneratedArtifact({ artifact, args, job, step })
    return { ok: true, artifactId: artifact.id, filename: artifact.filename, url: artifact.url }
  }
  if (name === 'create_xlsx') {
    const artifact = await createXlsx({ title: args.title, sheets: args.sheets || [] })
    persistGeneratedArtifact({ artifact, args, job, step })
    return { ok: true, artifactId: artifact.id, filename: artifact.filename, url: artifact.url }
  }
  // fs/shell 工具不落 artifact,执行结果直接回给模型.
  // 任意 fsShellTools 抛错(包括 env 未启用 / 路径越界)都返回 {ok:false,error}.
  if (['read_file', 'write_file', 'edit_file', 'bash_exec'].includes(name)) {
    try {
      return await dispatchFsShellTool(name, args || {}, {
        userId: job?.userId || null,
        signal,
        toolCallId,
        idempotencyKey,
      })
    } catch (err) {
      return {
        ok: false,
        code: err?.code || 'fs_tool_failed',
        error: err?.message || String(err),
        retryable: err?.retryable ?? ![401, 403, 404].includes(err?.statusCode),
        ...(err?.path ? { path: err.path } : {}),
        ...(err?.hint ? { hint: err.hint } : {}),
      }
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
      return await dispatchApplyPatchTool(name, args || {}, { userId: job?.userId || null })
    } catch (err) {
      return {
        ok: false,
        code: err?.code || 'apply_patch_failed',
        error: err?.message || String(err),
        retryable: err?.retryable ?? ![401, 403, 404].includes(err?.statusCode),
        ...(err?.path ? { path: err.path } : {}),
        ...(err?.hint ? { hint: err.hint } : {}),
      }
    }
  }
  if (name === 'remember') {
    return dispatchMemoryTool(name, args || {}, { userId: job?.userId || null })
  }
  if (['reflect', 'request_clarification', 'request_directory', 'sleep_until'].includes(name)) {
    try {
      return await dispatchAgenticTool(name, args || {})
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  if (name === 'Agent') {
    try {
      return await runSubagentBatch({
        userId: job?.userId || null,
        request: args || {},
        depth: -1,
        parentSessionId: job?.id || null,
        parentMessageId: step?.id || null,
        signal,
        budget,
        approvalContext,
      })
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  if (['git_status', 'git_diff', 'run_project_check', 'git_commit', 'git_push', 'git_rollback'].includes(name)) {
    try {
      return await dispatchGitTool(name, args || {}, {
        userId: job?.userId || null,
        toolCallId,
        idempotencyKey,
      })
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
  if (CONNECTOR_TOOL_NAMES.includes(name)) {
    return executeConnectorTool(name, args || {}, {
      userId: job?.userId || null,
      toolCallId,
      idempotencyKey,
    })
  }
  if (name.startsWith('browser_')) {
    try {
      const result = await executeBrowserTool(name, args || {}, {
        userId: job?.userId || null,
        toolCallId,
        idempotencyKey,
      })
      return result && typeof result === 'object' ? { ok: true, ...result } : { ok: true, result }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  if (name.startsWith('mcp__')) {
    try {
      const result = await callMcpTool({
        userId: job?.userId || null,
        fullToolName: name,
        args: args || {},
        toolCallId,
        idempotencyKey,
      })
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        return { ok: !result.isError, ...result }
      }
      return { ok: true, result }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  return { ok: false, error: `unknown tool: ${name}` }
}

export function buildJobToolIdempotencyKey({ jobId, stepId, toolCallId }) {
  return `job:${String(jobId || 'unknown')}:step:${String(stepId || 'unknown')}:tool:${String(toolCallId || 'unknown')}`
}

function supportsIdempotentResume(executor, callContext) {
  const capability = executor?.supportsIdempotentResume
  if (typeof capability === 'function') return capability(callContext) === true
  return capability === true
}

/**
 * Tools loop:给模型按产物意图裁剪后的工具集,多轮直到模型停止调用工具或达 maxIters。
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
export async function runToolsLoop({
  job,
  step,
  messages,
  runModel,
  signal,
  maxIters = MAX_ITERS,
  executeTool = executeServerTool,
  onApprovalPending = null,
  onApprovalResolved = null,
  claimSteering = null,
  acknowledgeSteering = null,
  releaseSteering = null,
  loadCheckpoint = null,
  saveCheckpoint = null,
  contextWindow = undefined,
  toolSpecs = undefined,
  approvalOrigin = 'job',
  approvalSessionId = null,
  approvalMode = null,
  runtimeBudget = null,
  approvalContext = null,
  requestToolApproval = requestApproval,
  enableToolHooks = true,
  onModelPhase = null,
  onToolCall = null,
  onToolStarted = null,
  onToolCompleted = null,
}) {
  // 文件产物工具按本次任务意图裁剪。同一份 spec 既喂给模型,也用于 validateToolCall ——
  // 这样"模型看不到"和"调了也会被拒"是同一个事实,不会两边漂移。
  //
  // 意图文本取 job.prompt + 本轮 user 消息:jobRuntime 走的是 job.prompt,
  // 但直接调 runToolsLoop(子任务、测试、未来的其他入口)只有 messages,
  // 只看 job.prompt 会把用户明写的「整理成 Word 文档」误判成无产物需求。
  const intentText = [
    job?.prompt || '',
    ...(Array.isArray(messages) ? messages : [])
      .filter((m) => m?.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : '')),
  ].join('\n')
  const activeToolSpecs = selectJobToolSpecs({
    prompt: intentText,
    specs: Array.isArray(toolSpecs) ? toolSpecs : SERVER_TOOL_SPECS,
  })
  const restored = typeof loadCheckpoint === 'function' ? await loadCheckpoint() : null
  const restoredState = restored?.state && typeof restored.state === 'object'
    ? restored.state
    : restored && typeof restored === 'object'
      ? restored
      : null
  const convo = ensureSafetySystemMessages(
    Array.isArray(restoredState?.messages) ? [...restoredState.messages] : [...messages],
  )
  const artifactIds = Array.isArray(restoredState?.artifactIds) ? [...restoredState.artifactIds] : []
  let finalText = ''
  let iter = Math.max(0, Number(restoredState?.iterations) || 0)
  let checkpointCalls = Array.isArray(restoredState?.toolCalls)
    ? restoredState.toolCalls.map((call) => ({
        ...call,
        idempotencyKey: call.idempotencyKey || buildJobToolIdempotencyKey({
          jobId: job?.id,
          stepId: step?.id,
          toolCallId: call.id,
        }),
      }))
    : null

  if (restoredState?.final?.text != null) {
    return {
      text: String(restoredState.final.text),
      artifactIds,
      iterations: Math.max(1, Number(restoredState.final.iterations) || iter || 1),
      resumed: true,
    }
  }

  const persistTurn = async ({ final = null } = {}) => {
    if (typeof saveCheckpoint !== 'function') return
    const saved = await saveCheckpoint({
      messages: convo,
      toolCalls: checkpointCalls || [],
      artifactIds,
      iterations: iter,
      budget: budget.snapshot?.() || null,
      final,
    })
    if (saved === false || saved === null) throw new Error('Failed to persist job turn checkpoint')
  }
  // ★ M3.5 + Lens-2 fix:任务级预算用 WeakMap 持有,模型/工具碰不到 job 的属性也无法绕过。
  const restoredBudget = restoredState?.budget && typeof restoredState.budget === 'object'
    ? {
        maxTotalCalls: restoredState.budget.maxTotalCalls,
        maxWallMs: restoredState.budget.maxWallMs,
        maxModelCalls: restoredState.budget.maxModelCalls,
        maxModelTokens: restoredState.budget.maxModelTokens,
        maxCostUsd: restoredState.budget.maxCostUsd,
        initialUsed: restoredState.budget.used,
        initialElapsedMs: restoredState.budget.elapsed,
        initialModelMs: restoredState.budget.modelMs,
        initialModelCalls: restoredState.budget.modelCalls,
        initialModelTokens: restoredState.budget.modelTokens,
        initialCostUsd: restoredState.budget.costUsd,
      }
    : undefined
  const budget = runtimeBudget || (job
    ? (getJobBudget(job) || attachJobBudget(job, restoredBudget))
    : createJobBudget(restoredBudget))
  const subagentApprovalContext = approvalContext || createSubagentApprovalContext()
  // 预算测试/小预算任务应优先报告 budgetExceeded；第 5 次相同调用再判无进展。
  const loopGuard = createToolLoopGuard({ maxRepeatedCalls: 4 })

  for (; iter < maxIters; iter += 1) {
    if (signal?.aborted) {
      const error = new Error('Turn cancelled')
      error.name = 'AbortError'
      throw error
    }
    let steeringLeaseId = null
    let toolCalls

    if (checkpointCalls?.length) {
      // The model response was already made durable before the previous process
      // stopped. Resume its unanswered calls without asking the model again.
      toolCalls = checkpointCalls
    } else {
      if (typeof claimSteering === 'function') {
        const claimed = await claimSteering()
        if (claimed?.messages?.length) {
          steeringLeaseId = claimed.leaseId
          convo.push({
            role: 'system',
            content: 'The user sent steering updates while this task was running. Apply them now; newer user direction takes precedence.',
          })
          for (const steering of claimed.messages) {
            // Preserve the user text verbatim. Do not summarize steering before the model sees it.
            convo.push({ role: 'user', content: steering.content })
          }
        }
      }

      let modelResult
      try {
        if (typeof onModelPhase === 'function') await onModelPhase({ phase: 'started', iteration: iter })
        const request = await callModelWithContextRecovery({
          messages: convo,
          tools: activeToolSpecs,
          callModel: (modelRequest) => runWithModelBudget(
            budget,
            () => runModel(modelRequest),
          ),
          isContextLengthError,
          contextWindow,
          signal,
          userId: job?.userId || null,
          sessionId: job?.id && step?.id ? `job:${job.id}:${step.id}` : null,
          consumeBudget: (cost) => budget.consume(cost),
        })
        convo.splice(0, convo.length, ...request.messages)
        modelResult = request.response
        if (typeof onModelPhase === 'function') await onModelPhase({
          phase: 'completed',
          iteration: iter,
          content: modelResult?.content || '',
          toolCalls: modelResult?.toolCalls || [],
          usage: modelResult?.usage || null,
          modelName: modelResult?.modelName || null,
        })
      } catch (error) {
        if (typeof onModelPhase === 'function') await onModelPhase({
          phase: 'failed', iteration: iter, error: error?.message || String(error),
        })
        if (steeringLeaseId && typeof releaseSteering === 'function') {
          await releaseSteering(steeringLeaseId)
        }
        // ★ 模型报错不再无条件炸掉整个 step。
        //
        // 原来这里直接 throw,一路冒到 runOneTick 把 job 标 failed,
        // **这一步已经收集到的所有工具结果全部丢弃**,checkpoint 也被删掉。
        // 于是 LM Studio 在第 30 轮打了个嗝,前 29 轮的活白干。
        //
        // subagentRuntime.js 早就做对了(见那里的降级注释),job 循环一直没跟上。
        // 现在对齐:已经跑过至少一轮 + 不是用户主动取消 → 降级成部分结果,
        // 把中断原因和已查到的东西交给用户,而不是一个空的 failed。
        if (error?.code === 'MODEL_BUDGET_EXCEEDED') {
          const collected = convo
            .filter((m) => m.role === 'tool')
            .map((m) => (typeof m.content === 'string' ? m.content : ''))
            .filter(Boolean)
            .join('\n')
            .slice(0, 4000)
          let wrapUpText = ''
          try {
            const wrapUpRequest = await callModelWithContextRecovery({
              messages: [
                ...convo,
                {
                  role: 'system',
                  content: `模型预算已用尽(${error.message})。请基于目前已有的信息给出最终回答，不要再调用任何工具。`,
                },
              ],
              tools: [],
              callModel: (modelRequest) => runWithModelBudget(
                budget,
                () => runModel(modelRequest),
                { allowOverBudget: true },
              ),
              isContextLengthError,
              contextWindow,
              signal,
              userId: job?.userId || null,
              sessionId: job?.id && step?.id ? `job:${job.id}:${step.id}` : null,
              toolChoice: 'none',
            })
            wrapUpText = wrapUpRequest.response?.content || ''
          } catch (wrapUpError) {
            if (wrapUpError?.name === 'AbortError') throw wrapUpError
          }
          return {
            text: wrapUpText || `(模型预算已用尽:${error.message})\n\n已经完成的部分:\n${collected || error.partialModelResult?.content || '(无)'}`,
            artifactIds,
            iterations: iter + 1,
            budgetExceeded: true,
            reason: error.message,
          }
        }
        if (error?.name === 'AbortError' || iter === 0) throw error

        const collected = convo
          .filter((m) => m.role === 'tool')
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .filter(Boolean)
          .join('\n')
          .slice(0, 4000)

        return {
          text: `(任务中断:${error?.message || String(error)})\n\n已经完成的部分:\n${collected || '(无)'}`,
          artifactIds,
          iterations: iter + 1,
          interrupted: true,
          reason: error?.message || String(error),
        }
      }
      const { content, toolCalls: rawToolCalls } = modelResult

      if (!rawToolCalls || rawToolCalls.length === 0) {
        finalText = content || ''
        convo.push({ role: 'assistant', content: finalText })
        try {
          await persistTurn({ final: { text: finalText, iterations: iter + 1 } })
          if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
        } catch (error) {
          if (steeringLeaseId && typeof releaseSteering === 'function') {
            await releaseSteering(steeringLeaseId)
          }
          throw error
        }
        break
      }

      // 唯一 id、参数 JSON 和简写/wire 形状都在公共 harness 里归一化。
      // 这样无 id 的调用也能保证 assistant.tool_calls 与 tool_call_id 严格配对。
      checkpointCalls = normalizeToolCalls(rawToolCalls).map((call) => ({
        ...call,
        idempotencyKey: buildJobToolIdempotencyKey({
          jobId: job?.id,
          stepId: step?.id,
          toolCallId: call.id,
        }),
        checkpointStatus: 'pending',
        checkpointApprovalId: null,
      }))
      if (typeof onToolCall === 'function') {
        for (const call of checkpointCalls) await onToolCall(call)
      }
      toolCalls = checkpointCalls
      convo.push(buildAssistantToolCallsMessage(toolCalls, content))
      try {
        // The model response and steering text become durable atomically from
        // the engine's perspective; only then may the steering lease be ACKed.
        await persistTurn()
        if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
          await acknowledgeSteering(steeringLeaseId)
        }
      } catch (error) {
        if (steeringLeaseId && typeof releaseSteering === 'function') {
          await releaseSteering(steeringLeaseId)
        }
        throw error
      }
    }

    let pausedByClarification = null
    let budgetExceeded = null
    let noProgressReason = null
    const markCall = async (call, updates) => {
      Object.assign(call, updates)
      await persistTurn()
    }

    const executeOne = async (call, { durableExecution = true } = {}) => {
      if (signal?.aborted) {
        const error = new Error('Turn cancelled')
        error.name = 'AbortError'
        throw error
      }
      if (typeof onToolStarted === 'function') await onToolStarted(call)
      const { name, args } = call
      // ★ M3.5:预算检查(reflect/request_clarification 不计,鼓励复盘与澄清)
      const isFree = name === 'reflect' || name === 'request_clarification' || name === 'request_directory' || name === 'sleep_until'
      let result
      let outcomeBudgetExceeded = null
      let outcomeNoProgressReason = null
      let clarification = null
      let artifactId = null
      const idempotentResume = call.checkpointStatus === 'executing'
        && supportsIdempotentResume(executeTool, {
          name,
          args: call.checkpointExecutionArgs ?? args,
          job,
          step,
          toolCallId: call.id,
          idempotencyKey: call.idempotencyKey,
        })
      if (call.checkpointStatus === 'executing'
        && !getToolMetadata(name, { args }).isConcurrencySafe
        && !idempotentResume) {
        // We cannot prove whether a side effect committed before the process
        // stopped. Never replay it automatically: report the uncertainty to
        // the model so it can verify state or ask the user how to proceed.
        result = {
          ok: false,
          code: 'tool_execution_outcome_unknown',
          error: `The service restarted while ${name} was executing. It was not replayed because its side effects may already have happened.`,
          retryable: false,
          requiresUserVerification: true,
        }
      } else {
        const guardDecision = loopGuard.before(call)
        if (!guardDecision.ok) {
          result = guardDecision.result
          outcomeNoProgressReason = guardDecision.reason
        } else {
          // 每次非思维型工具尝试都计成本，包括模型给出的未知工具/损坏参数。
          // 校验仍会阻止它们真正执行，但不能让无效调用绕过预算。
          if (!isFree) {
            const b = budget.consume(1)
            if (!b.ok) {
              outcomeBudgetExceeded = b.reason
              result = { ok: false, code: 'tool_budget_exceeded', error: b.reason, retryable: false }
            }
          }

          if (!result) {
            // 被产物门控挡下的文件工具单独给一条可执行的说明,否则模型只看到
            // 「未知工具：create_pptx」会以为是系统故障,继续重试到耗尽预算。
            if (isFileArtifactTool(call.name) && !activeToolSpecs.some((s) => s?.function?.name === call.name)) {
              result = {
                ok: false,
                code: 'artifact_tool_not_requested',
                error: `用户没有要求生成 ${call.name} 这类文件产物,该工具在本次任务中不可用。`,
                retryable: false,
                hint: '直接完成用户真正要求的工作(如修改代码、给出结论),并用文字说明结果;不要用文件代替交付。',
              }
            }
          }

          if (!result) {
            const validationError = validateToolCall(call, activeToolSpecs, {
              // 单测/嵌入方可注入自己的 executor；生产默认执行器仍严格限制在已声明工具集。
              allowUnknown: executeTool !== executeServerTool,
            })
            if (validationError) result = validationError
          }

          if (!result) {
            try {
              // Resume the exact persisted approval after restart; otherwise
              // run the pre hook once, then create and persist the approval.
              // A resumed approval already contains the hook-rewritten args,
              // so the pre hook must not be fired a second time after restart.
              const resumingApproval = call.checkpointStatus === 'awaiting_approval' && call.checkpointApprovalId
              let effectiveArgs = args
              let gate = null
              if (idempotentResume) {
                effectiveArgs = call.checkpointExecutionArgs ?? effectiveArgs
                gate = {
                  proceed: true,
                  args: effectiveArgs,
                  approvalId: call.checkpointApprovalId || null,
                  resumedIdempotentExecution: true,
                }
              } else if (resumingApproval) {
                gate = await resumePersistedApproval({ approvalId: call.checkpointApprovalId, signal })
                effectiveArgs = gate.args ?? effectiveArgs
              } else {
                if (enableToolHooks && job?.userId) {
                  const preHook = await dispatchHooks({
                    userId: job.userId,
                    event: 'pre_tool_use',
                    tool: name,
                    args: effectiveArgs,
                    sessionId: job.id || null,
                    requestId: step?.id || null,
                  })
                  if (!preHook.allow) {
                    result = {
                      ok: false,
                      denied: true,
                      code: 'hook_denied',
                      error: preHook.reason || `pre_tool_use hook denied ${name}`,
                      retryable: false,
                    }
                  } else if (preHook.replacementArgs && typeof preHook.replacementArgs === 'object') {
                    effectiveArgs = preHook.replacementArgs
                  }
                }
                if (!result && effectiveArgs !== args) {
                  const hookValidationError = validateToolCall(
                    { ...call, args: effectiveArgs },
                    activeToolSpecs,
                    { allowUnknown: executeTool !== executeServerTool },
                  )
                  if (hookValidationError) result = hookValidationError
                }
                if (!result) gate = await requestToolApproval({
                    userId: job?.userId || null,
                    origin: approvalOrigin,
                    jobId: approvalOrigin === 'chat' ? null : job?.id || null,
                    stepId: approvalOrigin === 'chat' ? job?.id || null : step?.id || null,
                    sessionId: approvalSessionId,
                    toolName: name,
                    args: effectiveArgs,
                    signal,
                    mode: approvalMode,
                    onPending: async (approval) => {
                      await markCall(call, {
                        checkpointStatus: 'awaiting_approval',
                        checkpointApprovalId: approval.id,
                      })
                      if (typeof onApprovalPending === 'function') await onApprovalPending(approval)
                    },
                  })
              }
              if (gate && !gate.proceed) {
                result = formatDeniedToolResult(gate)
              } else if (gate) {
                const executionArgs = gate.args ?? effectiveArgs
                rememberApprovedSubagentCall(subagentApprovalContext, name, executionArgs, gate)
                const executionMetadata = getToolMetadata(name, { args: executionArgs })
                // `block` means a cancellation request must not interrupt a tool that has
                // already started: an aborted shell/browser operation can leave partial
                // side effects.  Use a per-call shield signal, then let the outer loop
                // observe the original aborted signal at the next execution boundary.
                const executionSignal = executionMetadata.interruptBehavior === 'block'
                  ? new AbortController().signal
                  : signal
                if (durableExecution) {
                  await markCall(call, {
                    checkpointStatus: 'executing',
                    checkpointApprovalId: gate.approvalId || call.checkpointApprovalId || null,
                    checkpointExecutionArgs: executionArgs,
                    idempotencyKey: call.idempotencyKey,
                  })
                }
                result = await executeTool({
                  name,
                  args: executionArgs,
                  job,
                  step,
                  signal: executionSignal,
                  budget,
                  toolCallId: call.id,
                  idempotencyKey: call.idempotencyKey,
                  approvalContext: subagentApprovalContext,
                  allowedArtifactTools: new Set(
                    activeToolSpecs
                      .map((spec) => spec?.function?.name)
                      .filter((toolName) => isFileArtifactTool(toolName)),
                  ),
                })
                if (gate.authorization && result && typeof result === 'object') {
                  result = { ...result, approvalAuthorization: gate.authorization }
                }
                artifactId = result?.artifactId || null
                if (isLoopPauseResult(result)) clarification = result.clarification
                if (enableToolHooks && job?.userId) {
                  try {
                    await dispatchHooks({
                      userId: job.userId,
                      event: 'post_tool_use',
                      tool: name,
                      args: { input: executionArgs, output: result },
                      sessionId: job.id || null,
                      requestId: step?.id || null,
                    })
                  } catch {
                    // The tool has already executed; a post hook failure must
                    // not replay or reinterpret its side effects.
                  }
                }
              }
              if (gate?.approvalId && !gate.resumedIdempotentExecution && typeof onApprovalResolved === 'function') {
                await onApprovalResolved(gate)
              }
            } catch (err) {
              result = { ok: false, error: err?.message || String(err) }
            }
          }
        }
      }

      return {
        call,
        result,
        artifactId,
        clarification,
        budgetExceeded: outcomeBudgetExceeded,
        noProgressReason: outcomeNoProgressReason,
      }
    }

    const recordOutcome = async (outcome) => {
      if (outcome.artifactId) artifactIds.push(outcome.artifactId)
      convo.push(buildToolResultMessage(outcome.call, outcome.result))
      const progress = loopGuard.after(outcome.result)
      if (!noProgressReason) {
        noProgressReason = outcome.noProgressReason || (!progress.ok ? progress.reason : null)
      }
      if (!budgetExceeded && outcome.budgetExceeded) budgetExceeded = outcome.budgetExceeded
      if (!pausedByClarification && outcome.clarification) pausedByClarification = outcome.clarification
      await markCall(outcome.call, {
        checkpointStatus: 'completed',
        checkpointResult: outcome.result,
        checkpointArtifactId: outcome.artifactId || null,
      })
      if (typeof onToolCompleted === 'function') await onToolCompleted(outcome)
    }

    const canRunInParallel = toolCalls.length > 1
      && toolCalls.every((call) => getToolMetadata(call.name, { args: call.args }).isConcurrencySafe)

    if (canRunInParallel) {
      // 只有整批工具都已明确列入纯只读白名单时才并发。mapWithConcurrency
      // 按输入顺序返回结果，所以 tool messages 和 artifact 顺序仍与模型调用一致。
      const runnableCalls = toolCalls.filter((call) => call.checkpointStatus !== 'completed')
      const outcomes = await mapWithConcurrency(
        runnableCalls,
        (call) => executeOne(call, { durableExecution: false }),
        {
        concurrency: JOB_READ_CONCURRENCY,
        },
      )
      for (const outcome of outcomes) await recordOutcome(outcome)
    } else {
      // 写操作、Shell、澄清、未知工具以及读写混合批次一律严格串行。
      for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
        if (toolCalls[callIndex].checkpointStatus === 'completed') continue
        const outcome = await executeOne(toolCalls[callIndex])
        await recordOutcome(outcome)

        if (noProgressReason || budgetExceeded || pausedByClarification) {
          // 如果要继续向模型发收尾请求，协议要求 assistant 发出的每个 tool_call
          // 都必须有对应 tool result；未执行的调用明确标成 skipped。
          for (const skipped of toolCalls.slice(callIndex + 1)) {
            if (skipped.checkpointStatus === 'completed') continue
            const skippedResult = {
              ok: false,
              code: 'tool_execution_skipped',
              error: noProgressReason || budgetExceeded || '当前轮已暂停',
              retryable: false,
            }
            convo.push(buildToolResultMessage(skipped, skippedResult))
            Object.assign(skipped, {
              checkpointStatus: 'completed',
              checkpointResult: skippedResult,
            })
          }
          await persistTurn()
          break
        }
      }
    }
    checkpointCalls = null
    await persistTurn()
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
      // ★ 这里以前直接 return finalText —— 而 finalText 在预算路径上几乎必然是 ''。
      // 用户看到的就是「任务跑了很久,然后一个字都没有」,即
      // 「做到一半就没有后续」最典型的现场。
      //
      // 对齐 maxIters 路径的做法:让模型基于已有信息收个尾。
      // 收尾调用**不再受已耗尽的预算约束**(不传 consumeBudget)—— 否则预算已经
      // 超了,收尾调用自己也会被拒,永远拿不到总结,等于没修。
      if (!finalText) {
        try {
          const wrapUpRequest = await callModelWithContextRecovery({
            messages: [
              ...convo,
              {
                role: 'system',
                content: `任务预算已用尽(${budgetExceeded})。请基于目前已经取得的进展给出总结:做完了什么、还差什么、建议用户下一步怎么做。不要再调用任何工具。`,
              },
            ],
            tools: [],
            callModel: (modelRequest) => runWithModelBudget(
              budget,
              () => runModel(modelRequest),
              { allowOverBudget: true },
            ),
            isContextLengthError,
            contextWindow,
            signal,
            userId: job?.userId || null,
            sessionId: job?.id && step?.id ? `job:${job.id}:${step.id}` : null,
            toolChoice: 'none',
          })
          finalText = wrapUpRequest.response?.content || ''
        } catch {
          writeToolAudit?.({
            userId: job?.userId,
            origin: 'budget',
            toolName: 'wrap_up',
            args: { jobId: job?.id, stepId: step?.id },
            status: 'error',
            durationMs: 0,
          })
          finalText = ''
        }
      }
      return {
        text: finalText || `(任务预算已用尽:${budgetExceeded}。上面的工具结果可能已包含部分进展,可以点「重试」从断点继续。)`,
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
    if (noProgressReason) {
      try {
        const wrapUpRequest = await callModelWithContextRecovery({
          messages: [
            ...convo,
            {
              role: 'system',
              content: `工具循环因无进展停止：${noProgressReason}。请基于已有信息给出部分结论，不要再调用工具。`,
            },
          ],
          tools: [],
          callModel: (modelRequest) => runWithModelBudget(
            budget,
            () => runModel(modelRequest),
            { allowOverBudget: true },
          ),
          isContextLengthError,
          contextWindow,
          signal,
          userId: job?.userId || null,
          sessionId: job?.id && step?.id ? `job:${job.id}:${step.id}` : null,
          consumeBudget: (cost) => budget.consume(cost),
          toolChoice: 'none',
        })
        const wrapUp = wrapUpRequest.response
        finalText = wrapUp?.content || ''
      } catch {
        finalText = ''
      }
      return {
        text: finalText || `(工具循环已停止：${noProgressReason})`,
        artifactIds,
        iterations: iter + 1,
        noProgress: true,
        reason: noProgressReason,
      }
    }
  }

  // ★ Harness: 到达迭代上限时,以前直接返回空 finalText —— 用户看到的是
  // "任务完成但什么都没说"。对齐 subagentRuntime 的做法:让模型基于已有信息
  // 收个尾,拿不到就至少说清楚是被上限截断的,不要静默空返回。
  if (!finalText) {
    try {
      const wrapUpRequest = await callModelWithContextRecovery({
        messages: [
          ...convo,
          {
            role: 'system',
            content: `你已达到工具调用上限(${maxIters} 轮)。请基于目前已有的信息给出最终回答,不要再调用任何工具。`,
          },
        ],
        tools: [],
        callModel: (modelRequest) => runWithModelBudget(
          budget,
          () => runModel(modelRequest),
          { allowOverBudget: true },
        ),
        isContextLengthError,
        contextWindow,
        signal,
        userId: job?.userId || null,
        sessionId: job?.id && step?.id ? `job:${job.id}:${step.id}` : null,
        consumeBudget: (cost) => budget.consume(cost),
        toolChoice: 'none',
      })
      const wrapUp = wrapUpRequest.response
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

  return { text: finalText, artifactIds, iterations: Math.min(iter + 1, maxIters) }
}
