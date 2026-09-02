import { getDb } from '../db.js'
import { listSessionTurnArtifacts } from './turnArtifactStore.js'
import { enqueueSessionContentEventInDb } from './sessionContentOutboxStore.js'
import {
  latestTurnBoundaries,
  loadIncompleteCheckpointMetadata,
  recoverTerminalEvidenceMessages,
  withRecoveredIncompleteFailure,
  withRecoveredVerifiedLocalFiles,
} from './sessionSnapshotRecovery.js'
import {
  normalizeSessionExpectedRevision,
  normalizeSessionReplacementMessages,
  serializeSessionModelContext,
} from './sessionMutationValidation.js'
import {
  clampOffset,
  contentEventTimestamp,
  getSessionRecord,
  mapMessage,
  messageContentSnapshot,
  MessageOwnershipError,
  parseModelContext,
  SessionRevisionConflictError,
} from './sessionStoreShared.js'

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
  const serializedContext = serializeSessionModelContext(modelContext)
  db.transaction(() => {
    const write = db.prepare(`
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
        AND (messages.role IS NOT excluded.role OR messages.content IS NOT excluded.content
          OR messages.session_title IS NOT excluded.session_title
          OR messages.model_context_json IS NOT excluded.model_context_json
          OR messages.updated_at IS NOT excluded.updated_at)
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
    const persisted = db.prepare(`
      SELECT id, role, content, model_context_json, created_at, updated_at
      FROM messages
      WHERE user_id = ? AND session_id = ? AND id = ?
    `).get(userId, sessionId, id)
    if (!persisted) throw new MessageOwnershipError()
    if (write.changes === 0) return
    db.prepare(`
      UPDATE sessions
      SET updated_at = CASE
        WHEN COALESCE(updated_at, 0) < ? THEN ?
        ELSE updated_at
      END
      WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
    `).run(updatedAt, updatedAt, userId, sessionId)
    enqueueSessionContentEventInDb(db, {
      userId,
      sessionId,
      eventType: 'message.upsert',
      payload: {
        message: messageContentSnapshot({
          id: persisted.id,
          role: persisted.role,
          content: persisted.content,
          modelContextJson: persisted.model_context_json,
          createdAt: persisted.created_at,
          updatedAt: persisted.updated_at,
        }),
      },
      createdAt: contentEventTimestamp(updatedAt),
    })
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

export function getMessage({ userId, sessionId, messageId } = {}) {
  if (!userId || !messageId) return null
  const row = sessionId
    ? getDb().prepare(`
      SELECT id, session_id, user_id, role, content, model_context_json, created_at, updated_at, rowid
      FROM messages
      WHERE user_id = ? AND session_id = ? AND id = ?
      LIMIT 1
    `).get(userId, sessionId, messageId)
    : getDb().prepare(`
      SELECT id, session_id, user_id, role, content, model_context_json, created_at, updated_at, rowid
      FROM messages
      WHERE user_id = ? AND id = ?
      LIMIT 1
    `).get(userId, messageId)
  return row ? mapMessage(row) : null
}

export function getPreviousUserMessage({ userId, sessionId, messageId } = {}) {
  if (!userId || !sessionId || !messageId) return null
  const row = getDb().prepare(`
    SELECT previous.id, previous.session_id, previous.user_id, previous.role,
      previous.content, previous.model_context_json, previous.created_at,
      previous.updated_at, previous.rowid
    FROM messages AS current
    JOIN messages AS previous
      ON previous.user_id = current.user_id
      AND previous.session_id = current.session_id
    WHERE current.id = ?
      AND current.user_id = ?
      AND current.session_id = ?
      AND current.role = 'user'
      AND previous.role = 'user'
      AND (
        previous.created_at < current.created_at
        OR (previous.created_at = current.created_at AND previous.rowid < current.rowid)
      )
    ORDER BY previous.created_at DESC, previous.rowid DESC
    LIMIT 1
  `).get(messageId, userId, sessionId)
  return row ? mapMessage(row) : null
}

export function getSessionSnapshot({ userId, sessionId, limit = 2000, offset = 0 } = {}) {
  const db = getDb()
  return db.transaction(() => {
    const session = getSessionRecord({ userId, sessionId })
    if (!session) return null
    // Session revisions track transcript mutations, while terminal turn events
    // are append-only and can change independently. Expose both watermarks so
    // a paged client cannot combine pages from different terminal states.
    const turnEventRevision = session.turnEventRevision || 0
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
    const storedMessages = listMessages({ userId, sessionId, limit: safeLimit, offset: safeOffset })
      .map(withRecoveredVerifiedLocalFiles)
    const allTerminalBoundaries = latestTurnBoundaries(db, {
      userId,
      sessionId,
    })
    const pageMessageIds = new Set(storedMessages.map((message) => message?.id).filter(Boolean))
    const pageTurnIds = new Set(storedMessages
      .map((message) => String(message?.modelContext?.turnId || '').trim())
      .filter(Boolean))
    const terminalBoundaries = allTerminalBoundaries.filter((row) => (
      pageTurnIds.has(row.turn_id)
      || pageMessageIds.has(`${row.turn_id}:assistant`)
      || (row.evidence_anchor_id && pageMessageIds.has(row.evidence_anchor_id))
      || (!row.evidence_anchor_id && safeOffset === 0)
    ))
    const missingEvidenceMessages = allTerminalBoundaries.reduce(
      (count, row) => count + (row.has_evidence_message ? 0 : 1),
      0,
    )
    const terminalRecovery = recoverTerminalEvidenceMessages(
      storedMessages,
      terminalBoundaries,
      { userId, sessionId },
      {
        synthesizeMissing: true,
        synthesisAnchorIds: pageMessageIds,
        includeUnanchored: safeOffset === 0,
      },
    )
    const incompleteMetadataByTurn = loadIncompleteCheckpointMetadata(db, {
      userId,
      sessionId,
      messages: terminalRecovery.messages,
    })
    const messages = terminalRecovery.messages
      .map((message) => withRecoveredIncompleteFailure(message, incompleteMetadataByTurn))
      .map((message) => {
        const turnId = String(message?.modelContext?.turnId || '')
        if (!turnId) return message
        const artifacts = artifactsByTurn.get(turnId) || []
        if (!artifacts.length) return message
        const requestedIds = Array.isArray(message.modelContext?.artifactIds)
          ? new Set(message.modelContext.artifactIds.map(String))
          : null
        // An explicit empty list means this terminal message owns no managed
        // artifacts. Only legacy messages that omit artifactIds may fall back
        // to every durable artifact recorded for the turn.
        const matched = requestedIds
          ? artifacts.filter((artifact) => requestedIds.has(String(artifact.id)))
          : artifacts
        return matched.length ? { ...message, artifacts: matched } : message
      })
    const durableNextOffset = safeOffset + storedMessages.length
    const snapshotTotalMessages = totalMessages + missingEvidenceMessages
    const complete = durableNextOffset >= totalMessages
    return {
      session,
      messages,
      revision: session.revision,
      turnEventRevision,
      totalMessages: snapshotTotalMessages,
      complete,
      // Virtual terminal rows are returned beside their unique durable anchor
      // but never consume an OFFSET position in the messages table.
      nextOffset: complete ? null : durableNextOffset,
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
  const revision = normalizeSessionExpectedRevision(expectedRevision)
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
    const normalized = normalizeSessionReplacementMessages(messages, existingContexts, now)
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
    enqueueSessionContentEventInDb(db, {
      userId,
      sessionId,
      eventType: 'session.replace',
      payload: {
        messages: normalized.map((message) => messageContentSnapshot({
          id: message.id,
          role: message.role,
          content: message.content,
          modelContextJson: message.modelContextJson,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        })),
      },
      createdAt: contentEventTimestamp(now),
    })
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

export function deleteMessage({ userId, messageId }) {
  if (!userId || !messageId) return false
  const db = getDb()
  return db.transaction(() => {
    const row = db.prepare('SELECT session_id FROM messages WHERE user_id = ? AND id = ?')
      .get(userId, messageId)
    if (!row) return false
    const result = db.prepare('DELETE FROM messages WHERE user_id = ? AND id = ?').run(userId, messageId)
    if (result.changes > 0) {
      enqueueSessionContentEventInDb(db, {
        userId,
        sessionId: row.session_id,
        eventType: 'message.delete',
        payload: { messageId },
        createdAt: contentEventTimestamp(),
      })
    }
    return result.changes > 0
  })()
}
