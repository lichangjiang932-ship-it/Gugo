import { getDb } from '../db.js'
import { deleteManagedAttachmentsForSession } from './managedAttachmentStore.js'
import { runGovernedSessionDeletion } from './sessionDeletionGovernanceRuntime.js'
import { enqueueSessionContentEventInDb } from './sessionContentOutboxStore.js'
import {
  normalizeSessionExpectedRevision,
  normalizeSessionWorkspacePath,
} from './sessionMutationValidation.js'
import {
  clampLimit,
  clampOffset,
  contentEventTimestamp,
  getSessionRecord,
  listSessionContentSnapshots,
  mapSession,
  normalizeArchivedFilter,
  SessionOwnershipError,
  SessionRevisionConflictError,
} from './sessionStoreShared.js'

export { SessionMutationValidationError } from './sessionMutationValidation.js'
export {
  MessageOwnershipError,
  SessionBranchDepthError,
  SessionOwnershipError,
  SessionRevisionConflictError,
} from './sessionStoreShared.js'
export { forkSession, getSessionBranches } from './sessionBranchStore.js'
export {
  deleteMessage,
  getMessage,
  getPreviousUserMessage,
  getSessionSnapshot,
  listMessages,
  replaceSessionMessages,
  upsertMessage,
} from './sessionMessageStore.js'

const LOCAL_OWNER_META_KEY = 'local_auth_owner_user_id'
const SESSION_SCOPED_TABLES = [
  ['messages', 'session_id'],
  ['turn_events', 'session_id'],
  ['turn_artifacts', 'session_id'],
  ['pending_approvals', 'session_id'],
  ['session_meters', 'session_id'],
  ['compaction_archive', 'session_id'],
  ['memories', 'source_session_id'],
  ['subagent_runs', 'parent_session_id'],
]

function upsertSessionRecord({
  id,
  userId,
  title = 'Untitled',
  createdAt = Date.now(),
  updatedAt = createdAt,
  lastViewedAt = null,
  archivedAt = null,
  workspacePath = undefined,
}, { notifyLifecycle = true } = {}) {
  if (!id) throw new Error('session id is required')
  if (!userId) throw new Error('user id is required')
  const db = getDb()
  const owner = db.prepare('SELECT token, id, user_id, title, created_at FROM sessions WHERE token = ?').get(id)
  const ownerIsAuthSession = owner && owner.id === null && owner.title === null
  if (owner && (ownerIsAuthSession || owner.user_id !== userId)) throw new SessionOwnershipError()
  const row = owner?.user_id === userId ? owner : null
  const finalCreatedAt = row?.created_at || createdAt
  const normalizedWorkspacePath = normalizeSessionWorkspacePath(workspacePath)
  db.prepare(`
    INSERT INTO sessions
      (token, id, user_id, title, expires_at, created_at, updated_at, last_viewed_at,
        archived_at, workspace_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      id = excluded.id,
      title = excluded.title,
      updated_at = excluded.updated_at,
      last_viewed_at = COALESCE(excluded.last_viewed_at, sessions.last_viewed_at),
      archived_at = excluded.archived_at,
      workspace_path = CASE WHEN ? = 1 THEN excluded.workspace_path ELSE sessions.workspace_path END,
      revision = sessions.revision + 1
    WHERE sessions.user_id = excluded.user_id
  `).run(
    id,
    id,
    userId,
    title,
    Number.MAX_SAFE_INTEGER,
    finalCreatedAt,
    updatedAt,
    lastViewedAt,
    archivedAt,
    normalizedWorkspacePath,
    workspacePath === undefined ? 0 : 1,
  )
  if (!row && notifyLifecycle) notifySessionStarted({ userId, sessionId: id, title })
  return getSession({ userId, sessionId: id })
}

/** Best-effort notification; aggregate commits call this only after COMMIT. */
export function notifySessionStarted({ userId, sessionId, title = 'Untitled' } = {}) {
  if (!userId || !sessionId) return false
  void import('./hooksService.js')
    .then(({ dispatchHooks }) => dispatchHooks({
      userId,
      event: 'session_start',
      tool: null,
      args: { title },
      sessionId,
      requestId: sessionId,
      hookInvocationId: `session:${sessionId}:start`,
    }))
    .catch(() => { /* lifecycle hook is best-effort */ })
  return true
}

export function upsertSession(input) {
  return upsertSessionRecord(input)
}

/** Internal aggregate-store primitive: lifecycle notification is deferred. */
export function upsertSessionForAtomicCommit(input) {
  return upsertSessionRecord(input, { notifyLifecycle: false })
}

