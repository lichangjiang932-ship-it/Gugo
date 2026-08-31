import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { listSessionTurnArtifacts } from './turnArtifactStore.js'
import { deleteManagedAttachmentsForSession } from './managedAttachmentStore.js'
import { runGovernedSessionDeletion } from './sessionDeletionGovernanceRuntime.js'
import { enqueueSessionContentEventInDb } from './sessionContentOutboxStore.js'
import { extractVerifiedLocalFiles, recoverLegacyVerifiedLocalFiles } from './turnMessageContext.js'
import {
  missingRequirementsForIncompleteReason,
  normalizeIncompleteReason,
  normalizeTurnFailure,
} from './turnTerminalProjection.js'

const LOCAL_OWNER_META_KEY = 'local_auth_owner_user_id'
const MAX_BRANCH_DEPTH = 5
const MAX_BRANCH_LABEL_LENGTH = 120
const MAX_BRANCH_TREE_NODES = 1_000
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

export class SessionBranchDepthError extends Error {
  constructor(maxDepth = MAX_BRANCH_DEPTH) {
    super(`session branch depth cannot exceed ${maxDepth}`)
    this.name = 'SessionBranchDepthError'
    this.code = 'SESSION_BRANCH_DEPTH_LIMIT'
    this.maxDepth = maxDepth
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
    parentSessionId: row.parent_session_id || null,
    branchLabel: row.branch_label || null,
    forkedAt: row.forked_at ?? null,
    revision: Number(row.revision) || 0,
  }
}

