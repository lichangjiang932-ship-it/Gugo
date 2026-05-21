/**
 * 前端工具规格(OpenAI tool schema)和本地执行器(把 tool_call 路由到对应 fetch)。
 *
 * 流程:
 *   1) 前端把 buildToolSpecs(enabled) 塞进 chat 请求的 `tools` 字段
 *   2) 后端透传给上游模型,模型返回 tool_calls
 *   3) 前端 executeToolCall(call) 调本地 /api/tools/* 拿结果
 *   4) 把 { role: 'tool', tool_call_id, content } 追加到 messages,再发一轮
 */

// ★ batchF P1: /api/tools/* 现在强制鉴权,前端必须带 token,
//   否则未登录用户能直接调搜索/抓取消耗后端资源(也消耗别人的免费额度).
import { getAuthToken } from '../accountClient.js'

import { z } from 'zod'

// ★ batchG: 文件生成工具用到的解析器 — 旧版动态 import 会触发 vite
//   INEFFECTIVE_DYNAMIC_IMPORT 警告(因为同模块还被 artifactPreview.js /
//   RightPreviewPane.jsx 静态 import),所以这里直接静态引入,反正
//   ChatSplit chunk 里本就包含这两个模块.
import { parseMarkdownSlides } from '../presentationExport.js'
import { parseMarkdownDocument, parseSpreadsheetRows } from '../officeExport.js'

// ★ #18: 工具参数 zod schema — 模型可能给出脏数据,先校验再执行
const TOOL_ARG_SCHEMAS = {
  web_search: z.object({
    query: z.string().min(1, 'query 不能为空').max(500, 'query 过长'),
    max_results: z.number().int().min(1).max(10).optional(),
  }),
  fetch_url: z.object({
    url: z.string().url('url 必须是合法 http/https 链接'),
  }),
  create_pptx: z.object({
    title: z.string().min(1, 'title 不能为空').max(200),
    // markdown:用 --- 分页或 # 分页;每页第一行非分隔则当标题
    markdown: z.string().min(1, 'markdown 不能为空').max(60000),
  }),
  create_docx: z.object({
    title: z.string().min(1, 'title 不能为空').max(200),
    markdown: z.string().min(1, 'markdown 不能为空').max(120000),
  }),
  create_xlsx: z.object({
    title: z.string().min(1, 'title 不能为空').max(200),
    // 二维数组 (优先) 或 markdown 表格 / csv
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional(),
    markdown: z.string().max(60000).optional(),
  }).refine((d) => Array.isArray(d.rows) ? d.rows.length > 0 : !!d.markdown,
    { message: '需要提供 rows 或 markdown 至少一项' }),
  create_react_component: z.object({
    title: z.string().min(1, 'title 不能为空').max(200),
    // 单文件 React 组件源码;模型必须导出一个默认组件
    //   export default function App() { ... }
    // 沙箱里只能用 react/react-dom — 不允许 import 任何包,也不允许网络.
    code: z.string().min(1, 'code 不能为空').max(40000),
    description: z.string().max(500).optional(),
  }),
  create_mermaid: z.object({
    title: z.string().min(1, 'title 不能为空').max(200),
    mermaid_code: z.string().min(1, 'mermaid_code 不能为空').max(20000),
    chart_type: z.string().min(1),
  }),
  analyze_data: z.object({
    data_summary: z.string().min(1, 'data_summary 不能为空').max(200000),
    analysis_type: z.string().optional(),
    columns: z.string().max(2000).optional(),
  }),
}

