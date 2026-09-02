import fs from 'node:fs'
import path from 'node:path'
import { isToolPermittedForUser } from '../db.js'
import {
  findAuthorizedDirectoryGrant,
  isLocalCodeExecutionEnabled,
  resolveAuthorizedLocalPath,
} from '../services/localFileAccessService.js'
import { assertWorkspaceCapability } from '../services/workspaceTrustService.js'
import { extractAbsoluteShellPaths } from '../utils/bashGuard.js'

export const MAX_FILE_BYTES = 5 * 1024 * 1024
export const SHELL_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
export const SHELL_MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000
export const SHELL_MAX_OUTPUT = 1 * 1024 * 1024
export const SHELL_MAX_EXPECTED_OUTPUTS = 64
export const SHELL_MAX_ENV_KEYS = 32

export function getWorkspaceRoot() {
  const raw = process.env.WORKSPACE_ROOT?.trim()
  return path.resolve(raw || process.cwd())
}

function isFsEnabled() { return process.env.WORKSPACE_FS_ENABLED === '1' }
function isShellEnabled() { return process.env.WORKSPACE_SHELL_ENABLED === '1' }

export function badReq(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

export function mapWriteError(error, fullPath) {
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

export function assertToolPermitted(userId, toolName) {
  if (userId && !isToolPermittedForUser(userId, toolName)) {
    const error = badReq(`工具 ${toolName} 已被该用户在权限中心关闭`, 403)
    error.code = 'TOOL_DISABLED'
    throw error
  }
}

export function effectivePermissionToolName(permissionToolName, fallback) {
  return typeof permissionToolName === 'string' && permissionToolName.trim()
    ? permissionToolName.trim()
    : fallback
}

export function resolveForFileTool(rawPath, { userId = null, write = false, allowMissing = false } = {}) {
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
    allowAllFiles: false,
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

export function resolveShellCwdForCommand(rawCwd, { command, userId }) {
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

export function resolveInWorkspace(rawPath, { allowMissing = false } = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) throw badReq('path 必填')
  const root = getWorkspaceRoot()
  const full = path.resolve(root, rawPath)
  let real
  try {
    real = fs.realpathSync(full)
  } catch {
    if (!allowMissing) throw badReq(`路径不存在或无法访问: ${rawPath}`, 404)
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
