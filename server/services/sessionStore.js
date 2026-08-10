import { getDb } from '../db.js'
import { listSessionTurnArtifacts } from './turnArtifactStore.js'
import { deleteManagedAttachmentsForSession } from './managedAttachmentStore.js'

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

export class SessionOwnershipError extends Error {
  constructor(message = 'session not found') {
    super(message)
    this.name = 'SessionOwnershipError'
    this.code = 'SESSION_OWNERSHIP_CONFLICT'
  }
}

export class SessionRevisionConflictError extends Error {
  constructor(currentRevision) {
    super('session revision conflict')
    this.name = 'SessionRevisionConflictError'
    this.code = 'SESSION_REVISION_CONFLICT'
    this.currentRevision = Number(currentRevision) || 0
  }
}

export class SessionMutationValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SessionMutationValidationError'
    this.code = 'INVALID_SESSION_MUTATION'
  }
}

function clampLimit(limit, { fallback = 50, max = 100 } = {}) {
  const value = Number(limit)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(max, Math.floor(value))
}

function clampOffset(offset) {
  const value = Number(offset)
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

function normalizeArchivedFilter(archived = 'false') {
  if (archived === true || archived === 'true') return 'true'
  if (archived === 'all') return 'all'
  return 'false'
}

function mapSession(row) {
  if (!row) return null
  return {
    id: row.id || row.token,
    title: row.title || 'Untitled',
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    lastViewedAt: row.last_viewed_at || null,
    archivedAt: row.archived_at || null,
    pinnedAt: row.pinned_at ?? null,
    revision: Number(row.revision) || 0,
  }
}

export function upsertSession({
  id,
  userId,
  title = 'Untitled',
  createdAt = Date.now(),
  updatedAt = createdAt,
  lastViewedAt = null,
  archivedAt = null,
}) {
  if (!id) throw new Error('session id is required')
  if (!userId) throw new Error('user id is required')
  const db = getDb()
  const owner = db.prepare('SELECT token, id, user_id, title, created_at FROM sessions WHERE token = ?').get(id)
  const ownerIsAuthSession = owner && owner.id === null && owner.title === null
  if (owner && (ownerIsAuthSession || owner.user_id !== userId)) throw new SessionOwnershipError()
  const row = owner?.user_id === userId ? owner : null
  const finalCreatedAt = row?.created_at || createdAt
  db.prepare(`
    INSERT INTO sessions (token, id, user_id, title, expires_at, created_at, updated_at, last_viewed_at, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      id = excluded.id,
      title = excluded.title,
      updated_at = excluded.updated_at,
      last_viewed_at = COALESCE(excluded.last_viewed_at, sessions.last_viewed_at),
      archived_at = excluded.archived_at,
      revision = sessions.revision + 1
    WHERE sessions.user_id = excluded.user_id
  `).run(id, id, userId, title, Number.MAX_SAFE_INTEGER, finalCreatedAt, updatedAt, lastViewedAt, archivedAt)
  return getSession({ userId, sessionId: id })
}

function parseModelContext(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0 ? parsed : null
  } catch {
    return null
  }
}

function serializeModelContext(value) {
  if (!value || typeof value !== 'object') return '{}'
  return JSON.stringify(value)
}

function normalizeExpectedRevision(value) {
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new SessionMutationValidationError('expectedRevision must be a non-negative integer')
  }
  return revision
}

function normalizeMessageContent(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

function normalizeReplacementMessages(messages, existingContexts, now) {
  if (!Array.isArray(messages)) {
    throw new SessionMutationValidationError('messages must be an array')
  }
  if (messages.length > 50_000) {
    throw new SessionMutationValidationError('messages exceeds the 50000 item limit')
  }
  const ids = new Set()
  return messages.map((message, index) => {
    const id = String(message?.id || '').trim()
    const role = String(message?.role || '').trim()
    if (!id || id.length > 512) {
      throw new SessionMutationValidationError(`messages[${index}].id is invalid`)
    }
    if (ids.has(id)) {
      throw new SessionMutationValidationError(`duplicate message id: ${id}`)
    }
    ids.add(id)
    if (!['user', 'assistant', 'system', 'tool'].includes(role)) {
      throw new SessionMutationValidationError(`messages[${index}].role is invalid`)
    }
    const createdAtValue = Number(message?.createdAt)
    const updatedAtValue = Number(message?.updatedAt)
    const createdAt = Number.isFinite(createdAtValue) ? Math.floor(createdAtValue) : now + index
    const updatedAt = Number.isFinite(updatedAtValue) ? Math.floor(updatedAtValue) : createdAt
    const providedContext = message?.modelContext && typeof message.modelContext === 'object'
      ? serializeModelContext(message.modelContext)
      : null
    return {
      id,
      role,
      content: normalizeMessageContent(message?.content),
      modelContextJson: providedContext || existingContexts.get(id) || '{}',
      createdAt,
      updatedAt,
    }
  })
}

function mapMessage(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    role: row.role,
    content: row.content,
    modelContext: parseModelContext(row.model_context_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
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
    return claimed.changes === 1 ? getSession({ userId, sessionId }) : null
  })()
}

