/**
 * codeSearch 工具集 - 基于 ripgrep 的代码搜索/符号定位/导入分析。
 *
 * 设计权衡:
 *   - 用 rg --json 拿结构化结果,不要 grep -n 那种文本拼接
 *   - 不解析 AST(那是 M1.5 tree-sitter 的事),用启发式多语言正则定位 symbol
 *   - 全部只读,沙箱在 WORKSPACE_ROOT 内,沿用 fsShellTools 的路径解析
 *   - 不读 .git / node_modules / dist / .next 等,默认走 .gitignore
 *
 * 工具(全部只读):
 *   - grep_code   : 全文搜索, 比 grep 强一个量级
 *   - find_symbol : 找函数/类/常量定义位置
 *   - list_imports: 提取文件首部 import/require
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { sanitizeChildEnv } from './sensitiveEnv.js'

const RG_BIN = process.env.RG_BIN || 'rg'
const RG_TIMEOUT_MS = 15_000
const RG_MAX_OUTPUT = 4 * 1024 * 1024 // 4MB 结构化输出上限
const DEFAULT_MAX_RESULTS = 50
const HARD_MAX_RESULTS = 500
const DEFAULT_CONTEXT = 2

function getWorkspaceRoot() {
  const raw = process.env.WORKSPACE_ROOT?.trim()
  return raw ? path.resolve(raw) : process.cwd()
}

function badReq(msg, status = 400) {
  const err = new Error(msg)
  err.statusCode = status
  return err
}

/**
 * 把任意 path 解析到 WORKSPACE_ROOT 下绝对路径,防 traversal/symlink 逃逸。
 * 复用 fsShellTools 的逻辑思路,这里独立实现避免循环依赖。
 */
function resolveInWorkspace(rawPath) {
  const root = getWorkspaceRoot()
  if (!rawPath || rawPath === '.') return root
  const absRaw = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath)
  const resolved = fs.existsSync(absRaw) ? fs.realpathSync(absRaw) : path.resolve(absRaw)
  const rootReal = fs.realpathSync(root)
  if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
    throw badReq(`路径越界: ${rawPath}`, 403)
  }
  return resolved
}

function toRelative(absPath) {
  const root = getWorkspaceRoot()
  try {
    const rootReal = fs.realpathSync(root)
    return path.relative(rootReal, absPath) || '.'
  } catch {
    return absPath
  }
}

/* ─── rg 调用核心 ─── */

function runRg(args, { cwd = getWorkspaceRoot() } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(
      RG_BIN,
      args,
      {
        cwd,
        timeout: RG_TIMEOUT_MS,
        maxBuffer: RG_MAX_OUTPUT,
        windowsHide: true,
        env: sanitizeChildEnv(),
      },
      (err, stdout, stderr) => {
        // rg 退出码: 0=有匹配, 1=无匹配, 2=错误
        const code = err?.code
        if (err && code !== 0 && code !== 1) {
          resolve({
            ok: false,
            code,
            error: err.killed ? `rg 超时(${RG_TIMEOUT_MS}ms)` : (stderr || err.message || 'rg 失败'),
            stdout: String(stdout || ''),
          })
          return
        }
        resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') })
      }
      )
    } catch (err) {
      resolve({
        ok: false,
        code: err?.code,
        error: err?.message || 'rg failed to start',
        stdout: '',
      })
    }
  })
}

function isRgUnavailable(result) {
  const msg = String(result?.error || '')
  return ['EPERM', 'EACCES', 'ENOENT'].includes(result?.code) ||
    /spawn\s+(EPERM|EACCES|ENOENT)|not recognized|not found/i.test(msg)
}

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', 'build', 'server-data'])
const TYPE_EXTENSIONS = {
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  jsx: ['.jsx'],
  ts: ['.ts', '.tsx'],
  tsx: ['.tsx'],
  py: ['.py'],
  rs: ['.rs'],
  md: ['.md', '.mdx'],
  json: ['.json'],
  css: ['.css'],
  html: ['.html', '.htm'],
}

