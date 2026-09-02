import { getDb } from '../db.js'
import { enqueueSessionContentEventInDb } from './sessionContentOutboxStore.js'

const EPHEMERAL_MODEL_CONTEXT_KEYS = Object.freeze([
  'clarification',
  'directoryAuthorizationPending',
  'interrupted',
  'liveSteering',
  'paused',
  'pausedSequence',
  'pendingServerSync',
  'serverConnectionState',
  'serverResumeResolution',
  'streaming',
])

export class LegacySessionImportConflictError extends Error {
  constructor(message = 'legacy session import conflicts with server-owned data') {
    super(message)
    this.name = 'LegacySessionImportConflictError'
    this.code = 'LEGACY_SESSION_IMPORT_CONFLICT'
    this.statusCode = 409
    this.retryable = false
  }
}

function timestamp(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function nullableTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function stableModelContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const context = { ...value }
  for (const key of EPHEMERAL_MODEL_CONTEXT_KEYS) delete context[key]
  return context
}

function mapSession(row) {
  if (!row) return null
  return {
    id: row.id || row.token,
    title: row.title || 'Untitled',
    workspacePath: row.workspace_path || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    lastViewedAt: row.last_viewed_at ?? null,
    archivedAt: row.archived_at ?? null,
    pinnedAt: row.pinned_at ?? null,
    parentSessionId: row.parent_session_id || null,
    branchLabel: row.branch_label || null,
    forkedAt: row.forked_at ?? null,
    revision: Number(row.revision) || 0,
  }
}

function visibleSession(db, { userId, sessionId }) {
  return mapSession(db.prepare(`
    SELECT token, id, title, created_at, updated_at, last_viewed_at, archived_at,
      pinned_at, revision, parent_session_id, branch_label, forked_at, workspace_path
    FROM sessions
    WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
  `).get(userId, sessionId))
}

function normalizeForInsert(session, now) {
  const createdAt = timestamp(session.createdAt, now)
  const updatedAt = Math.max(createdAt, timestamp(session.updatedAt, createdAt))
  return {
    ...session,
    createdAt,
    updatedAt,
    lastViewedAt: nullableTimestamp(session.lastViewedAt),
    archivedAt: nullableTimestamp(session.archivedAt),
    pinnedAt: nullableTimestamp(session.pinnedAt),
    messages: session.messages.map((message) => {
      const messageCreatedAt = timestamp(message.createdAt, createdAt)
      return {
        ...message,
        createdAt: messageCreatedAt,
        updatedAt: Math.max(messageCreatedAt, timestamp(message.updatedAt, messageCreatedAt)),
        modelContext: stableModelContext(message.modelContext),
      }
    }),
  }
}

/**
 * Import one already-validated browser batch without ever updating an existing
 * Session. The IMMEDIATE transaction serializes occupancy checks with inserts,
 * making retries idempotent and preserving server authority for every token.
 */
export function importLegacySessions({ userId, sessions } = {}, {
  db = getDb(),
  now = Date.now(),
} = {}) {
  const normalizedNow = timestamp(now, Date.now())
  const normalizedSessions = sessions.map((session) => normalizeForInsert(session, normalizedNow))
  const transaction = db.transaction(() => {
    const occupiedStatement = db.prepare('SELECT 1 FROM sessions WHERE token = ?')
    const messageOccupiedStatement = db.prepare('SELECT 1 FROM messages WHERE id = ?')
    const candidates = []
    const statuses = new Map()

    for (const session of normalizedSessions) {
      if (occupiedStatement.get(session.id)) {
        statuses.set(session.id, {
          id: session.id,
          status: 'server_authoritative',
          session: visibleSession(db, { userId, sessionId: session.id }),
        })
      } else {
        candidates.push(session)
      }
    }

    // Check the complete batch before the first write so a message-id collision
    // cannot leave a prefix of the batch committed.
    for (const session of candidates) {
      for (const message of session.messages) {
        if (messageOccupiedStatement.get(message.id)) {
          throw new LegacySessionImportConflictError()
        }
      }
    }

    const insertSession = db.prepare(`
      INSERT INTO sessions
        (token, id, user_id, title, expires_at, created_at, updated_at,
          last_viewed_at, archived_at, pinned_at, parent_session_id, branch_label, forked_at,
          workspace_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
    `)
    const insertMessage = db.prepare(`
      INSERT INTO messages
        (id, session_id, user_id, role, content, session_title,
          model_context_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    for (const session of candidates) {
      insertSession.run(
        session.id,
        session.id,
        userId,
        session.title || 'Untitled',
        Number.MAX_SAFE_INTEGER,
        session.createdAt,
        session.updatedAt,
        session.lastViewedAt,
        session.archivedAt,
        session.pinnedAt,
        session.workspacePath || null,
      )
      const contentSnapshots = []
      for (const message of session.messages) {
        const modelContextJson = JSON.stringify(message.modelContext)
        insertMessage.run(
          message.id,
          session.id,
          userId,
          message.role,
          message.content,
          session.title || 'Untitled',
          modelContextJson,
          message.createdAt,
          message.updatedAt,
        )
        contentSnapshots.push({
          id: message.id,
          role: message.role,
          content: message.content,
          modelContext: message.modelContext,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        })
      }
      enqueueSessionContentEventInDb(db, {
        userId,
        sessionId: session.id,
        eventType: 'session.replace',
        payload: { messages: contentSnapshots },
        createdAt: normalizedNow,
      })
      statuses.set(session.id, {
        id: session.id,
        status: 'imported',
        session: visibleSession(db, { userId, sessionId: session.id }),
      })
    }

    const results = normalizedSessions.map((session) => statuses.get(session.id))
    const importedCount = results.filter((result) => result.status === 'imported').length
    return {
      results,
      importedCount,
      serverAuthoritativeCount: results.length - importedCount,
    }
  })
  return transaction.immediate()
}
