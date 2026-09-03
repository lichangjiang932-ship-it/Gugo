import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { enqueueSessionContentEventInDb } from './sessionContentOutboxStore.js'
import {
  normalizeSessionBranchLabel,
  SessionMutationValidationError,
} from './sessionMutationValidation.js'
import {
  contentEventTimestamp,
  getSessionRecord,
  mapSession,
  messageContentSnapshot,
  SessionBranchDepthError,
} from './sessionStoreShared.js'

const MAX_BRANCH_DEPTH = 5
const MAX_BRANCH_TREE_NODES = 1_000

function forkSafeModelContext(value) {
  if (!value) return '{}'
  try {
    const context = JSON.parse(value)
    if (!context || typeof context !== 'object' || Array.isArray(context)) return '{}'
    for (const key of [
      'clarification',
      'directoryAuthorizationPending',
      'interrupted',
      'liveSteering',
      'paused',
      'pausedSequence',
      'serverConnectionState',
      'serverResumeResolution',
      'streaming',
    ]) delete context[key]
    return JSON.stringify(context)
  } catch {
    return '{}'
  }
}

function uniqueGeneratedId(db, { factory, table, used }) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = String(factory()).trim()
    if (!id || id.length > 512 || used.has(id)) continue
    const exists = table === 'sessions'
      ? db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(id)
      : db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id)
    if (exists) continue
    used.add(id)
    return id
  }
  throw new Error('failed to allocate a unique session branch id')
}

function sessionAncestors(db, { userId, sessionId, maxDepth = MAX_BRANCH_DEPTH + 1 }) {
  return db.prepare(`
    WITH RECURSIVE ancestors(token, parent_session_id, depth) AS (
      SELECT token, parent_session_id, 0
      FROM sessions
      WHERE user_id = @userId AND token = @sessionId
        AND (id IS NOT NULL OR title IS NOT NULL)
      UNION ALL
      SELECT parent.token, parent.parent_session_id, ancestors.depth + 1
      FROM sessions AS parent
      JOIN ancestors ON parent.token = ancestors.parent_session_id
      WHERE parent.user_id = @userId
        AND (parent.id IS NOT NULL OR parent.title IS NOT NULL)
        AND ancestors.depth < @maxDepth
    )
    SELECT token, parent_session_id, depth
    FROM ancestors
    ORDER BY depth ASC
  `).all({ userId, sessionId, maxDepth })
}

export function forkSession({
  userId,
  sessionId,
  label = null,
  now = Date.now(),
  idFactory = randomUUID,
} = {}) {
  if (!userId || !sessionId) return null
  if (typeof idFactory !== 'function') {
    throw new SessionMutationValidationError('idFactory must be a function')
  }
  const branchLabel = normalizeSessionBranchLabel(label)
  const db = getDb()
  return db.transaction(() => {
    const source = db.prepare(`
      SELECT token, title, workspace_path
      FROM sessions
      WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
    `).get(userId, sessionId)
    if (!source) return null

    const ancestors = sessionAncestors(db, { userId, sessionId })
    const sourceDepth = Math.max(0, ...ancestors.map((item) => Number(item.depth) || 0))
    if (sourceDepth >= MAX_BRANCH_DEPTH) throw new SessionBranchDepthError()

    const usedSessionIds = new Set()
    const usedMessageIds = new Set()
    const forkedSessionId = uniqueGeneratedId(db, {
      factory: idFactory,
      table: 'sessions',
      used: usedSessionIds,
    })
    const timestamp = Number.isFinite(Number(now)) ? Math.floor(Number(now)) : Date.now()
    db.prepare(`
      INSERT INTO sessions
        (token, id, user_id, title, expires_at, created_at, updated_at,
          last_viewed_at, archived_at, pinned_at, parent_session_id, branch_label, forked_at,
          workspace_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)
    `).run(
      forkedSessionId,
      forkedSessionId,
      userId,
      source.title || 'Untitled',
      Number.MAX_SAFE_INTEGER,
      timestamp,
      timestamp,
      source.token,
      branchLabel,
      timestamp,
      source.workspace_path,
    )

    const sourceMessages = db.prepare(`
      SELECT role, content, model_context_json, created_at, updated_at, rowid
      FROM messages
      WHERE user_id = ? AND session_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(userId, source.token)
    const insertMessage = db.prepare(`
      INSERT INTO messages
        (id, session_id, user_id, role, content, session_title,
          model_context_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const forkedMessages = []
    for (const message of sourceMessages) {
      const messageId = uniqueGeneratedId(db, {
        factory: idFactory,
        table: 'messages',
        used: usedMessageIds,
      })
      const modelContextJson = forkSafeModelContext(message.model_context_json)
      insertMessage.run(
        messageId,
        forkedSessionId,
        userId,
        message.role,
        message.content,
        source.title || 'Untitled',
        modelContextJson,
        message.created_at,
        message.updated_at,
      )
      forkedMessages.push(messageContentSnapshot({
        id: messageId,
        role: message.role,
        content: message.content,
        modelContextJson,
        createdAt: message.created_at,
        updatedAt: message.updated_at,
      }))
    }
    enqueueSessionContentEventInDb(db, {
      userId,
      sessionId: forkedSessionId,
      eventType: 'session.replace',
      payload: { messages: forkedMessages },
      createdAt: contentEventTimestamp(timestamp),
    })

    return {
      session: getSessionRecord({ userId, sessionId: forkedSessionId }),
      totalMessages: sourceMessages.length,
    }
  })()
}

export function getSessionBranches({ userId, sessionId } = {}) {
  if (!userId || !sessionId) return null
  const db = getDb()
  const ancestors = sessionAncestors(db, { userId, sessionId, maxDepth: MAX_BRANCH_DEPTH })
  if (!ancestors.length) return null
  const rootSessionId = ancestors.at(-1).token
  const rows = db.prepare(`
    WITH RECURSIVE branch_tree(
      token, id, title, created_at, updated_at, last_viewed_at, archived_at,
      pinned_at, revision, parent_session_id, branch_label, forked_at, workspace_path, depth
    ) AS (
      SELECT token, id, title, created_at, updated_at, last_viewed_at, archived_at,
        pinned_at, revision, parent_session_id, branch_label, forked_at, workspace_path, 0
      FROM sessions
      WHERE user_id = @userId AND token = @rootSessionId
        AND (id IS NOT NULL OR title IS NOT NULL)
      UNION ALL
      SELECT child.token, child.id, child.title, child.created_at, child.updated_at,
        child.last_viewed_at, child.archived_at, child.pinned_at, child.revision,
        child.parent_session_id, child.branch_label, child.forked_at, child.workspace_path,
        branch_tree.depth + 1
      FROM sessions AS child
      JOIN branch_tree ON child.parent_session_id = branch_tree.token
      WHERE child.user_id = @userId
        AND (child.id IS NOT NULL OR child.title IS NOT NULL)
        AND branch_tree.depth < @maxDepth
    )
    SELECT * FROM branch_tree
    ORDER BY depth ASC, COALESCE(forked_at, created_at) ASC, token ASC
    LIMIT @limit
  `).all({
    userId,
    rootSessionId,
    maxDepth: MAX_BRANCH_DEPTH,
    limit: MAX_BRANCH_TREE_NODES + 1,
  })
  const truncated = rows.length > MAX_BRANCH_TREE_NODES
  return {
    rootSessionId,
    branches: rows.slice(0, MAX_BRANCH_TREE_NODES).map((row) => ({
      ...mapSession(row),
      depth: Number(row.depth) || 0,
    })),
    truncated,
  }
}