const TOOL_SPECS = {
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: '使用搜索引擎查询互联网最新信息。返回 title、url、snippet 列表。当用户问到时事、最新发布、需要外部资料时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词,使用用户问题中的核心实体' },
          max_results: { type: 'integer', description: '返回结果上限,默认 6,最大 10', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      },
    },
  },
  fetch_url: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '抓取指定 URL 的页面正文,返回 markdown 形式的主要内容。用于读取 web_search 给出的链接细节。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整的 http/https URL' },
        },
        required: ['url'],
      },
    },
  },
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 file inside the configured workspace, optionally by line offset/limit. Use this before editing existing project files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path inside workspace, or an absolute path that still resolves inside workspace.' },
          offset: { type: 'integer', description: 'Zero-based starting line. Optional.' },
          limit: { type: 'integer', description: 'Number of lines to return. 0 or omitted reads to the end.' },
        },
        required: ['path'],
      },
    },
  },
  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 file inside the configured workspace. Prefer edit_file for small changes to existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', description: 'Complete file content.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  edit_file: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Precise string replacement inside a workspace file. old_string must be unique unless replace_all is true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: 'Exact existing text, including whitespace.' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences instead of requiring uniqueness.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  bash_exec: {
    type: 'function',
    function: {
      name: 'bash_exec',
      description: 'Run a shell command inside the configured workspace. Use for tests/builds/inspection; output is capped and secrets are masked server-side.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command string, e.g. npm test or git diff --stat.' },
          cwd: { type: 'string', description: 'Optional workspace-relative working directory.' },
          timeout_ms: { type: 'integer', description: 'Timeout in milliseconds, 1000-300000.' },
        },
        required: ['command'],
      },
    },
  },
  git_status: {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Read git branch and changed files for the configured workspace. Read-only. Use before and after code edits.',
      parameters: { type: 'object', properties: {} },
    },
  },
  git_diff: {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Read unified git diff for the workspace or a single changed file. Read-only.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Optional workspace-relative changed file path.' } },
      },
    },
  },
  run_project_check: {
    type: 'function',
    function: {
      name: 'run_project_check',
      description: 'Run exactly one allowed project check: lint, test, or build. Does not execute arbitrary shell commands.',
      parameters: {
        type: 'object',
        properties: { check: { type: 'string', enum: ['lint', 'test', 'build'], description: 'Allowed verification command.' } },
        required: ['check'],
      },
    },
  },
  create_pptx: {
    type: 'function',
    function: {
      name: 'create_pptx',
      description: [
        '生成可下载的 PowerPoint 演示文稿(.pptx).当用户需要 PPT/幻灯片/汇报材料时调用。',
        'markdown 用 --- 分页,每页第一行 `# 标题`,第二行 HTML 注释指定类型: <!-- cover -->, <!-- toc -->, <!-- section -->, <!-- content -->, <!-- data -->, <!-- chart -->, <!-- table -->, <!-- split -->, <!-- process -->, <!-- quote -->, <!-- image -->, <!-- end -->.',
        '图表页用 <!-- chart --> + fenced ```chart``` 块,语法: type: bar|line|pie / categories: a, b, c / series:\\n  系列名: 1, 2, 3.',
        '每页 bullets ≤ 4 条且每条 ≤ 18 字,标题写结论句不要写抽象主题词.同类数据 3+ 项优先用 chart 或 table.',
        '生成后右侧自动预览,用户可一键下载;点"高级"按钮走截图法导出更精致视觉。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '演示文稿标题(也作为下载文件名)' },
          markdown: { type: 'string', description: '幻灯片 markdown 源,--- 分页,首行 # 标题,次行 <!-- type -->' },
        },
        required: ['title', 'markdown'],
      },
    },
  },
  create_docx: {
    type: 'function',
    function: {
      name: 'create_docx',
      description: '生成可下载的 Word 文档(.docx).当用户需要长文报告/合同/说明书时调用。markdown 标题、列表、引用、代码块都会被正确转换。生成完成后右侧自动预览,用户可一键下载。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '文档标题(也作为下载文件名)' },
          markdown: { type: 'string', description: '文档正文 markdown' },
        },
        required: ['title', 'markdown'],
      },
    },
  },
  create_xlsx: {
    type: 'function',
    function: {
      name: 'create_xlsx',
      description: '生成可下载的 Excel 表格(.xlsx).当用户需要数据表/对比表/任务清单时调用。优先用 rows(二维数组)给结构化数据,否则用 markdown 表格。生成完成后右侧自动预览,用户可一键下载。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '表格标题(也作为下载文件名)' },
          rows: {
            type: 'array',
            description: '二维数组形式的表格数据,第一行通常是表头.示例 [["姓名","部门"],["张三","研发"]]',
            items: { type: 'array', items: {} },
          },
          markdown: { type: 'string', description: '当不便用 rows 时,可传 markdown 表格或 csv 文本(三反引号包裹)' },
        },
        required: ['title'],
      },
    },
  },
  create_react_component: {
    type: 'function',
    function: {
      name: 'create_react_component',
      description: '生成一个可在右侧实时渲染的 React 单文件组件(类似 Claude artifacts / Codex web preview)。当用户要求做交互式 demo、可视化、小工具、UI 原型时调用。约束:必须是单文件,只能用 React + ReactDOM(已注入全局),不能 import 任何包,不能访问网络;可以用 useState/useEffect 等所有 React hooks,可以用内联 Tailwind class(已注入 cdn)或内联 style。源码末尾必须 export default 一个组件(如 export default function App(){...})。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '组件标题(展示在预览顶部 + 文件名)' },
          code: { type: 'string', description: '完整的单文件 React 组件源码,含 export default。可以用 JSX 和现代 ES 语法 — 沙箱用 babel-standalone 编译。' },
          description: { type: 'string', description: '可选: 简短说明这个组件做什么(展示给用户)' },
        },
        required: ['title', 'code'],
      },
    },
  },
  create_mermaid: {
    type: 'function',
    function: {
      name: 'create_mermaid',
      description: '将流程、架构、关系或时序转化为 Mermaid 图表。当用户提到"画流程图""画架构图""画时序图""画甘特图""画思维导图""画类图"或描述某个流程/结构/关系时调用。支持 flowchart/TD、sequenceDiagram、classDiagram、gantt、pie、mindmap、erDiagram、stateDiagram 等。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '图表标题' },
          mermaid_code: { type: 'string', description: '符合 Mermaid 语法的图表代码。不要加 ```mermaid 围栏标记，直接写纯语法。确保语法正确可被 mermaid.js 渲染。' },
          chart_type: { type: 'string', enum: ['flowchart', 'sequenceDiagram', 'classDiagram', 'gantt', 'pie', 'mindmap', 'erDiagram', 'stateDiagram', 'gitGraph', 'journey'], description: '图表类型' },
        },
        required: ['title', 'mermaid_code', 'chart_type'],
      },
    },
  },
  analyze_data: {
    type: 'function',
    function: {
      name: 'analyze_data',
      description: '对用户上传的 CSV/表格/JSON 数据进行深度分析。当用户上传数据文件并问"分析一下""有什么发现""趋势如何"时调用。返回描述性统计、趋势、异常、关联分析。',
      parameters: {
        type: 'object',
        properties: {
          data_summary: { type: 'string', description: '数据内容摘要或前 50 行 CSV 文本（脱敏后）。如果数据较大，用摘要描述代替全文。' },
          analysis_type: { type: 'string', enum: ['descriptive', 'trend', 'correlation', 'anomaly', 'full'], description: '分析类型：descriptive 描述统计、trend 趋势分析、correlation 关联分析、anomaly 异常检测、full 全部分析' },
          columns: { type: 'string', description: '列名列表（逗号分隔），帮助理解数据结构。' },
        },
        required: ['data_summary'],
      },
    },
  },

}