/** Internal aggregate-store primitive: callers own the surrounding transaction. */
export function setSessionWorkspacePathForAtomicCommit({
  userId,
  sessionId,
  workspacePath,
} = {}) {
  if (!userId || !sessionId) return false
  const normalizedWorkspacePath = normalizeSessionWorkspacePath(workspacePath)
  const result = getDb().prepare(`
    UPDATE sessions
    SET workspace_path = ?
    WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
  `).run(normalizedWorkspacePath, userId, sessionId)
  return result.changes === 1
}

/** Persist an explicit workspace selection (or clear) outside a Turn commit. */
export function setSessionWorkspace({
  userId,
  sessionId,
  workspacePath,
  now = Date.now(),
} = {}) {
  if (!userId || !sessionId) return null
  const normalizedWorkspacePath = normalizeSessionWorkspacePath(workspacePath)
  const result = getDb().prepare(`
    UPDATE sessions
    SET workspace_path = ?, updated_at = ?
    WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
  `).run(normalizedWorkspacePath, now, userId, sessionId)
  if (result.changes !== 1) return null
  return getSession({ userId, sessionId })
}
/**
 * Claim one legacy chat for the selected local-auth owner. This deliberately
 * does not merge whole users because providers and agents may exist on both.
 */
export function claimLocalChatSession({ userId, sessionId, authMode, now = Date.now() }) {
  if (authMode !== 'local' || !userId || !sessionId) return null
  const db = getDb()
  const localOwner = db.prepare('SELECT value FROM meta WHERE key = ?').get(LOCAL_OWNER_META_KEY)?.value
  if (localOwner !== userId) return null

  return db.transaction(() => {
    const session = db.prepare(`
      SELECT token, user_id
      FROM sessions
      WHERE token = ? AND (id IS NOT NULL OR title IS NOT NULL)
    `).get(sessionId)
    if (!session) return null
    if (session.user_id === userId) return getSession({ userId, sessionId })

    db.prepare(`
      UPDATE pending_approvals
      SET status = 'cancelled', updated_at = ?
      WHERE user_id = ? AND session_id = ? AND origin = 'chat' AND status = 'pending'
    `).run(now, session.user_id, sessionId)
    for (const [table, sessionColumn] of SESSION_SCOPED_TABLES) {
      db.prepare(`
        UPDATE ${table}
        SET user_id = ?
        WHERE user_id = ? AND ${sessionColumn} = ?
      `).run(userId, session.user_id, sessionId)
    }
    const claimed = db.prepare(`
      UPDATE sessions
      SET user_id = ?, updated_at = ?
      WHERE token = ? AND user_id = ? AND (id IS NOT NULL OR title IS NOT NULL)
    `).run(userId, now, sessionId, session.user_id)
    if (claimed.changes !== 1) return null
    enqueueSessionContentEventInDb(db, {
      userId: session.user_id,
      sessionId,
      eventType: 'session.delete',
      payload: {},
      createdAt: contentEventTimestamp(now),
    })
    enqueueSessionContentEventInDb(db, {
      userId,
      sessionId,
      eventType: 'session.replace',
      payload: { messages: listSessionContentSnapshots(db, { userId, sessionId }) },
      createdAt: contentEventTimestamp(now),
    })
    return getSession({ userId, sessionId })
  })()
}

export function getSession({ userId, sessionId }) {
  return getSessionRecord({ userId, sessionId })
}

/**
 * Check whether a token is already occupied without exposing its owner. This
 * includes auth-session rows, which must never be converted into chat rows.
 */
export function isSessionIdOccupied({ sessionId } = {}) {
  if (!sessionId) return false
  return !!getDb().prepare('SELECT 1 FROM sessions WHERE token = ?').get(sessionId)
}

export function listSessions({ userId, archived = 'false', limit = 100, offset = 0 } = {}) {
  if (!userId) return []
  const filter = normalizeArchivedFilter(archived)
  const clauses = ['user_id = @userId', '(id IS NOT NULL OR title IS NOT NULL)']
  if (filter === 'true') clauses.push('archived_at IS NOT NULL')
  if (filter === 'false') clauses.push('archived_at IS NULL')
  const rows = getDb().prepare(`
    SELECT token, id, title, created_at, updated_at, last_viewed_at, archived_at,
      pinned_at, revision, parent_session_id, branch_label, forked_at, workspace_path,
      COALESCE((SELECT MAX(turn_events.rowid) FROM turn_events
        WHERE turn_events.user_id = sessions.user_id
          AND turn_events.session_id = sessions.token), 0) AS turn_event_revision
    FROM sessions
    WHERE ${clauses.join(' AND ')}
    ORDER BY
      CASE WHEN pinned_at IS NULL THEN 1 ELSE 0 END ASC,
      pinned_at DESC,
      CASE WHEN pinned_at IS NULL THEN COALESCE(updated_at, created_at) ELSE 0 END DESC,
      token ASC
    LIMIT @limit OFFSET @offset
  `).all({
    userId,
    limit: clampLimit(limit, { fallback: 100, max: 200 }),
    offset: clampOffset(offset),
  })
  return rows.map(mapSession)
}