export function getSession({ userId, sessionId }) {
  if (!userId || !sessionId) return null
  const row = getDb().prepare(`
    SELECT token, id, title, created_at, updated_at, last_viewed_at, archived_at, pinned_at, revision
    FROM sessions
    WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
  `).get(userId, sessionId)
  return mapSession(row)
}

export function listSessions({ userId, archived = 'false', limit = 100, offset = 0 } = {}) {
  if (!userId) return []
  const filter = normalizeArchivedFilter(archived)
  const clauses = ['user_id = @userId', '(id IS NOT NULL OR title IS NOT NULL)']
  if (filter === 'true') clauses.push('archived_at IS NOT NULL')
  if (filter === 'false') clauses.push('archived_at IS NULL')
  const rows = getDb().prepare(`
    SELECT token, id, title, created_at, updated_at, last_viewed_at, archived_at, pinned_at, revision
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

export function upsertMessage({
  id,
  userId,
  sessionId,
  role,
  content = '',
  modelContext = null,
  createdAt = Date.now(),
  updatedAt = createdAt,
}) {
  if (!id) throw new Error('message id is required')
  if (!userId) throw new Error('user id is required')
  if (!sessionId) throw new Error('session id is required')
  if (!role) throw new Error('message role is required')
  const db = getDb()
  const session = db.prepare(`
    SELECT title FROM sessions
    WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
  `).get(userId, sessionId)
  if (!session) throw new Error('session not found')
  const serializedContext = serializeModelContext(modelContext)
  db.transaction(() => {
    db.prepare(`
      INSERT INTO messages
        (id, session_id, user_id, role, content, session_title, model_context_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        role = excluded.role,
        content = excluded.content,
        session_title = excluded.session_title,
        model_context_json = excluded.model_context_json,
        updated_at = excluded.updated_at
      WHERE messages.user_id = excluded.user_id AND messages.session_id = excluded.session_id
    `).run(
      id,
      sessionId,
      userId,
      role,
      String(content ?? ''),
      session.title || '',
      serializedContext,
      createdAt,
      updatedAt,
    )
    db.prepare(`
      UPDATE sessions
      SET updated_at = CASE
        WHEN COALESCE(updated_at, 0) < ? THEN ?
        ELSE updated_at
      END
      WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
    `).run(updatedAt, updatedAt, userId, sessionId)
  })()
  return {
    id,
    sessionId,
    userId,
    role,
    content: String(content ?? ''),
    modelContext: parseModelContext(serializedContext),
    createdAt,
    updatedAt,
  }
}

export function listMessages({ userId, sessionId, limit = 500, offset = 0, recent = false } = {}) {
  if (!userId || !sessionId) return []
  const safeLimit = Math.min(2000, Math.max(1, Number(limit) || 500))
  const safeOffset = clampOffset(offset)
  const order = recent ? 'DESC' : 'ASC'
  const rows = getDb().prepare(`
    SELECT id, session_id, user_id, role, content, model_context_json, created_at, updated_at, rowid
    FROM messages
    WHERE user_id = ? AND session_id = ?
    ORDER BY created_at ${order}, rowid ${order}
    LIMIT ? OFFSET ?
  `).all(userId, sessionId, safeLimit, safeOffset)
  if (recent) rows.reverse()
  return rows.map(mapMessage)
}

export function getSessionSnapshot({ userId, sessionId, limit = 2000, offset = 0 } = {}) {
  const db = getDb()
  return db.transaction(() => {
    const session = getSession({ userId, sessionId })
    if (!session) return null
    const safeLimit = Math.min(2000, Math.max(1, Number(limit) || 2000))
    const safeOffset = clampOffset(offset)
    const totalMessages = db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE user_id = ? AND session_id = ?
    `).get(userId, sessionId).count
    const artifactsByTurn = new Map()
    for (const artifact of listSessionTurnArtifacts({ userId, sessionId })) {
      const entries = artifactsByTurn.get(artifact.turnId) || []
      entries.push({
        id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        url: artifact.url,
        filename: artifact.filename,
        createdAt: artifact.createdAt,
      })
      artifactsByTurn.set(artifact.turnId, entries)
    }
    const messages = listMessages({ userId, sessionId, limit: safeLimit, offset: safeOffset })
      .map((message) => {
        const turnId = String(message?.modelContext?.turnId || '')
        if (!turnId) return message
        const artifacts = artifactsByTurn.get(turnId) || []
        if (!artifacts.length) return message
        const requestedIds = Array.isArray(message.modelContext?.artifactIds)
          ? new Set(message.modelContext.artifactIds.map(String))
          : null
        const matched = requestedIds?.size
          ? artifacts.filter((artifact) => requestedIds.has(String(artifact.id)))
          : artifacts
        return matched.length ? { ...message, artifacts: matched } : message
      })
    const complete = safeOffset + messages.length >= totalMessages
    return {
      session,
      messages,
      revision: session.revision,
      totalMessages,
      complete,
      nextOffset: complete ? null : safeOffset + messages.length,
    }
  })()
}

