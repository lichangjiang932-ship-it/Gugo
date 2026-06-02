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

// per-user 工具 gate(功能补全):用户在权限中心关掉某工具后,后端入口也拒绝执行,
// 不只靠前端不暴露(前端可被绕过)。userId 为空(系统/内部调用)不 gate。
function assertToolPermitted(userId, toolName) {
  if (userId && !isToolPermittedForUser(userId, toolName)) {
    throw badReq(`工具 ${toolName} 已被该用户在权限中心关闭`, 403)
  }
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

function toRelative(absPath) {
  const rel = path.relative(getWorkspaceRoot(), absPath)
  return rel.split(path.sep).join('/')
}

/* ── read_file ─────────────────────────────────────────────── */

export async function readFileTool({ path: rawPath, offset = 0, limit = 0 }) {
  if (!isFsEnabled()) throw badReq('WORKSPACE_FS_ENABLED=1 未启用,无法读取文件', 403)
  const full = resolveInWorkspace(rawPath)
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
    path: toRelative(full),
    size: stat.size,
    totalLines: lines.length,
    offset: o,
    returnedLines: slice.length,
    content: slice.join('\n'),
  }
}

/* ── write_file ────────────────────────────────────────────── */

export async function writeFileTool({ path: rawPath, content, userId = null }) {
  assertToolPermitted(userId, 'write_file')
  // ★ M3.5:写类限流
  if (userId && !writeLimiter.tryConsume(userId, 'write')) {
    throw badReq('写文件限流:超过 120 次/分钟', 429)
  }
  if (!isFsEnabled()) throw badReq('WORKSPACE_FS_ENABLED=1 未启用,无法写入文件', 403)
  if (typeof content !== 'string') throw badReq('content 必须是字符串')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_FILE_BYTES) {
    throw badReq(`内容过大(${bytes} 字节,上限 ${MAX_FILE_BYTES})`, 413)
  }
  const full = resolveInWorkspace(rawPath, { allowMissing: true })
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
  // ★ C-P2.4: 轻量可观测 — 总大小超阈值仅 warn,不阻断
  try { checkWorkspaceSize(getWorkspaceRoot()) } catch { /* 巡检失败不影响写入 */ }
  return { ok: true, path: toRelative(full), bytes }
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
  if (!isFsEnabled()) throw badReq('WORKSPACE_FS_ENABLED=1 未启用,无法编辑文件', 403)
  if (typeof old_string !== 'string' || old_string.length === 0) {
    throw badReq('old_string 必填且不能为空')
  }
  if (typeof new_string !== 'string') {
    throw badReq('new_string 必填')
  }
  if (old_string === new_string) {
    throw badReq('old_string 与 new_string 相同,没有改动')
  }
  const full = resolveInWorkspace(rawPath)
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
  fs.writeFileSync(full, next, 'utf8')
  return {
    ok: true,
    path: toRelative(full),
    replacedCount,
    deltaBytes: Buffer.byteLength(next, 'utf8') - Buffer.byteLength(orig, 'utf8'),
  }
}

/* ── bash_exec ─────────────────────────────────────────────── */

export async function bashExecTool({ command, cwd: rawCwd, timeout_ms, userId = null }) {
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

  const root = getWorkspaceRoot()
  const cwd = rawCwd ? resolveInWorkspace(rawCwd) : root
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
    }).then((r) => {
      const durationMs = Date.now() - startedAt
      const auditArgs = { command, cwd: toRelative(cwd) }
      if (r.timedOut) {
        if (userId) writeToolAudit({ userId, origin: 'bash', toolName: 'bash_exec', args: auditArgs, status: 'timeout', durationMs })
        resolve({
          ok: false,
          timedOut: true,
          error: `命令超时(${timeout}ms),进程组已被清理`,
          stdout: r.stdout,
          stderr: r.stderr,
          cwd: toRelative(cwd),
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
          cwd: toRelative(cwd),
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
          cwd: toRelative(cwd),
        })
        return
      }
      if (userId) writeToolAudit({ userId, origin: 'bash', toolName: 'bash_exec', args: auditArgs, status: 'ok', durationMs })
      resolve({
        ok: true,
        exitCode: 0,
        stdout: r.stdout,
        stderr: r.stderr,
        cwd: toRelative(cwd),
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
    if (url.startsWith('/api/tools/fs/read')) result = await readFileTool(bodyWithUser)
    else if (url.startsWith('/api/tools/fs/write')) result = await writeFileTool(bodyWithUser)
    else if (url.startsWith('/api/tools/fs/edit')) result = await editFileTool(bodyWithUser)
    else if (url.startsWith('/api/tools/shell/exec')) result = await bashExecTool(bodyWithUser)
    else { sendJson(res, 404, { ok: false, error: '未知端点' }); return }
    sendJson(res, 200, result)
  } catch (err) {
    const status = err?.statusCode || 500
    sendJson(res, status, { ok: false, error: err?.message || 'tool failed' })
  }
}

// 给 jobTools/jobRuntime 共用:统一 dispatcher,直接函数调用,不经 HTTP.
// userId 可选(内部 job/subagent 传进来),有则落 audit
export async function dispatchFsShellTool(name, args, { userId = null } = {}) {
  const argsWithUser = userId ? { ...args, userId } : args
  switch (name) {
    case 'read_file': return readFileTool(argsWithUser)
    case 'write_file': return writeFileTool(argsWithUser)
    case 'edit_file': return editFileTool(argsWithUser)
    case 'bash_exec': return bashExecTool(argsWithUser)
    default: throw new Error(`unknown fsShell tool: ${name}`)
  }
}

// 给前端 / jobTools 共用的 OpenAI function spec.
export const FS_SHELL_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取 workspace 内的文件全文(或指定行区间).path 相对 workspace 或绝对路径,必须在 workspace 内.超过 5MB 会拒绝.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径,相对 workspace 或绝对(须在 workspace 内)' },
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
      description: '在 workspace 里跑 shell 命令(Windows 用 cmd.exe,其他用 /bin/sh).默认超时 60s,最长 5min,stdout+stderr 上限 1MB.敏感 env(API key/邮箱密码)已被屏蔽.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '完整命令字符串,例如 "ls -la src" 或 "npm test"' },
          cwd: { type: 'string', description: '相对 workspace 的子目录,默认 workspace 根' },
          timeout_ms: { type: 'integer', description: '超时毫秒数,默认 60000,最大 300000' },
        },
        required: ['command'],
      },
    },
  },
]
