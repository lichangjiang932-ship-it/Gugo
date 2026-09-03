export const CODE_SEARCH_TOOL_SPECS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'grep_code',
      description: '在 workspace 里全文搜索代码(基于 ripgrep).比 read_file + 正则强一个量级:支持 glob/文件类型过滤、上下文行、忽略 .git/node_modules.返回结构化 [{file, line, col, text, context_before, context_after}].',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '搜索模式(默认 smart-case 正则,可用 regex)' },
          path: { type: 'string', description: '搜索范围,默认 workspace 根' },
          glob: { type: 'string', description: 'glob 过滤,例如 "*.tsx" 或 "src/**/*.js"' },
          file_type: { type: 'string', description: 'rg 内置类型别名,例如 "ts"/"py"/"go"/"rust"' },
          case_sensitive: { type: 'boolean', default: false, description: '默认 false(smart-case)' },
          word: { type: 'boolean', default: false, description: '是否整词匹配,默认 false' },
          max_results: { type: 'integer', default: 50, description: '最大返回数,默认 50,上限 500' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_symbol',
      description: '定位符号(函数/类/常量)的定义位置.支持 JS/TS/Python/Go/Rust/Java.比 grep 精准,只返回声明行,不返回调用.适合"这个函数定义在哪""有没有同名的类".',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '符号名(必须是合法标识符)' },
          kind: { type: 'string', enum: ['all', 'function', 'class', 'const'], default: 'all', description: '默认 all' },
          language: { type: 'string', description: 'rg 类型别名,如 "ts" 只在 TypeScript 里找' },
          path: { type: 'string', description: '搜索范围,默认 workspace 根' },
          max_results: { type: 'integer', default: 20, description: '最大返回数,默认 20,上限 100' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_imports',
      description: '扫单个文件的首 80 行,提取所有 import/require/use 语句,返回 [{line, kind, source, raw}].快速看一个文件依赖什么.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '文件路径(相对 workspace 或绝对,须在 workspace 内)' },
        },
        required: ['file'],
      },
    },
  },
])
