/**
 * 服务端工具注册表（底座 A）
 *
 * 把前端 src/lib/tools/index.js 的 TOOL_SPECS 镜像一份到服务端，并支持
 * 动态注册四种 origin 的工具：
 *   - builtin  : 项目自带的固定工具（web_search、fetch_url、read_file、...）
 *   - mcp      : MCP server 发现的工具（feature 1）
 *   - skill    : 技能包附带的工具
 *   - subagent : 子代理白名单衍生（feature 2）
 *
 * 用法：
 *   GET /api/tools/specs?mode=chat|plan|code|subagent:<type>
 *     → { ok, specs: [{ origin, source?, tool: { type:'function', function:{...} } }] }
 *
 * 前端 buildToolSpecs() 现在改为先调一次本接口拿到「当前会话能用的工具」，
 * 然后本地保留 TOOL_ARG_SCHEMAS（zod）做参数校验。MCP/skill 来源的工具
 * 没有本地 schema → 由服务端在执行端口再做一次校验。
 */

const BUILTIN_SPECS = {
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '使用搜索引擎查询互联网最新信息。返回 title、url、snippet 列表。当用户问到时事、最新发布、需要外部资料时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          max_results: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      },
    },
  },
  fetch_url: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '抓取指定 URL 的页面正文，返回 markdown 形式的主要内容。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '完整的 http/https URL' } },
        required: ['url'],
      },
    },
  },
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 file inside the configured workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
        },
        required: ['path'],
      },
    },
  },
  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 file inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  edit_file: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Precise string replacement inside a workspace file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  bash_exec: {
    type: 'function',
    function: {
      name: 'bash_exec',
      description: 'Run a shell command inside the configured workspace.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          timeout_ms: { type: 'integer' },
        },
        required: ['command'],
      },
    },
  },
  git_status: {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Read git branch and changed files for the workspace.',
      parameters: { type: 'object', properties: {} },
    },
  },
  git_diff: {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Read unified git diff for the workspace or a single file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  },
  run_project_check: {
    type: 'function',
    function: {
      name: 'run_project_check',
      description: 'Run exactly one allowed project check: lint, test, or build.',
      parameters: {
        type: 'object',
        properties: { check: { type: 'string', enum: ['lint', 'test', 'build'] } },
        required: ['check'],
      },
    },
  },
  create_pptx: {
    type: 'function',
    function: {
      name: 'create_pptx',
      description: '生成可下载的 PowerPoint 演示文稿(.pptx)。必须产出分页面、结论式标题和精炼内容，避免普通大纲或说明尾巴。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          markdown: { type: 'string' },
        },
        required: ['title', 'markdown'],
      },
    },
  },
  create_docx: {
    type: 'function',
    function: {
      name: 'create_docx',
      description: '生成可下载的 Word 文档(.docx)。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          markdown: { type: 'string' },
        },
        required: ['title', 'markdown'],
      },
    },
  },
  create_xlsx: {
    type: 'function',
    function: {
      name: 'create_xlsx',
      description: '生成可下载的 Excel 表格(.xlsx)。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          rows: { type: 'array', items: { type: 'array' } },
          markdown: { type: 'string' },
        },
        required: ['title'],
      },
    },
  },
  create_react_component: {
    type: 'function',
    function: {
      name: 'create_react_component',
      description: '生成一个可在右侧实时渲染的 React 单文件组件。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          code: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['title', 'code'],
      },
    },
  },
  create_mermaid: {
    type: 'function',
    function: {
      name: 'create_mermaid',
      description: 'Create a Mermaid diagram artifact for flows, architecture graphs, sequences, and system maps.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          diagram: { type: 'string' },
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
      description: 'Create a Chart.js artifact from a JSON chart configuration.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, config: { type: 'object' } },
        required: ['title', 'config'],
      },
    },
  },
  create_svg: {
    type: 'function',
    function: {
      name: 'create_svg',
      description: 'Create a sanitized SVG artifact for vector previews.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, svg: { type: 'string' } },
        required: ['title', 'svg'],
      },
    },
  },
  create_html_app: {
    type: 'function',
    function: {
      name: 'create_html_app',
      description: 'Create a multi-file HTML artifact collapsed into one previewable file card.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, files: { type: 'object', additionalProperties: { type: 'string' } } },
        required: ['title', 'files'],
      },
    },
  },
  Agent: {
    type: 'function',
    function: {
      name: 'Agent',
      description: 'Delegate a focused sub-task to an isolated sub-agent. Returns a final summary only.',
      parameters: {
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

  manage_todos: {
    type: 'function',
    function: {
      name: 'manage_todos',
      description:
        'Maintain a structured to-do list for the current task. Call repeatedly to update statuses. Exactly one item should be in_progress at a time. Use this for any multi-step task so the user can see plan + progress.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                  description: 'imperative form, e.g. "Add error handling to login flow"',
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                },
                activeForm: {
                  type: 'string',
                  description: 'present-continuous form shown while in_progress',
                },
              },
              required: ['content', 'status', 'activeForm'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  grep_code: {
    type: 'function',
    function: {
      name: 'grep_code',
      description:
        '在 workspace 里全文搜索代码(ripgrep).比 read_file + 正则快一个量级,支持 glob/文件类型过滤 + 上下文行,默认忽略 .git/node_modules/dist.结果是结构化 {file,line,col,text,context_before,context_after}.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: '默认 workspace 根' },
          glob: { type: 'string', description: '例如 "*.tsx"' },
          file_type: { type: 'string', description: 'rg 类型别名,如 "ts"/"py"' },
          case_sensitive: { type: 'boolean' },
          word: { type: 'boolean' },
          max_results: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: ['pattern'],
      },
    },
  },
  find_symbol: {
    type: 'function',
    function: {
      name: 'find_symbol',
      description:
        '定位符号定义位置(function/class/const),支持 JS/TS/Python/Go/Rust/Java.只返回声明行,不返回调用.适合"这个函数定义在哪".',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '符号名(合法标识符)' },
          kind: { type: 'string', enum: ['all', 'function', 'class', 'const'] },
          language: { type: 'string', description: 'rg 类型别名' },
          path: { type: 'string' },
          max_results: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['name'],
      },
    },
  },
  list_imports: {
    type: 'function',
    function: {
      name: 'list_imports',
      description:
        '扫单个文件首 80 行,提取 import/require/use 语句.快速看依赖.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string' },
        },
        required: ['file'],
      },
    },
  },
  apply_patch: {
    type: 'function',
    function: {
      name: 'apply_patch',
      description:
        'Codex 风格多文件原子 patch(Add/Update/Delete).Update 用 unified-diff hunks(@@ 分隔,\' \'上下文,+加行,-删行).比 edit_file 省 token,比 write_file 安全(不覆盖已存在),全部成功才落盘,失败自动回滚.dry_run=true 只预览.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string' },
          dry_run: { type: 'boolean' },
        },
        required: ['patch'],
      },
    },
  },
  reflect: {
    type: 'function',
    function: {
      name: 'reflect',
      description:
        '★ 多步任务中每完成一个关键动作后调一次,简短复盘(只输出反思,无副作用).observation=实际发生的,next_step=下一步(或 "done").',
      parameters: {
        type: 'object',
        properties: {
          observation: { type: 'string' },
          what_worked: { type: 'string' },
          what_didnt: { type: 'string' },
          next_step: { type: 'string' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['observation', 'next_step'],
      },
    },
  },
  request_clarification: {
    type: 'function',
    function: {
      name: 'request_clarification',
      description:
        '★ 遇到歧义/缺信息/需授权/风险决策时,调它问用户而不是编造.调用后当轮工具循环会停下来等用户回复.options 给 2-5 个选项可加速回复.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          why: { type: 'string' },
          blocker_kind: { type: 'string', enum: ['missing_info', 'ambiguous_intent', 'permission', 'risk_decision', 'other'] },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['question'],
      },
    },
  },
}

