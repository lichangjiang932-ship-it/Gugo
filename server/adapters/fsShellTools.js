// Claude-Code 风格的 fs / shell 工具集.让模型在 chat 里能 read_file / write_file
// / edit_file / bash_exec.全部经过路径沙箱 + 大小上限 + 鉴权.
//
// 安全闸门:
//   - WORKSPACE_FS_ENABLED=1     启用 read/write/edit
//   - WORKSPACE_SHELL_ENABLED=1  启用共享 workspace 的 bash_exec
//   - 本机 local + loopback 下，用户 read_write grant 默认允许 bash_exec
//   - LOCAL_CODE_EXECUTION_ENABLED=0 可关闭本地授权目录代码执行
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
import { createHash, randomBytes } from 'node:crypto'
import {
  isProtectedExecutionEnvKey,
  sanitizeChildEnv,
} from '../utils/sensitiveEnv.js'
import {
  buildCodeExecutionEnv,
  codeExecutionFailureHint,
  inferCodeExecutionOutputPaths,
} from '../utils/codeExecutionRuntime.js'
import { runProcessWithGroup } from '../utils/processGroup.js'
import { bashLimiter, writeLimiter } from '../utils/rateLimiter.js'
import { writeToolAudit } from '../utils/audit.js'
import {
  checkBashCommandDanger,
  checkShellPathSyntax,
  extractAbsoluteShellPaths,
} from '../utils/bashGuard.js'
import { checkWorkspaceSize } from '../utils/workspaceSize.js'
import { isToolPermittedForUser } from '../db.js'
import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import {
  findAuthorizedDirectoryGrant,
  isLocalCodeExecutionEnabled,
  resolveAuthorizedLocalPath,
} from '../services/localFileAccessService.js'
import { assertWorkspaceCapability } from '../services/workspaceTrustService.js'
import {
  extractManagedAttachmentContent,
  extractPdfBufferContent,
} from '../services/managedAttachmentContent.js'

const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB read/write upper bound
const SHELL_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const SHELL_MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000
const SHELL_MAX_OUTPUT = 1 * 1024 * 1024 // 内存只保留 stdout+stderr 尾部；完整日志按需落盘
const SHELL_MAX_EXPECTED_OUTPUTS = 64
const SHELL_MAX_ENV_KEYS = 32

function createShellOutputLogPath() {
  const dataRoot = path.resolve(process.env.APP_DATA_DIR || path.join(process.cwd(), 'server-data'))
  return path.join(
    dataRoot,
    'tool-logs',
    `command-${Date.now()}-${randomBytes(8).toString('hex')}.log`,
  )
}

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
    const error = badReq(`工具 ${toolName} 已被该用户在权限中心关闭`, 403)
    error.code = 'TOOL_DISABLED'
    throw error
  }
}

function normalizeShellEnvKeys(value) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    const error = badReq('env_keys 必须是环境变量名称数组')
    error.code = 'SHELL_ENV_KEYS_INVALID'
    throw error
  }
  if (value.length > SHELL_MAX_ENV_KEYS) {
    const error = badReq(`env_keys 最多允许 ${SHELL_MAX_ENV_KEYS} 项`, 413)
    error.code = 'SHELL_ENV_KEYS_LIMIT'
    throw error
  }
  const keys = []
  for (const rawKey of value) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      const error = badReq(`无效的环境变量名称: ${String(rawKey ?? '')}`)
      error.code = 'SHELL_ENV_KEY_INVALID'
      throw error
    }
    if (isProtectedExecutionEnvKey(key)) {
      const error = badReq(`环境变量 ${key} 属于 Gugo 服务凭据，禁止注入工作区命令`, 403)
      error.code = 'SHELL_ENV_KEY_PROTECTED'
      throw error
    }
    if (process.env[key] == null) {
      const error = badReq(`宿主环境变量不存在: ${key}`)
      error.code = 'SHELL_ENV_KEY_NOT_FOUND'
      throw error
    }
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

function requestedEnvValues(keys) {
  return [...new Set(keys
    .map((key) => String(process.env[key] || ''))
    .filter(Boolean))]
}

