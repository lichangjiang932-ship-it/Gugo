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
//   否则未登录用户能直接调用搜索/抓取并消耗后端资源。
import { getAuthToken } from '../accountClient.js'

import { z } from 'zod'

// ★ batchG: 文件生成工具用到的解析器 — 旧版动态 import 会触发 vite
//   INEFFECTIVE_DYNAMIC_IMPORT 警告(因为同模块还被 artifactPreview.js /
//   RightPreviewPane.jsx 静态 import),所以这里直接静态引入,反正
//   ChatSplit chunk 里本就包含这两个模块.
import { parseMarkdownSlides } from '../presentationExport.js'
import { parseMarkdownDocument, parseSpreadsheetRows } from '../officeExport.js'
import { askDirectoryApproval } from '../toolApproval.js'
import { translateKey } from '../../i18n/translations.js'

const FILE_ARTIFACT_TOOL_NAMES = new Set(['create_pptx', 'create_docx', 'create_xlsx'])

// ★ #18: 工具参数 zod schema — 模型可能给出脏数据,先校验再执行
const TOOL_ARG_SCHEMAS = {
  list_directory: z.object({
    path: z.string().min(1, 'path 不能为空').max(2000),
    limit: z.number().int().min(1).max(500).optional(),
  }),
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
    title: z.string().min(1).max(200),
    diagram: z.string().min(1).max(50000),
    theme: z.enum(['default', 'neutral', 'dark', 'forest', 'base']).optional(),
  }),
  create_chart: z.object({
    title: z.string().min(1).max(200),
    config: z.record(z.string(), z.any()),
  }),
  create_svg: z.object({
    title: z.string().min(1).max(200),
    svg: z.string().min(1).max(200000),
  }),
  create_html_app: z.object({
    title: z.string().min(1).max(200),
    files: z.record(z.string(), z.string()).refine((files) => !!files['index.html'], { message: 'files must include index.html' }),
  }),
  Agent: z.object({
    subagent_type: z.enum(['explore', 'plan', 'general']).optional(),
    prompt: z.string().min(1).max(20000).optional(),
    description: z.string().min(1).max(120).optional(),
    tasks: z.array(z.object({
      subagent_type: z.enum(['explore', 'plan', 'general']),
      prompt: z.string().min(1).max(20000),
      description: z.string().min(1).max(120),
    })).min(1).max(3).optional(),
  }).superRefine((value, ctx) => {
    const hasSingle = value.subagent_type && value.prompt && value.description
    if (!hasSingle && !value.tasks?.length) {
      ctx.addIssue({ code: 'custom', message: 'provide one subagent task or a tasks array' })
    }
  }),
  // Feature 8: Todo — 整组替换 — 模型可反复调用更新状态
  manage_todos: z.object({
    todos: z.array(z.object({
      content: z.string().min(1, 'content 不能为空').max(300),
      status: z.enum(['pending', 'in_progress', 'completed']),
      activeForm: z.string().min(1, 'activeForm 不能为空').max(300),
    })).max(50, 'todo 数量上限 50'),
  }).refine((d) => {
    const inProg = d.todos.filter((t) => t.status === 'in_progress').length
    return inProg <= 1
  }, { message: '同一时间只允许一个 in_progress' }),

  // Reasonix-style multi_edit: 原子化批量 SEARCH/REPLACE
  multi_edit: z.object({
    edits: z.array(z.object({
      path: z.string().min(1, 'path 不能为空').max(500),
      oldText: z.string().min(1, 'oldText 不能为空'),
      newText: z.string().min(0),
    })).min(1, '至少需要一个 edit').max(20, '单次最多 20 个 edit'),
  }),

  // ★ M1: ripgrep 代码搜索三件套
  grep_code: z.object({
    pattern: z.string().min(1, 'pattern 不能为空').max(1000),
    path: z.string().max(500).optional(),
    glob: z.string().max(200).optional(),
    file_type: z.string().regex(/^[a-z0-9+-]+$/i, 'file_type 仅允许字母数字').optional(),
    case_sensitive: z.boolean().optional(),
    word: z.boolean().optional(),
    max_results: z.number().int().min(1).max(500).optional(),
  }),
  find_symbol: z.object({
    name: z.string().regex(/^[a-zA-Z_$][\w$]*$/, 'name 必须是合法标识符'),
    kind: z.enum(['all', 'function', 'class', 'const']).optional(),
    language: z.string().regex(/^[a-z0-9+-]+$/i).optional(),
    path: z.string().max(500).optional(),
    max_results: z.number().int().min(1).max(100).optional(),
  }),
  list_imports: z.object({
    file: z.string().min(1, 'file 必填').max(500),
  }),
  apply_patch: z.object({
    patch: z.string().min(1, 'patch 不能为空').max(2 * 1024 * 1024, 'patch 过大'),
    dry_run: z.boolean().optional(),
  }),
  reflect: z.object({
    observation: z.string().min(1, 'observation 不能为空').max(4000),
    what_worked: z.string().max(600).optional().nullable(),
    what_didnt: z.string().max(600).optional().nullable(),
    next_step: z.string().min(1, 'next_step 不能为空').max(600),
    confidence: z.enum(['low', 'medium', 'high']).optional(),
  }),
  request_clarification: z.object({
    question: z.string().min(1, 'question 不能为空').max(4000),
    why: z.string().max(600).optional().nullable(),
    blocker_kind: z.enum(['missing_info', 'ambiguous_intent', 'permission', 'risk_decision', 'other']).optional(),
    options: z.array(z.string().max(200)).max(8).optional().nullable(),
  }),
}

