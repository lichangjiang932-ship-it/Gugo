import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { getDb } from '../db.js'
import { getRuntimeEnv } from '../utils/runtimeEnv.js'
import { isApprovalBypassEnabled } from './approvalSettingsStore.js'
import { getWorkspaceTrustStatus } from './workspaceTrustService.js'
import { resolveManagedAttachmentPath } from './managedAttachmentStore.js'

const execFileAsync = promisify(execFile)
const MAX_GRANTS = 64
const PICKER_TIMEOUT_MS = 2 * 60 * 1000

function isLoopbackHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/**
 * Local code execution is available by default only for the desktop-style
 * single-user deployment bound to loopback. Multi-user or remotely bound
 * servers must opt in explicitly with LOCAL_CODE_EXECUTION_ENABLED=1.
 */
export function isLocalCodeExecutionEnabled(env = getRuntimeEnv()) {
  if (env.LOCAL_CODE_EXECUTION_ENABLED === '1') return true
  if (env.LOCAL_CODE_EXECUTION_ENABLED === '0') return false
  const authMode = String(env.AUTH_MODE || 'local').trim().toLowerCase()
  const serverHost = String(env.SERVER_HOST || '127.0.0.1').trim()
  return authMode === 'local' && isLoopbackHost(serverHost)
}

function serviceError(message, statusCode = 400, code = 'LOCAL_FILE_ACCESS_ERROR') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function workspaceRoot() {
  return path.resolve(process.env.WORKSPACE_ROOT?.trim() || process.cwd())
}

function sharedWorkspaceTrusted() {
  return process.env.WORKSPACE_SHARED_TRUSTED === '1'
}

function realPath(input) {
  // Keep one canonical representation across Node APIs on Windows. The
  // native variant expands 8.3 aliases (for example RUNNER~1) while the
  // regular variant preserves the representation returned by os.tmpdir().
  // Mixing the two makes an already-authorized path appear different.
  return fs.realpathSync(input)
}

function samePath(left, right) {
  const a = path.normalize(left)
  const b = path.normalize(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertPathWritable(canonicalPath, stat) {
  let descriptor = null
  let probePath = canonicalPath
  let createdProbe = false
  try {
    if (stat.isDirectory()) {
      probePath = path.join(canonicalPath, `.gugo-write-probe-${crypto.randomUUID()}.tmp`)
      descriptor = fs.openSync(probePath, 'wx')
      createdProbe = true
    } else {
      descriptor = fs.openSync(canonicalPath, 'r+')
    }
    fs.closeSync(descriptor)
    descriptor = null
    if (createdProbe) {
      fs.unlinkSync(probePath)
      createdProbe = false
    }
  } catch (cause) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor) } catch { /* best effort */ }
    }
    if (createdProbe) {
      try { fs.unlinkSync(probePath) } catch { /* best effort */ }
    }
    const error = serviceError(
      `所选路径无法写入（${cause?.code || 'WRITE_DENIED'}）：${canonicalPath}。`
        + '授权未保存，请先检查 Windows 文件夹权限、只读属性或安全软件拦截。',
      403,
      'PATH_NOT_WRITABLE',
    )
    error.path = canonicalPath
    error.retryable = false
    error.hint = '同一根目录下改试 src、.tmp、output 不会解决；修复目录权限后再授权一次。'
    error.cause = cause
    throw error
  }
}

function resolveTarget(rawPath, { allowMissing = false } = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw serviceError('path 必填', 400, 'PATH_REQUIRED')
  }
  const fullPath = path.resolve(rawPath.trim())
  try {
    return { fullPath: realPath(fullPath), anchorPath: null, exists: true }
  } catch {
    if (!allowMissing) {
      throw serviceError(`路径不存在或无法访问: ${rawPath}`, 404, 'PATH_NOT_FOUND')
    }
    let probe = fullPath
    while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe)
    let anchorPath
    try {
      anchorPath = realPath(probe)
    } catch {
      throw serviceError('无可锚定的祖先目录', 404, 'PATH_NOT_FOUND')
    }
    return { fullPath, anchorPath, exists: false }
  }
}