function normalizeBranchLabel(value) {
  if (value == null) return null
  if (typeof value !== 'string') {
    throw new SessionMutationValidationError('label must be a string')
  }
  const label = value.trim().replace(/\s+/g, ' ')
  if (!label) return null
  if (label.length > MAX_BRANCH_LABEL_LENGTH) {
    throw new SessionMutationValidationError(
      `label exceeds the ${MAX_BRANCH_LABEL_LENGTH} character limit`,
    )
  }
  return label
}

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
  const branchLabel = normalizeBranchLabel(label)
  const db = getDb()
  return db.transaction(() => {
    const source = db.prepare(`
      SELECT token, title
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
          last_viewed_at, archived_at, pinned_at, parent_session_id, branch_label, forked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)
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
      session: getSession({ userId, sessionId: forkedSessionId }),
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
      pinned_at, revision, parent_session_id, branch_label, forked_at, depth
    ) AS (
      SELECT token, id, title, created_at, updated_at, last_viewed_at, archived_at,
        pinned_at, revision, parent_session_id, branch_label, forked_at, 0
      FROM sessions
      WHERE user_id = @userId AND token = @rootSessionId
        AND (id IS NOT NULL OR title IS NOT NULL)
      UNION ALL
      SELECT child.token, child.id, child.title, child.created_at, child.updated_at,
        child.last_viewed_at, child.archived_at, child.pinned_at, child.revision,
        child.parent_session_id, child.branch_label, child.forked_at,
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

function upsertSessionRecord({
  id,
  userId,
  title = 'Untitled',
  createdAt = Date.now(),
  updatedAt = createdAt,
  lastViewedAt = null,
  archivedAt = null,
}, { notifyLifecycle = true } = {}) {
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
  if (!row && notifyLifecycle) notifySessionStarted({ userId, sessionId: id, title })
  return getSession({ userId, sessionId: id })
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

function contentEventTimestamp(value = Date.now()) {
  const timestamp = Number(value)
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : Date.now()
}

function messageContentSnapshot({
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

function listSessionContentSnapshots(db, { userId, sessionId }) {
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

function withRecoveredVerifiedLocalFiles(message) {
  const context = message?.modelContext
  if (message?.role !== 'assistant'
    || !context
    || typeof context !== 'object'
    || Object.hasOwn(context, 'verifiedLocalFiles')) {
    return message
  }
  const options = {
    userId: message.userId,
    verifiedAt: context.turnCompletedAt || message.updatedAt || message.createdAt,
  }
  const verifiedLocalFiles = extractVerifiedLocalFiles(context.toolTrace, options)
  const compatibleVerifiedLocalFiles = verifiedLocalFiles.length > 0
    ? verifiedLocalFiles
    : recoverLegacyVerifiedLocalFiles(context.toolTrace, options)
  if (compatibleVerifiedLocalFiles.length === 0) return message
  // Older messages predate persisted receipts. Enrich only this read response;
  // the database remains unchanged and the download route independently
  // reconstructs and authorizes the same deterministic receipt.
  return {
    ...message,
    modelContext: { ...context, verifiedLocalFiles: compatibleVerifiedLocalFiles },
  }
}

function incompleteCheckpointMetadata(stateJson) {
  const state = parseModelContext(stateJson)
  const final = state?.final
  if (!final || typeof final !== 'object' || Array.isArray(final) || final.incomplete !== true) {
    return null
  }
  const budgetExceeded = typeof final.budgetExceeded === 'boolean'
    ? final.budgetExceeded
    : undefined
  const noProgress = typeof final.noProgress === 'boolean'
    ? final.noProgress
    : undefined
  const rawReason = String(final.reason || '').trim().toLowerCase()
  const incompleteReason = budgetExceeded === true
    ? 'execution_budget_exhausted'
    : noProgress === true
      ? 'tool_no_progress'
      : (rawReason ? normalizeIncompleteReason(rawReason, '') : '')
  const recordedMissingRequirements = [...new Set(
    (Array.isArray(final.missingRequirements) ? final.missingRequirements : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => /^[a-z][a-z0-9_]{1,95}$/u.test(value)),
  )].slice(0, 16)
  return {
    ...(incompleteReason
      ? {
          incompleteReason,
          missingRequirements: recordedMissingRequirements.length > 0
            ? recordedMissingRequirements
            : missingRequirementsForIncompleteReason(incompleteReason),
        }
      : {}),
    ...(typeof final.retryable === 'boolean' ? { retryable: final.retryable } : {}),
    ...(typeof final.manualRetryable === 'boolean'
      ? { manualRetryable: final.manualRetryable }
      : {}),
    ...(final.taskVerification && typeof final.taskVerification === 'object'
      ? { taskVerification: final.taskVerification }
      : {}),
  }
}

function loadIncompleteCheckpointMetadata(db, { userId, sessionId, messages }) {
  const turnIds = [...new Set((Array.isArray(messages) ? messages : [])
    .filter((message) => (
      message?.role === 'assistant'
      && message?.modelContext?.turnEvidence === true
      && message.modelContext.evidenceState === 'failed'
      && message.modelContext.error
      && typeof message.modelContext.error === 'object'
      && !Array.isArray(message.modelContext.error)
      && ['incompleteReason', 'missingRequirements', 'retryable', 'manualRetryable', 'taskVerification']
        .some((field) => !Object.hasOwn(message.modelContext.error, field))
    ))
    .map((message) => String(message.modelContext.turnId || '').trim())
    .filter(Boolean))]
  if (turnIds.length === 0) return new Map()

  const metadataByTurn = new Map()
  const chunkSize = 250
  for (let index = 0; index < turnIds.length; index += chunkSize) {
    const chunk = turnIds.slice(index, index + chunkSize)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db.prepare(`
      SELECT turn_id, state_json
      FROM turn_checkpoints
      WHERE user_id = ? AND session_id = ? AND turn_id IN (${placeholders})
    `).all(userId, sessionId, ...chunk)
    for (const row of rows) {
      const metadata = incompleteCheckpointMetadata(row.state_json)
      if (metadata) metadataByTurn.set(String(row.turn_id), metadata)
    }
  }
  return metadataByTurn
}

function withRecoveredIncompleteFailure(message, metadataByTurn) {
  const context = message?.modelContext
  const failure = context?.error
  if (message?.role !== 'assistant'
    || context?.turnEvidence !== true
    || context.evidenceState !== 'failed'
    || !failure
    || typeof failure !== 'object'
    || Array.isArray(failure)) {
    return message
  }
  const turnId = String(context.turnId || '').trim()
  const recovered = metadataByTurn.get(turnId)
  if (!recovered) return message
  const fields = [
    'incompleteReason',
    'missingRequirements',
    'retryable',
    'manualRetryable',
    'taskVerification',
  ]
  const additions = Object.fromEntries(fields
    .filter((field) => !Object.hasOwn(failure, field) && Object.hasOwn(recovered, field))
    .map((field) => [field, recovered[field]]))
  if (Object.keys(additions).length === 0) return message

  // Compatibility for older terminal evidence: enrich only the snapshot
  // response. Newer persisted diagnostics and the database row remain the
  // source of truth and are never overwritten here.
  return {
    ...message,
    modelContext: {
      ...context,
      error: {
        ...failure,
        ...additions,
      },
    },
  }
}

const SNAPSHOT_BOUNDARY_TYPES = new Set([
  'turn.completed',
  'turn.cancelled',
  'turn.failed',
  'turn.interrupted',
  'turn.blocked',
  'turn.paused',
])

const SNAPSHOT_FAILURE_BOUNDARY_TYPES = new Set([
  'turn.failed',
  'turn.interrupted',
  'turn.blocked',
])

function latestTurnBoundaries(db, { userId, sessionId, turnIds = null }) {
  const scopedTurnIds = Array.isArray(turnIds)
    ? [...new Set(turnIds.map((value) => String(value || '').trim()).filter(Boolean))]
    : null
  if (scopedTurnIds && scopedTurnIds.length === 0) return []
  const turnFilter = scopedTurnIds
    ? ` AND event.turn_id IN (${scopedTurnIds.map(() => '?').join(', ')})`
    : ''
  return db.prepare(`
    SELECT event.turn_id, event.sequence, event.type, event.payload_json,
      event.created_at,
      EXISTS(
        SELECT 1 FROM messages
        WHERE messages.user_id = event.user_id
          AND messages.session_id = event.session_id
          AND messages.id = event.turn_id || ':assistant'
      ) AS has_evidence_message,
      COALESCE(
        (
          SELECT anchor.id
          FROM messages AS anchor
          WHERE anchor.user_id = event.user_id
            AND anchor.session_id = event.session_id
            AND anchor.id = event.turn_id || ':user'
          LIMIT 1
        ),
        (
          SELECT anchor.id
          FROM messages AS anchor
          WHERE anchor.user_id = event.user_id
            AND anchor.session_id = event.session_id
            AND json_valid(anchor.model_context_json)
            AND json_extract(anchor.model_context_json, '$.turnId') = event.turn_id
          ORDER BY anchor.created_at ASC, anchor.rowid ASC
          LIMIT 1
        )
      ) AS evidence_anchor_id
    FROM turn_events AS event
    WHERE event.user_id = ? AND event.session_id = ?${turnFilter}
      AND event.sequence = (
        SELECT MAX(latest.sequence)
        FROM turn_events AS latest
        WHERE latest.user_id = event.user_id
          AND latest.session_id = event.session_id
          AND latest.turn_id = event.turn_id
      )
  `).all(userId, sessionId, ...(scopedTurnIds || []))
    .filter((row) => SNAPSHOT_BOUNDARY_TYPES.has(row.type))
}

function eventFailure(payload, type) {
  const nested = payload?.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
    ? payload.error
    : {}
  const source = { ...payload, ...nested }
  if ((!Array.isArray(nested.missingRequirements) || nested.missingRequirements.length === 0)
    && Array.isArray(payload?.missingRequirements)) {
    source.missingRequirements = payload.missingRequirements
  }
  if ((!nested.taskVerification || Object.keys(nested.taskVerification).length === 0)
    && payload?.taskVerification && typeof payload.taskVerification === 'object') {
    source.taskVerification = payload.taskVerification
  }
  return normalizeTurnFailure(source, {
    code: type === 'turn.interrupted'
      ? 'TURN_INTERRUPTED'
      : type === 'turn.blocked' ? 'TURN_RECOVERY_BLOCKED' : 'TURN_FAILED',
    retryable: type === 'turn.interrupted',
  })
}

function terminalEventEvidence(payload, key) {
  if (payload && typeof payload === 'object' && Object.hasOwn(payload, key)) return payload[key]
  const nested = payload?.error
  if (nested && typeof nested === 'object' && !Array.isArray(nested) && Object.hasOwn(nested, key)) {
    return nested[key]
  }
  return undefined
}

function projectTerminalEvidence(message, row, { userId, sessionId }) {
  const payload = parseModelContext(row.payload_json) || {}
  const context = message?.modelContext && typeof message.modelContext === 'object'
    ? message.modelContext
    : {}
  const failureBoundary = SNAPSHOT_FAILURE_BOUNDARY_TYPES.has(row.type)
  const state = row.type.slice('turn.'.length)
  const artifactIds = terminalEventEvidence(payload, 'artifactIds')
  const deliveryArtifactIds = terminalEventEvidence(payload, 'deliveryArtifactIds')
  const verifiedLocalFiles = terminalEventEvidence(payload, 'verifiedLocalFiles')
  const retainedLocalFiles = terminalEventEvidence(payload, 'retainedLocalFiles')
  const iterations = terminalEventEvidence(payload, 'iterations')
  const usage = terminalEventEvidence(payload, 'usage')
  const turnModelUsage = terminalEventEvidence(payload, 'turnModelUsage')
  const estimatedPromptTokens = terminalEventEvidence(payload, 'estimatedPromptTokens')
  const failedRetryRejection = context.failedRetryRejection
  const preservedFailedRetryRejection = row.type === 'turn.failed'
    && context.turnEvidence === true
    && context.evidenceState === 'failed'
    && context.serverLastSequence === row.sequence
    && failedRetryRejection && typeof failedRetryRejection === 'object'
    && !Array.isArray(failedRetryRejection)
    && failedRetryRejection.failureSequence === row.sequence
    && failedRetryRejection.code === context.error?.code
    && context.error?.retryable === false
      ? failedRetryRejection
      : null
  const terminalContextBase = { ...context }
  for (const key of [
    'error',
    'recovery',
    'failedRetryRejection',
    'paused',
    'clarification',
    'pausedSequence',
    'paused_sequence',
  ]) delete terminalContextBase[key]
  const recoveryKind = String(terminalEventEvidence(payload, 'recoveryKind') || '').trim()
  const recoveryToolCallId = String(terminalEventEvidence(payload, 'toolCallId') || '').trim()
  const recoveryModelRequestId = String(terminalEventEvidence(payload, 'modelRequestId') || '').trim()
  const recoveryAction = terminalEventEvidence(payload, 'recoveryAction')
  const recovery = row.type === 'turn.blocked'
    && terminalEventEvidence(payload, 'requiresUserVerification') === true
    && recoveryKind
    ? {
        recoveryKind,
        requiresUserVerification: true,
        ...(recoveryToolCallId ? { toolCallId: recoveryToolCallId } : {}),
        ...(recoveryModelRequestId ? { modelRequestId: recoveryModelRequestId } : {}),
        ...(recoveryAction && typeof recoveryAction === 'object' && !Array.isArray(recoveryAction)
          ? { recoveryAction }
          : {}),
      }
    : null
  const terminalContext = {
    ...terminalContextBase,
    turnId: row.turn_id,
    turnEvidence: true,
    evidenceState: state,
    serverLastSequence: row.sequence,
    turnCompletedAt: row.created_at,
    ...(Array.isArray(artifactIds)
      ? { artifactIds }
      : {}),
    ...(Array.isArray(deliveryArtifactIds)
      ? { deliveryArtifactIds }
      : {}),
    ...(Array.isArray(verifiedLocalFiles)
      ? { verifiedLocalFiles }
      : {}),
    ...(Array.isArray(retainedLocalFiles)
      ? { retainedLocalFiles }
      : {}),
    ...(Number.isInteger(iterations) && iterations >= 0
      ? { iterations }
      : {}),
    ...(usage && typeof usage === 'object' && !Array.isArray(usage) ? { usage } : {}),
    ...(turnModelUsage && typeof turnModelUsage === 'object' && !Array.isArray(turnModelUsage)
      ? { turnModelUsage }
      : {}),
    ...(Number.isInteger(estimatedPromptTokens) && estimatedPromptTokens >= 0
      ? { estimatedPromptTokens }
      : {}),
    ...(failureBoundary ? {
      error: preservedFailedRetryRejection ? context.error : eventFailure(payload, row.type),
    } : {}),
    ...(preservedFailedRetryRejection
      ? { failedRetryRejection: preservedFailedRetryRejection }
      : {}),
    ...(recovery ? { recovery } : {}),
    ...(row.type === 'turn.paused'
      ? {
          paused: true,
          pausedSequence: row.sequence,
          ...(payload.clarification ? { clarification: payload.clarification } : {}),
        }
      : {}),
  }
  const eventText = String(
    terminalEventEvidence(payload, 'partialText')
      ?? terminalEventEvidence(payload, 'text')
      ?? '',
  )
  return {
    ...(message || {}),
    id: `${row.turn_id}:assistant`,
    userId,
    sessionId,
    role: 'assistant',
    content: eventText || String(message?.content || ''),
    modelContext: terminalContext,
    createdAt: message?.createdAt ?? row.created_at,
    updatedAt: Math.max(Number(message?.updatedAt) || 0, Number(row.created_at) || 0),
  }
}

function recoverTerminalEvidenceMessages(messages, rows, scope, {
  synthesizeMissing = false,
  synthesisAnchorIds = null,
  includeUnanchored = false,
} = {}) {
  const byId = new Map(messages.map((message, index) => [message.id, index]))
  const recovered = [...messages]
  const missing = []
  let synthesized = 0
  for (const row of rows) {
    const id = `${row.turn_id}:assistant`
    const index = byId.get(id)
    if (index !== undefined) {
      recovered[index] = projectTerminalEvidence(recovered[index], row, scope)
    } else if (synthesizeMissing
      && !row.has_evidence_message
      && (synthesisAnchorIds === null
        || (row.evidence_anchor_id
          ? synthesisAnchorIds.has(row.evidence_anchor_id)
          : includeUnanchored))) {
      missing.push({ row, message: projectTerminalEvidence(null, row, scope) })
      synthesized += 1
    }
  }
  missing.sort((left, right) => (
    (Number(left.message.createdAt) || 0) - (Number(right.message.createdAt) || 0)
      || left.row.sequence - right.row.sequence
  ))
  for (const entry of missing) {
    const userMessageId = `${entry.row.turn_id}:user`
    const userIndex = recovered.findIndex((message) => message.id === userMessageId)
    if (userIndex >= 0) {
      let insertIndex = userIndex + 1
      while (insertIndex < recovered.length
        && String(recovered[insertIndex]?.modelContext?.turnId || '') === entry.row.turn_id) {
        insertIndex += 1
      }
      recovered.splice(insertIndex, 0, entry.message)
      continue
    }
    const createdAt = Number(entry.message.createdAt) || 0
    const nextIndex = recovered.findIndex((message) => (Number(message.createdAt) || 0) >= createdAt)
    if (nextIndex >= 0) recovered.splice(nextIndex, 0, entry.message)
    else recovered.push(entry.message)
  }
  return { messages: recovered, synthesized }
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
  if (!userId || !sessionId) return null
  const row = getDb().prepare(`
    SELECT token, id, title, created_at, updated_at, last_viewed_at, archived_at,
      pinned_at, revision, parent_session_id, branch_label, forked_at
    FROM sessions
    WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
  `).get(userId, sessionId)
  return mapSession(row)
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
      pinned_at, revision, parent_session_id, branch_label, forked_at
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
    if (write.changes !== 1) throw new MessageOwnershipError()
    db.prepare(`
      UPDATE sessions
      SET updated_at = CASE
        WHEN COALESCE(updated_at, 0) < ? THEN ?
        ELSE updated_at
      END
      WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
    `).run(updatedAt, updatedAt, userId, sessionId)
    const persisted = db.prepare(`
      SELECT id, role, content, model_context_json, created_at, updated_at
      FROM messages
      WHERE user_id = ? AND session_id = ? AND id = ?
    `).get(userId, sessionId, id)
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
    const session = getSession({ userId, sessionId })
    if (!session) return null
    // Session revisions track transcript mutations, while terminal turn events
    // are append-only and can change independently. Expose both watermarks so
    // a paged client cannot combine pages from different terminal states.
    const turnEventRevision = Number(db.prepare(`
      SELECT COALESCE(MAX(rowid), 0) AS revision
      FROM turn_events
      WHERE user_id = ? AND session_id = ?
    `).get(userId, sessionId)?.revision) || 0
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

export function deleteSession({ userId, sessionId, expectedRevision } = {}, governanceDependencies) {
  if (!userId || !sessionId) return null
  const revision = normalizeExpectedRevision(expectedRevision)
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
