import fs from 'node:fs'
import path from 'node:path'

export const LOCAL_FILE_GRANT_SCOPES = Object.freeze({
  PERSISTENT: 'persistent',
  SESSION: 'session',
})

export function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function accessModeSatisfies(actual, requested) {
  return actual === 'read_write' || requested === 'read_only'
}

export function mapGrant(row) {
  let available = false
  try { available = fs.existsSync(row.root_path) } catch { /* unavailable */ }
  return {
    id: row.id,
    path: row.root_path,
    resourceType: row.resource_type,
    accessMode: row.access_mode,
    scope: row.scope || LOCAL_FILE_GRANT_SCOPES.PERSISTENT,
    available,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Revalidate the exact grant identity persisted in a checkpoint. A covering
 * parent grant is valid for a new request, but it must never replace the
 * session/persistent grant that the checkpoint was originally bound to.
 */
export function findAuthorizedDirectoryGrantByIdAndScope({
  userId,
  grantId,
  authorizationScope,
  rawPath,
  accessMode = 'read_only',
} = {}, {
  findAuthorizedDirectoryGrant,
  getPersistentGrantRows,
  getSessionGrantRows,
  resolveDirectoryRequestPath,
  resolveTarget,
} = {}) {
  const normalizedGrantId = String(grantId || '').trim()
  const normalizedScope = String(authorizationScope || '').trim()
  if (!userId || !normalizedGrantId || typeof rawPath !== 'string' || !rawPath.trim()) return null
  if (!['read_only', 'read_write'].includes(accessMode)) return null

  if (normalizedScope === 'bypass') {
    const grant = findAuthorizedDirectoryGrant({ userId, rawPath, accessMode })
    return grant?.id === normalizedGrantId && grant?.scope === normalizedScope ? grant : null
  }
  const rows = normalizedScope === LOCAL_FILE_GRANT_SCOPES.SESSION
    ? getSessionGrantRows(userId)
    : normalizedScope === LOCAL_FILE_GRANT_SCOPES.PERSISTENT
      ? getPersistentGrantRows(userId)
      : []
  const row = rows.find((grant) => String(grant.id || '').trim() === normalizedGrantId)
  if (row?.resource_type !== 'directory' || !accessModeSatisfies(row.access_mode, accessMode)) return null

  try {
    const requestedPath = resolveDirectoryRequestPath({ userId, rawPath })
    const target = resolveTarget(requestedPath, { allowMissing: true })
    const checkedPath = target.exists ? target.fullPath : target.anchorPath
    if (!checkedPath || !fs.existsSync(row.root_path) || !isInside(row.root_path, checkedPath)) return null
    return mapGrant(row)
  } catch {
    return null
  }
}