export function replaceSessionMessages({
  userId,
  sessionId,
  expectedRevision,
  messages,
  now = Date.now(),
} = {}) {
  if (!userId || !sessionId) return null
  const revision = normalizeExpectedRevision(expectedRevision)
  const db = getDb()
  return db.transaction(() => {
    const session = db.prepare(`
      SELECT token, title, revision
      FROM sessions
      WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
    `).get(userId, sessionId)
    if (!session) return null
    if (Number(session.revision) !== revision) {
      throw new SessionRevisionConflictError(session.revision)
    }

    const existingContexts = new Map(db.prepare(`
      SELECT id, model_context_json
      FROM messages
      WHERE user_id = ? AND session_id = ?
    `).all(userId, sessionId).map((row) => [row.id, row.model_context_json || '{}']))
    const normalized = normalizeReplacementMessages(messages, existingContexts, now)
    db.prepare('DELETE FROM messages WHERE user_id = ? AND session_id = ?').run(userId, sessionId)
    const insert = db.prepare(`
      INSERT INTO messages
        (id, session_id, user_id, role, content, session_title, model_context_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const message of normalized) {
      insert.run(
        message.id,
        sessionId,
        userId,
        message.role,
        message.content,
        session.title || '',
        message.modelContextJson,
        message.createdAt,
        message.updatedAt,
      )
    }
    db.prepare(`
      UPDATE sessions
      SET updated_at = ?, revision = revision + 1
      WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
    `).run(now, userId, sessionId)
    const current = db.prepare('SELECT revision FROM sessions WHERE user_id = ? AND token = ?')
      .get(userId, sessionId)
    return {
      revision: Number(current.revision) || 0,
      totalMessages: normalized.length,
    }
  })()
}

export function deleteSession({ userId, sessionId, expectedRevision } = {}) {
  if (!userId || !sessionId) return null
  const revision = normalizeExpectedRevision(expectedRevision)
  const db = getDb()
  const result = db.transaction(() => {
    const session = db.prepare(`
      SELECT token, revision
      FROM sessions
      WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
    `).get(userId, sessionId)
    if (!session) return null
    if (Number(session.revision) !== revision) {
      throw new SessionRevisionConflictError(session.revision)
    }

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
    const result = db.prepare(`
      DELETE FROM sessions
      WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
    `).run(userId, sessionId)
    return result.changes === 1 ? { deleted: true, previousRevision: revision } : null
  })()
  if (result?.deleted) {
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

export function deleteMessage({ userId, messageId }) {
  if (!userId || !messageId) return false
  const db = getDb()
  return db.transaction(() => {
    const row = db.prepare('SELECT session_id FROM messages WHERE user_id = ? AND id = ?')
      .get(userId, messageId)
    if (!row) return false
    const result = db.prepare('DELETE FROM messages WHERE user_id = ? AND id = ?').run(userId, messageId)
    return result.changes > 0
  })()
}
