// Claude-Code 风格的 fs / shell 工具集.让模型在 chat 里能 read_file / write_file
// / edit_file / bash_exec.全部经过路径沙箱 + 大小上限 + 鉴权.
//
// 安全闸门(默认全部关闭):
//   - WORKSPACE_FS_ENABLED=1     启用 read/write/edit
//   - WORKSPACE_SHELL_ENABLED=1  启用 bash_exec
//   - WORKSPACE_ROOT=<absolute path>  工作目录,默认 process.cwd().
//     所有路径都 resolve 到这里下,realpath 检查防 symlink 逃逸.
//
// 即便前端 PERMISSIONS 开关被切开,server 不开 env 也 403 — 前端开关只是 UX 提示,
// 不进入信任边界.
//
// 路径策略:
//   - 接受的 path 既可以是相对(相对 WORKSPACE_ROOT)也可以是绝对(必须在 WORKSPACE_ROOT 内)
//   - 返回的 path 总是相对 WORKSPACE_ROOT(便于跨机器复现 / 日志脱敏)

import fs from 'node:fs'
import path from 'node:path'
import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'
import { runProcessWithGroup } from '../utils/processGroup.js'
import { bashLimiter, writeLimiter } from '../utils/rateLimiter.js'
import { writeToolAudit } from '../utils/audit.js'
import { checkBashCommandDanger } from '../utils/bashGuard.js'
import { checkWorkspaceSize } from '../utils/workspaceSize.js'
import { isToolPermittedForUser } from '../db.js'
import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import { resolveAuthorizedLocalPath } from '../services/localFileAccessService.js'
import { assertWorkspaceCapability } from '../services/workspaceTrustService.js'

const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB read/write upper bound
const SHELL_DEFAULT_TIMEOUT_MS = 60 * 1000
const SHELL_MAX_TIMEOUT_MS = 5 * 60 * 1000
const SHELL_MAX_OUTPUT = 1 * 1024 * 1024 // 1 MB combined stdout+stderr cap

function getWorkspaceRoot() {
  const raw = process.env.WORKSPACE_ROOT?.trim()
  return path.resolve(raw || process.cwd())
}

function isFsEnabled() { return process.env.WORKSPACE_FS_ENABLED === '1' }
function isShellEnabled() { return process.env.WORKSPACE_SHELL_ENABLED === '1' }

function badReq(message, statusCode = 400) {
  const e = new Error(message)
  e.statusCode = statusCode
  return e
}