const READ_ONLY_MODE_TOOLS = new Set([
  'web_search',
  'fetch_url',
  'read_file',
  'grep_code',
  'find_symbol',
  'list_imports',
  'git_status',
  'git_diff',
  'reflect',
  'request_clarification',
  'Agent',
])
const CODE_MODE_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'apply_patch',
  'grep_code',
  'find_symbol',
  'list_imports',
  'bash_exec',
  'git_status',
  'git_diff',
  'run_project_check',
  'reflect',
  'request_clarification',
  'Agent',
]

// 动态注册的工具表：name → { origin, source, spec, exec? }
// origin: 'mcp' | 'skill' | 'subagent'
const dynamicTools = new Map()

export function registerDynamicTool({ name, origin, source = null, spec, exec = null }) {
  if (!name || !spec) throw new Error('registerDynamicTool 缺少 name/spec')
  dynamicTools.set(name, { origin, source, spec, exec })
}

export function unregisterDynamicTool(name) {
  return dynamicTools.delete(name)
}

export function unregisterByOrigin(origin, sourceMatch = null) {
  const toRemove = []
  for (const [name, info] of dynamicTools) {
    if (info.origin !== origin) continue
    if (sourceMatch && info.source !== sourceMatch) continue
    toRemove.push(name)
  }
  toRemove.forEach((n) => dynamicTools.delete(n))
  return toRemove.length
}

