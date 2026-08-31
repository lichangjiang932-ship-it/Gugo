import { isDeepStrictEqual } from 'node:util'
import { getDb } from '../db.js'
import { bindManagedAttachmentsToMessage } from './managedAttachmentStore.js'
import {
  getMessage,
  getSession,
  notifySessionStarted,
  upsertMessage,
  upsertSessionForAtomicCommit,
} from './sessionStore.js'
import {
  appendTurnEventsInTransaction,
  publishCommittedTurnEvents,
} from './turnEventStore.js'
import {
  failureAllowsFailedRetry,
  failureSupportsFailedRetry,
  MAX_FAILED_TURN_RETRIES,
  resetManualRetryVerificationBudget,
} from './turnFailedRetryPolicy.js'
import { isPermanentFailedRetryRejectionCode } from './turnFailedRetryRejection.js'
import {
  failedRetryAttemptPayload,
  isValidFailedRetryAttemptRecord,
} from './turnRecoveryProjection.js'

const TURN_BOUNDARY_TYPES = new Set([
  'turn.completed',
  'turn.cancelled',
  'turn.failed',
  'turn.paused',
  'turn.interrupted',
  'turn.blocked',
])

function persistenceError(code, message) {
  const error = new Error(message)
  error.code = code
  error.status = 409
  error.retryable = false
  return error
}

function parseJsonRecord(value) {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function storedTurnEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    sequence: row.sequence,
    type: row.type,
    payload: parseJsonRecord(row.payload_json) || {},
    createdAt: row.created_at,
  }
}

function resetRetryBudget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value || null
  return {
    ...value,
    used: 0,
    elapsed: 0,
    modelMs: 0,
    modelCalls: 0,
    modelTokens: 0,
    costUsd: 0,
    costEvidenceComplete: true,
  }
}

function failedRetryCheckpointState(state, attemptPayload) {
  const retryState = attemptPayload?.manualRetry === true
    ? resetManualRetryVerificationBudget(state)
    : state
  const iterations = Math.max(0, Number(retryState?.iterations) || 0)
  return {
    ...retryState,
    final: null,
    iterationWindowStart: iterations,
    retryAssistantText: String(attemptPayload?.assistantText || ''),
    retryReasoningText: String(attemptPayload?.reasoningText || ''),
    ...(state?.budget && typeof state.budget === 'object' && !Array.isArray(state.budget)
      ? { budget: resetRetryBudget(state.budget) }
      : {}),
  }
}

function normalizedExecutionLease(value) {
  const ownerId = String(value?.ownerId || '').trim()
  const fencingToken = Number(value?.fencingToken)
  if (!ownerId || !Number.isSafeInteger(fencingToken) || fencingToken <= 0) return null
  return { ownerId, fencingToken }
}

function assertLiveExecutionLease(db, { userId, event, executionLease, now }) {
  const proof = normalizedExecutionLease(executionLease)
  const checkedAt = Number(now)
  const live = proof && Number.isFinite(checkedAt)
    ? db.prepare(`
        SELECT 1
        FROM turn_execution_leases
        WHERE user_id = ? AND session_id = ? AND turn_id = ?
          AND owner_id = ? AND fencing_token = ? AND expires_at > ?
        LIMIT 1
      `).get(
        userId,
        event.sessionId,
        event.turnId,
        proof.ownerId,
        proof.fencingToken,
        checkedAt,
      )
    : null
  if (!live) {
    throw persistenceError(
      'TURN_EXECUTION_LEASE_STALE',
      'turn execution lease is missing, expired, or has been superseded',
    )
  }
  return proof
}

function assertEventScope({ userId, event, type = null } = {}) {
  if (!userId) throw new TypeError('userId is required')
  if (!event || typeof event !== 'object') throw new TypeError('event is required')
  if (!event.sessionId || !event.turnId) throw new TypeError('event sessionId and turnId are required')
  if (type && event.type !== type) {
    throw persistenceError('TURN_STORAGE_EVENT_TYPE_INVALID', `expected ${type} event`)
  }
}

function assertMessageScope(message, { userId, sessionId }) {
  if (!message || typeof message !== 'object') throw new TypeError('message must be an object')
  if (message.userId !== userId || message.sessionId !== sessionId) {
    throw persistenceError('TURN_STORAGE_SCOPE_MISMATCH', 'message scope does not match event scope')
  }
}

