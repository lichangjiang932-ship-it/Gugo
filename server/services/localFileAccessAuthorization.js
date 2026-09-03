import fs from 'node:fs'
import path from 'node:path'
import { isApprovalBypassEnabled } from './approvalSettingsStore.js'
import { resolveManagedAttachmentPath } from './managedAttachmentStore.js'
import {
  findAuthorizedDirectoryGrantByIdAndScope as findAuthorizedDirectoryGrantByIdAndScopeWithDependencies,
  isInside,
  mapGrant,
} from './localFileGrantIdentity.js'
import {
  getGrantRows,
  getPersistentGrantRows,
  getSessionGrantRows,
  getSettingsRow,
} from './localFileAccessGrantStore.js'
import {
  realPath,
  resolveTarget,
  samePath,
  serviceError,
  sharedWorkspaceTrusted,
  workspaceRoot,
} from './localFileAccessPathPolicy.js'

export function findAuthorizedDirectoryGrant({
  userId,
  rawPath,
  accessMode = 'read_only',
} = {}, { resolveDirectoryRequestPath }) {
  if (!userId || typeof rawPath !== 'string' || !rawPath.trim()) return null
  if (!['read_only', 'read_write'].includes(accessMode)) return null
  const requestedPath = resolveDirectoryRequestPath({ userId, rawPath })

  let target
  try {
    target = resolveTarget(requestedPath, { allowMissing: true })
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
      scope: 'bypass',
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

export function findAuthorizedDirectoryGrantByIdAndScope(
  options = {},
  { resolveDirectoryRequestPath },
) {
  return findAuthorizedDirectoryGrantByIdAndScopeWithDependencies(options, {
    findAuthorizedDirectoryGrant: (grantOptions) => findAuthorizedDirectoryGrant(
      grantOptions,
      { resolveDirectoryRequestPath },
    ),
    getPersistentGrantRows,
    getSessionGrantRows,
    resolveDirectoryRequestPath,
    resolveTarget,
  })
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

export function resolveAuthorizedLocalPath({
  userId,
  rawPath,
  write = false,
  allowMissing = false,
  allowWorkspace = process.env.WORKSPACE_FS_ENABLED === '1',
  allowAllFiles = true,
}, { getProjectDirectory }) {
  const raw = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (!raw) throw serviceError('path 必填', 400, 'PATH_REQUIRED')
  const managedAttachment = resolveManagedAttachmentPath({ userId, rawPath: raw, write })
  if (managedAttachment) return managedAttachment
  const bypassEnabled = isApprovalBypassEnabled({ userId })
  const workspaceEnabled = allowWorkspace === true
  const workspaceTrusted = workspaceEnabled && (!userId || sharedWorkspaceTrusted())
  const projectDirectory = getProjectDirectory({ userId })
  const hasProjectGrant = Boolean(userId && getGrantRows(userId).some((row) => (
    row.resource_type === 'directory'
    && fs.existsSync(row.root_path)
    && samePath(row.root_path, projectDirectory)
  )))
  if (!path.isAbsolute(raw) && !workspaceEnabled && !bypassEnabled && !hasProjectGrant) {
    // Include the authorized roots so the caller can correct a relative path
    // without guessing which absolute directory is available.
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

  const basePath = path.isAbsolute(raw) ? raw : path.resolve(projectDirectory, raw)
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
    const error = serviceError('路径越出 workspace', 403, 'PATH_NOT_AUTHORIZED')
    error.path = target.fullPath || rawPath || ''
    error.suggestGrantPath = error.path
    error.requiredAccessMode = write ? 'read_write' : 'read_only'
    throw error
  }
  if (allowAllFiles && getSettingsRow(userId)?.all_files_enabled) {
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
    const shown = target.fullPath || rawPath || ''
    const error = serviceError(
      `${write ? '该路径未获得写入授权' : '该路径未获得读取授权'}：${shown}`
        + '。请在聊天输入框上方点「本地文件」授权这个目录后重试。',
      403,
      'PATH_NOT_AUTHORIZED'
    )
    error.path = shown
    let suggest = target.exists ? shown : (target.anchorPath || path.dirname(shown))
    try {
      if (target.exists && fs.statSync(target.fullPath).isFile()) {
        suggest = path.dirname(target.fullPath)
      }
    } catch {
      // stat failure does not change the authorization error.
    }
    error.suggestGrantPath = suggest
    error.requiredAccessMode = write ? 'read_write' : 'read_only'
    throw error
  }
  return {
    fullPath: target.fullPath,
    displayPath: target.fullPath,
    source: 'grant',
    rootPath: grant.root_path,
    grantId: grant.id,
  }
}
