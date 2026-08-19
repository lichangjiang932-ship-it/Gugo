import { MEMORY_TOOL_SPECS } from './memoryTools.js'
import { normalizeToolRiskMetadata } from '../utils/toolRiskMetadata.js'
import { isReadOnlyShellCommand } from '../utils/bashGuard.js'
import { authenticateRequest } from '../middleware.js'
import { BUILTIN_ARTIFACT_TOOL_SPECS } from '../services/builtinArtifactToolSpecs.js'
import { IMAGE_TOOL_SPECS } from '../adapters/imageTools.js'
import { MEDIA_TOOL_SPECS } from '../adapters/mediaTools.js'
import { PDF_TOOL_SPECS } from '../adapters/pdfTools.js'
import { BATCH_FILE_TOOL_SPECS } from '../adapters/batchFileTools.js'
import { FS_SHELL_TOOL_SPECS } from '../adapters/fsShellTools.js'
import { GIT_TOOL_SPECS } from '../adapters/gitWorkbench.js'
import { CODING_AGENT_TOOL_SPECS } from '../adapters/codingAgentTools.js'
import { CODE_SEARCH_TOOL_SPECS } from './codeSearch.js'
import { APPLY_PATCH_TOOL_SPECS } from './applyPatch.js'
import { AGENTIC_TOOL_SPECS } from './agenticTools.js'
import { randomUUID } from 'node:crypto'

function specsByName(specs) {
  return Object.fromEntries((Array.isArray(specs) ? specs : [])
    .map((spec) => [String(spec?.function?.name || '').trim(), spec])
    .filter(([name]) => Boolean(name)))
}
/**
 * 服务端工具 Schema 目录与动态注册表。
 *
 * JSON Schema 只在服务端定义。/api/tools/specs、TurnEngine 和执行前
 * validateToolCall 都消费这里保存的同一组 spec 对象。支持动态注册：
 *   - builtin  : 项目自带的固定工具（web_search、fetch_url、read_file、...）
 *   - mcp      : MCP server 发现的工具（feature 1）
 *   - skill    : 技能包附带的工具
 *   - subagent : 子代理白名单衍生（feature 2）
 *
 * 用法：
 *   GET /api/tools/specs?mode=chat|plan|code|subagent:<type>
 *     → { ok, specs: [{ origin, source?, tool: { type:'function', function:{...} } }] }
 *
 * 前端只消费 /api/tools/specs，不再维护 parameters 或 zod 镜像；所有
 * 工具（包括 MCP/skill/browser）都在服务端执行边界统一校验。
 */