function walkFiles(root, out = []) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walkFiles(path.join(root, entry.name), out)
    } else if (entry.isFile()) {
      out.push(path.join(root, entry.name))
    }
  }
  return out
}

function globToRegex(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '[^/\\\\]')
    .replace(/\0/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function matchesGlob(rel, glob) {
  if (!glob) return true
  const normalized = rel.replace(/\\/g, '/')
  const base = path.basename(rel)
  const re = globToRegex(String(glob).replace(/\\/g, '/'))
  return re.test(normalized) || re.test(base)
}

function matchesFileType(file, fileType) {
  if (!fileType) return true
  const ext = path.extname(file).toLowerCase()
  const allowed = TYPE_EXTENSIONS[String(fileType).toLowerCase()]
  return allowed ? allowed.includes(ext) : ext === `.${String(fileType).toLowerCase()}`
}

function buildSearchRegex(pattern, { caseSensitive = false, word = false } = {}) {
  const source = word ? `\\b(?:${pattern})\\b` : pattern
  return new RegExp(source, caseSensitive ? '' : 'i')
}

function searchFilesFallback({
  pattern,
  target,
  maxResults,
  context = DEFAULT_CONTEXT,
  fileType = null,
  glob = null,
  caseSensitive = false,
  word = false,
}) {
  const re = buildSearchRegex(pattern, { caseSensitive, word })
  const matches = []
  for (const file of walkFiles(target)) {
    const rel = toRelative(file)
    if (!matchesFileType(file, fileType) || !matchesGlob(rel, glob)) continue
    let stat
    try { stat = fs.statSync(file) } catch { continue }
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue
    let lines
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/) } catch { continue }
    let countInFile = 0
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      re.lastIndex = 0
      const match = re.exec(line)
      if (!match) continue
      countInFile += 1
      if (countInFile > 20) break
      const before = []
      for (let j = Math.max(0, i - context); j < i; j += 1) {
        before.push({ line: j + 1, text: lines[j] })
      }
      const after = []
      for (let j = i + 1; j < Math.min(lines.length, i + 1 + context); j += 1) {
        after.push({ line: j + 1, text: lines[j] })
      }
      matches.push({
        file: rel,
        line: i + 1,
        col: match.index + 1,
        text: line,
        submatches: [{ match: match[0], start: match.index, end: match.index + match[0].length }],
        context_before: before,
        context_after: after,
      })
      if (matches.length >= maxResults) return matches
    }
  }
  return matches
}

/**
 * 解析 rg --json 的输出。
 * 每行一个 JSON,有 type=begin|match|context|end|summary
 * 我们按 file 聚合,合并 context 行到对应 match。
 */
function parseRgJson(stdout, maxResults) {
  const lines = stdout.split('\n').filter(Boolean)
  const matches = []
  let currentFile = null
  // 缓存:每个 match 前置 context 是 type=context 在 match 之前到达
  // 我们用滑动窗口收集 context,在遇到 match 时一并写入
  let beforeBuf = []

  for (const raw of lines) {
    let evt
    try { evt = JSON.parse(raw) } catch { continue }
    const t = evt.type
    if (t === 'begin') {
      currentFile = evt.data?.path?.text || null
      beforeBuf = []
    } else if (t === 'context') {
      beforeBuf.push({
        line: evt.data?.line_number,
        text: stripTrailingNewline(evt.data?.lines?.text || ''),
      })
      // 只保留最近 DEFAULT_CONTEXT 行
      if (beforeBuf.length > DEFAULT_CONTEXT * 2) beforeBuf.shift()
    } else if (t === 'match') {
      const data = evt.data
      const lineNumber = data.line_number
      const lineText = stripTrailingNewline(data.lines?.text || '')
      const submatches = (data.submatches || []).map((sm) => ({
        match: sm.match?.text || '',
        start: sm.start,
        end: sm.end,
      }))
      const before = beforeBuf
        .filter((c) => c.line < lineNumber)
        .slice(-DEFAULT_CONTEXT)
      matches.push({
        file: currentFile,
        line: lineNumber,
        col: (submatches[0]?.start ?? 0) + 1,
        text: lineText,
        submatches,
        context_before: before,
        context_after: [],
      })
      beforeBuf = []
      if (matches.length >= maxResults) break
    } else if (t === 'end') {
      // 收尾,把剩余 context 当作上一个 match 的 after
      const lastInFile = [...matches].reverse().find((m) => m.file === currentFile)
      if (lastInFile && beforeBuf.length) {
        lastInFile.context_after = beforeBuf
          .filter((c) => c.line > lastInFile.line)
          .slice(0, DEFAULT_CONTEXT)
      }
      currentFile = null
      beforeBuf = []
    }
  }
  return matches
}

