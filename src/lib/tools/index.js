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
  create_pptx: {
    type: 'function',
    function: {
      name: 'create_pptx',
      description: '生成可下载的 PowerPoint 演示文稿(.pptx).当用户需要 PPT/幻灯片/汇报材料时调用。markdown 用 --- 或 # 分页,第一行作为页标题。生成完成后右侧会自动出现预览窗口,用户可一键下载。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '演示文稿标题(也作为下载文件名)' },
          markdown: { type: 'string', description: '幻灯片 markdown 源,---/# 分页' },
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

async function execCreateReactComponent(args) {
  const title = String(args.title).trim().slice(0, 200) || 'react-component'
  const code = String(args.code)
  const description = args.description ? String(args.description).trim().slice(0, 500) : ''
  // 最轻量 sanity check — 防止常见错误传到沙箱前就报
  if (!/export\s+default/.test(code)) {
    throw new Error('代码缺少 export default — 请用 `export default function App() { ... }` 或 `export default () => ...`')
  }
  if (/\bimport\s+[^;]*\bfrom\b/.test(code)) {
    throw new Error('沙箱不允许 import 外部包;只能用 React/ReactDOM(已作为全局变量注入)')
  }
  if (/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(code)) {
    throw new Error('沙箱禁用网络请求(fetch/XHR/WebSocket);请用本地状态生成示例数据')
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

const EXECUTORS = {
  web_search: execWebSearch,
  fetch_url: execFetchUrl,
  create_pptx: execCreatePptx,
  create_docx: execCreateDocx,
  create_xlsx: execCreateXlsx,
  create_react_component: execCreateReactComponent,
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