function redactSensitiveValues(value, secrets) {
  let output = String(value ?? '')
  for (const secret of secrets) output = output.split(secret).join('[REDACTED]')
  return output
}

function redactProcessOutput(result, secrets) {
  if (!secrets.length) return result
  return {
    ...result,
    stdout: redactSensitiveValues(result?.stdout, secrets),
    stderr: redactSensitiveValues(result?.stderr, secrets),
    ...(result?.error ? { error: redactSensitiveValues(result.error, secrets) } : {}),
    sensitiveOutputRedacted: true,
  }
}

function effectivePermissionToolName(permissionToolName, fallback) {
  return typeof permissionToolName === 'string' && permissionToolName.trim()
    ? permissionToolName.trim()
    : fallback
}

export function resolveForFileTool(rawPath, { userId = null, write = false, allowMissing = false } = {}) {
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
  const rootPath = resolved.rootPath || getWorkspaceRoot()
  if (resolved.source === 'workspace') {
    if (!isShellEnabled()) {
      const error = badReq('共享工作区 Shell 未启用；请设置 WORKSPACE_SHELL_ENABLED=1', 403)
      error.code = 'WORKSPACE_SHELL_DISABLED'
      throw error
    }
    assertWorkspaceCapability({ userId, rootPath, capability: 'shell' })
  } else if (resolved.source === 'grant' || resolved.source === 'bypass') {
    if (!isLocalCodeExecutionEnabled()) {
      const error = badReq('本地代码执行已被 LOCAL_CODE_EXECUTION_ENABLED=0 关闭', 403)
      error.code = 'LOCAL_CODE_EXECUTION_DISABLED'
      throw error
    }
    if (!userId) {
      const error = badReq('本地代码执行必须绑定已登录用户和已授权目录', 403)
      error.code = 'USER_REQUIRED'
      throw error
    }
  } else {
    const error = badReq('代码执行必须使用用户明确授权的读写目录或“全部放行”模式；全文件访问不会隐式授予 Shell 权限', 403)
    error.code = 'SHELL_DIRECTORY_GRANT_REQUIRED'
    error.requiredAccessMode = 'read_write'
    throw error
  }
  return resolved
}

