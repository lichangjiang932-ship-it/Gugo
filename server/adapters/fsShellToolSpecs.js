import {
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_MAX_ENV_KEYS,
  SHELL_MAX_TIMEOUT_MS,
} from './fsShellSupport.js'

export const FS_SHELL_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: '列出工作区或用户已授权本地文件夹中的内容。额外授权范围必须使用绝对路径，最多返回 500 项。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件夹路径。可使用工作区相对路径或已授权的绝对路径。' },
          limit: { type: 'integer', default: 200, description: '最多返回多少项，默认 200，最大 500。' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作区或用户已授权本地范围内的 UTF-8 文件全文（或指定行区间）。额外授权范围请使用绝对路径，超过 5MB 会拒绝。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区相对路径，或用户已授权范围内的绝对路径。' },
          offset: { type: 'integer', default: 0, description: '起始行号(从 0),可选' },
          limit: { type: 'integer', default: 0, description: '读取行数,0 表示读到末尾' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写整文件(覆盖).不存在则创建,父目录自动 mkdir.单次最多 5MB.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', description: '完整文件内容(UTF-8)' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '精确字符串替换.old_string 在文件里必须唯一(或传 replace_all:true).返回 replacedCount.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: '要被替换的原字符串(精确,含空白和缩进)' },
          new_string: { type: 'string', description: '替换后的新字符串' },
          replace_all: { type: 'boolean', default: false, description: '为 true 时替换全部出现,默认 false 且要求唯一' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash_exec',
      description: '在 workspace 或用户已授权的本地读写目录里跑 shell 命令，可调用已安装的 Python、Node 和 PowerShell（Windows 用 cmd.exe,其他用 /bin/sh）。Windows 不要使用 tail/grep/sed/awk 等 Unix 管道；改用原生命令或 powershell -NoProfile -Command。生成 PDF/PNG 等需要多行或较长 Python 时，不要把脚本塞进 python -c；先用 write_file 写 UTF-8 .py，再用 bash_exec 运行。命令中的绝对路径会逐一校验授权；Windows command 中的每个绝对路径始终用双引号包裹（即使不含空格）。Python/Node/PowerShell 必须在 expected_outputs 声明最终产物。默认超时 10min，最长 6h；stdout+stderr 内存中保留最后 1MB，超长时不中断进程并返回完整日志路径。敏感 env 默认屏蔽；只有 env_keys 明确列出的宿主变量才会在高风险审批后注入，变量值会从结果脱敏，Gugo 自身服务凭据始终禁止。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '完整命令字符串,例如 "ls -la src" 或 "npm test"' },
          cwd: { type: 'string', description: 'workspace 相对目录或用户已授权目录的绝对路径,默认 workspace 根' },
          session: { type: 'string', enum: ['new', 'reuse'], default: 'new', description: 'new 每次启动独立 Shell（默认）；reuse 按用户和授权目录复用 Shell，保留 cd、环境变量与虚拟环境状态。' },
          timeout_ms: { type: 'integer', default: SHELL_DEFAULT_TIMEOUT_MS, minimum: 1000, maximum: SHELL_MAX_TIMEOUT_MS, description: '超时毫秒数，默认 600000，最大 21600000（6 小时）' },
          expected_outputs: { type: 'array', default: [], items: { type: 'string' }, description: '命令预期创建或修改的文件路径;只读命令留空.' },
          env_keys: { type: 'array', maxItems: SHELL_MAX_ENV_KEYS, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }, description: '可选宿主环境变量名称。仅在本次高风险审批通过后按名称注入；变量值不会进入工具参数或结果，Gugo 自身服务凭据始终禁止。' },
        },
        required: ['command'],
      },
    },
  },
]