const READ_ONLY_MODE_TOOLS = new Set(['web_search', 'fetch_url', 'read_file', 'git_status', 'git_diff'])
const CODE_MODE_TOOLS = ['read_file', 'write_file', 'edit_file', 'bash_exec', 'git_status', 'git_diff', 'run_project_check']
const RESEARCH_MODE_TOOLS = ['web_search', 'fetch_url', 'create_mermaid', 'analyze_data', 'create_docx', 'create_xlsx']
const WRITE_MODE_TOOLS = ['create_docx', 'create_pptx', 'create_xlsx', 'create_mermaid', 'create_react_component']
const DEBUG_MODE_TOOLS = [...CODE_MODE_TOOLS, 'create_react_component', 'analyze_data']

export function resolveToolsForMode(toolsConfig = {}, mode = 'chat') {
  const enabled = Object.entries(toolsConfig || {})
    .filter(([, on]) => !!on)
    .map(([name]) => name)

  if (mode === 'plan') {
    return enabled.filter((name) => READ_ONLY_MODE_TOOLS.has(name))
  }

  if (mode === 'code') {
    return [...new Set([...enabled, ...CODE_MODE_TOOLS])]
  }

  if (mode === 'research') {
    return [...new Set([...enabled, ...RESEARCH_MODE_TOOLS])]
  }

  if (mode === 'write') {
    return [...new Set([...enabled, ...WRITE_MODE_TOOLS])]
  }

  if (mode === 'debug') {
    return [...new Set([...enabled, ...DEBUG_MODE_TOOLS])]
  }

  return enabled
}