function mapGrant(row) {
  let available = false
  try { available = fs.existsSync(row.root_path) } catch { /* unavailable */ }
  return {
    id: row.id,
    path: row.root_path,
    resourceType: row.resource_type,
    accessMode: row.access_mode,
    available,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function getSettingsRow(userId) {
  return getDb().prepare(
    'SELECT all_files_enabled, updated_at FROM local_file_access_settings WHERE user_id = ?'
  ).get(userId)
}

function getGrantRows(userId) {
  return getDb().prepare(
    'SELECT * FROM local_file_grants WHERE user_id = ? ORDER BY created_at ASC'
  ).all(userId)
}

export function getLocalFileAccessStatus({ userId }) {
  if (!userId) throw serviceError('userId 必填', 400, 'USER_REQUIRED')
  const settings = getSettingsRow(userId)
  const grants = getGrantRows(userId).map(mapGrant)
  const workspaceEnabled = process.env.WORKSPACE_FS_ENABLED === '1'
  const root = workspaceEnabled ? workspaceRoot() : null
  const bypassEnabled = isApprovalBypassEnabled({ userId })
  return {
    allFilesEnabled: !!settings?.all_files_enabled,
    bypassEnabled,
    grants,
    workspace: {
      enabled: workspaceEnabled,
      path: root,
      sharedTrusted: workspaceEnabled && sharedWorkspaceTrusted(),
      requiresUserGrant: workspaceEnabled && !sharedWorkspaceTrusted(),
      trust: root ? getWorkspaceTrustStatus({ userId, rootPath: root }) : null,
    },
    // Return policy status for every authorized directory, including untrusted
    // ones, so the UI can show the actual read/write/shell/git boundary.
    trustedWorkspaces: grants
      .filter((grant) => grant.resourceType === 'directory')
      .map((grant) => getWorkspaceTrustStatus({ userId, rootPath: grant.path })),
    runtime: {
      platform: process.platform,
      pickerAvailable: ['win32', 'darwin', 'linux'].includes(process.platform),
      hostFileSystem: true,
      localCodeExecutionEnabled: isLocalCodeExecutionEnabled(),
    },
  }
}

/**
 * Return the persisted directory grant that already satisfies a concrete
 * request_directory call. Explicit permission bypass is a user-selected
 * read/write authority, while the separate all-files toggle and exact-file
 * grants still do not grant shell/code execution authority.
 */
export function findAuthorizedDirectoryGrant({
  userId,
  rawPath,
  accessMode = 'read_only',
} = {}) {
  if (!userId || typeof rawPath !== 'string' || !rawPath.trim()) return null
  if (!['read_only', 'read_write'].includes(accessMode)) return null
  if (!path.isAbsolute(rawPath.trim())) return null

  let target
  try {
    target = resolveTarget(rawPath.trim(), { allowMissing: true })
  } catch {
    return null
  }
  const checkedPath = target.exists ? target.fullPath : target.anchorPath
  if (!checkedPath) return null

  if (isApprovalBypassEnabled({ userId })) {
    let authorizedPath = target.fullPath
    try {
      if (target.exists && fs.statSync(target.fullPath).isFile()) {
        authorizedPath = path.dirname(target.fullPath)
      }
    } catch {
      // The canonical target already passed resolution; retain it if stat
      // becomes unavailable between those operations.
    }
    return {
      id: `permission-bypass:${userId}`,
      path: authorizedPath,
      resourceType: 'directory',
      accessMode: 'read_write',
      available: target.exists,
      createdAt: null,
      updatedAt: null,
      source: 'bypass',
    }
  }

  const row = getGrantRows(userId).find((grant) => {
    if (grant.resource_type !== 'directory') return false
    if (accessMode === 'read_write' && grant.access_mode !== 'read_write') return false
    try {
      if (!fs.existsSync(grant.root_path)) return false
      return isInside(grant.root_path, checkedPath)
    } catch {
      return false
    }
  })
  return row ? mapGrant(row) : null
}

export function isExistingLocalDirectory(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim() || !path.isAbsolute(rawPath.trim())) return false
  try {
    const target = resolveTarget(rawPath.trim())
    return fs.statSync(target.fullPath).isDirectory()
  } catch {
    return false
  }
}

export function grantLocalPath({ userId, rootPath, accessMode = 'read_write', now = Date.now() }) {
  if (!userId) throw serviceError('userId 必填', 400, 'USER_REQUIRED')
  if (!['read_only', 'read_write'].includes(accessMode)) {
    throw serviceError('accessMode 仅支持 read_only 或 read_write', 400, 'INVALID_ACCESS_MODE')
  }
  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    throw serviceError('请选择或输入文件/文件夹绝对路径', 400, 'PATH_REQUIRED')
  }
  if (!path.isAbsolute(rootPath.trim())) {
    throw serviceError('必须使用绝对路径', 400, 'ABSOLUTE_PATH_REQUIRED')
  }
  let canonicalPath
  try {
    canonicalPath = realPath(path.resolve(rootPath.trim()))
  } catch {
    throw serviceError('路径不存在或无法访问', 404, 'PATH_NOT_FOUND')
  }
  const stat = fs.statSync(canonicalPath)
  if (!stat.isDirectory() && !stat.isFile()) {
    throw serviceError('仅支持普通文件或文件夹', 400, 'UNSUPPORTED_RESOURCE')
  }
  if (accessMode === 'read_write') assertPathWritable(canonicalPath, stat)

  const db = getDb()
  const rows = getGrantRows(userId)
  const existing = rows.find((row) => samePath(row.root_path, canonicalPath))
  if (!existing && rows.length >= MAX_GRANTS) {
    throw serviceError(`最多授权 ${MAX_GRANTS} 个文件或文件夹`, 409, 'GRANT_LIMIT_REACHED')
  }
  const id = existing?.id || crypto.randomUUID()
  db.prepare(`
    INSERT INTO local_file_grants
      (id, user_id, root_path, resource_type, access_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      root_path = excluded.root_path,
      resource_type = excluded.resource_type,
      access_mode = excluded.access_mode,
      updated_at = excluded.updated_at
  `).run(
    id,
    userId,
    canonicalPath,
    stat.isDirectory() ? 'directory' : 'file',
    accessMode,
    existing?.created_at || now,
    now
  )
  return mapGrant(db.prepare('SELECT * FROM local_file_grants WHERE id = ? AND user_id = ?').get(id, userId))
}