function comparableMessage(message, { ignoreCreatedAt = false } = {}) {
  let modelContext
  try {
    modelContext = message?.modelContext === null || message?.modelContext === undefined
      ? null
      : JSON.parse(JSON.stringify(message.modelContext))
  } catch {
    modelContext = message?.modelContext || null
  }
  return message ? {
    id: message.id,
    sessionId: message.sessionId,
    userId: message.userId,
    role: message.role,
    content: String(message.content ?? ''),
    modelContext,
    ...(!ignoreCreatedAt ? { createdAt: message.createdAt } : {}),
    updatedAt: message.updatedAt,
  } : null
}

function assertExistingMessage(readMessage, message, options = {}) {
  const existing = readMessage({
    userId: message.userId,
    sessionId: message.sessionId,
    messageId: message.id,
  })
  if (!isDeepStrictEqual(
    comparableMessage(existing, options),
    comparableMessage(message, options),
  )) {
    throw persistenceError(
      'TURN_STORAGE_OPERATION_CONFLICT',
      `persisted message ${message.id} does not match the retried operation`,
    )
  }
}

function failedRetryAttemptCount(db, { userId, sessionId, turnId }) {
  const events = db.prepare(`SELECT * FROM turn_events
    WHERE user_id = ? AND session_id = ? AND turn_id = ? ORDER BY sequence ASC`)
    .all(userId, sessionId, turnId)
    .map(storedTurnEvent)
  return events.reduce((count, event) => (
    isValidFailedRetryAttemptRecord(events, event) ? count + 1 : count
  ), 0)
}

function assertFailedRetryPayload(actual, expected) {
  const fields = [
    'attempt',
    'reason',
    'manualRetry',
    'resetStreaming',
    'checkpointSequence',
    'previousStreamSequence',
    'assistantText',
    'reasoningText',
  ]
  const actualIdentity = Object.fromEntries(fields.map((field) => [field, actual?.[field]]))
  const expectedIdentity = Object.fromEntries(fields.map((field) => [field, expected?.[field]]))
  if (!expected
    || !isDeepStrictEqual(actualIdentity, expectedIdentity)
    || !isDeepStrictEqual(actual, expected)) {
    throw persistenceError(
      'TURN_FAILED_RETRY_EVENT_INVALID',
      'failed Turn retry metadata does not match persisted Turn history',
    )
  }
}

function assertStoredFailedRetryEvent(row, { userId, event, expectedPayload }) {
  if (!row
    || row.user_id !== userId
    || row.session_id !== event.sessionId
    || row.turn_id !== event.turnId
    || row.sequence !== event.sequence
    || row.type !== 'turn.attempt'
    || !String(row.id || '').trim()
    || !Number.isFinite(Number(row.created_at))) {
    throw persistenceError(
      'TURN_FAILED_RETRY_CONFLICT',
      'persisted failed Turn retry event identity is incomplete or conflicting',
    )
  }
  assertFailedRetryPayload(parseJsonRecord(row.payload_json), expectedPayload)
}

function normalizeAttachmentBinding(value, { userId, sessionId }) {
  if (!value) return null
  const attachmentIds = [...new Set((Array.isArray(value.attachmentIds) ? value.attachmentIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))]
  if (attachmentIds.length === 0) return null
  if (value.userId !== userId || value.sessionId !== sessionId || !value.messageId) {
    throw persistenceError('TURN_STORAGE_SCOPE_MISMATCH', 'attachment scope does not match event scope')
  }
  return { ...value, attachmentIds }
}

function eventAttachmentIds(event) {
  return [...new Set((Array.isArray(event?.payload?.attachments) ? event.payload.attachments : [])
    .map((attachment) => typeof attachment === 'object' ? attachment?.id : attachment)
    .map((id) => String(id || '').trim())
    .filter(Boolean))]
}

function assertAttachmentOperationIdentity(binding, event) {
  const expectedIds = eventAttachmentIds(event)
  const actualIds = binding?.attachmentIds || []
  const expectedMessageId = String(event?.payload?.userMessageId || '').trim()
  if (!isDeepStrictEqual(actualIds, expectedIds)
    || (binding && binding.messageId !== expectedMessageId)) {
    throw persistenceError(
      'TURN_STORAGE_OPERATION_CONFLICT',
      'attachment binding does not match the turn.started operation identity',
    )
  }
}

