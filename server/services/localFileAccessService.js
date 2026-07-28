import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { getDb } from '../db.js'

const execFileAsync = promisify(execFile)
const MAX_GRANTS = 64
const PICKER_TIMEOUT_MS = 2 * 60 * 1000

function serviceError(message, statusCode = 400, code = 'LOCAL_FILE_ACCESS_ERROR') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function workspaceRoot() {
  return path.resolve(process.env.WORKSPACE_ROOT?.trim() || process.cwd())
}

function realPath(input) {
  return fs.realpathSync.native ? fs.realpathSync.native(input) : fs.realpathSync(input)
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
  return {
    allFilesEnabled: !!settings?.all_files_enabled,
    grants,
    workspace: {
      enabled: workspaceEnabled,
      path: workspaceEnabled ? workspaceRoot() : null,
    },
    runtime: {
      platform: process.platform,
      pickerAvailable: ['win32', 'darwin', 'linux'].includes(process.platform),
      hostFileSystem: true,
    },
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

export function resolveAuthorizedLocalPath({ userId, rawPath, write = false, allowMissing = false }) {
  const raw = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (!raw) throw serviceError('path 必填', 400, 'PATH_REQUIRED')
  const workspaceEnabled = process.env.WORKSPACE_FS_ENABLED === '1'
  if (!path.isAbsolute(raw) && !workspaceEnabled) {
    throw serviceError('本地文件模式请使用已授权范围内的绝对路径', 403, 'ABSOLUTE_PATH_REQUIRED')
  }

  const basePath = path.isAbsolute(raw) ? raw : path.resolve(workspaceRoot(), raw)
  const target = resolveTarget(basePath, { allowMissing })
  const checkedPath = target.exists ? target.fullPath : target.anchorPath

  if (workspaceEnabled) {
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
    throw serviceError('路径越出 workspace', 403, 'PATH_NOT_AUTHORIZED')
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
    throw serviceError(
      write ? '该路径未获得写入授权' : '该路径未获得读取授权',
      403,
      'PATH_NOT_AUTHORIZED'
    )
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