export function buildToolSpecs(enabledNames) {
  // 接受 Array / Set / 任何 iterable;去重防同一 spec 被塞进两遍
  // (#18 用户在权限中心可能勾选过 + toolsConfig 也开了重复来源)
  const seen = new Set()
  const list = []
  for (const name of enabledNames || []) {
    if (typeof name !== 'string') continue
    if (seen.has(name)) continue
    seen.add(name)
    const spec = TOOL_SPECS[name]
    if (spec) {
      list.push(spec)
    } else if (typeof console !== 'undefined') {
      console.warn(`[tools] 未知工具被忽略: ${name}`)
    }
  }
  return list
}

export function listToolNames() {
  return Object.keys(TOOL_SPECS)
}

/* ── 执行器 ── */

async function callJson(url, body) {
  const headers = { 'Content-Type': 'application/json' }
  const token = getAuthToken?.()
  if (token) headers.Authorization = `Bearer ${token}`
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await resp.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!resp.ok || data?.ok === false) {
    const err = new Error(data?.error || `HTTP ${resp.status}`)
    err.status = resp.status
    throw err
  }
  return data
}


async function callWorkspaceJson(url, body) {
  const headers = { 'Content-Type': 'application/json' }
  const token = getAuthToken?.()
  if (token) headers.Authorization = `Bearer ${token}`
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await resp.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!resp.ok) {
    const err = new Error(data?.error || `HTTP ${resp.status}`)
    err.status = resp.status
    throw err
  }
  return data
}

async function execWebSearch(args) {
  const query = String(args?.query || '').trim()
  if (!query) throw new Error('query 不能为空')
  const max_results = Number(args?.max_results) || 6
  const data = await callJson('/api/tools/search', { query, maxResults: max_results })
  // 返给模型的内容尽量精简
  return {
    content: JSON.stringify({
      query,
      results: (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
    }),
    billing: data.billing || null,
  }
}

async function execFetchUrl(args) {
  const url = String(args?.url || '').trim()
  if (!url) throw new Error('url 不能为空')
  const data = await callJson('/api/tools/fetch', { url })
  return {
    content: JSON.stringify({
      url: data.url || url,
      title: data.title || '',
      truncated: !!data.truncated,
      markdown: data.markdown || '',
    }),
    billing: data.billing || null,
  }
}

// ── G1: 文件生成工具 ────────────────────────────────────────────────────────
// 这三个工具不走后端 — 直接在前端用 pptxgenjs / docx / xlsx 生成,
// 返回带 artifact 描述符的结果.executor 把 artifact 透到 callsite,
// callsite 再写到 last message meta(artifactType + artifactSource),
// ChatMessages 看到 explicit artifact 就直接渲染卡片 + 弹右栏预览.
//
// 模型拿到的工具 content 只是简短 ack(避免 markdown 全文回灌占用上下文).


async function execReadFile(args) {
  const data = await callWorkspaceJson('/api/tools/fs/read', args)
  return { content: JSON.stringify(data) }
}

async function execWriteFile(args) {
  const data = await callWorkspaceJson('/api/tools/fs/write', args)
  return { content: JSON.stringify(data) }
}

async function execEditFile(args) {
  const data = await callWorkspaceJson('/api/tools/fs/edit', args)
  return { content: JSON.stringify(data) }
}

async function execBashExec(args) {
  const data = await callWorkspaceJson('/api/tools/shell/exec', args)
  return { content: JSON.stringify(data) }
}

async function execGitStatus(args) {
  const data = await callWorkspaceJson('/api/tools/git/status', args || {})
  return { content: JSON.stringify(data) }
}

async function execGitDiff(args) {
  const data = await callWorkspaceJson('/api/tools/git/diff', args || {})
  return { content: JSON.stringify(data) }
}

async function execRunProjectCheck(args) {
  const data = await callWorkspaceJson('/api/tools/check/run', args || {})
  return { content: JSON.stringify(data) }
}

async function execCreatePptx(args) {
  const title = String(args.title).trim().slice(0, 200) || 'presentation'
  const markdown = String(args.markdown)
  // 用现有 parseMarkdownSlides 做一次 sanity 解析,失败就让模型知道
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) throw new Error('markdown 解析为 0 张幻灯片;请用 --- 分页或以 # 开头的页标题')
  return {
    content: JSON.stringify({
      ok: true,
      title,
      slides: slides.length,
      message: `已生成 PPT 草稿 "${title}"(${slides.length} 页),用户可在右侧预览并下载。`,
    }),
    artifact: { type: 'pptx', title, source: markdown },
  }
}