/**
 * SQLite implementation of the aggregate Turn commit boundary.
 *
 * Dependencies are injectable only for conformance/fault-injection tests. The
 * production instance always uses the single process database and never mixes
 * another Session/Event implementation into this transaction.
 */
export function createSqliteTurnPersistenceTransactions({
  openDatabase = getDb,
  readSession = getSession,
  readMessage = getMessage,
  writeSession = upsertSessionForAtomicCommit,
  writeMessage = upsertMessage,
  bindAttachments = bindManagedAttachmentsToMessage,
  appendEventsInTransaction = appendTurnEventsInTransaction,
  publishEvents = publishCommittedTurnEvents,
  notifySession = notifySessionStarted,
  now = Date.now,
} = {}) {
  const commit = ({
    userId,
    event,
    checkpointState = null,
    mutate = null,
    executionLease,
  }) => {
    const db = openDatabase()
    let committed
    let mutationResult
    db.transaction(() => {
      assertLiveExecutionLease(db, { userId, event, executionLease, now: now() })
      mutationResult = mutate?.({ db })
      committed = appendEventsInTransaction([{ userId, event, checkpointState }], db)
    }).immediate()
    publishEvents(committed.insertedEvents)
    return { event: committed.stored[0], inserted: committed.insertedEvents.length > 0, mutationResult }
  }

  return Object.freeze({
    async commitTurnStart({
      userId,
      session = null,
      messages = [],
      attachmentBinding = null,
      attachmentBindingAuthorized = false,
      event,
    } = {}) {
      assertEventScope({ userId, event, type: 'turn.started' })
      if (event.sequence !== 0) {
        throw persistenceError('TURN_STORAGE_SEQUENCE_INVALID', 'turn.started must use sequence 0')
      }
      const sessionId = event.sessionId
      const scopedMessages = Array.isArray(messages) ? messages : []
      for (const message of scopedMessages) assertMessageScope(message, { userId, sessionId })
      const binding = normalizeAttachmentBinding(attachmentBinding, { userId, sessionId })
      assertAttachmentOperationIdentity(binding, event)
      let createdSession = false
      let committed
      const db = openDatabase()
      db.transaction(() => {
        let currentSession = readSession({ userId, sessionId })
        if (!currentSession && session) {
          if (session.userId !== userId || session.id !== sessionId) {
            throw persistenceError('TURN_STORAGE_SCOPE_MISMATCH', 'session scope does not match event scope')
          }
          currentSession = writeSession(session)
          createdSession = true
        }
        if (!currentSession) throw new Error('session not found')

        committed = appendEventsInTransaction([{ userId, event, checkpointState: null }], db)
        const inserted = committed.insertedEvents.length > 0
        for (const message of scopedMessages) {
          if (inserted) writeMessage(message)
          assertExistingMessage(readMessage, message)
        }
        if (binding && inserted) {
          if (attachmentBindingAuthorized !== true) {
            throw persistenceError(
              'TURN_ATTACHMENT_ATOMIC_BINDING_UNAUTHORIZED',
              'SQLite turn start requires host authorization for its attachment transaction domain',
            )
          }
          bindAttachments(binding)
        }
      })()
      publishEvents(committed.insertedEvents)
      if (createdSession) {
        notifySession({ userId, sessionId, title: session?.title || 'Untitled' })
      }
      return committed.stored[0]
    },

    async commitTurnCheckpoint({ userId, event, checkpointState, executionLease } = {}) {
      assertEventScope({ userId, event, type: 'turn.checkpoint' })
      if (!checkpointState || typeof checkpointState !== 'object' || Array.isArray(checkpointState)) {
        throw new TypeError('checkpointState must be an object')
      }
      return commit({ userId, event, checkpointState, executionLease }).event
    },

    async commitTurnBoundary({ userId, event, message = null, executionLease } = {}) {
      assertEventScope({ userId, event })
      if (!TURN_BOUNDARY_TYPES.has(event.type)) {
        throw persistenceError('TURN_STORAGE_EVENT_TYPE_INVALID', 'event is not a Turn boundary')
      }
      if (message) assertMessageScope(message, { userId, sessionId: event.sessionId })
      const db = openDatabase()
      let committed
      db.transaction(() => {
        assertLiveExecutionLease(db, { userId, event, executionLease, now: now() })
        committed = appendEventsInTransaction([{ userId, event, checkpointState: null }], db)
        if (message) {
          if (committed.insertedEvents.length > 0) writeMessage(message)
          // Boundary transitions intentionally reuse `${turnId}:assistant`.
          // SQLite preserves the first projection's created_at on upsert, so
          // paused/blocked evidence can advance without weakening the exact
          // comparison of mutable content, context, and updated_at.
          assertExistingMessage(readMessage, message, { ignoreCreatedAt: true })
        }
      }).immediate()
      publishEvents(committed.insertedEvents)
      return committed.stored[0]
    },

    async commitTurnFailedRetry({ userId, event, message } = {}) {
      assertEventScope({ userId, event, type: 'turn.attempt' })
      if (event.payload?.reason !== 'failed_retry' || event.payload?.resetStreaming !== true) {
        throw persistenceError(
          'TURN_FAILED_RETRY_EVENT_INVALID',
          'failed Turn retry requires a resetStreaming failed_retry attempt event',
        )
      }
      assertMessageScope(message, { userId, sessionId: event.sessionId })
      if (message.id !== `${event.turnId}:assistant`
        || message.role !== 'assistant'
        || message.content !== event.payload.assistantText
        || message.modelContext?.turnId !== event.turnId
        || message.modelContext?.turnEvidence !== true
        || message.modelContext?.evidenceState !== 'retrying'
        || message.modelContext?.serverLastSequence !== event.sequence
        || message.updatedAt !== event.createdAt) {
        throw persistenceError(
          'TURN_FAILED_RETRY_PROJECTION_INVALID',
          'failed Turn retry projection does not match the retry attempt',
        )
      }

      const db = openDatabase()
      let committed
      db.transaction(() => {
        const checkpoint = db.prepare(`SELECT event_sequence, state_json FROM turn_checkpoints
          WHERE user_id = ? AND session_id = ? AND turn_id = ?`).get(
          userId,
          event.sessionId,
          event.turnId,
        )
        const checkpointState = parseJsonRecord(checkpoint?.state_json)
        if (!checkpointState || !Number.isInteger(checkpoint?.event_sequence)) {
          throw persistenceError(
            'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED',
            'a durable Turn checkpoint is required before retrying a failed Turn',
          )
        }

        const eventRows = db.prepare(`SELECT * FROM turn_events
          WHERE user_id = ? AND session_id = ? AND turn_id = ?
          ORDER BY sequence ASC`).all(userId, event.sessionId, event.turnId)
        const persistedEvents = eventRows.map(storedTurnEvent)
        const existingRetry = db.prepare(`SELECT * FROM turn_events
          WHERE user_id = ? AND session_id = ? AND turn_id = ? AND sequence = ?
          LIMIT 1`).get(userId, event.sessionId, event.turnId, event.sequence)
        const latest = eventRows.at(-1)
        const failureRow = existingRetry
          ? eventRows.find((row) => row.sequence === event.sequence - 1)
          : latest
        const failureEvent = storedTurnEvent(failureRow)
        if (!failureEvent || failureEvent.type !== 'turn.failed') {
          throw persistenceError(
            'TURN_FAILED_RETRY_CONFLICT',
            'the Turn is no longer at a failed terminal boundary',
          )
        }
        const expectedPayload = failedRetryAttemptPayload(
          persistedEvents,
          failureEvent,
          { eventSequence: checkpoint.event_sequence },
        )
        assertFailedRetryPayload(event.payload, expectedPayload)

        if (existingRetry) {
          assertStoredFailedRetryEvent(existingRetry, { userId, event, expectedPayload })
          assertExistingMessage(readMessage, {
            ...message,
            updatedAt: existingRetry.created_at,
          }, { ignoreCreatedAt: true })
          committed = {
            stored: [storedTurnEvent(existingRetry)],
            insertedEvents: [],
          }
          return
        }
        const failure = parseJsonRecord(latest.payload_json)
        if (!failureAllowsFailedRetry(failure, event.payload)) {
          throw persistenceError(
            'TURN_FAILED_RETRY_NOT_ALLOWED',
            'the failed Turn does not authorize this retry mode',
          )
        }
        if (event.sequence !== latest.sequence + 1) {
          throw persistenceError(
            'TURN_FAILED_RETRY_CONFLICT',
            'the failed Turn retry sequence is stale',
          )
        }

        if (event.payload.checkpointSequence !== checkpoint.event_sequence) {
          throw persistenceError(
            'TURN_FAILED_RETRY_CHECKPOINT_CONFLICT',
            'the failed Turn checkpoint changed before retry',
          )
        }

        const checkpointUpdate = db.prepare(`UPDATE turn_checkpoints
          SET state_json = ?, updated_at = ?
          WHERE user_id = ? AND session_id = ? AND turn_id = ? AND event_sequence = ?`).run(
          JSON.stringify({
            ...failedRetryCheckpointState(checkpointState, event.payload),
            checkpointVersion: 1,
          }),
          event.createdAt,
          userId,
          event.sessionId,
          event.turnId,
          checkpoint.event_sequence,
        )
        if (checkpointUpdate.changes !== 1) {
          throw persistenceError(
            'TURN_FAILED_RETRY_CHECKPOINT_CONFLICT',
            'the failed Turn checkpoint could not be atomically updated',
          )
        }

        committed = appendEventsInTransaction(
          [{ userId, event, checkpointState: null }],
          db,
          { allowFailedRetry: true },
        )
        if (committed.insertedEvents.length !== 1) {
          throw persistenceError(
            'TURN_FAILED_RETRY_CONFLICT',
            'the failed Turn retry attempt was already committed',
          )
        }
        writeMessage(message)
        assertExistingMessage(readMessage, message, { ignoreCreatedAt: true })
      }).immediate()
      publishEvents(committed.insertedEvents)
      return committed.stored[0]
    },

    async commitTurnFailedRetryRejection({ userId, failureEvent, message } = {}) {
      assertEventScope({ userId, event: failureEvent, type: 'turn.failed' })
      assertMessageScope(message, { userId, sessionId: failureEvent.sessionId })
      const rejection = message.modelContext?.failedRetryRejection
      if (message.id !== `${failureEvent.turnId}:assistant`
        || message.role !== 'assistant'
        || message.modelContext?.turnEvidence !== true
        || message.modelContext?.evidenceState !== 'failed'
        || message.modelContext?.serverLastSequence !== failureEvent.sequence
        || message.modelContext?.error?.retryable !== false
        || rejection?.failureSequence !== failureEvent.sequence
        || rejection?.code !== message.modelContext?.error?.code
        || !isPermanentFailedRetryRejectionCode(rejection?.code)) {
        throw persistenceError(
          'TURN_FAILED_RETRY_REJECTION_PROJECTION_INVALID',
          'failed Turn retry rejection projection does not match the terminal failure',
        )
      }

      const db = openDatabase()
      db.transaction(() => {
        const latest = db.prepare(`SELECT id, sequence, type, payload_json FROM turn_events
          WHERE user_id = ? AND session_id = ? AND turn_id = ?
          ORDER BY sequence DESC LIMIT 1`).get(
          userId,
          failureEvent.sessionId,
          failureEvent.turnId,
        )
        if (!latest
          || latest.id !== failureEvent.id
          || latest.sequence !== failureEvent.sequence
          || latest.type !== 'turn.failed') {
          throw persistenceError(
            'TURN_FAILED_RETRY_REJECTION_CONFLICT',
            'the Turn is no longer at the failed terminal being rejected',
          )
        }
        const failure = parseJsonRecord(latest.payload_json)
        const retryLimitReached = rejection.code === 'TURN_FAILED_RETRY_LIMIT_REACHED'
          && failedRetryAttemptCount(db, {
            userId,
            sessionId: failureEvent.sessionId,
            turnId: failureEvent.turnId,
          }) >= MAX_FAILED_TURN_RETRIES
        if (!failureSupportsFailedRetry(failure) && !retryLimitReached) {
          throw persistenceError(
            'TURN_FAILED_RETRY_REJECTION_CONFLICT',
            'the terminal failure is no longer eligible for failed retry rejection',
          )
        }
        writeMessage(message)
        assertExistingMessage(readMessage, message, { ignoreCreatedAt: true })
      }).immediate()
      return message
    },
  })
}

export const SQLITE_TURN_PERSISTENCE_TRANSACTIONS = createSqliteTurnPersistenceTransactions()