function stripTrailingNewline(s) {
  return String(s || '').replace(/\r?\n$/, '')
}

/* ─── 工具 1:grep_code ─── */

export async function grepCodeTool({
  pattern,
  path: rawPath = '.',
  glob = null,
  file_type = null,
  case_sensitive = false,
  word = false,
  max_results = DEFAULT_MAX_RESULTS,
} = {}) {
  if (typeof pattern !== 'string' || !pattern.trim()) throw badReq('pattern 必填')
  if (pattern.length > 1000) throw badReq('pattern 过长', 413)
  const target = resolveInWorkspace(rawPath)
  const limit = Math.min(Math.max(Number(max_results) || DEFAULT_MAX_RESULTS, 1), HARD_MAX_RESULTS)

  const args = [
    '--json',
    `--context=${DEFAULT_CONTEXT}`,
    '--max-count=20', // 单文件最多 20 处,避免 minified 一个文件吃光配额
    '--max-filesize=2M',
    '--hidden',
    '--glob=!.git/**',
    '--glob=!node_modules/**',
    '--glob=!dist/**',
    '--glob=!.next/**',
    '--glob=!build/**',
    '--glob=!server-data/**',
  ]
  if (case_sensitive) args.push('--case-sensitive')
  else args.push('--smart-case')
  if (word) args.push('--word-regexp')
  if (file_type) {
    if (!/^[a-z0-9+-]+$/i.test(String(file_type))) throw badReq('file_type 仅允许字母数字')
    args.push(`--type=${file_type}`)
  }
  if (glob) {
    if (typeof glob !== 'string' || glob.length > 200) throw badReq('glob 非法')
    args.push(`--glob=${glob}`)
  }
  args.push('--', pattern, toRelative(target) || '.')

  const result = await runRg(args)
  if (!result.ok) {
    if (isRgUnavailable(result)) {
      const matches = searchFilesFallback({
        pattern,
        target,
        maxResults: limit,
        context: DEFAULT_CONTEXT,
        fileType: file_type,
        glob,
        caseSensitive: case_sensitive,
        word,
      })
      return {
        ok: true,
        pattern,
        searched_path: toRelative(target),
        total: matches.length,
        truncated: matches.length >= limit,
        matches,
      }
    }
    return { ok: false, error: result.error, matches: [] }
  }
  const matches = parseRgJson(result.stdout, limit)
  return {
    ok: true,
    pattern,
    searched_path: toRelative(target),
    total: matches.length,
    truncated: matches.length >= limit,
    matches,
  }
}

/* ─── 工具 2:find_symbol ─── */