async function execCreateDocx(args) {
  const title = String(args.title).trim().slice(0, 200) || 'document'
  const markdown = String(args.markdown)
  const doc = parseMarkdownDocument(markdown)
  if (!doc.blocks.length) throw new Error('markdown 解析为 0 个内容块')
  return {
    content: JSON.stringify({
      ok: true,
      title,
      blocks: doc.blocks.length,
      message: `已生成 Word 草稿 "${title}"(${doc.blocks.length} 个块),用户可在右侧预览并下载。`,
    }),
    artifact: { type: 'docx', title, source: markdown },
  }
}

async function execCreateXlsx(args) {
  const title = String(args.title).trim().slice(0, 200) || 'spreadsheet'
  const rows = Array.isArray(args.rows) ? args.rows : null
  let source
  if (rows && rows.length) {
    // 直接用结构化数组 — 转成 csv 让现有 parseSpreadsheetRows 走通
    source = '```csv\n' + rows.map((r) =>
      r.map((c) => {
        const s = c == null ? '' : String(c)
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }).join(',')
    ).join('\n') + '\n```'
  } else if (args.markdown) {
    source = String(args.markdown)
  } else {
    throw new Error('需要 rows 或 markdown 至少一项')
  }
  const parsed = parseSpreadsheetRows(source)
  if (!parsed.length) throw new Error('解析为 0 行数据')
  return {
    content: JSON.stringify({
      ok: true,
      title,
      rows: parsed.length,
      message: `已生成 Excel 草稿 "${title}"(${parsed.length} 行),用户可在右侧预览并下载。`,
    }),
    artifact: { type: 'xlsx', title, source },
  }
}