const TOOL_SPECS = {
  list_directory: {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and folders inside the workspace or a user-authorized local directory. Use absolute paths for additional local grants.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path or an authorized absolute folder path.' },
          limit: { type: 'integer', description: 'Maximum entries to return, from 1 to 500.' },
        },
        required: ['path'],
      },
    },
  },
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
      description: 'Read a UTF-8 file inside the workspace or a user-authorized local path, optionally by line offset/limit. Use absolute paths for additional local grants.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path or an authorized absolute file path.' },
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
      description: 'Create or overwrite a UTF-8 file inside the workspace or a user-authorized read/write local path. Prefer edit_file for small changes.',
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
      description: 'Precise string replacement inside a workspace or user-authorized read/write file. old_string must be unique unless replace_all is true.',
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
  multi_edit: {
    type: 'function',
    function: {
      name: 'multi_edit',
      description: 'Atomic batch edit across multiple files. Pre-validates all SEARCH texts exist and are unique, then applies all edits. Rollbacks on any failure. Use for cross-file refactoring and bulk pattern replacements.',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            description: 'List of SEARCH/REPLACE edits (max 20)',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'File path relative to workspace' },
                oldText: { type: 'string', description: 'Exact text to replace — must be unique in file' },
                newText: { type: 'string', description: 'Replacement text' },
              },
              required: ['path', 'oldText', 'newText'],
            },
          },
        },
        required: ['edits'],
      },
    },
  },
  apply_patch: {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Codex-style atomic multi-file patch. Supports Add/Update/Delete File with unified-diff hunks. Cheaper than edit_file for large changes, safer than write_file (refuses to overwrite existing). All-or-nothing: any failure rolls back. Set dry_run=true to preview diff without writing.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'Codex-format patch text starting with "*** Begin Patch" and ending with "*** End Patch".' },
          dry_run: { type: 'boolean', description: 'Default false. true returns diff preview without writing.' },
        },
        required: ['patch'],
      },
    },
  },
  bash_exec: {
    type: 'function',
    function: {
      name: 'bash_exec',
      description: 'Run a shell command inside the configured workspace or a user-authorized local directory. Use for tests/builds/inspection; output is capped and secrets are masked server-side.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command string, e.g. npm test or git diff --stat.' },
          cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute working directory.' },
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
      description: 'Read git branch and changed files for the configured workspace or a user-authorized repository. Read-only. Use before and after code edits.',
      parameters: {
        type: 'object',
        properties: { cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute repository path.' } },
      },
    },
  },
  git_diff: {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Read unified git diff for the workspace or a user-authorized repository. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional repository-relative changed file path.' },
          cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute repository path.' },
        },
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
        properties: {
          check: { type: 'string', enum: ['lint', 'test', 'build'], description: 'Allowed verification command.' },
          cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute repository path.' },
        },
        required: ['check'],
      },
    },
  },
  create_pptx: {
    type: 'function',
    function: {
      name: 'create_pptx',
      description: '生成可下载的.PPTX 演示文稿。必须用 --- 分页、# 结论式标题、第二行 <!-- type --> 页面类型(cover/toc/section/data/chart/table/split/process/quote/content/end)。图表用 ```chart``` 块。内容页每条要点用“主张；证据/机制/影响：具体事实或因果链”，用户要求页数时严格遵守，严禁输出制作建议或说明尾巴。',
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
      description: 'Create a Mermaid diagram artifact that opens in the right preview pane. Use for flows, architecture graphs, sequences, and system maps.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          diagram: { type: 'string', description: 'Mermaid source, for example flowchart TD; A-->B' },
          theme: { type: 'string', enum: ['default', 'neutral', 'dark', 'forest', 'base'] },
        },
        required: ['title', 'diagram'],
      },
    },
  },
  create_chart: {
    type: 'function',
    function: {
      name: 'create_chart',
      description: 'Create a Chart.js artifact from a JSON chart configuration. Use when data should be previewed visually instead of left as a table.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          config: { type: 'object', description: 'Chart.js config with type, data, and options.' },
        },
        required: ['title', 'config'],
      },
    },
  },
  create_svg: {
    type: 'function',
    function: {
      name: 'create_svg',
      description: 'Create a sanitized SVG artifact for logos, diagrams, icons, or vector illustrations.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          svg: { type: 'string', description: 'Complete inline SVG source, without scripts or external links.' },
        },
        required: ['title', 'svg'],
      },
    },
  },
  create_html_app: {
    type: 'function',
    function: {
      name: 'create_html_app',
      description: 'Create a multi-file HTML artifact. Provide index.html plus optional styles.css/app.js; it is collapsed into one previewable file card.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          files: {
            type: 'object',
            description: 'Map of filename to text content. Must include index.html. External script/link tags are rejected.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['title', 'files'],
      },
    },
  },
  Agent: {
    type: 'function',
    function: {
      name: 'Agent',
      description: 'Delegate focused work to isolated sub-agents. Pass one task, or up to 3 independent tasks to run them in parallel. Returns final summaries only.',
      parameters: {
        type: 'object',
        properties: {
          subagent_type: { type: 'string', enum: ['explore', 'plan', 'general'] },
          prompt: { type: 'string', description: 'Full instructions; the sub-agent cannot see hidden parent context unless you include it.' },
          description: { type: 'string', description: '5-10 word label shown to the user.' },
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
            items: {
              type: 'object',
              properties: {
                subagent_type: { type: 'string', enum: ['explore', 'plan', 'general'] },
                prompt: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['subagent_type', 'prompt', 'description'],
            },
          },
        },
        anyOf: [
          { required: ['subagent_type', 'prompt', 'description'] },
          { required: ['tasks'] },
        ],
      },
    },
  },

  // Feature 8: Todo 追踪 — 模型用来管理多步任务清单,UI 顶部 sticky 渲染
  manage_todos: {
    type: 'function',
    function: {
      name: 'manage_todos',
      description: '维护当前任务的 Todo 清单。多步任务必须调用本工具让用户实时看到进度;每次传整组替换,同一时间只允许一个 in_progress。content 用祈使句(如"添加错误处理"),activeForm 用进行时(如"添加错误处理中")。模型可反复调用更新状态。',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '祈使句形式,如"修复登录闪退"' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                activeForm: { type: 'string', description: '进行时,如"修复登录闪退中"' },
              },
              required: ['content', 'status', 'activeForm'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },

}