// 多语言符号识别正则(启发式,M1.5 接 tree-sitter 之前的过渡方案)
// 注意:这里只匹配"定义",不匹配引用 — 引用走 grep_code 即可
const SYMBOL_PATTERNS = {
  // JS/TS
  function: [
    String.raw`\b(?:export\s+(?:default\s+)?)?(?:async\s+)?function\*?\s+__NAME__\b`,
    String.raw`\b(?:export\s+)?const\s+__NAME__\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>`,
    String.raw`\b(?:export\s+)?const\s+__NAME__\s*=\s*(?:async\s+)?function\b`,
    // Python def
    String.raw`^\s*(?:async\s+)?def\s+__NAME__\s*\(`,
    // Go func
    String.raw`^\s*func\s+(?:\([^)]+\)\s+)?__NAME__\s*\(`,
    // Rust fn
    String.raw`^\s*(?:pub\s+(?:\([^)]+\)\s+)?)?(?:async\s+)?fn\s+__NAME__\b`,
    // Java/C# method - 粗略,会漏修饰符组合,可接受
    String.raw`\b(?:public|private|protected|static|final|\s)+[\w<>\[\],?\s]+\s+__NAME__\s*\([^)]*\)\s*\{`,
  ],
  class: [
    String.raw`\b(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+__NAME__\b`,
    // Python
    String.raw`^\s*class\s+__NAME__\s*[\(:]`,
    // Rust struct/enum/trait
    String.raw`^\s*(?:pub\s+(?:\([^)]+\)\s+)?)?(?:struct|enum|trait)\s+__NAME__\b`,
    // Go type
    String.raw`^\s*type\s+__NAME__\s+(?:struct|interface)\b`,
  ],
  const: [
    String.raw`\b(?:export\s+)?(?:const|let|var)\s+__NAME__\s*=`,
    // Python module-level
    String.raw`^__NAME__\s*=\s*[^=]`,
    // Go
    String.raw`^\s*(?:const|var)\s+__NAME__\b`,
    // Rust
    String.raw`^\s*(?:pub\s+(?:\([^)]+\)\s+)?)?(?:const|static)\s+__NAME__\s*:`,
  ],
}

function buildSymbolRegex(name, kind) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const kinds = kind === 'all' || !kind
    ? ['function', 'class', 'const']
    : [kind]
  const patterns = []
  for (const k of kinds) {
    const arr = SYMBOL_PATTERNS[k]
    if (!arr) continue
    for (const p of arr) patterns.push(p.replace(/__NAME__/g, esc))
  }
  // rg 用 | 联结成一个 PCRE-like 正则
  return patterns.map((p) => `(?:${p})`).join('|')
}

export async function findSymbolTool({
  name,
  kind = 'all',
  language = null,
  path: rawPath = '.',
  max_results = 20,
} = {}) {
  if (typeof name !== 'string' || !name.trim()) throw badReq('name 必填')
  if (!/^[a-zA-Z_$][\w$]*$/.test(name)) throw badReq('name 必须是合法标识符')
  if (!['all', 'function', 'class', 'const'].includes(kind)) {
    throw badReq('kind 必须是 all/function/class/const')
  }
  const target = resolveInWorkspace(rawPath)
  const limit = Math.min(Math.max(Number(max_results) || 20, 1), 100)
  const regex = buildSymbolRegex(name, kind)

  const args = [
    '--json',
    '--context=1',
    '--max-count=5',
    '--max-filesize=2M',
    '--hidden',
    '--glob=!.git/**',
    '--glob=!node_modules/**',
    '--glob=!dist/**',
    '--glob=!.next/**',
    '--glob=!build/**',
    '--glob=!server-data/**',
    '--pcre2', // 用 PCRE2 才能支持 (?:...) 等花式分组(rg 默认 Rust regex 也支持,这里保险)
  ]
  if (language) {
    if (!/^[a-z0-9+-]+$/i.test(String(language))) throw badReq('language 非法')
    args.push(`--type=${language}`)
  }
  args.push('--', regex, toRelative(target) || '.')

  const result = await runRg(args)
  if (!result.ok) {
    if (isRgUnavailable(result)) {
      const matches = searchFilesFallback({
        pattern: regex,
        target,
        maxResults: limit,
        context: 1,
        fileType: language,
        caseSensitive: true,
      })
      return {
        ok: true,
        name,
        kind,
        searched_path: toRelative(target),
        total: matches.length,
        truncated: matches.length >= limit,
        symbols: matches.map((m) => ({
          file: m.file,
          line: m.line,
          definition: m.text.trim(),
          context_before: m.context_before,
        })),
      }
    }
    return { ok: false, error: result.error, symbols: [] }
  }
  const matches = parseRgJson(result.stdout, limit)
  return {
    ok: true,
    name,
    kind,
    searched_path: toRelative(target),
    total: matches.length,
    truncated: matches.length >= limit,
    symbols: matches.map((m) => ({
      file: m.file,
      line: m.line,
      definition: m.text.trim(),
      context_before: m.context_before,
    })),
  }
}