// ★ 危险代码模式 — 沙箱逃逸/恶意行为拦截
const DANGEROUS_PATTERNS = [
  { pattern: /\beval\s*\(/, msg: '沙箱禁用 eval() — 请用本地状态与逻辑实现功能' },
  { pattern: /\bnew\s+Function\s*\(/, msg: '沙箱禁用 new Function() — 请用常规函数定义' },
  { pattern: /\bsetTimeout\s*\(\s*["']/, msg: '沙箱禁用 setTimeout 字符串参数 — 请传入函数' },
  { pattern: /\bsetInterval\s*\(\s*["']/, msg: '沙箱禁用 setInterval 字符串参数 — 请传入函数' },
  { pattern: /document\.write\s*\(/, msg: '沙箱禁用 document.write — 请用 JSX 渲染' },
  { pattern: /window\.location\s*=/, msg: '沙箱禁用 window.location 跳转 — 请用本地交互实现功能' },
  { pattern: /<script\b/i, msg: '沙箱禁用 <script> 标签 — 请用 JSX 与 hooks 实现逻辑' },
  { pattern: /\brequire\s*\(/, msg: '沙箱禁用 require() — 只能用 React/ReactDOM 全局变量' },
  { pattern: /\bimport\s*\(/, msg: '沙箱禁用动态 import() — 请用本地状态实现功能' },
  { pattern: /\bfetch\s*\(|XMLHttpRequest|WebSocket/, msg: '沙箱禁用网络请求(fetch/XHR/WebSocket);请用本地状态生成示例数据' },
  { pattern: /\bimport\s+[^;]*\bfrom\b/, msg: '沙箱不允许 import 外部包;只能用 React/ReactDOM(已作为全局变量注入)' },
]

async function execCreateReactComponent(args) {
  const title = String(args.title).trim().slice(0, 200) || 'react-component'
  const code = String(args.code)
  const description = args.description ? String(args.description).trim().slice(0, 500) : ''
  // 最轻量 sanity check — 防止常见错误传到沙箱前就报
  if (!/export\s+default/.test(code)) {
    throw new Error('代码缺少 export default — 请用 `export default function App() { ... }` 或 `export default () => ...`')
  }
  for (const { pattern, msg } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      throw new Error(msg)
    }
  }
  return {
    content: JSON.stringify({
      ok: true,
      title,
      bytes: code.length,
      message: `已生成 React 组件 "${title}"(${code.length} 字符),用户可在右侧实时预览并交互。`,
    }),
    artifact: { type: 'react', title, source: code, description },
  }
}

/* ── New tool executors ── */

async function execCreateMermaid(args) {
  const title = String(args.title).trim().slice(0, 200) || "diagram"
  const code = String(args.mermaid_code)
  const chartType = String(args.chart_type || "flowchart")
  const validTypes = ["flowchart", "sequenceDiagram", "classDiagram", "gantt", "pie", "mindmap", "erDiagram", "stateDiagram", "gitGraph", "journey"]
  if (!validTypes.includes(chartType)) {
    throw new Error("Unsupported chart type: " + chartType)
  }
  const typeKeyword = chartType === "flowchart" ? "flowchart" : chartType
  if (!code.toLowerCase().includes(typeKeyword.toLowerCase()) && !code.toLowerCase().includes("graph")) {
    throw new Error("Mermaid code missing keyword, check syntax")
  }
  const bt = String.fromCharCode(96)
  const fence = bt + bt + bt
  const lines = [
    "Chart generated: " + title + ". Embed with fenced mermaid block:",
    "",
    fence + "mermaid",
    code,
    fence,
  ]
  return {
    content: JSON.stringify({
      ok: true,
      title,
      chartType,
      code,
      message: lines.join("\n"),
    }),
  }
}

async function execAnalyzeData(args) {
  const summary = String(args.data_summary)
  const analysisType = String(args.analysis_type || 'full')
  const columns = String(args.columns || '')
  const colList = columns ? columns.split(',').map(c => c.trim()).filter(Boolean) : []
  return {
    content: JSON.stringify({
      ok: true,
      analysisType,
      columns: colList,
      rowPreview: summary.slice(0, 500),
      message: `收到数据分析请求（类型: ${analysisType}，列: ${colList.join(', ') || '未指定'}）。模型将基于数据摘要进行深入分析。`,
    }),
  }
}

const EXECUTORS = {
  web_search: execWebSearch,
  fetch_url: execFetchUrl,
  create_pptx: execCreatePptx,
  create_docx: execCreateDocx,
  create_xlsx: execCreateXlsx,
  create_react_component: execCreateReactComponent,
  create_mermaid: execCreateMermaid,
  analyze_data: execAnalyzeData,
  read_file: execReadFile,
  write_file: execWriteFile,
  edit_file: execEditFile,
  bash_exec: execBashExec,
  git_status: execGitStatus,
  git_diff: execGitDiff,
  run_project_check: execRunProjectCheck,
}

export async function executeToolCall(call, options = {}) {
  const { maxRetries = 2, retryDelayMs = 600 } = options
  const name = call?.name
  const fn = EXECUTORS[name]
  let parsedArgs = {}
  if (call?.arguments) {
    try { parsedArgs = JSON.parse(call.arguments) } catch { parsedArgs = {} }
  }
  if (!fn) {
    return { ok: false, content: JSON.stringify({ error: `未知工具: ${name}` }) }
  }

  // ★ #18: zod 参数校验 — 失败直接返回 (不可重试)
  const schema = TOOL_ARG_SCHEMAS[name]
  if (schema) {
    const parsed = schema.safeParse(parsedArgs)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.message).join('; ')
      return { ok: false, content: JSON.stringify({ error: `参数无效: ${issues}` }) }
    }
    parsedArgs = parsed.data
  }

  // ★ #24: 失败重试 — 网络/反爬瞬时错误自动重试 (最多 maxRetries 次,指数退避)
  let lastErr
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const output = await fn(parsedArgs)
      const content = typeof output === 'string' ? output : output.content
      const billing = typeof output === 'string' ? null : output.billing
      const artifact = typeof output === 'string' ? null : (output.artifact || null)
      return { ok: true, content, billing, artifact, attempts: attempt + 1 }
    } catch (err) {
      lastErr = err
      const msg = err?.message || String(err)
      // 不可重试:参数校验类错误 / 沙箱策略拒绝
      const nonRetriable = /参数|不能为空|invalid|required|沙箱/i.test(msg)
      if (nonRetriable || attempt === maxRetries) break
      // 指数退避:600ms → 1200ms
      await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)))
    }
  }
  return {
    ok: false,
    content: JSON.stringify({
      error: lastErr?.message || String(lastErr),
      attempts: maxRetries + 1,
    }),
  }
}