function mapWriteError(error, fullPath) {
  if (!['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return error
  const mapped = badReq(
    `宿主文件系统拒绝写入（${error.code}）：${fullPath}。`
      + '这不是文件名或子目录问题，在同一授权根目录下改试 src、.tmp、output 不会解决。',
    403,
  )
  mapped.code = 'FILESYSTEM_WRITE_DENIED'
  mapped.path = fullPath
  mapped.retryable = false
  mapped.hint = '请确认该目录已授予“读写”权限，并检查 Windows 文件夹 ACL、只读属性或安全软件拦截；权限变化后再重试一次。'
  mapped.cause = error
  return mapped
}

// per-user 工具 gate(功能补全):用户在权限中心关掉某工具后,后端入口也拒绝执行,
// 不只靠前端不暴露(前端可被绕过)。userId 为空(系统/内部调用)不 gate。
function assertToolPermitted(userId, toolName) {
  if (userId && !isToolPermittedForUser(userId, toolName)) {
    throw badReq(`工具 ${toolName} 已被该用户在权限中心关闭`, 403)
  }
}

function resolveForFileTool(rawPath, { userId = null, write = false, allowMissing = false } = {}) {
  // 先按「本地文件授权」解析：用户显式授权的路径（grant / all_files）是独立的
  // 信任边界，不应被全局 WORKSPACE_FS_ENABLED 开关短路——授权行为本身已经
  // 是用户的明确同意。只有落到 workspace 来源的路径才需要全局开关 + 工作区信任。
  const resolved = resolveAuthorizedLocalPath({ userId, rawPath, write, allowMissing })
  if (resolved.source === 'workspace') {
    if (!isFsEnabled()) {
      throw badReq('WORKSPACE_FS_ENABLED=1 未启用,无法访问工作区文件', 403)
    }
    assertWorkspaceCapability({
      userId,
      rootPath: resolved.rootPath || getWorkspaceRoot(),
      capability: write ? 'fileSystemWrite' : 'fileSystem',
    })
  }
  return resolved
}

export function resolveForShellCwd(rawPath, { userId = null } = {}) {
  const requestedPath = rawPath == null || rawPath === '' ? getWorkspaceRoot() : rawPath
  const resolved = resolveAuthorizedLocalPath({
    userId,
    rawPath: requestedPath,
    write: true,
    allowWorkspace: true,
  })
  assertWorkspaceCapability({
    userId,
    rootPath: resolved.rootPath || getWorkspaceRoot(),
    capability: 'shell',
  })
  return resolved
}

// 把任意 path 字符串解析到 WORKSPACE_ROOT 下的绝对路径.防 traversal + symlink 逃逸.
// allowMissing=true 时即便文件 / 中间目录不存在也接受(write_file 自动 mkdir 父目录场景),
// 此时回溯到第一个真实存在的祖先,验证它在 workspace 内.
export function resolveInWorkspace(rawPath, { allowMissing = false } = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw badReq('path 必填')
  }
  const root = getWorkspaceRoot()
  const full = path.resolve(root, rawPath)
  let real
  try {
    real = fs.realpathSync(full)
  } catch {
    if (!allowMissing) throw badReq(`路径不存在或无法访问: ${rawPath}`, 404)
    // 沿祖先向上找第一个真实存在的目录;它必须在 workspace 内
    let probe = full
    while (probe !== path.dirname(probe)) {
      if (fs.existsSync(probe)) break
      probe = path.dirname(probe)
    }
    let anchor
    try { anchor = fs.realpathSync(probe) } catch { throw badReq('无可锚定的祖先目录', 404) }
    if (anchor !== root && !anchor.startsWith(root + path.sep)) {
      throw badReq('路径越出 workspace', 403)
    }
    return full
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw badReq('路径越出 workspace', 403)
  }
  return real
}

/* ── read_file ─────────────────────────────────────────────── */

export async function readFileTool({ path: rawPath, offset = 0, limit = 0, userId = null }) {
  const resolved = resolveForFileTool(rawPath, { userId })
  const full = resolved.fullPath
  const stat = fs.statSync(full)
  if (stat.isDirectory()) throw badReq('路径是目录,不是文件', 400)
  if (stat.size > MAX_FILE_BYTES) {
    throw badReq(`文件过大(${stat.size} 字节,上限 ${MAX_FILE_BYTES})`, 413)
  }
  const all = fs.readFileSync(full, 'utf8')
  const lines = all.split('\n')
  const o = Math.max(0, Math.floor(Number(offset) || 0))
  const l = Math.max(0, Math.floor(Number(limit) || 0))
  const slice = l > 0 ? lines.slice(o, o + l) : lines.slice(o)
  return {
    ok: true,
    path: resolved.displayPath,
    scope: resolved.source,
    size: stat.size,
    totalLines: lines.length,
    offset: o,
    returnedLines: slice.length,
    content: slice.join('\n'),
  }
}

/* ── list_directory ───────────────────────────────────────── */

export async function listDirectoryTool({ path: rawPath, limit = 200, userId = null }) {
  const resolved = resolveForFileTool(rawPath, { userId })
  const full = resolved.fullPath
  const stat = fs.statSync(full)
  if (!stat.isDirectory()) throw badReq('路径不是文件夹', 400)
  const maxEntries = Math.min(Math.max(Number(limit) || 200, 1), 500)
  const allEntries = fs.readdirSync(full, { withFileTypes: true })
    .map((entry) => {
      const entryPath = path.join(full, entry.name)
      let entryStat = null
      try { entryStat = fs.statSync(entryPath) } catch { /* inaccessible entry */ }
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
        size: entryStat?.isFile() ? entryStat.size : null,
        modifiedAt: entryStat?.mtimeMs ? Math.round(entryStat.mtimeMs) : null,
      }
    })
    .sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name)
      if (a.type === 'directory') return -1
      if (b.type === 'directory') return 1
      return a.name.localeCompare(b.name)
    })
  return {
    ok: true,
    path: resolved.displayPath,
    scope: resolved.source,
    total: allEntries.length,
    truncated: allEntries.length > maxEntries,
    entries: allEntries.slice(0, maxEntries),
  }
}