/* ─── 工具 3:list_imports ─── */

// 文件首 N 行扫 import,够用且不解析整文件
const IMPORT_SCAN_LINES = 80

const IMPORT_PATTERNS = [
  // ES module
  { re: /^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/, kind: 'esm' },
  // CJS
  { re: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/, kind: 'cjs' },
  // Python
  { re: /^\s*(?:from\s+([\w.]+)\s+)?import\s+([\w.,\s*]+)/, kind: 'py' },
  // Go
  { re: /^\s*import\s+(?:"([^"]+)"|\(\s*"([^"]+)")/, kind: 'go' },
  // Rust
  { re: /^\s*use\s+([\w:]+(?:::\{[^}]+\})?)/, kind: 'rust' },
  // Java/Kotlin
  { re: /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)/, kind: 'java' },
]

export async function listImportsTool({ file } = {}) {
  if (typeof file !== 'string' || !file.trim()) throw badReq('file 必填')
  const abs = resolveInWorkspace(file)
  const stat = fs.statSync(abs)
  if (!stat.isFile()) throw badReq(`不是文件: ${file}`)
  if (stat.size > 5 * 1024 * 1024) throw badReq('文件过大', 413)
  const raw = fs.readFileSync(abs, 'utf8')
  const lines = raw.split(/\r?\n/).slice(0, IMPORT_SCAN_LINES)
  const imports = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.startsWith('//') || line.startsWith('#')) continue
    for (const { re, kind } of IMPORT_PATTERNS) {
      const m = re.exec(line)
      if (!m) continue
      // 提取第一个非空 capture group 作为 source
      const source = m.slice(1).find((g) => g)
      if (!source) continue
      imports.push({ line: i + 1, kind, source, raw: line.trim() })
      break
    }
  }
  return {
    ok: true,
    file: toRelative(abs),
    scanned_lines: lines.length,
    total: imports.length,
    imports,
  }
}

/* ─── dispatcher + OpenAI specs ─── */

export async function dispatchCodeSearchTool(name, args) {
  switch (name) {
    case 'grep_code': return grepCodeTool(args || {})
    case 'find_symbol': return findSymbolTool(args || {})
    case 'list_imports': return listImportsTool(args || {})
    default: throw new Error(`unknown codeSearch tool: ${name}`)
  }
}

export const CODE_SEARCH_TOOL_SPECS = [
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
          case_sensitive: { type: 'boolean', description: '默认 false(smart-case)' },
          word: { type: 'boolean', description: '是否整词匹配,默认 false' },
          max_results: { type: 'integer', description: '最大返回数,默认 50,上限 500' },
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
          kind: { type: 'string', enum: ['all', 'function', 'class', 'const'], description: '默认 all' },
          language: { type: 'string', description: 'rg 类型别名,如 "ts" 只在 TypeScript 里找' },
          path: { type: 'string', description: '搜索范围,默认 workspace 根' },
          max_results: { type: 'integer', description: '最大返回数,默认 20,上限 100' },
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
]