function resolveShellCwdForCommand(rawCwd, { command, userId }) {
  const cwdWasOmitted = rawCwd == null || rawCwd === ''
  if (cwdWasOmitted && userId) {
    const absolutePaths = extractAbsoluteShellPaths(command)
    if (absolutePaths.length > 0) {
      const grants = absolutePaths.map((rawPath) => findAuthorizedDirectoryGrant({
        userId,
        rawPath,
        accessMode: 'read_write',
      }))
      const [firstGrant] = grants
      const sameGrant = firstGrant && grants.every((grant) => (
        grant
        && grant.id === firstGrant.id
        && path.normalize(grant.path) === path.normalize(firstGrant.path)
      ))
      if (sameGrant) return resolveForShellCwd(firstGrant.path, { userId })
    }
  }
  return resolveForShellCwd(rawCwd, { userId })
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
  if (resolved.source === 'attachment') {
    const extracted = await extractManagedAttachmentContent({ userId, id: resolved.attachmentId })
    const all = extracted.text
    const lines = all.split('\n')
    const o = Math.max(0, Math.floor(Number(offset) || 0))
    const l = Math.max(0, Math.floor(Number(limit) || 0))
    const slice = l > 0 ? lines.slice(o, o + l) : lines.slice(o)
    return {
      ok: true,
      path: resolved.displayPath,
      scope: resolved.source,
      size: stat.size,
      mimeType: resolved.attachment.mimeType,
      sha256: resolved.attachment.sha256,
      extractionStatus: extracted.extractionStatus,
      requiresVision: extracted.requiresVision,
      truncated: extracted.truncated,
      totalLines: lines.length,
      offset: o,
      returnedLines: slice.length,
      content: slice.join('\n'),
    }
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw badReq(`文件过大(${stat.size} 字节,上限 ${MAX_FILE_BYTES})`, 413)
  }
  const buffer = fs.readFileSync(full)
  const isPdf = path.extname(full).toLowerCase() === '.pdf'
    || buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  const extracted = isPdf ? extractPdfBufferContent(buffer) : null
  const all = isPdf
    ? extracted.text || '[PDF 文件未提取到可读文本；文件可能是扫描件或使用了压缩/自定义字体。]'
    : buffer.toString('utf8')
  const lines = all.split('\n')
  const o = Math.max(0, Math.floor(Number(offset) || 0))
  const l = Math.max(0, Math.floor(Number(limit) || 0))
  const slice = l > 0 ? lines.slice(o, o + l) : lines.slice(o)
  return {
    ok: true,
    path: resolved.displayPath,
    scope: resolved.source,
    size: stat.size,
    ...(isPdf ? {
      mimeType: extracted.mimeType,
      extractionStatus: extracted.extractionStatus,
      requiresVision: extracted.requiresVision,
    } : {}),
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

function contentLineCount(value) {
  const text = String(value || '')
  if (!text) return 0
  const lines = text.split(/\r?\n/u).length
  return lines - (/\r?\n$/u.test(text) ? 1 : 0)
}

function contentLines(value) {
  const text = String(value || '')
  if (!text) return []
  const lines = text.split(/\r?\n/u)
  if (/\r?\n$/u.test(text)) lines.pop()
  return lines
}

/**
 * Count a shortest line-level edit script, matching the additions/deletions
 * users see in a normal source diff. Common prefixes/suffixes are removed
 * first; a bounded Myers search prevents an adversarial full-file rewrite
 * from consuming unbounded CPU and falls back to one middle replacement.
 */
function lineChangeStats(previous, next) {
  const before = contentLines(previous)
  const after = contentLines(next)
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let beforeEnd = before.length
  let afterEnd = after.length
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1
    afterEnd -= 1
  }
  const left = before.slice(start, beforeEnd)
  const right = after.slice(start, afterEnd)
  const n = left.length
  const m = right.length
  if (n === 0 || m === 0) return { additions: m, deletions: n }

  const max = n + m
  const maxDistance = Math.min(max, 4096)
  const offset = maxDistance + 1
  const frontier = new Int32Array((maxDistance * 2) + 3)
  frontier.fill(-1)
  frontier[offset + 1] = 0
  for (let distance = 0; distance <= maxDistance; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = offset + diagonal
      let x
      if (diagonal === -distance
        || (diagonal !== distance && frontier[index - 1] < frontier[index + 1])) {
        x = frontier[index + 1]
      } else {
        x = frontier[index - 1] + 1
      }
      let y = x - diagonal
      while (x < n && y < m && left[x] === right[y]) {
        x += 1
        y += 1
      }
      frontier[index] = x
      if (x >= n && y >= m) {
        return {
          additions: (distance - n + m) / 2,
          deletions: (distance + n - m) / 2,
        }
      }
    }
  }
  return { additions: m, deletions: n }
}

export async function writeFileTool(
  { path: rawPath, content, userId = null },
  { permissionToolName = 'write_file' } = {},
) {
  assertToolPermitted(userId, effectivePermissionToolName(permissionToolName, 'write_file'))
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
  let previousContent = null
  let previousContentKnown = false
  try {
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      previousContent = fs.readFileSync(full, 'utf8')
    }
    previousContentKnown = true
  } catch {
    // Progress metadata must not turn a permitted write into a failure. If the
    // previous state is unreadable, omit line counts and keep the real write.
  }
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
  const changed = !previousContentKnown || previousContent !== content
  const changes = previousContentKnown ? [{
    path: resolved.displayPath,
    ...(previousContent == null
      ? { additions: contentLineCount(content), deletions: 0 }
      : lineChangeStats(previousContent, content)),
  }] : []
  return { ok: true, path: resolved.displayPath, scope: resolved.source, bytes, changed, changes }
}

/* ── edit_file (字符串精确替换) ────────────────────────────── */

export async function editFileTool({
  path: rawPath,
  old_string,
  new_string,
  replace_all = false,
  userId = null,
}, {
  permissionToolName = 'edit_file',
} = {}) {
  assertToolPermitted(userId, effectivePermissionToolName(permissionToolName, 'edit_file'))
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
    changes: [{ path: resolved.displayPath, ...lineChangeStats(orig, next) }],
  }
}

