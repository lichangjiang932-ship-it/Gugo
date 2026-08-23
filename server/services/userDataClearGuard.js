function clearGuardError(message = 'User data is currently being cleared') {
  const error = new Error(message)
  error.code = 'USER_DATA_CLEAR_IN_PROGRESS'
  error.statusCode = 409
  error.incomplete = false
  error.databaseCleared = false
  error.cleanupPending = false
  return error
}

function operationTableExists(db) {
  return !!db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'user_data_clear_operations'
  `).get()
}

export function userDataClearInProgress(db, userId) {
  const ownerId = String(userId || '').trim()
  if (!ownerId || !operationTableExists(db)) return false
  return !!db.prepare(`
    SELECT 1 FROM user_data_clear_operations WHERE owner_id = ? LIMIT 1
  `).get(ownerId)
}

export function anyUserDataClearInProgress(db) {
  if (!operationTableExists(db)) return false
  return !!db.prepare(`
    SELECT 1 FROM user_data_clear_operations LIMIT 1
  `).get()
}

export function assertUserDataMutationAllowed(db, userId, message) {
  if (userDataClearInProgress(db, userId)) throw clearGuardError(message)
}

/**
 * Managed artifact paths are globally addressable and can be referenced by
 * more than one user. Keep their database writers fenced for the complete
 * lifetime of every durable clear journal, including post-commit cleanup.
 */
export function assertManagedArtifactMutationAllowed(db, message) {
  if (anyUserDataClearInProgress(db)) throw clearGuardError(message)
}

export const _testing = {
  clearGuardError,
}