/* ── write_file ────────────────────────────────────────────── */

export async function writeFileTool({ path: rawPath, content, userId = null }) {
  assertToolPermitted(userId, 'write_file')
  // ★ M3.5:写类限流
  if (userId && !writeLimiter.tryConsume(userId, 'write')) {
    throw badReq('写文件限流:超过 120 次/分钟', 429)
  }
  if (typeof content !== 'string') throw badReq('content 必须是字符串')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_FILE_BYTES) {
    throw badReq(`内容过大(${bytes} 字节,上限 ${MAX_FILE_BYTES})`, 413)
  }
  const resolved = resolveForFileTool(rawPath, { userId, write: true, allowMissing: true })
  const full = resolved.fullPath
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf8')
  } catch (error) {
    throw mapWriteError(error, full)
  }
  // ★ C-P2.4: 轻量可观测 — 总大小超阈值仅 warn,不阻断
  if (resolved.source === 'workspace') {
    try { checkWorkspaceSize(getWorkspaceRoot()) } catch { /* 巡检失败不影响写入 */ }
  }
  return { ok: true, path: resolved.displayPath, scope: resolved.source, bytes }
}

/* ── edit_file (字符串精确替换) ────────────────────────────── */

export async function editFileTool({
  path: rawPath,
  old_string,
  new_string,
  replace_all = false,
  userId = null,
}) {
  assertToolPermitted(userId, 'edit_file')
  // ★ M3.5:写类限流
  if (userId && !writeLimiter.tryConsume(userId, 'write')) {
    throw badReq('编辑限流:超过 120 次/分钟', 429)
  }
  if (typeof old_string !== 'string' || old_string.length === 0) {
    throw badReq('old_string 必填且不能为空')
  }
  if (typeof new_string !== 'string') {
    throw badReq('new_string 必填')
  }
  if (old_string === new_string) {
    throw badReq('old_string 与 new_string 相同,没有改动')
  }
  const resolved = resolveForFileTool(rawPath, { userId, write: true })
  const full = resolved.fullPath
  const stat = fs.statSync(full)
  if (stat.size > MAX_FILE_BYTES) {
    throw badReq(`文件过大(${stat.size} 字节,上限 ${MAX_FILE_BYTES})`, 413)
  }
  const orig = fs.readFileSync(full, 'utf8')
  let next
  let replacedCount
  if (replace_all) {
    const parts = orig.split(old_string)
    replacedCount = parts.length - 1
    if (replacedCount === 0) throw badReq('old_string 在文件里未找到')
    next = parts.join(new_string)
  } else {
    const idx = orig.indexOf(old_string)
    if (idx === -1) throw badReq('old_string 在文件里未找到')
    const second = orig.indexOf(old_string, idx + old_string.length)
    if (second !== -1) {
      throw badReq('old_string 在文件里出现多次,请加上下文使其唯一,或传 replace_all:true')
    }
    next = orig.slice(0, idx) + new_string + orig.slice(idx + old_string.length)
    replacedCount = 1
  }
  try {
    fs.writeFileSync(full, next, 'utf8')
  } catch (error) {
    throw mapWriteError(error, full)
  }
  return {
    ok: true,
    path: resolved.displayPath,
    scope: resolved.source,
    replacedCount,
    deltaBytes: Buffer.byteLength(next, 'utf8') - Buffer.byteLength(orig, 'utf8'),
  }
}

/* ── bash_exec ─────────────────────────────────────────────── */

