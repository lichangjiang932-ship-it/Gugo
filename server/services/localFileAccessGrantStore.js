import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db.js'
import {
  LOCAL_FILE_GRANT_SCOPES,
  accessModeSatisfies,
  mapGrant,
} from './localFileGrantIdentity.js'
import {
  assertPathWritable,
  pathKey,
  realPath,
  samePath,
  serviceError,
} from './localFileAccessPathPolicy.js'

const MAX_GRANTS = 64
const sessionGrantsByUser = new Map()

function normalizeGrantScope(scope = LOCAL_FILE_GRANT_SCOPES.PERSISTENT) {
  if (scope === LOCAL_FILE_GRANT_SCOPES.PERSISTENT || scope === LOCAL_FILE_GRANT_SCOPES.SESSION) return scope
  throw serviceError('scope 仅支持 persistent 或 session', 400, 'INVALID_GRANT_SCOPE')
}

export function getSettingsRow(userId) {
  return getDb().prepare(
    'SELECT all_files_enabled, default_output_directory, updated_at FROM local_file_access_settings WHERE user_id = ?'
  ).get(userId)
}

export function getPersistentGrantRows(userId) {
  return getDb().prepare(
    'SELECT * FROM local_file_grants WHERE user_id = ? ORDER BY created_at ASC'
  ).all(userId).map((row) => ({ ...row, scope: LOCAL_FILE_GRANT_SCOPES.PERSISTENT }))
}

export function getSessionGrantRows(userId) {
  return userId ? [...(sessionGrantsByUser.get(userId)?.values() || [])] : []
}

export function getGrantRows(userId) {
  return [...getPersistentGrantRows(userId), ...getSessionGrantRows(userId)]
}

export function grantLocalPath({
  userId,
  rootPath,
  accessMode = 'read_write',
  scope = LOCAL_FILE_GRANT_SCOPES.PERSISTENT,
  now = Date.now(),
}) {
  if (!userId) throw serviceError('userId 必填', 400, 'USER_REQUIRED')
  if (!['read_only', 'read_write'].includes(accessMode)) {
    throw serviceError('accessMode 仅支持 read_only 或 read_write', 400, 'INVALID_ACCESS_MODE')
  }
  const normalizedScope = normalizeGrantScope(scope)
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

  const persistentRows = getPersistentGrantRows(userId)
  const sessionRows = getSessionGrantRows(userId)
  const persistent = persistentRows.find((row) => samePath(row.root_path, canonicalPath))
  const session = sessionRows.find((row) => samePath(row.root_path, canonicalPath))
  if (
    normalizedScope === LOCAL_FILE_GRANT_SCOPES.SESSION
    && persistent
    && accessModeSatisfies(persistent.access_mode, accessMode)
  ) {
    return mapGrant(persistent)
  }
  const existing = normalizedScope === LOCAL_FILE_GRANT_SCOPES.SESSION ? session : persistent
  const uniqueRoots = new Set([...persistentRows, ...sessionRows].map((row) => pathKey(row.root_path)))
  if (!existing && !uniqueRoots.has(pathKey(canonicalPath)) && uniqueRoots.size >= MAX_GRANTS) {
    throw serviceError(`最多授权 ${MAX_GRANTS} 个文件或文件夹`, 409, 'GRANT_LIMIT_REACHED')
  }
  if (normalizedScope === LOCAL_FILE_GRANT_SCOPES.SESSION) {
    let grants = sessionGrantsByUser.get(userId)
    if (!grants) {
      grants = new Map()
      sessionGrantsByUser.set(userId, grants)
    }
    const key = pathKey(canonicalPath)
    const row = {
      id: existing?.id || `session:${crypto.randomUUID()}`,
      user_id: userId,
      root_path: canonicalPath,
      resource_type: stat.isDirectory() ? 'directory' : 'file',
      access_mode: accessMode,
      created_at: existing?.created_at || now,
      updated_at: now,
      scope: LOCAL_FILE_GRANT_SCOPES.SESSION,
    }
    grants.set(key, row)
    return mapGrant(row)
  }

  const db = getDb()
  const id = persistent?.id || crypto.randomUUID()
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
    persistent?.created_at || now,
    now
  )
  if (session && accessModeSatisfies(accessMode, session.access_mode)) {
    const grants = sessionGrantsByUser.get(userId)
    grants?.delete(pathKey(canonicalPath))
    if (grants?.size === 0) sessionGrantsByUser.delete(userId)
  }
  return mapGrant(db.prepare('SELECT * FROM local_file_grants WHERE id = ? AND user_id = ?').get(id, userId))
}

export function revokeLocalPath({ userId, id }) {
  if (!userId || !id) return false
  const grants = sessionGrantsByUser.get(userId)
  if (grants) {
    const entry = [...grants.entries()].find(([, row]) => row.id === id)
    if (entry) {
      grants.delete(entry[0])
      if (grants.size === 0) sessionGrantsByUser.delete(userId)
      return true
    }
  }
  return getDb().prepare('DELETE FROM local_file_grants WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
}

export function clearSessionLocalFileGrants({ userId } = {}) {
  if (userId) return sessionGrantsByUser.delete(userId)
  const hadEntries = sessionGrantsByUser.size > 0
  sessionGrantsByUser.clear()
  return hadEntries
}
