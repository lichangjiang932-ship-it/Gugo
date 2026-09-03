import { getDb } from '../db.js'

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

export class SessionBranchDepthError extends Error {
  constructor(maxDepth = 5) {
    super(`session branch depth cannot exceed ${maxDepth}`)
    this.name = 'SessionBranchDepthError'
    this.code = 'SESSION_BRANCH_DEPTH_LIMIT'
    this.maxDepth = maxDepth
  }
}

export class MessageOwnershipError extends Error {
  constructor(message = 'message id belongs to another session') {
    super(message)
    this.name = 'MessageOwnershipError'
    this.code = 'MESSAGE_OWNERSHIP_CONFLICT'
    this.status = 409
    this.retryable = false
  }
}

export function clampLimit(limit, { fallback = 50, max = 100 } = {}) {
  const value = Number(limit)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(max, Math.floor(value))
}

export function clampOffset(offset) {
  const value = Number(offset)
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

export function normalizeArchivedFilter(archived = 'false') {
  if (archived === true || archived === 'true') return 'true'
  if (archived === 'all') return 'all'
  return 'false'
}

export function mapSession(row) {
  if (!row) return null
  const turnEventRevision = Number(row.turn_event_revision)
  return {
    id: row.id || row.token,
    title: row.title || 'Untitled',
    workspacePath: row.workspace_path || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    lastViewedAt: row.last_viewed_at || null,
    archivedAt: row.archived_at || null,
    pinnedAt: row.pinned_at ?? null,
    parentSessionId: row.parent_session_id || null,
    branchLabel: row.branch_label || null,
    forkedAt: row.forked_at ?? null,
    revision: Number(row.revision) || 0,
    ...(Number.isInteger(turnEventRevision) && turnEventRevision >= 0 ? { turnEventRevision } : {}),
  }
}

export function getSessionRecord({ userId, sessionId }) {
  if (!userId || !sessionId) return null
  const row = getDb().prepare(`
    SELECT token, id, title, created_at, updated_at, last_viewed_at, archived_at,
      pinned_at, revision, parent_session_id, branch_label, forked_at, workspace_path,
      COALESCE((SELECT MAX(turn_events.rowid) FROM turn_events
        WHERE turn_events.user_id = sessions.user_id
          AND turn_events.session_id = sessions.token), 0) AS turn_event_revision
    FROM sessions
    WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
  `).get(userId, sessionId)
  return mapSession(row)
}

export function parseModelContext(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0 ? parsed : null
  } catch {
    return null
  }
}

export function contentEventTimestamp(value = Date.now()) {
  const timestamp = Number(value)
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : Date.now()
}

export function messageContentSnapshot({
  id,
  role,
  content,
  modelContext = null,
  modelContextJson = null,
  createdAt,
  updatedAt,
}) {
  return {
    id,
    role,
    content: String(content ?? ''),
    modelContext: modelContextJson == null ? modelContext : parseModelContext(modelContextJson),
    createdAt,
    updatedAt,
  }
}

export function listSessionContentSnapshots(db, { userId, sessionId }) {
  return db.prepare(`
    SELECT id, role, content, model_context_json, created_at, updated_at, rowid
    FROM messages
    WHERE user_id = ? AND session_id = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(userId, sessionId).map((row) => messageContentSnapshot({
    id: row.id,
    role: row.role,
    content: row.content,
    modelContextJson: row.model_context_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export function mapMessage(row) {
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
