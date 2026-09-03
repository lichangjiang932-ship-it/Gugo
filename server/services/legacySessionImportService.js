import { createHash } from 'node:crypto'
import { getDb } from '../db.js'
import { enqueueSessionContentEventInDb } from './sessionContentOutboxStore.js'

const RECOVERY_ID_ATTEMPTS = 32

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

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`
}

function sha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function importShape(session) {
  return {
    title: session.title || 'Untitled',
    workspacePath: session.workspacePath || null,
    lastViewedAt: session.lastViewedAt ?? null,
    archivedAt: session.archivedAt ?? null,
    pinnedAt: session.pinnedAt ?? null,
    messages: session.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      modelContext: stableModelContext(message.modelContext),
    })),
  }
}

function recoverySessionId({ userId, session, attempt }) {
  return `legacy-recovery-${sha256({
    version: 1,
    userId,
    sourceSessionId: session.id,
    content: importShape(session),
    attempt,
  })}`
}

function recoveryMessageId({ userId, sessionId, message, index }) {
  return `legacy-recovery-message-${sha256({
    version: 1,
    userId,
    sessionId,
    sourceMessageId: message.id,
    index,
  })}`
}

function recoveryCandidate(session, { userId, attempt }) {
  const id = recoverySessionId({ userId, session, attempt })
  return {
    ...session,
    id,
    messages: session.messages.map((message, index) => ({
      ...message,
      id: recoveryMessageId({ userId, sessionId: id, message, index }),
    })),
  }
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

function storedImportShape(db, { userId, sessionId }) {
  const row = db.prepare(`
    SELECT id, user_id, title, last_viewed_at, archived_at, pinned_at, workspace_path
    FROM sessions
    WHERE token = ?
  `).get(sessionId)
  if (!row || row.user_id !== userId || (row.id == null && row.title == null)) return null
  const messages = db.prepare(`
    SELECT id, role, content, model_context_json
    FROM messages
    WHERE session_id = ?
    ORDER BY rowid
  `).all(sessionId).map((message) => {
    let modelContext
    try {
      modelContext = stableModelContext(JSON.parse(message.model_context_json || '{}'))
    } catch {
      modelContext = null
    }
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      modelContext,
    }
  })
  return {
    title: row.title || 'Untitled',
    workspacePath: row.workspace_path || null,
    lastViewedAt: row.last_viewed_at ?? null,
    archivedAt: row.archived_at ?? null,
    pinnedAt: row.pinned_at ?? null,
    messages,
  }
}

function storedImportMatches(db, { userId, candidate }) {
  const stored = storedImportShape(db, { userId, sessionId: candidate.id })
  return stored !== null && canonicalJson(stored) === canonicalJson(importShape(candidate))
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

    const messagesAvailable = (session) => session.messages.every(
      (message) => !messageOccupiedStatement.get(message.id),
    )
    const insert = (session) => {
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
    }

    const results = normalizedSessions.map((sourceSession) => {
      let candidate = sourceSession
      if (occupiedStatement.get(candidate.id)) {
        if (storedImportMatches(db, { userId, candidate })) {
          return {
            id: sourceSession.id,
            sessionId: candidate.id,
            status: 'server_authoritative',
            session: visibleSession(db, { userId, sessionId: candidate.id }),
          }
        }
      } else if (messagesAvailable(candidate)) {
        insert(candidate)
        return {
          id: sourceSession.id,
          sessionId: candidate.id,
          status: 'imported',
          session: visibleSession(db, { userId, sessionId: candidate.id }),
        }
      }

      for (let attempt = 0; attempt < RECOVERY_ID_ATTEMPTS; attempt += 1) {
        candidate = recoveryCandidate(sourceSession, { userId, attempt })
        if (occupiedStatement.get(candidate.id)) {
          if (storedImportMatches(db, { userId, candidate })) {
            return {
              id: sourceSession.id,
              sessionId: candidate.id,
              status: 'server_authoritative',
              session: visibleSession(db, { userId, sessionId: candidate.id }),
            }
          }
          continue
        }
        if (!messagesAvailable(candidate)) continue
        insert(candidate)
        return {
          id: sourceSession.id,
          sessionId: candidate.id,
          status: 'imported',
          session: visibleSession(db, { userId, sessionId: candidate.id }),
        }
      }
      throw new LegacySessionImportConflictError('legacy session recovery ids are exhausted')
    })

    for (const result of results) {
      if (!result.session) throw new LegacySessionImportConflictError()
    }
    const importedCount = results.filter((result) => result.status === 'imported').length
    return {
      results,
      importedCount,
      serverAuthoritativeCount: results.length - importedCount,
    }
  })
  return transaction.immediate()
}