export async function bashExecTool({ command, cwd: rawCwd, timeout_ms, userId = null, signal = null }) {
  assertToolPermitted(userId, 'bash_exec')
  if (!isShellEnabled()) {
    throw badReq('WORKSPACE_SHELL_ENABLED=1 未启用,无法执行 shell 命令', 403)
  }
  if (typeof command !== 'string' || !command.trim()) throw badReq('command 必填')
  if (command.length > 10_000) throw badReq('command 过长', 413)

  // ★ P0:危险命令拦截(rm -rf / / dd /dev / curl|sh / 私钥外泄等)
  const danger = checkBashCommandDanger(command)
  if (danger) {
    if (userId) writeToolAudit({ userId, origin: 'bash', toolName: 'bash_exec', args: { command }, status: 'denied' })
    throw badReq(`命令被安全策略拦截:${danger.reason}`, 403)
  }

  // ★ M3.5:单用户限流(防模型失控狂打)
  if (userId && !bashLimiter.tryConsume(userId, 'bash_exec')) {
    writeToolAudit({ userId, origin: 'bash', toolName: 'bash_exec', args: { command }, status: 'denied' })
    throw badReq('bash_exec 限流:超过 30 次/分钟,请稍后重试', 429)
  }

  const resolvedCwd = resolveForShellCwd(rawCwd, { userId })
  const cwd = resolvedCwd.fullPath
  const displayCwd = resolvedCwd.displayPath
  if (!fs.statSync(cwd).isDirectory()) throw badReq('cwd 不是目录')

  const timeout = Math.min(
    Math.max(Number(timeout_ms) || SHELL_DEFAULT_TIMEOUT_MS, 1000),
    SHELL_MAX_TIMEOUT_MS
  )

  const isWin = process.platform === 'win32'
  const shellPath = isWin ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh'
  const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command]
  const startedAt = Date.now()

  return new Promise((resolve) => {
    runProcessWithGroup({
      shellPath,
      shellArgs,
      cwd,
      env: sanitizeChildEnv(),
      timeout,
      maxBuffer: SHELL_MAX_OUTPUT,
      windowsHide: true,
      signal,
    }).then((r) => {
      const durationMs = Date.now() - startedAt
      const auditArgs = { command, cwd: displayCwd }
      if (r.aborted) {
        if (userId) writeToolAudit({ userId, origin: 'bash', toolName: 'bash_exec', args: auditArgs, status: 'cancelled', durationMs })
        resolve({
          ok: false,
          cancelled: true,
          error: '命令已取消，进程组已清理',
          stdout: r.stdout,
          stderr: r.stderr,
          cwd: displayCwd,
        })
        return
      }
      if (r.timedOut) {
        if (userId) writeToolAudit({ userId, origin: 'bash', toolName: 'bash_exec', args: auditArgs, status: 'timeout', durationMs })
        resolve({
          ok: false,
          timedOut: true,
          error: `命令超时(${timeout}ms),进程组已被清理`,
          stdout: r.stdout,
          stderr: r.stderr,
          cwd: displayCwd,
        })
        return
      }
      if (r.truncated) {
        if (userId) writeToolAudit({ userId, origin: 'bash', toolName: 'bash_exec', args: auditArgs, status: 'truncated', durationMs })
        resolve({
          ok: false,
          truncated: true,
          error: `输出超过 ${SHELL_MAX_OUTPUT} 字节,已截断并杀进程组`,
          stdout: r.stdout,
          stderr: r.stderr,
          cwd: displayCwd,
        })
        return
      }
      if (r.code !== 0) {
        if (userId) writeToolAudit({ userId, origin: 'bash', toolName: 'bash_exec', args: auditArgs, status: 'error', durationMs })
        resolve({
          ok: false,
          exitCode: r.code,
          signal: r.signal,
          error: `命令退出码 ${r.code}${r.signal ? ` (signal=${r.signal})` : ''}`,
          stdout: r.stdout,
          stderr: r.stderr,
          cwd: displayCwd,
        })
        return
      }
      if (userId) writeToolAudit({ userId, origin: 'bash', toolName: 'bash_exec', args: auditArgs, status: 'ok', durationMs })
      resolve({
        ok: true,
        exitCode: 0,
        stdout: r.stdout,
        stderr: r.stderr,
        cwd: displayCwd,
      })
    })
  })
}