export function revokeLocalPath({ userId, id }) {
  if (!userId || !id) return false
  return getDb().prepare('DELETE FROM local_file_grants WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
}

export function setAllFilesAccess({ userId, enabled, confirmation, now = Date.now() }) {
  if (!userId) throw serviceError('userId 必填', 400, 'USER_REQUIRED')
  if (enabled && confirmation !== 'ALLOW_ALL_LOCAL_FILES') {
    throw serviceError('开启全盘访问需要明确确认', 400, 'CONFIRMATION_REQUIRED')
  }
  getDb().prepare(`
    INSERT INTO local_file_access_settings (user_id, all_files_enabled, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      all_files_enabled = excluded.all_files_enabled,
      updated_at = excluded.updated_at
  `).run(userId, enabled ? 1 : 0, now)
  return getLocalFileAccessStatus({ userId })
}

export function resolveAuthorizedLocalPath({
  userId,
  rawPath,
  write = false,
  allowMissing = false,
  allowWorkspace = process.env.WORKSPACE_FS_ENABLED === '1',
}) {
  const raw = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (!raw) throw serviceError('path 必填', 400, 'PATH_REQUIRED')
  const managedAttachment = resolveManagedAttachmentPath({ userId, rawPath: raw, write })
  if (managedAttachment) return managedAttachment
  const bypassEnabled = isApprovalBypassEnabled({ userId })
  const workspaceEnabled = allowWorkspace === true
  const workspaceTrusted = workspaceEnabled && (!userId || sharedWorkspaceTrusted())
  if (!path.isAbsolute(raw) && !workspaceEnabled && !bypassEnabled) {
    // ★ 报错要告诉模型「你能用什么」,而不只是「你不能用什么」。
    //
    // 原来只说「请使用已授权范围内的绝对路径」—— 模型不知道授权了哪些目录,
    // 只能瞎猜或者放弃。实测日志里它连着试了 5 种路径写法全失败,
    // 最后绕道用 read_file 硬啃,或者干脆改去生成 PPT 交差。
    // 把已授权的根目录直接列出来,它下一次调用就能命中。
    let hint = ''
    try {
      const roots = getGrantRows(userId).map((row) => row.root_path).filter(Boolean)
      hint = roots.length
        ? ` 当前已授权：${roots.slice(0, 5).join('、')}${roots.length > 5 ? ` 等 ${roots.length} 个` : ''}。请改用其中之一开头的绝对路径。`
        : ' 当前没有任何已授权目录，请先在「设置 → 本地文件」里添加要访问的文件夹。'
    } catch {
      /* 取不到授权列表不影响报错本身 */
    }
    throw serviceError(
      `本地文件模式请使用绝对路径（收到相对路径 "${raw}"）。${hint}`,
      403,
      'ABSOLUTE_PATH_REQUIRED',
    )
  }

  const basePath = path.isAbsolute(raw) ? raw : path.resolve(workspaceRoot(), raw)
  const target = resolveTarget(basePath, { allowMissing })
  const checkedPath = target.exists ? target.fullPath : target.anchorPath

  if (bypassEnabled) {
    return {
      fullPath: target.fullPath,
      displayPath: target.fullPath,
      source: 'bypass',
      rootPath: path.parse(target.fullPath).root,
    }
  }

  if (workspaceTrusted) {
    const root = realPath(workspaceRoot())
    if (isInside(root, checkedPath)) {
      return {
        fullPath: target.fullPath,
        displayPath: path.relative(root, target.fullPath).split(path.sep).join('/'),
        source: 'workspace',
        rootPath: root,
      }
    }
  }

  if (!userId) {
    const err = serviceError('路径越出 workspace', 403, 'PATH_NOT_AUTHORIZED')
    err.path = target.fullPath || rawPath || ''
    err.suggestGrantPath = err.path
    err.requiredAccessMode = write ? 'read_write' : 'read_only'
    throw err
  }
  if (getSettingsRow(userId)?.all_files_enabled) {
    return {
      fullPath: target.fullPath,
      displayPath: target.fullPath,
      source: 'all_files',
      rootPath: path.parse(target.fullPath).root,
    }
  }

  const grants = getGrantRows(userId)
  const grant = grants.find((row) => {
    if (write && row.access_mode !== 'read_write') return false
    if (row.resource_type === 'file') return target.exists && samePath(row.root_path, target.fullPath)
    return isInside(row.root_path, checkedPath)
  })
  if (!grant) {
    // ★ 把具体路径带进错误里。以前只说「该路径未获得读取授权」,模型无法告诉用户
    // 到底要授权哪个目录,用户就卡在「它说读不到,但我不知道去哪开」。
    const shown = target.fullPath || rawPath || ''
    const err = serviceError(
      `${write ? '该路径未获得写入授权' : '该路径未获得读取授权'}：${shown}`
        + '。请在聊天输入框上方点「本地文件」授权这个目录后重试。',
      403,
      'PATH_NOT_AUTHORIZED'
    )
    err.path = shown
    // 给模型一个可直接转述的提示:授权哪个目录最省事(文件就给它的父目录)
    let suggest = target.exists ? shown : (target.anchorPath || path.dirname(shown))
    try {
      if (target.exists && fs.statSync(target.fullPath).isFile()) {
        suggest = path.dirname(target.fullPath)
      }
    } catch {
      // stat 失败就用原路径,不影响主流程
    }
    err.suggestGrantPath = suggest
    err.requiredAccessMode = write ? 'read_write' : 'read_only'
    throw err
  }
  return {
    fullPath: target.fullPath,
    displayPath: target.fullPath,
    source: 'grant',
    rootPath: grant.root_path,
    grantId: grant.id,
  }
}

export async function pickLocalDirectory() {
  let result
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dialog.Description = '选择允许 Gugo 访问的文件夹'",
      '$dialog.ShowNewFolderButton = $true',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
    ].join('; ')
    result = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      timeout: PICKER_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024,
    })
  } else if (process.platform === 'darwin') {
    result = await execFileAsync('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a folder for Gugo")'], {
      timeout: PICKER_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    })
  } else if (process.platform === 'linux') {
    result = await execFileAsync('zenity', ['--file-selection', '--directory', '--title=Choose a folder for Gugo'], {
      timeout: PICKER_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    })
  } else {
    throw serviceError('当前系统不支持原生文件夹选择器，请直接输入绝对路径', 501, 'PICKER_UNAVAILABLE')
  }
  const selected = String(result.stdout || '').trim()
  return selected ? realPath(selected) : null
}