export function getBuiltinSpec(name) {
  return BUILTIN_SPECS[name] || null
}

export function getDynamicTool(name) {
  return dynamicTools.get(name) || null
}

export function listAllSpecs() {
  const out = []
  for (const [name, spec] of Object.entries(BUILTIN_SPECS)) {
    out.push({ origin: 'builtin', source: null, name, tool: spec })
  }
  for (const [name, info] of dynamicTools) {
    out.push({ origin: info.origin, source: info.source, name, tool: info.spec })
  }
  return out
}

/**
 * 按 mode 过滤可用工具：
 *   - chat / undefined  → 所有 builtin + dynamic（前端再按 toolsConfig 勾选过滤）
 *   - plan              → 只读 builtin + 标记为 readOnly 的 dynamic
 *   - code              → builtin 中的 CODE_MODE_TOOLS + 所有 dynamic
 *   - subagent:<type>   → 由 subagentRegistry 给出白名单（这里只看 builtin 列表）
 */
export function resolveSpecsForMode(mode = 'chat', { subagentWhitelist = null } = {}) {
  const all = listAllSpecs()
  if (mode === 'plan') {
    return all.filter((s) => {
      if (s.origin === 'builtin') return READ_ONLY_MODE_TOOLS.has(s.name)
      // 动态工具：MCP 类的 readOnly hint 来自 source 注册时；这里默认放过
      return false
    })
  }
  if (mode === 'code') {
    return all.filter((s) => {
      if (s.origin === 'builtin') return CODE_MODE_TOOLS.includes(s.name)
      return true
    })
  }
  if (mode?.startsWith('subagent:') && Array.isArray(subagentWhitelist)) {
    const set = new Set(subagentWhitelist)
    return all.filter((s) => set.has(s.name))
  }
  return all
}

export function listBuiltinNames() {
  return Object.keys(BUILTIN_SPECS)
}

/**
 * GET /api/tools/specs?mode=...
 *
 * 这是公共端点 — 不返回任何用户敏感数据（仅工具描述），所以不强制鉴权，
 * 但仍走 corsMiddleware/rate-limit。MCP 类动态工具列表在用户登录后由
 * mcpManager 注入；未登录用户只会看到 builtin + skill 全局工具。
 */
export function handleToolSpecsRequest(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: '仅支持 GET' }))
    return
  }
  try {
    const url = new URL(req.url, 'http://localhost')
    const mode = url.searchParams.get('mode') || 'chat'
    const specs = resolveSpecsForMode(mode)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, mode, specs }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }))
  }
}