const READ_ONLY_MODE_TOOLS = new Set(['web_search', 'fetch_url', 'list_directory', 'read_file', 'git_status', 'git_diff', 'manage_todos', 'Agent'])
const CODE_MODE_TOOLS = ['list_directory', 'read_file', 'write_file', 'edit_file', 'bash_exec', 'git_status', 'git_diff', 'run_project_check', 'manage_todos', 'Agent']

function sortToolSpecsByName(specs = []) {
  return [...specs].sort((a, b) => {
    const aName = String(a?.function?.name || '')
    const bName = String(b?.function?.name || '')
    return aName < bName ? -1 : aName > bName ? 1 : 0
  })
}

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
    if (spec && typeof EXECUTORS[name] === 'function') {
      list.push(spec)
    } else if (typeof console !== 'undefined') {
      console.warn(spec
        ? `[tools] Tool without an executor was ignored: ${name}`
        : `[tools] 未知工具被忽略: ${name}`)
    }
  }
  return sortToolSpecsByName(list)
}

export function listToolNames() {
  return Object.keys(TOOL_SPECS)
}

/**
 * Feature 1: 拉服务端 /api/tools/specs 取得当前模式的完整工具列表
 *   - builtin: 服务端镜像了 TOOL_SPECS
 *   - mcp: McpManager 在连接时注入的动态工具
 *   - skill: 后续 feature
 * 返回 [{type:'function', function:{name, description, parameters}}]
 *
 * 失败时返回空数组（caller 应该 fallback 到本地 buildToolSpecs(enabledNames)）。
 */