export function archiveSession({ userId, sessionId, now = Date.now() }) {
  if (!userId || !sessionId) return null
  const result = getDb().prepare(`
    UPDATE sessions
    SET archived_at = COALESCE(archived_at, ?), updated_at = ?, revision = revision + 1
    WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
  `).run(now, now, userId, sessionId)
  if (!result.changes) return null
  return getSession({ userId, sessionId })
}

export function unarchiveSession({ userId, sessionId, now = Date.now() }) {
  if (!userId || !sessionId) return null
  const result = getDb().prepare(`
    UPDATE sessions
    SET archived_at = NULL, updated_at = ?, revision = revision + 1
    WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
  `).run(now, userId, sessionId)
  if (!result.changes) return null
  return getSession({ userId, sessionId })
}

export function pinSession({ userId, sessionId, now = Date.now() }) {
  if (!userId || !sessionId) return null
  const result = getDb().prepare(`
    UPDATE sessions
    SET pinned_at = COALESCE(pinned_at, ?), revision = revision + 1
    WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
  `).run(now, userId, sessionId)
  if (!result.changes) return null
  return getSession({ userId, sessionId })
}

export function unpinSession({ userId, sessionId }) {
  if (!userId || !sessionId) return null
  const result = getDb().prepare(`
    UPDATE sessions
    SET pinned_at = NULL, revision = revision + 1
    WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
  `).run(userId, sessionId)
  if (!result.changes) return null
  return getSession({ userId, sessionId })
}

export function deleteSession({ userId, sessionId, expectedRevision } = {}, governanceDependencies) {
  if (!userId || !sessionId) return null
  const revision = normalizeSessionExpectedRevision(expectedRevision)
  const db = getDb()
  const validate = () => {
    const session = db.prepare(`
      SELECT token, revision
      FROM sessions
      WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
    `).get(userId, sessionId)
    if (!session) return null
    if (Number(session.revision) !== revision) {
      throw new SessionRevisionConflictError(session.revision)
    }
    return session
  }
  if (validate() === null) return null
  const result = runGovernedSessionDeletion({
    db,
    userId,
    sessionId,
    validate,
    commitDatabaseDeletion() {
    db.prepare(`
      UPDATE memories
      SET source_session_id = NULL, source_message_id = NULL
      WHERE user_id = ? AND source_session_id = ?
    `).run(userId, sessionId)
    db.prepare(`
      UPDATE subagent_runs
      SET parent_session_id = NULL, parent_message_id = NULL
      WHERE user_id = ? AND parent_session_id = ?
    `).run(userId, sessionId)
    for (const table of ['pending_approvals', 'session_meters', 'compaction_archive']) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND session_id = ?`).run(userId, sessionId)
    }
    enqueueSessionContentEventInDb(db, {
      userId,
      sessionId,
      eventType: 'session.delete',
      payload: {},
      createdAt: contentEventTimestamp(),
    })
    const result = db.prepare(`
      DELETE FROM sessions
      WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
    `).run(userId, sessionId)
    return result.changes === 1 ? { deleted: true, previousRevision: revision } : null
    },
  }, governanceDependencies)
  if (result?.deleted) {
    void import('./hooksService.js')
      .then(({ dispatchHooks }) => dispatchHooks({
        userId,
        event: 'session_end',
        tool: null,
        args: {},
        sessionId,
        requestId: sessionId,
        hookInvocationId: `session:${sessionId}:end`,
      }))
      .catch(() => { /* lifecycle hook is best-effort */ })
    try {
      deleteManagedAttachmentsForSession({ userId, sessionId })
    } catch (error) {
      // The session deletion is already committed. Keep the API result truthful;
      // the attachment maintenance pass will retry any filesystem cleanup.
      console.warn('[attachments] failed to clean deleted session:', error?.message || error)
    }
  }
  return result
}
