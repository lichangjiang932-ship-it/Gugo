import { MEMORY_TOOL_SPECS } from './memoryTools.js'
import { BUILTIN_ARTIFACT_TOOL_SPECS } from '../services/builtinArtifactToolSpecs.js'
import { IMAGE_TOOL_SPECS } from '../adapters/imageTools.js'
import { MEDIA_TOOL_SPECS } from '../adapters/mediaTools.js'
import { PDF_TOOL_SPECS } from '../adapters/pdfTools.js'
import { BATCH_FILE_TOOL_SPECS } from '../adapters/batchFileTools.js'
import { FS_SHELL_TOOL_SPECS } from '../adapters/fsShellTools.js'
import { GIT_TOOL_SPECS } from '../adapters/gitWorkbench.js'
import { CODING_AGENT_TOOL_SPECS } from '../adapters/codingAgentTools.js'
import { CODE_SEARCH_TOOL_SPECS } from './codeSearch.js'
import { LSP_TOOL_SPECS } from './lspTool.js'
import { APPLY_PATCH_TOOL_SPECS } from './applyPatch.js'
import { AGENTIC_TOOL_SPECS } from './agenticTools.js'
import { RUN_CODE_TOOL_SPECS } from '../services/runCodeRuntime.js'
import { CODEX_APP_SERVER_TOOL_SPECS, CODEX_MODELS_TOOL_NAME } from '../services/codexAppServerTool.js'
import { SUBAGENT_MAX_PER_BATCH } from '../services/subagentBatchConfig.js'
import { createToolSchemaMetadataCatalog } from './toolSchemaMetadata.js'
import { createToolSchemaResolution } from './toolSchemaResolution.js'
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
          session: { type: 'string', enum: ['new', 'reuse'], default: 'new', description: 'Use reuse to keep cwd, environment variables, and virtual-environment activation across calls for the same user and authorized root.' },
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
      description: `Delegate focused work to isolated sub-agents. Pass one task, or up to ${SUBAGENT_MAX_PER_BATCH} independent tasks to run them in parallel. Returns final summaries only.`,
      parameters: {
        type: 'object',
        properties: {
          subagent_type: { type: 'string', enum: ['explore', 'plan', 'general'] },
          prompt: { type: 'string' },
          description: { type: 'string' },
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: SUBAGENT_MAX_PER_BATCH,
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
  ...specsByName(LSP_TOOL_SPECS),
  ...specsByName(APPLY_PATCH_TOOL_SPECS),
  ...specsByName(AGENTIC_TOOL_SPECS),
  ...specsByName(RUN_CODE_TOOL_SPECS),
  ...specsByName(CODEX_APP_SERVER_TOOL_SPECS),
  ...specsByName(MEMORY_TOOL_SPECS),
}

const {
  getBuiltinSpec,
  getToolMetadata,
} = createToolSchemaMetadataCatalog(BUILTIN_TOOL_SCHEMA_CATALOG, {
  codexModelsToolName: CODEX_MODELS_TOOL_NAME,
})

const {
  handleToolSpecsRequest,
  listAllSpecs,
  listBuiltinNames,
  listBuiltinSpecs,
  resolveSpecsForMode,
} = createToolSchemaResolution({
  builtinCatalog: BUILTIN_TOOL_SCHEMA_CATALOG,
  codexModelsToolName: CODEX_MODELS_TOOL_NAME,
  getToolMetadata,
})

export {
  getBuiltinSpec,
  getToolMetadata,
  handleToolSpecsRequest,
  listAllSpecs,
  listBuiltinNames,
  listBuiltinSpecs,
  resolveSpecsForMode,
}

export {
  filterCurrentDynamicToolSpecs,
  getDynamicTool,
  getDynamicToolRegistrationId,
  getDynamicToolSpecRegistrationId,
  inheritDynamicToolSpecRegistration,
  matchesDynamicToolRegistration,
  registerDynamicTool,
  snapshotDynamicToolSpecRegistrations,
  unregisterByOrigin,
  unregisterDynamicTool,
  unregisterUserDynamicTools,
} from './toolSchemaDynamicRegistry.js'