/* ── HTTP handler (用于 /api/tools/fs/* 和 /api/tools/shell/*) ── */

export async function handleFsShellRequest(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '仅支持 POST' })
    return
  }
  // 鉴权:fs/shell 比 search/fetch 危险得多,必须登录.
  if (!authenticateRequest(req)) {
    sendJson(res, 401, { ok: false, error: '请先登录' })
    return
  }
  const url = req.url || ''
  try {
    const body = await readJson(req)
    // ★ P0:透传 userId 让 audit 能记是谁干的
    const bodyWithUser = { ...body, userId: req.userId }
    let result
    if (url.startsWith('/api/tools/fs/list')) result = await listDirectoryTool(bodyWithUser)
    else if (url.startsWith('/api/tools/fs/read')) result = await readFileTool(bodyWithUser)
    else if (url.startsWith('/api/tools/fs/write')) result = await writeFileTool(bodyWithUser)
    else if (url.startsWith('/api/tools/fs/edit')) result = await editFileTool(bodyWithUser)
    else if (url.startsWith('/api/tools/shell/exec')) result = await bashExecTool(bodyWithUser)
    else { sendJson(res, 404, { ok: false, error: '未知端点' }); return }
    sendJson(res, 200, result)
  } catch (err) {
    const status = err?.statusCode || 500
    sendJson(res, status, {
      ok: false,
      code: err?.code || 'FS_TOOL_FAILED',
      error: err?.message || 'tool failed',
      retryable: err?.retryable ?? ![401, 403, 404].includes(status),
      ...(err?.path ? { path: err.path } : {}),
      ...(err?.hint ? { hint: err.hint } : {}),
      ...(err?.suggestGrantPath ? { suggestGrantPath: err.suggestGrantPath } : {}),
      ...(err?.requiredAccessMode ? { requiredAccessMode: err.requiredAccessMode } : {}),
    })
  }
}

// 给 jobTools/jobRuntime 共用:统一 dispatcher,直接函数调用,不经 HTTP.
// userId 可选(内部 job/subagent 传进来),有则落 audit
export async function dispatchFsShellTool(name, args, { userId = null, signal = null } = {}) {
  const argsWithUser = userId ? { ...args, userId } : args
  switch (name) {
    case 'list_directory': return listDirectoryTool(argsWithUser)
    case 'read_file': return readFileTool(argsWithUser)
    case 'write_file': return writeFileTool(argsWithUser)
    case 'edit_file': return editFileTool(argsWithUser)
    case 'bash_exec': return bashExecTool({ ...argsWithUser, signal })
    default: throw new Error(`unknown fsShell tool: ${name}`)
  }
}

// 给前端 / jobTools 共用的 OpenAI function spec.
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
          limit: { type: 'integer', description: '最多返回多少项，默认 200，最大 500。' },
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
          offset: { type: 'integer', description: '起始行号(从 0),可选' },
          limit: { type: 'integer', description: '读取行数,0 表示读到末尾' },
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
          replace_all: { type: 'boolean', description: '为 true 时替换全部出现,默认 false 且要求唯一' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash_exec',
      description: '在 workspace 或用户已授权本地目录里跑 shell 命令(Windows 用 cmd.exe,其他用 /bin/sh).默认超时 60s,最长 5min,stdout+stderr 上限 1MB.敏感 env(API key/邮箱密码)已被屏蔽.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '完整命令字符串,例如 "ls -la src" 或 "npm test"' },
          cwd: { type: 'string', description: 'workspace 相对目录或用户已授权目录的绝对路径,默认 workspace 根' },
          timeout_ms: { type: 'integer', description: '超时毫秒数,默认 60000,最大 300000' },
        },
        required: ['command'],
      },
    },
  },
]