export async function fetchToolSpecsFromServer(mode = 'chat') {
  try {
    const params = new URLSearchParams()
    if (mode) params.set('mode', mode)
    const resp = await fetch(`/api/tools/specs?${params.toString()}`)
    if (!resp.ok) return []
    const data = await resp.json()
    if (!data?.ok || !Array.isArray(data.specs)) return []
    return data.specs.map((s) => s.tool).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Feature 1: 合并 builtin 启用工具 + 服务端动态工具 (mcp/skill/subagent)
 * builtin 工具的开关由 toolsConfig 控制；MCP 工具一旦 server enabled 就默认开启。
 */
export async function buildToolSpecsAsync({ enabledBuiltinNames, mode = 'chat' }) {
  const builtin = buildToolSpecs(enabledBuiltinNames || [])
  const serverList = await fetchToolSpecsFromServer(mode)
  const seen = new Set(builtin.map((t) => t.function?.name))
  const dynamic = serverList.filter((t) => {
    const name = t.function?.name
    if (!name || seen.has(name)) return false
    // 只补充非 builtin 部分（mcp__* / skill 等）
    return name.startsWith('mcp__') || name.startsWith('skill__') || !TOOL_SPECS[name]
  })
  // 排除已经在 builtin 里出现的同名
  return sortToolSpecsByName([...builtin, ...dynamic])
}

/* ── 执行器 ── */

function responseErrorMessage(data, fallback) {
  if (typeof data?.error === 'string' && data.error) return data.error
  if (typeof data?.error?.message === 'string' && data.error.message) return data.error.message
  return fallback
}

async function callJson(url, body, { method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  const token = getAuthToken?.()
  if (token) headers.Authorization = `Bearer ${token}`
  const resp = await fetch(url, {
    method,
    headers,
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  })
  const text = await resp.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!resp.ok || data?.ok === false) {
    const err = new Error(responseErrorMessage(data, `HTTP ${resp.status}`))
    err.status = resp.status
    err.code = data?.error?.code || data?.code
    err.retryable = data?.retryable
    err.path = data?.path
    err.hint = data?.hint
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
    let message = responseErrorMessage(data, `HTTP ${resp.status}`)
    // ★ 404 且响应体不是 JSON → 是**路由本身没注册**,不是资源不存在。
    //
    // 真实事故:dev server 漏注册 /api/tools/code/,模型每次调 grep_code
    // 都只看到裸的 "HTTP 404",于是它以为是路径写错了,连着换了 5 种
    // 路径写法反复重试,全失败,最后绕道用 read_file 硬啃整个文件。
    // 说清楚「这是后端没接上,换路径没用」,它才能立刻改用别的工具。
    if (resp.status === 404 && !data?.error) {
      message = `接口 ${url} 未注册（HTTP 404）。这是后端路由缺失，不是文件或资源不存在——`
        + '换路径重试没有用，请改用其他工具（如 read_file / list_directory）完成任务，'
        + '并在最终回复里告诉用户这个接口不可用。'
    }
    const err = new Error(message)
    err.status = resp.status
    err.code = data?.error?.code || data?.code
    err.retryable = data?.retryable
    err.path = data?.path
    err.hint = data?.hint
    err.suggestGrantPath = data?.suggestGrantPath
    err.requiredAccessMode = data?.requiredAccessMode
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

async function execListDirectory(args) {
  const data = await callWorkspaceJson('/api/tools/fs/list', args)
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

// ★ M1: 代码搜索三件套
async function execGrepCode(args) {
  const data = await callWorkspaceJson('/api/tools/code/grep', args)
  return { content: JSON.stringify(data) }
}
async function execFindSymbol(args) {
  const data = await callWorkspaceJson('/api/tools/code/find-symbol', args)
  return { content: JSON.stringify(data) }
}
async function execListImports(args) {
  const data = await callWorkspaceJson('/api/tools/code/list-imports', args)
  return { content: JSON.stringify(data) }
}
async function execApplyPatch(args) {
  // 客户端只获取预览并转发执行请求。风险裁决、授权范围与审计均由服务端处理。
  const preview = await callWorkspaceJson('/api/tools/code/apply-patch', { ...args, dry_run: true })
  if (preview?.ok === false) {
    return { ok: false, content: JSON.stringify(preview) }
  }
  const data = await callWorkspaceJson('/api/tools/code/apply-patch', { ...args, dry_run: false })
  return { ok: data?.ok !== false, content: JSON.stringify(data) }
}
async function execReflect(args) {
  const data = await callWorkspaceJson('/api/tools/agent/reflect', args)
  return { content: JSON.stringify(data) }
}
async function execRemember(args) {
  const data = await callWorkspaceJson('/api/tools/agent/remember', args)
  return { ok: data?.ok !== false, content: JSON.stringify(data) }
}

async function execRequestClarification(args) {
  const data = await callWorkspaceJson('/api/tools/agent/clarify', args)
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


function rejectDangerousHtml(source, label = 'HTML') {
  const text = String(source || '')
  const bad = [
    /<script\b[^>]*\bsrc\s*=/i,
    /<link\b[^>]*\brel=["']?stylesheet["']?[^>]*\bhref\s*=/i,
    /javascript:/i,
    /on\w+\s*=/i,
  ]
  if (bad.some((re) => re.test(text))) {
    throw new Error(`${label} contains external scripts/styles or inline event handlers; keep artifacts self-contained.`)
  }
  return text
}

function rejectSvgScripts(svg) {
  const text = String(svg || '')
  if (!/^\s*<svg[\s>]/i.test(text)) throw new Error('svg must start with an <svg> element')
  if (/<script\b|javascript:|on\w+\s*=/i.test(text)) throw new Error('SVG scripts and event handlers are not allowed')
  return text
}

async function execCreateMermaid(args) {
  const title = String(args.title || 'diagram').trim().slice(0, 200) || 'diagram'
  const diagram = String(args.diagram || '').trim()
  if (!diagram) throw new Error('diagram is required')
  if (/<script\b|javascript:/i.test(diagram)) throw new Error('Mermaid source cannot contain scripts')
  return {
    content: JSON.stringify({ ok: true, title, type: 'mermaid', message: `Created Mermaid artifact "${title}".` }),
    artifact: { type: 'mermaid', title, source: diagram, description: args.theme || 'default' },
  }
}

async function execCreateChart(args) {
  const title = String(args.title || 'chart').trim().slice(0, 200) || 'chart'
  const config = args.config && typeof args.config === 'object' ? args.config : null
  if (!config) throw new Error('config is required')
  const source = JSON.stringify(config, null, 2)
  return {
    content: JSON.stringify({ ok: true, title, type: 'chart', message: `Created chart artifact "${title}".` }),
    artifact: { type: 'chart', title, source },
  }
}

async function execCreateSvg(args) {
  const title = String(args.title || 'vector').trim().slice(0, 200) || 'vector'
  const source = rejectSvgScripts(args.svg)
  return {
    content: JSON.stringify({ ok: true, title, type: 'svg', bytes: source.length, message: `Created SVG artifact "${title}".` }),
    artifact: { type: 'svg', title, source },
  }
}

async function execCreateHtmlApp(args) {
  const title = String(args.title || 'html-app').trim().slice(0, 200) || 'html-app'
  const files = args.files && typeof args.files === 'object' ? args.files : {}
  if (!files['index.html']) throw new Error('files must include index.html')
  const safeFiles = {}
  for (const [name, value] of Object.entries(files)) {
    if (!/^[\w./-]+$/.test(name) || name.includes('..')) throw new Error(`unsafe filename: ${name}`)
    safeFiles[name] = rejectDangerousHtml(String(value || ''), name)
  }
  const source = JSON.stringify(safeFiles, null, 2)
  return {
    content: JSON.stringify({ ok: true, title, type: 'html_multi', files: Object.keys(safeFiles), message: `Created multi-file HTML artifact "${title}".` }),
    artifact: { type: 'html_multi', title, source },
  }
}

async function execAgent(args) {
  const tasks = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : [args]
  const settled = await Promise.allSettled(tasks.map((task) => callJson('/api/subagent/run', {
    subagent_type: task.subagent_type,
    prompt: task.prompt,
    description: task.description,
  })))
  const runs = settled.map((result, index) => result.status === 'fulfilled'
    ? {
        ok: true,
        runId: result.value.run?.id || result.value.id || null,
        status: result.value.run?.status || result.value.status || 'completed',
        description: tasks[index].description,
        result: result.value.result_text || result.value.run?.resultText || result.value.result || '',
      }
    : {
        ok: false,
        status: 'failed',
        description: tasks[index].description,
        error: result.reason?.message || String(result.reason),
      })
  return {
    content: JSON.stringify({
      ok: runs.some((run) => run.ok),
      parallel: runs.length > 1,
      runs,
    }),
  }
}

// Feature 8: Todo — 纯前端,返回 todos 字段供 caller dispatch SET_TODOS
async function execManageTodos(args) {
  const todos = Array.isArray(args.todos) ? args.todos : []
  const summary = {
    pending: todos.filter((t) => t.status === 'pending').length,
    in_progress: todos.filter((t) => t.status === 'in_progress').length,
    completed: todos.filter((t) => t.status === 'completed').length,
  }
  const inProgressItem = todos.find((t) => t.status === 'in_progress')
  return {
    content: JSON.stringify({
      ok: true,
      total: todos.length,
      summary,
      currentTask: inProgressItem?.activeForm || null,
      message: `Todo 已更新: ${summary.completed}/${todos.length} 完成${inProgressItem ? `; 当前: ${inProgressItem.activeForm}` : ''}`,
    }),
    todos,
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
  create_chart: execCreateChart,
  create_svg: execCreateSvg,
  create_html_app: execCreateHtmlApp,
  Agent: execAgent,
  list_directory: execListDirectory,
  read_file: execReadFile,
  write_file: execWriteFile,
  edit_file: execEditFile,
  bash_exec: execBashExec,
  git_status: execGitStatus,
  git_diff: execGitDiff,
  run_project_check: execRunProjectCheck,
  manage_todos: execManageTodos,
  multi_edit: execMultiEdit,
  grep_code: execGrepCode,
  find_symbol: execFindSymbol,
  list_imports: execListImports,
  apply_patch: execApplyPatch,
  reflect: execReflect,
  request_clarification: execRequestClarification,
  remember: execRemember,
}

/** 模型可见的内置工具必须同时具备 schema 和真实执行器。 */
export function getBuiltinToolRuntimeStatus() {
  const specNames = Object.keys(TOOL_SPECS)
  const executorNames = Object.keys(EXECUTORS)
  return {
    missingExecutors: specNames.filter((name) => typeof EXECUTORS[name] !== 'function'),
    missingSpecs: executorNames.filter((name) => !TOOL_SPECS[name]),
  }
}

/**
 * multi_edit — 原子化批量 SEARCH/REPLACE。
 *
 * 流程：
 *   1. 读取所有目标文件的内容（读一次）
 *   2. 校验每个 oldText 在文件中唯一存在
 *   3. 全部通过 → 对所有文件做替换并写回
 *   4. 任何一个写入失败 → 回滚已写的文件到原始内容
 */
async function execMultiEdit(args) {
  const { edits } = args
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('multi_edit: edits 不能为空')
  }

  // Phase 1: 读取所有文件 + 校验
  const originalContents = []
  for (const edit of edits) {
    const resp = await fetch('/api/tools/fs/read_file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
      body: JSON.stringify({ path: edit.path }),
    })
    const data = await resp.json()
    if (!data.ok) throw new Error(`multi_edit: 无法读取 ${edit.path} — ${data.error || resp.status}`)

    const content = data.content
    const firstIdx = content.indexOf(edit.oldText)
    const lastIdx = content.lastIndexOf(edit.oldText)

    if (firstIdx === -1) {
      throw new Error(`multi_edit: "${edit.oldText.slice(0, 50)}..." 在 ${edit.path} 中不存在`)
    }
    if (firstIdx !== lastIdx) {
      throw new Error(`multi_edit: "${edit.oldText.slice(0, 50)}..." 在 ${edit.path} 中出现多次，不是唯一`)
    }

    originalContents.push({ path: edit.path, original: content, edit })
  }

  // Phase 2: 全部通过 → 执行写入
  const writtenFiles = []
  try {
    for (const item of originalContents) {
      const newContent = item.original.replace(item.edit.oldText, item.edit.newText)
      const resp = await fetch('/api/tools/fs/write_file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
        body: JSON.stringify({ path: item.path, content: newContent }),
      })
      const data = await resp.json()
      if (!data.ok) throw new Error(`写入 ${item.path} 失败: ${data.error || resp.status}`)
      writtenFiles.push(item)
    }
    return { ok: true, edited: edits.length, files: edits.map((e) => e.path) }
  } catch (err) {
    // Phase 3: 回滚已写的文件
    for (const item of writtenFiles) {
      try {
        await fetch('/api/tools/fs/write_file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
          body: JSON.stringify({ path: item.path, content: item.original }),
        })
      } catch { /* 回滚失败静默 */ }
    }
    throw new Error(`multi_edit 失败，已回滚 ${writtenFiles.length} 个文件: ${err.message}`, { cause: err })
  }
}

export async function executeToolCall(call, options = {}) {  const { maxRetries = 2, retryDelayMs = 600 } = options
  const name = call?.name
  if (FILE_ARTIFACT_TOOL_NAMES.has(name)) {
    const granted = options.allowedArtifactTools instanceof Set
      ? options.allowedArtifactTools
      : new Set(options.allowedArtifactTools || [])
    if (!granted.has(name)) {
      return {
        ok: false,
        content: JSON.stringify({
          code: 'artifact_tool_not_requested',
          error: String(translateKey('toolRuntime.artifactNotRequested', options.lang || 'zh')).replace('{name}', name),
          retryable: false,
        }),
        attempts: 0,
      }
    }
  }
  let parsedArgs = {}
  if (call?.arguments) {
    try {
      parsedArgs = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
      if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
        throw new Error('参数 JSON 的顶层必须是对象')
      }
    } catch (err) {
      return {
        ok: false,
        content: JSON.stringify({
          code: 'invalid_tool_arguments',
          error: `工具参数不是有效 JSON：${err?.message || String(err)}`,
          retryable: true,
          hint: '请修正 JSON 后重新调用，不要重复发送相同参数。',
        }),
        attempts: 0,
      }
    }
  }

  // Feature 1: MCP 工具 (mcp__server__tool) — 没在本地 EXECUTORS 注册,统一走后端
  if (name && name.startsWith('mcp__')) {
    try {
      const data = await callJson('/api/tools/mcp/call', { fullToolName: name, arguments: parsedArgs })
      // MCP tools/call 返回 { content: [{type, text/...}], isError? }
      const result = data?.result || data
      const isError = !!result?.isError
      const textParts = Array.isArray(result?.content)
        ? result.content
            .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
            .map((c) => c.text || '')
            .join('\n')
        : JSON.stringify(result)
      return {
        ok: !isError,
        content: textParts || JSON.stringify(result),
        attempts: 1,
      }
    } catch (err) {
      return { ok: false, content: JSON.stringify({ error: err.message || String(err) }) }
    }
  }

  if (name && name.startsWith('browser_')) {
    const routes = {
      browser_open_url: '/api/browser/open',
      browser_state: '/api/browser/state',
      browser_snapshot: '/api/browser/snapshot',
      browser_console: '/api/browser/console',
      browser_click: '/api/browser/click',
      browser_type: '/api/browser/type',
      browser_wait: '/api/browser/wait',
      browser_screenshot: '/api/browser/screenshot',
    }
    const route = routes[name]
    if (!route) return { ok: false, content: JSON.stringify({ error: `未知 Browser 工具: ${name}` }) }
    try {
      const data = await callJson(route, parsedArgs)
      const result = data?.result ?? data
      const compact = name === 'browser_screenshot' && result?.data
        ? { ...result, data: undefined, captured: true }
        : result
      return { ok: true, content: JSON.stringify(compact), attempts: 1 }
    } catch (err) {
      return { ok: false, content: JSON.stringify({ error: err.message || String(err) }), attempts: 1 }
    }
  }

  if (name && (name.startsWith('connected_app_') || name.startsWith('notion_') || name.startsWith('github_'))) {
    const routes = {
      connected_app_list: '/api/connectors/apps',
      connected_app_open: '/api/connectors/apps/open',
      notion_search: '/api/connectors/notion/search',
      notion_fetch_page: '/api/connectors/notion/page',
      github_search_repositories: '/api/connectors/github/search-repositories',
      github_get_file: '/api/connectors/github/file',
    }
    const route = routes[name]
    if (!route) return { ok: false, content: JSON.stringify({ error: `Unknown connector tool: ${name}` }) }
    try {
      const data = name === 'connected_app_list'
        ? await callJson(route, undefined, { method: 'GET' })
        : await callJson(route, parsedArgs)
      return { ok: true, content: JSON.stringify(data?.result ?? data?.apps ?? data), attempts: 1 }
    } catch (err) {
      return { ok: false, content: JSON.stringify({ error: err.message || String(err) }), attempts: 1 }
    }
  }

  const fn = EXECUTORS[name]
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
  let usedAttempts = 0
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    usedAttempts = attempt + 1
    try {
      const output = await fn(parsedArgs)
      const ok = output && typeof output === 'object' && typeof output.ok === 'boolean' ? output.ok : true
      const content = typeof output === 'string' ? output : output.content
      const artifact = typeof output === 'string' ? null : (output.artifact || null)
      // Feature 8: manage_todos 返回的 todos 字段直传 caller,用于 dispatch SET_TODOS
      const todos = typeof output === 'string' ? null : (output.todos || null)
      return { ok, content, artifact, todos, attempts: attempt + 1 }
    } catch (err) {
      lastErr = err
      if (err?.code === 'PATH_NOT_AUTHORIZED') {
        const decision = await askDirectoryApproval({
          name,
          args: parsedArgs,
          path: err.path || parsedArgs?.path || null,
          suggestGrantPath: err.suggestGrantPath || err.path || parsedArgs?.path || null,
          requiredAccessMode: err.requiredAccessMode
            || (['write_file', 'edit_file', 'apply_patch'].includes(name) ? 'read_write' : 'read_only'),
        })
        if (!decision.approved) {
          const denied = new Error(decision.reason || 'The user denied directory authorization.')
          denied.code = 'PATH_AUTHORIZATION_REJECTED'
          denied.status = 403
          denied.retryable = false
          denied.path = err.path
          lastErr = denied
          break
        }

        // The grant UI resolves only after persistence. Retry this exact
        // operation once; a second failure is final and must not reopen the
        // authorization prompt or enter the generic retry loop.
        usedAttempts += 1
        try {
          const output = await fn(parsedArgs)
          const ok = output && typeof output === 'object' && typeof output.ok === 'boolean' ? output.ok : true
          const content = typeof output === 'string' ? output : output.content
          const artifact = typeof output === 'string' ? null : (output.artifact || null)
          const todos = typeof output === 'string' ? null : (output.todos || null)
          return { ok, content, artifact, todos, attempts: usedAttempts }
        } catch (retryError) {
          lastErr = retryError
          break
        }
      }
      const msg = err?.message || String(err)
      // 不可重试:参数校验类错误 / 沙箱策略拒绝
      let nonRetriable = /参数|不能为空|invalid|required|沙箱/i.test(msg)
      // ★ 404(路由不存在)/ 403(权限不足)/ 401 重试毫无意义 —— 这些是
      // 确定性失败,退避再打三次只是把一次失败变成三次失败 + 两次等待。
      // 实测日志里 grep_code 因为后端漏注册路由,每次调用都白等两轮退避,
      // 模型连试 6 次共 18 个请求全 404,预算和时间都烧在了原地打转上。
      if (err?.status === 404 || err?.status === 403 || err?.status === 401) {
        nonRetriable = true
      }
      if (nonRetriable || attempt === maxRetries) break
      // 指数退避:600ms → 1200ms
      await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)))
    }
  }
  return {
    ok: false,
    content: JSON.stringify({
      ...(lastErr?.code ? { code: lastErr.code } : {}),
      error: lastErr?.message || String(lastErr),
      // 真实尝试次数 —— 确定性失败会提前 break,不该谎报成 maxRetries + 1
      attempts: usedAttempts,
      // 确定性失败要明确告诉模型别再试同一个工具
      ...(lastErr?.retryable === false || lastErr?.status === 404 || lastErr?.status === 403 || lastErr?.status === 401
        ? { retryable: false, hint: lastErr?.hint || '这是确定性失败，重试或换参数都没用，请改用其他工具。' }
        : {}),
      ...(lastErr?.path ? { path: lastErr.path } : {}),
    }),
  }
}