/* ── bash_exec ─────────────────────────────────────────────── */

function outputEntryType(stat) {
  if (stat.isFile()) return 'file'
  if (stat.isDirectory()) return 'directory'
  if (stat.isSymbolicLink()) return 'symlink'
  return 'other'
}

function hashFileContent(fullPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(fullPath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

async function hashDirectoryTree(rootPath) {
  const treeHash = createHash('sha256')

  async function visit(fullPath, relativePath) {
    const stat = await fs.promises.lstat(fullPath)
    const type = outputEntryType(stat)
    treeHash.update(JSON.stringify([
      relativePath.split(path.sep).join('/'),
      type,
      stat.size,
      stat.mtimeMs,
    ]))
    treeHash.update('\0')

    if (type === 'directory') {
      const entries = await fs.promises.readdir(fullPath)
      entries.sort((left, right) => left.localeCompare(right))
      for (const entry of entries) {
        await visit(path.join(fullPath, entry), path.join(relativePath, entry))
      }
      return
    }
    if (type === 'file') {
      treeHash.update(await hashFileContent(fullPath))
      treeHash.update('\0')
      return
    }
    if (type === 'symlink') {
      treeHash.update(await fs.promises.readlink(fullPath))
      treeHash.update('\0')
    }
  }

  await visit(rootPath, '')
  return treeHash.digest('hex')
}

async function snapshotExpectedOutput(fullPath) {
  let stat
  try {
    stat = await fs.promises.lstat(fullPath)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { exists: false }
    throw error
  }

  const type = outputEntryType(stat)
  let contentHash = null
  if (type === 'file') contentHash = await hashFileContent(fullPath)
  else if (type === 'directory') contentHash = await hashDirectoryTree(fullPath)
  else if (type === 'symlink') contentHash = createHash('sha256')
    .update(await fs.promises.readlink(fullPath))
    .digest('hex')

  return {
    exists: true,
    type,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    contentHash,
  }
}

async function prepareExpectedOutputs(rawOutputs, { cwd, userId }) {
  if (rawOutputs == null) return []
  if (!Array.isArray(rawOutputs)) throw badReq('expected_outputs 必须是路径数组')
  if (rawOutputs.length > SHELL_MAX_EXPECTED_OUTPUTS) {
    throw badReq(`expected_outputs 最多 ${SHELL_MAX_EXPECTED_OUTPUTS} 项`, 413)
  }

  const targets = []
  const seen = new Set()
  for (const rawOutput of rawOutputs) {
    if (typeof rawOutput !== 'string' || !rawOutput.trim()) {
      throw badReq('expected_outputs 中的每一项都必须是非空路径')
    }
    const declaredPath = rawOutput.trim()
    const requestedPath = path.isAbsolute(declaredPath)
      ? declaredPath
      : path.resolve(cwd, declaredPath)
    const resolved = resolveAuthorizedLocalPath({
      userId,
      rawPath: requestedPath,
      write: true,
      allowMissing: true,
      allowWorkspace: true,
    })
    const dedupeKey = process.platform === 'win32'
      ? path.normalize(resolved.fullPath).toLowerCase()
      : path.normalize(resolved.fullPath)
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    let before
    try {
      before = await snapshotExpectedOutput(resolved.fullPath)
    } catch (error) {
      const wrapped = badReq(`无法在命令执行前读取 expected_outputs: ${declaredPath}`)
      wrapped.code = 'EXPECTED_OUTPUT_SNAPSHOT_FAILED'
      wrapped.cause = error
      throw wrapped
    }
    targets.push({
      declaredPath,
      fullPath: resolved.fullPath,
      path: resolved.displayPath,
      scope: resolved.source,
      before,
    })
  }
  return targets
}

function changedOutputRecord(target, after, status) {
  const before = target.before
  return {
    path: target.path,
    declaredPath: target.declaredPath,
    scope: target.scope,
    status,
    type: after.type,
    size: after.size,
    modifiedAt: after.mtimeMs,
    contentChanged: before.exists && before.contentHash !== after.contentHash,
    sizeChanged: before.exists && before.size !== after.size,
    mtimeChanged: before.exists && before.mtimeMs !== after.mtimeMs,
    typeChanged: before.exists && before.type !== after.type,
  }
}

async function verifyExpectedOutputs(targets) {
  const verifiedOutputs = []
  const unverifiedOutputs = []

  for (const target of targets) {
    let after
    try {
      after = await snapshotExpectedOutput(target.fullPath)
    } catch (error) {
      unverifiedOutputs.push({
        path: target.path,
        declaredPath: target.declaredPath,
        scope: target.scope,
        status: 'inaccessible',
        error: error?.message || String(error),
      })
      continue
    }

    if (!after.exists) {
      unverifiedOutputs.push({
        path: target.path,
        declaredPath: target.declaredPath,
        scope: target.scope,
        status: 'missing',
        existedBefore: target.before.exists,
      })
      continue
    }
    if (!target.before.exists) {
      verifiedOutputs.push(changedOutputRecord(target, after, 'created'))
      continue
    }

    const changed = target.before.type !== after.type
      || target.before.size !== after.size
      || target.before.mtimeMs !== after.mtimeMs
      || target.before.contentHash !== after.contentHash
    if (changed) {
      verifiedOutputs.push(changedOutputRecord(
        target,
        after,
        target.before.type === after.type ? 'modified' : 'replaced',
      ))
    } else {
      unverifiedOutputs.push({
        path: target.path,
        declaredPath: target.declaredPath,
        scope: target.scope,
        status: 'unchanged',
        existedBefore: true,
        type: after.type,
        size: after.size,
        modifiedAt: after.mtimeMs,
      })
    }
  }

  return {
    verifiedOutputs,
    unverifiedOutputs,
    changedPaths: verifiedOutputs.map((output) => output.path),
  }
}

function sameOrInside(rootPath, candidatePath) {
  const root = path.normalize(rootPath)
  const candidate = path.normalize(candidatePath)
  const relative = path.relative(root, candidate)
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertShellCommandPathsAuthorized(command, { userId, expectedTargets }) {
  const pathSyntax = checkShellPathSyntax(command)
  if (pathSyntax) {
    const error = badReq(
      `命令路径被安全策略拦截：${pathSyntax.reason}`,
      pathSyntax.statusCode || 403,
    )
    error.code = pathSyntax.code || 'SHELL_PATH_POLICY_DENIED'
    if (pathSyntax.path) error.path = pathSyntax.path
    if (pathSyntax.hint) error.hint = pathSyntax.hint
    throw error
  }

  for (const rawPath of extractAbsoluteShellPaths(command)) {
    const absolutePath = path.resolve(rawPath)
    const declaredOutput = expectedTargets.some((target) => sameOrInside(target.fullPath, absolutePath))
    try {
      resolveAuthorizedLocalPath({
        userId,
        rawPath: absolutePath,
        write: declaredOutput,
        allowMissing: declaredOutput,
        allowWorkspace: true,
      })
    } catch (cause) {
      const error = badReq(`命令引用了未授权路径：${rawPath}`, 403)
      error.code = 'SHELL_PATH_NOT_AUTHORIZED'
      error.path = rawPath
      error.requiredAccessMode = declaredOutput ? 'read_write' : 'read_only'
      error.cause = cause
      throw error
    }
  }
}

export async function bashExecTool({
  command,
  cwd: rawCwd,
  timeout_ms,
  expected_outputs,
  env_keys,
  userId = null,
  signal = null,
  onOutput = null,
}, {
  permissionToolName = 'bash_exec',
} = {}) {
  assertToolPermitted(userId, effectivePermissionToolName(permissionToolName, 'bash_exec'))
  if (typeof command !== 'string' || !command.trim()) throw badReq('command 必填')
  if (command.length > 10_000) throw badReq('command 过长', 413)
  const inheritedEnvKeys = normalizeShellEnvKeys(env_keys)
  const sensitiveEnvValues = requestedEnvValues(inheritedEnvKeys)

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

  const resolvedCwd = resolveShellCwdForCommand(rawCwd, { command, userId })
  const cwd = resolvedCwd.fullPath
  const displayCwd = resolvedCwd.displayPath
  if (!fs.statSync(cwd).isDirectory()) throw badReq('cwd 不是目录')
  const expectedTargets = await prepareExpectedOutputs(expected_outputs, { cwd, userId })
  const inferredTargets = expectedTargets.length === 0
    ? await prepareExpectedOutputs(inferCodeExecutionOutputPaths(command), { cwd, userId })
    : []
  assertShellCommandPathsAuthorized(command, {
    userId,
    expectedTargets: [...expectedTargets, ...inferredTargets],
  })

  const timeout = Math.min(
    Math.max(Number(timeout_ms) || SHELL_DEFAULT_TIMEOUT_MS, 1000),
    SHELL_MAX_TIMEOUT_MS
  )

  const isWin = process.platform === 'win32'
  const shellPath = isWin ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh'
  const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command]
  const startedAt = Date.now()
  const outputLogPath = sensitiveEnvValues.length > 0 ? null : createShellOutputLogPath()
  const rawResult = await runProcessWithGroup({
    shellPath,
    shellArgs,
    cwd,
    env: buildCodeExecutionEnv(sanitizeChildEnv({}, { inheritKeys: inheritedEnvKeys })),
    timeout,
    maxBuffer: SHELL_MAX_OUTPUT,
    windowsHide: true,
    // Node's default Windows argv quoting rewrites embedded quotes in the
    // command passed to cmd.exe. Preserve the command exactly so quoted paths
    // containing characters such as parentheses remain valid.
    windowsVerbatimArguments: isWin,
    signal,
    overflowMode: 'tail',
    fullOutputPath: outputLogPath,
    onOutput,
  })
  const r = redactProcessOutput(rawResult, sensitiveEnvValues)
  const durationMs = Date.now() - startedAt
  const auditArgs = {
    command,
    cwd: displayCwd,
    ...(inheritedEnvKeys.length > 0 ? { env_keys: inheritedEnvKeys } : {}),
    ...(expectedTargets.length > 0
      ? { expected_outputs: expectedTargets.map((target) => target.path) }
      : {}),
  }
  const outputVerification = expectedTargets.length > 0
    ? await verifyExpectedOutputs(expectedTargets)
    : null
  const inferredVerification = inferredTargets.length > 0
    ? await verifyExpectedOutputs(inferredTargets)
    : null
  const inferredChanges = inferredVerification?.changedPaths?.length > 0
    ? {
        verifiedOutputs: inferredVerification.verifiedOutputs,
        changedPaths: inferredVerification.changedPaths,
      }
    : null
  const verificationFields = outputVerification || inferredChanges || {}
  const failureHint = codeExecutionFailureHint(command, {
    platform: process.platform,
    stderr: r.stderr,
  })
  const executionMetadata = {
    durationMs,
    ...(r.truncated ? {
      truncated: true,
      totalOutputBytes: r.totalOutputBytes,
      ...(r.fullOutputPath ? { fullOutputPath: r.fullOutputPath } : {}),
      outputNotice: r.fullOutputPath
        ? '输出过长，已保留尾部；完整日志已写入 fullOutputPath。'
        : sensitiveEnvValues.length > 0
          ? '输出过长，已保留并脱敏尾部；为避免凭据写入磁盘，完整日志未落盘。'
          : '输出过长，已保留尾部；完整日志写入失败。',
    } : {}),
    ...(r.sensitiveOutputRedacted ? { sensitiveOutputRedacted: true } : {}),
    ...(r.outputLogError ? { outputLogError: r.outputLogError } : {}),
  }

  if (r.processTreeCleanupFailed) {
    if (userId) writeToolAudit({ userId, origin: 'bash', toolName: 'bash_exec', args: auditArgs, status: 'error', durationMs })
    return {
      ok: false,
      code: 'PROCESS_TREE_CLEANUP_FAILED',
      processTreeCleanupFailed: true,
      ...(r.aborted ? { cancelled: true } : {}),
      ...(r.timedOut ? { timedOut: true } : {}),
      ...(r.truncated ? { truncated: true } : {}),
      error: '命令已停止，但无法确认所有子进程都已退出',
      hint: '请检查仍在运行的子进程；在确认清理完成前不要重试会修改同一目录的命令。',
      stdout: r.stdout,
      stderr: r.stderr,
      cwd: displayCwd,
      ...executionMetadata,
      ...verificationFields,
    }
  }
  if (r.aborted) {
    if (userId) writeToolAudit({ userId, origin: 'bash', toolName: 'bash_exec', args: auditArgs, status: 'cancelled', durationMs })
    return {
      ok: false,
      cancelled: true,
      error: '命令已取消，进程组已清理',
      stdout: r.stdout,
      stderr: r.stderr,
      cwd: displayCwd,
      ...executionMetadata,
      ...(failureHint ? { hint: failureHint } : {}),
      ...verificationFields,
    }
  }
  if (r.timedOut) {
    if (userId) writeToolAudit({ userId, origin: 'bash', toolName: 'bash_exec', args: auditArgs, status: 'timeout', durationMs })
    return {
      ok: false,
      timedOut: true,
      error: `命令超时(${timeout}ms),进程组已被清理`,
      stdout: r.stdout,
      stderr: r.stderr,
      cwd: displayCwd,
      ...executionMetadata,
      ...(failureHint ? { hint: failureHint } : {}),
      ...verificationFields,
    }
  }
  if (r.code !== 0) {
    if (userId) writeToolAudit({ userId, origin: 'bash', toolName: 'bash_exec', args: auditArgs, status: 'error', durationMs })
    return {
      ok: false,
      exitCode: r.code,
      signal: r.signal,
      error: `命令退出码 ${r.code}${r.signal ? ` (signal=${r.signal})` : ''}`,
      stdout: r.stdout,
      stderr: r.stderr,
      cwd: displayCwd,
      ...executionMetadata,
      ...verificationFields,
    }
  }
  if (outputVerification?.unverifiedOutputs.length > 0) {
    if (userId) writeToolAudit({ userId, origin: 'bash', toolName: 'bash_exec', args: auditArgs, status: 'error', durationMs })
    const failures = outputVerification.unverifiedOutputs
      .map((output) => `${output.path} (${output.status})`)
      .join('、')
    return {
      ok: false,
      exitCode: 0,
      code: 'EXPECTED_OUTPUT_VERIFICATION_FAILED',
      verificationFailed: true,
      retryable: true,
      error: `命令退出成功，但 expected_outputs 未创建或未发生变化：${failures}`,
      stdout: r.stdout,
      stderr: r.stderr,
      cwd: displayCwd,
      ...executionMetadata,
      ...verificationFields,
    }
  }
  if (userId) writeToolAudit({ userId, origin: 'bash', toolName: 'bash_exec', args: auditArgs, status: 'ok', durationMs })
  return {
    ok: true,
    exitCode: 0,
    stdout: r.stdout,
    stderr: r.stderr,
    cwd: displayCwd,
    ...executionMetadata,
    ...verificationFields,
  }
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
export async function dispatchFsShellTool(name, args, { userId = null, signal = null, onOutput = null } = {}) {
  const argsWithUser = userId ? { ...args, userId } : args
  switch (name) {
    case 'list_directory': return listDirectoryTool(argsWithUser)
    case 'read_file': return readFileTool(argsWithUser)
    case 'write_file': return writeFileTool(argsWithUser)
    case 'edit_file': return editFileTool(argsWithUser)
    case 'bash_exec': return bashExecTool({ ...argsWithUser, signal, onOutput })
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
          timeout_ms: { type: 'integer', default: SHELL_DEFAULT_TIMEOUT_MS, minimum: 1000, maximum: SHELL_MAX_TIMEOUT_MS, description: '超时毫秒数，默认 600000，最大 21600000（6 小时）' },
          expected_outputs: { type: 'array', default: [], items: { type: 'string' }, description: '命令预期创建或修改的文件路径;只读命令留空.' },
          env_keys: { type: 'array', maxItems: SHELL_MAX_ENV_KEYS, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }, description: '可选宿主环境变量名称。仅在本次高风险审批通过后按名称注入；变量值不会进入工具参数或结果，Gugo 自身模型/认证密钥始终禁止。' },
        },
        required: ['command'],
      },
    },
  },
]