export const BUILTIN_TOOL_SCHEMA_CATALOG = {
  list_directory: {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and folders inside the workspace or a user-authorized local directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: ['path'],
      },
    },
  },
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
      description: 'Run a shell command inside the configured workspace or a user-authorized local directory. In Windows commands, always wrap every absolute path in double quotes, even when it contains no spaces. When it creates or changes files, list every intended path in expected_outputs so the runtime can verify them.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute working directory.' },
          timeout_ms: { type: 'integer' },
          expected_outputs: { type: 'array', items: { type: 'string' }, description: 'Files this command is expected to create or modify; omit for read-only commands.' },
        },
        required: ['command'],
      },
    },
  },
  git_status: {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Read git branch and changed files for the workspace or a user-authorized repository.',
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
      description: 'Read unified git diff for the workspace or a user-authorized repository.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute repository path.' },
        },
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
        properties: {
          check: { type: 'string', enum: ['lint', 'test', 'build'] },
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
  Agent: {
    type: 'function',
    function: {
      name: 'Agent',
      description: 'Delegate focused work to isolated sub-agents. Pass one task, or up to 3 independent tasks to run them in parallel. Returns final summaries only.',
      parameters: {
        type: 'object',
        properties: {
          subagent_type: { type: 'string', enum: ['explore', 'plan', 'general'] },
          prompt: { type: 'string' },
          description: { type: 'string' },
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
              required: ['subagent_type', 'prompt'],
            },
          },
        },
        anyOf: [
          { required: ['subagent_type', 'prompt'] },
          { required: ['tasks'] },
        ],
      },
    },
  },

  // ★ 长期记忆写入。记忆注入一直是通的,但以前没人写 —— 只有 Memory 管理页
  // 能手动加,于是模型在同一个上下文里也像没有记忆。
  remember: MEMORY_TOOL_SPECS[0],

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
  set_deliverables: {
    type: 'function',
    function: {
      name: 'set_deliverables',
      description: 'Select the persisted artifacts that are the final files delivered by this turn. Pass exact artifact IDs returned by earlier tool results. Each call replaces the previous selection; pass an empty array when the turn intentionally delivers no files.',
      parameters: {
        type: 'object',
        properties: {
          artifact_ids: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            maxItems: 256,
            uniqueItems: true,
          },
        },
        required: ['artifact_ids'],
        additionalProperties: false,
      },
    },
  },
  rewind_files: {
    type: 'function',
    function: {
      name: 'rewind_files',
      description: 'Revert file changes recorded by this turn. Without tool_call_id it restores every file this turn touched back to its state before the turn. With tool_call_id it restores that tool call and every later mutation. Use when the user says the last edits were wrong, or when you detect you modified the wrong file.',
      parameters: {
        type: 'object',
        properties: {
          tool_call_id: {
            type: 'string',
            description: 'Optional. Revert from this tool call onward. Omit to revert the whole turn.',
          },
        },
      },
    },
  },
  bash_background: {
    type: 'function',
    function: {
      name: 'bash_background',
      description: 'Start a detached background process and return its processId and log path. Output is written to the log file, never returned inline. Use for long-running local servers, scrapers, watchers, or builds that would exceed the synchronous bash_exec timeout. Poll with process_list and read the log to check progress.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run in the background.' },
          cwd: { type: 'string', description: 'Optional authorized working directory.' },
        },
        required: ['command'],
      },
    },
  },
  process_list: {
    type: 'function',
    function: {
      name: 'process_list',
      description: 'List background processes started by this user, with their id, status, and log path.',
      parameters: { type: 'object', properties: {} },
    },
  },
  process_kill: {
    type: 'function',
    function: {
      name: 'process_kill',
      description: 'Terminate a background process previously started by bash_background. Returns the updated process record.',
      parameters: {
        type: 'object',
        properties: { process_id: { type: 'string', description: 'The background process id returned by bash_background or process_list.' } },
        required: ['process_id'],
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
  // Override the historical frontend-compatible artifact schemas above with
  // the exact contracts executed by TurnEngine. This is the server source of
  // truth consumed by both /api/tools/specs and SERVER_TOOL_SPECS.
  ...BUILTIN_ARTIFACT_TOOL_SPECS,
  // Media/PDF/image adapters own their schemas. The registry and TurnEngine
  // consume those same objects so adding a capability does not create another
  // hand-maintained model-facing contract.
  ...specsByName(IMAGE_TOOL_SPECS),
  ...specsByName(MEDIA_TOOL_SPECS),
  ...specsByName(PDF_TOOL_SPECS),
  ...specsByName(BATCH_FILE_TOOL_SPECS),
  ...specsByName(FS_SHELL_TOOL_SPECS),
  ...specsByName(GIT_TOOL_SPECS),
  ...specsByName(CODING_AGENT_TOOL_SPECS),
  ...specsByName(CODE_SEARCH_TOOL_SPECS),
  ...specsByName(APPLY_PATCH_TOOL_SPECS),
  ...specsByName(AGENTIC_TOOL_SPECS),
  ...specsByName(MEMORY_TOOL_SPECS),
}

const RISK_LEVEL_BY_CATEGORY = Object.freeze({
  read: 'low',
  write_local: 'medium',
  exec: 'high',
  external: 'high',
})

function builtinMetadata(category, isConcurrencySafe, overrides = {}) {
  const requiredApproval = overrides.requiredApproval ?? category !== 'read'
  return Object.freeze({
    riskLevel: RISK_LEVEL_BY_CATEGORY[category],
    requiredApproval,
    requiresApproval: requiredApproval,
    category,
    isConcurrencySafe,
    isDestructive: category !== 'read',
    ...overrides,
  })
}

// Explicit source of truth for every built-in tool. The legacy name sets below
// remain only as a compatibility fallback for old/plugin-provided specs.
const BUILTIN_TOOL_METADATA = Object.freeze({
  list_directory: builtinMetadata('read', true),
  web_search: builtinMetadata('read', true),
  fetch_url: builtinMetadata('read', true),
  read_file: builtinMetadata('read', true),
  write_file: builtinMetadata('write_local', false),
  edit_file: builtinMetadata('write_local', false),
  bash_exec: builtinMetadata('exec', false),
  git_status: builtinMetadata('read', true),
  git_diff: builtinMetadata('read', true),
  run_project_check: builtinMetadata('exec', false),
  create_pptx: builtinMetadata('external', false),
  create_docx: builtinMetadata('external', false),
  create_xlsx: builtinMetadata('external', false),
  Agent: builtinMetadata('read', false),
  remember: builtinMetadata('external', false),
  manage_todos: builtinMetadata('external', false),
  set_deliverables: builtinMetadata('write_local', false, {
    requiredApproval: false,
    requiresApproval: false,
    isIdempotent: true,
    interruptBehavior: 'block',
    isDestructive: false,
  }),
  rewind_files: builtinMetadata('write_local', false),
  bash_background: builtinMetadata('exec', false),
  process_list: builtinMetadata('read', true),
  process_kill: builtinMetadata('exec', false),
  grep_code: builtinMetadata('read', true),
  find_symbol: builtinMetadata('read', true),
  list_imports: builtinMetadata('read', true),
  apply_patch: builtinMetadata('write_local', false),
  reflect: builtinMetadata('read', false),
  request_clarification: builtinMetadata('read', false),
  read_artifact_source: builtinMetadata('read', true),
  generate_image: builtinMetadata('external', false),
  create_pdf: builtinMetadata('external', false),
  create_html_app: builtinMetadata('external', false),
  image_info: builtinMetadata('read', true),
  image_transform: builtinMetadata('write_local', false),
  media_probe: builtinMetadata('read', true),
  media_transform: builtinMetadata('exec', false),
  pdf_info: builtinMetadata('read', true),
  pdf_text: builtinMetadata('read', true),
  render_pdf_pages: builtinMetadata('external', false),
  pdf_transform: builtinMetadata('write_local', false),
  archive_create: builtinMetadata('write_local', false),
  archive_list: builtinMetadata('read', true),
  archive_extract: builtinMetadata('write_local', false),
  batch_rename: builtinMetadata('write_local', false),
  file_hash_manifest: builtinMetadata('read', true),
  git_write: builtinMetadata('external', false),
  git_commit: builtinMetadata('external', false),
  git_push: builtinMetadata('external', false),
  git_rollback: builtinMetadata('external', false),
  run_command: builtinMetadata('exec', false),
  patch_file: builtinMetadata('write_local', false),
  run_test: builtinMetadata('exec', false),
  docker_exec: builtinMetadata('exec', false),
  file_download: builtinMetadata('write_local', false),
  request_directory: builtinMetadata('external', false),
  sleep_until: builtinMetadata('external', false),
})

const missingMetadata = Object.keys(BUILTIN_TOOL_SCHEMA_CATALOG).filter((name) => !BUILTIN_TOOL_METADATA[name])
const unknownMetadata = Object.keys(BUILTIN_TOOL_METADATA).filter((name) => !BUILTIN_TOOL_SCHEMA_CATALOG[name])
if (missingMetadata.length || unknownMetadata.length) {
  throw new Error(`Built-in tool metadata mismatch (missing: ${missingMetadata.join(', ') || 'none'}; unknown: ${unknownMetadata.join(', ') || 'none'})`)
}
for (const [name, spec] of Object.entries(BUILTIN_TOOL_SCHEMA_CATALOG)) {
  // Keep the model-facing tool JSON protocol-clean while attaching the
  // declaration to the canonical in-process spec object.
  Object.defineProperty(spec, 'metadata', {
    value: BUILTIN_TOOL_METADATA[name],
    enumerable: false,
    configurable: false,
    writable: false,
  })
}

const READ_ONLY_MODE_TOOLS = new Set([
  'read_artifact_source',
  'list_directory',
  'web_search',
  'fetch_url',
  'read_file',
  'grep_code',
  'find_symbol',
  'list_imports',
  'git_status',
  'git_diff',
  'image_info',
  'media_probe',
  'pdf_info',
  'pdf_text',
  'archive_list',
  'file_hash_manifest',
  'process_list',
  'reflect',
  'request_clarification',
  'Agent',
])
const BUILTIN_CONCURRENCY_SAFE_TOOLS = new Set([
  'read_artifact_source',
  'web_search',
  'fetch_url',
  'list_directory',
  'read_file',
  'grep_code',
  'find_symbol',
  'list_imports',
  'git_status',
  'git_diff',
  'image_info',
  'media_probe',
  'pdf_info',
  'pdf_text',
  'archive_list',
  'file_hash_manifest',
  'process_list',
  'connected_app_list',
])
const BUILTIN_WRITE_LOCAL_TOOLS = new Set([
  'write_file',
  'edit_file',
  'patch_file',
  'apply_patch',
  'multi_edit',
  'image_transform',
  'pdf_transform',
  'archive_create',
  'archive_extract',
  'batch_rename',
  'file_download',
  'rewind_files',
  'set_deliverables',
])
const BUILTIN_EXEC_TOOLS = new Set([
  'bash_exec',
  'run_command',
  'run_project_check',
  'media_transform',
  'run_test',
  'docker_exec',
  'bash_background',
  'process_kill',
])
const CODE_MODE_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'apply_patch',
  'patch_file',
  'grep_code',
  'find_symbol',
  'list_imports',
  'bash_exec',
  'run_command',
  'git_status',
  'git_diff',
  'run_project_check',
  'run_test',
  'docker_exec',
  'file_download',
  'git_write',
  'set_deliverables',
  'reflect',
  'request_clarification',
  'Agent',
]

// 动态注册的工具表：name → { origin, source, spec, exec? }
// origin: 'mcp' | 'skill' | 'subagent'
const globalDynamicTools = new Map()
const userDynamicTools = new Map()
const DYNAMIC_REGISTRATION_STATE = Symbol('gugo.dynamicToolRegistrationState')
const dynamicToolSpecRegistrationIds = new WeakMap()

function newDynamicRegistrationId() {
  return `dynamic-tool:${randomUUID()}`
}

function bindToolSpecRegistration(spec, registrationId) {
  if (spec && typeof spec === 'object' && registrationId) {
    dynamicToolSpecRegistrationIds.set(spec, registrationId)
  }
  return spec
}

/**
 * Preserve the host-only registration identity when a schema is cloned for
 * canonical ordering. The identity lives in a WeakMap, so it is never sent to
 * a model/provider as an unsupported schema field.
 */
export function inheritDynamicToolSpecRegistration(target, source) {
  return bindToolSpecRegistration(target, dynamicToolSpecRegistrationIds.get(source) || null)
}

export function getDynamicToolSpecRegistrationId(spec) {
  return spec && typeof spec === 'object'
    ? dynamicToolSpecRegistrationIds.get(spec) || null
    : null
}

export function snapshotDynamicToolSpecRegistrations(specs = []) {
  const snapshot = Object.create(null)
  for (const spec of Array.isArray(specs) ? specs : []) {
    const name = String(spec?.function?.name || '').trim()
    const registrationId = getDynamicToolSpecRegistrationId(spec)
    if (name && registrationId) snapshot[name] = registrationId
  }
  return snapshot
}

/**
 * Remove dynamic schemas whose registration was revoked or replaced after an
 * active loop was created. Static and legacy unbound schemas are left intact;
 * execution still rejects an unbound runtime-plugin call at the gate.
 */
export function filterCurrentDynamicToolSpecs(specs = [], { userId = null } = {}) {
  return (Array.isArray(specs) ? specs : []).filter((spec) => {
    const registrationId = getDynamicToolSpecRegistrationId(spec)
    if (!registrationId) return true
    const name = String(spec?.function?.name || '').trim()
    return Boolean(name) && matchesDynamicToolRegistration(name, registrationId, { userId })
  })
}

function registrationState(registration) {
  return registration?.[DYNAMIC_REGISTRATION_STATE] || null
}

function nearestActiveRegistration(registration) {
  let current = registration
  while (current) {
    const state = registrationState(current)
    if (!state || state.active) return current
    current = state.previous
  }
  return null
}

function deactivateRegistration(registration) {
  const state = registrationState(registration)
  if (state) state.active = false
}

function normalizeUserScope(userId) {
  const normalized = String(userId || '').trim()
  return normalized || null
}

function getDynamicToolMap(userId, { create = false } = {}) {
  const scope = normalizeUserScope(userId)
  if (!scope) return globalDynamicTools
  let scoped = userDynamicTools.get(scope)
  if (!scoped && create) {
    scoped = new Map()
    userDynamicTools.set(scope, scoped)
  }
  return scoped || null
}

export function registerDynamicTool({ name, origin, source = null, spec, exec = null, metadata = null, userId = null }) {
  if (!name || !spec) throw new Error('registerDynamicTool 缺少 name/spec')
  const map = getDynamicToolMap(userId, { create: true })
  const previous = map.get(name)
  const registrationId = newDynamicRegistrationId()
  // Give every registration its own outer schema identity. A caller may reuse
  // the same schema object for a later shadow registration; sharing that object
  // would otherwise rewrite the identity of the registration being restored.
  const registeredSpec = bindToolSpecRegistration({
    ...spec,
    ...(spec?.function && typeof spec.function === 'object'
      ? { function: { ...spec.function } }
      : {}),
  }, registrationId)
  const registration = {
    registrationId,
    origin,
    source,
    spec: registeredSpec,
    exec,
    metadata: normalizeToolRiskMetadata(metadata, { origin }),
  }
  Object.defineProperty(registration, DYNAMIC_REGISTRATION_STATE, {
    value: { active: true, previous },
  })
  map.set(name, registration)

  // Dynamic registration is a reversible side effect. The identity check is
  // important when a newer registration replaces this one: disposing the old
  // owner must not remove the newer tool. If this call shadowed an existing
  // registration, unloading restores it exactly.
  let disposed = false
  return () => {
    if (disposed) return false
    disposed = true
    deactivateRegistration(registration)
    if (map.get(name) !== registration) return false
    const restore = nearestActiveRegistration(previous)
    if (restore) map.set(name, restore)
    else map.delete(name)
    const scope = normalizeUserScope(userId)
    if (scope && map.size === 0) userDynamicTools.delete(scope)
    return true
  }
}

export function unregisterDynamicTool(name, { userId = null } = {}) {
  const map = getDynamicToolMap(userId)
  if (!map) return false
  deactivateRegistration(map.get(name))
  const removed = map.delete(name)
  const scope = normalizeUserScope(userId)
  if (scope && map.size === 0) userDynamicTools.delete(scope)
  return removed
}

export function unregisterByOrigin(origin, sourceMatch = null, { userId = null } = {}) {
  const map = getDynamicToolMap(userId)
  if (!map) return 0
  const toRemove = []
  for (const [name, info] of map) {
    if (info.origin !== origin) continue
    if (sourceMatch && info.source !== sourceMatch) continue
    toRemove.push(name)
  }
  toRemove.forEach((n) => {
    deactivateRegistration(map.get(n))
    map.delete(n)
  })
  const scope = normalizeUserScope(userId)
  if (scope && map.size === 0) userDynamicTools.delete(scope)
  return toRemove.length
}

export function unregisterUserDynamicTools(userId) {
  const scope = normalizeUserScope(userId)
  if (!scope) return 0
  const map = userDynamicTools.get(scope)
  if (!map) return 0
  const removed = map.size
  userDynamicTools.delete(scope)
  return removed
}

export function getBuiltinSpec(name) {
  return BUILTIN_TOOL_SCHEMA_CATALOG[name] || null
}

export function getDynamicTool(name, { userId = null } = {}) {
  const scoped = getDynamicToolMap(userId)
  return scoped?.get(name) || globalDynamicTools.get(name) || null
}

export function getDynamicToolRegistrationId(name, { userId = null } = {}) {
  return getDynamicTool(name, { userId })?.registrationId || null
}

export function matchesDynamicToolRegistration(name, expectedRegistrationId, { userId = null } = {}) {
  const expected = String(expectedRegistrationId || '').trim()
  if (!expected) return false
  return getDynamicToolRegistrationId(name, { userId }) === expected
}

export function getToolMetadata(name, { args = {}, userId = null } = {}) {
  const dynamic = getDynamicTool(name, { userId })
  if (dynamic?.metadata) return dynamic.metadata
  const builtin = getBuiltinSpec(name)
  if (!builtin) return normalizeToolRiskMetadata(null, { origin: 'unknown', source: 'fallback' })

  if (builtin.metadata) {
    // bash_exec retains its exact argv classifier. Other command runners stay
    // exec/high until their own wire formats have dedicated safety parsers.
    if (name === 'bash_exec' && isReadOnlyShellCommand(args?.command)) {
      return normalizeToolRiskMetadata({
        ...builtin.metadata,
        riskLevel: 'low',
        category: 'read',
        requiredApproval: false,
        requiresApproval: false,
        isReadOnly: true,
        isConcurrencySafe: true,
        isIdempotent: true,
        interruptBehavior: 'cancel',
        isDestructive: false,
      }, { origin: 'builtin', source: 'declared' })
    }
    return normalizeToolRiskMetadata(builtin.metadata, { origin: 'builtin', source: 'declared' })
  }

  // Compatibility fallback for legacy specs that predate declarations.
  // Only bash_exec is covered by bashGuard's exact argv classifier. Other
  // command runners may use a different shell/wire format and must remain
  // approval-required until they have a dedicated parser.
  const isReadOnly = name === 'bash_exec'
    ? isReadOnlyShellCommand(args?.command)
    : READ_ONLY_MODE_TOOLS.has(name)
  const riskClass = isReadOnly
    ? 'read'
    : (BUILTIN_WRITE_LOCAL_TOOLS.has(name) ? 'write_local'
        : BUILTIN_EXEC_TOOLS.has(name) ? 'exec' : 'external')
  return normalizeToolRiskMetadata({
    riskClass,
    isReadOnly,
    isConcurrencySafe: (name === 'bash_exec' && isReadOnly)
      || BUILTIN_CONCURRENCY_SAFE_TOOLS.has(name),
    interruptBehavior: isReadOnly ? 'cancel' : 'block',
    isDestructive: !isReadOnly,
  }, { origin: 'builtin', source: 'fallback' })
}

export function listAllSpecs({ userId = null } = {}) {
  const out = []
  for (const [name, spec] of Object.entries(BUILTIN_TOOL_SCHEMA_CATALOG)) {
    out.push({ origin: 'builtin', source: null, name, tool: spec, metadata: getToolMetadata(name) })
  }
  const visibleDynamic = new Map(globalDynamicTools)
  const scoped = getDynamicToolMap(userId)
  if (scoped && scoped !== globalDynamicTools) {
    for (const [name, info] of scoped) visibleDynamic.set(name, info)
  }
  for (const [name, info] of visibleDynamic) {
    out.push({ origin: info.origin, source: info.source, name, tool: info.spec, metadata: info.metadata })
  }
  // ★ 缓存: 按 name 稳定排序后再返回。dynamicTools 是 Map,按插入序迭代 ——
  // MCP / 连接器的注册顺序随进程重启和连接时序变化,工具列表一抖,
  // 序列化后的字节前缀就变,上游前缀缓存直接失效。
  // builtin 在前、dynamic 在后,组内按 name 排,保证同一份工具集永远同一个字节序列。
  out.sort((a, b) => {
    if (a.origin === 'builtin' && b.origin !== 'builtin') return -1
    if (a.origin !== 'builtin' && b.origin === 'builtin') return 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  return out
}

/**
 * 按 mode 过滤可用工具：
 *   - chat / undefined  → 所有 builtin + dynamic（前端再按 toolsConfig 勾选过滤）
 *   - plan              → 保持完整目录可见；执行边界由 approval gate 强制
 *   - code              → builtin 中的 CODE_MODE_TOOLS + 所有 dynamic
 *   - subagent:<type>   → 由 subagentRegistry 给出白名单（这里只看 builtin 列表）
 */
export function resolveSpecsForMode(mode = 'chat', { subagentWhitelist = null, userId = null } = {}) {
  const all = listAllSpecs({ userId })
  if (mode === 'plan') return all
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
  return Object.keys(BUILTIN_TOOL_SCHEMA_CATALOG)
}

/** Canonical model-facing specs for every statically executable server tool. */
export function listBuiltinSpecs() {
  return Object.values(BUILTIN_TOOL_SCHEMA_CATALOG)
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
    const userId = authenticateRequest(req)
    const specs = resolveSpecsForMode(mode, { userId })
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, mode, specs }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }))
  }
}
