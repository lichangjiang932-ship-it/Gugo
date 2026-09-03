import { createHash } from 'node:crypto'

import {
  createTurnEventTransportEnvelope,
  parseTurnEventTransportEnvelope,
} from '../../shared/turnEvents.js'
import { projectTurnEventForClient } from '../../shared/turnEventProjection.js'
import { getDb } from '../db.js'

const DEFAULT_PAGE_LIMIT = 100
const MAX_PAGE_LIMIT = 1_000

function outboxError(code, message) {
  return Object.assign(new Error(message), {
    name: 'AgentEventOutboxError',
    code,
    retryable: false,
  })
}

function eventFingerprint(userId, envelope) {
  return createHash('sha256')
    .update(JSON.stringify({ userId, envelope }))
    .digest('hex')
}

function nonNegativeCursor(value) {
  const cursor = Number(value)
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw outboxError(
      'AGENT_EVENT_OUTBOX_CURSOR_INVALID',
      'afterCursor must be a non-negative safe integer',
    )
  }
  return cursor
}

function boundedPageLimit(value) {
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw outboxError(
      'AGENT_EVENT_OUTBOX_LIMIT_INVALID',
      'limit must be a positive safe integer',
    )
  }
  return Math.min(limit, MAX_PAGE_LIMIT)
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value
  const pending = [value]
  const seen = new Set()
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    for (const child of Object.values(current)) {
      if (child && typeof child === 'object') pending.push(child)
    }
    Object.freeze(current)
  }
  return value
}

function parseStoredEnvelope(row) {
  let envelope
  try {
    envelope = parseTurnEventTransportEnvelope(JSON.parse(row.envelope_json))
  } catch (cause) {
    throw Object.assign(
      outboxError('AGENT_EVENT_OUTBOX_CORRUPT', 'stored Agent Event envelope is invalid'),
      { cause },
    )
  }
  const fingerprint = eventFingerprint(row.user_id, envelope)
  if (row.event_id !== envelope.event.id
    || row.event_type !== envelope.event.type
    || row.created_at !== envelope.event.createdAt
    || row.event_fingerprint !== fingerprint) {
    throw outboxError(
      'AGENT_EVENT_OUTBOX_CORRUPT',
      'stored Agent Event identity does not match its envelope',
    )
  }
  return deepFreeze(envelope)
}

function mapStoredRow(row, { inserted = false } = {}) {
  const envelope = parseStoredEnvelope(row)
  return Object.freeze({
    cursor: row.cursor,
    eventId: row.event_id,
    userId: row.user_id,
    eventType: row.event_type,
    envelope,
    eventFingerprint: row.event_fingerprint,
    createdAt: row.created_at,
    inserted,
  })
}

function readStreamMetadata(db) {
  const row = db.prepare(`
    SELECT epoch, truncated_through
    FROM agent_event_stream_metadata
    WHERE stream_key = 'global'
  `).get()
  if (!row
    || !Number.isSafeInteger(row.epoch)
    || row.epoch < 1
    || !Number.isSafeInteger(row.truncated_through)
    || row.truncated_through < 0) {
    throw outboxError(
      'AGENT_EVENT_OUTBOX_CORRUPT',
      'Agent Event stream metadata is missing or invalid',
    )
  }
  return Object.freeze({
    epoch: row.epoch,
    truncatedThrough: row.truncated_through,
  })
}

/** Capture one newly inserted Turn event inside its caller-owned transaction. */
export function enqueueAgentEventOutboxInDb(db, { userId, event } = {}) {
  if (!db || typeof db.prepare !== 'function' || db.inTransaction !== true) {
    throw outboxError(
      'AGENT_EVENT_OUTBOX_TRANSACTION_REQUIRED',
      'caller-owned Agent Event outbox transaction is required',
    )
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('user id is required')
  }
  const ownerId = userId

  const envelope = createTurnEventTransportEnvelope(projectTurnEventForClient(event))
  const envelopeJson = JSON.stringify(envelope)
  const fingerprint = eventFingerprint(ownerId, envelope)
  const result = db.prepare(`
    INSERT INTO agent_event_outbox (
      event_id, user_id, event_type, envelope_json, event_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING
  `).run(
    envelope.event.id,
    ownerId,
    envelope.event.type,
    envelopeJson,
    fingerprint,
    envelope.event.createdAt,
  )
  const row = result.changes === 1
    ? db.prepare('SELECT * FROM agent_event_outbox WHERE cursor = ?')
      .get(Number(result.lastInsertRowid))
    : db.prepare('SELECT * FROM agent_event_outbox WHERE event_id = ?')
      .get(envelope.event.id)
  if (!row
    || row.user_id !== ownerId
    || row.event_type !== envelope.event.type
    || row.envelope_json !== envelopeJson
    || row.event_fingerprint !== fingerprint
    || row.created_at !== envelope.event.createdAt) {
    throw outboxError(
      'AGENT_EVENT_OUTBOX_IDEMPOTENCY_CONFLICT',
      'event id was already used for a different Agent Event',
    )
  }
  return mapStoredRow(row, { inserted: result.changes === 1 })
}

/**
 * Read a bounded global-cursor page for host-owned replay orchestration.
 * Entries include internal tenant identity and must never cross a plugin or
 * public transport boundary; only each entry's envelope is plugin-safe.
 */
export function readAgentEventOutboxPage({
  afterCursor = 0,
  limit = DEFAULT_PAGE_LIMIT,
  db = getDb(),
} = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required')
  const cursor = nonNegativeCursor(afterCursor)
  const pageLimit = boundedPageLimit(limit)
  const readPage = () => {
    const stream = readStreamMetadata(db)
    if (cursor < stream.truncatedThrough) {
      const error = outboxError(
        'AGENT_EVENT_OUTBOX_CURSOR_TRUNCATED',
        'afterCursor is older than the retained Agent Event stream',
      )
      error.details = Object.freeze({
        epoch: stream.epoch,
        afterCursor: cursor,
        truncatedThrough: stream.truncatedThrough,
      })
      throw error
    }
    const rows = db.prepare(`
      SELECT * FROM agent_event_outbox
      WHERE cursor > ?
      ORDER BY cursor ASC
      LIMIT ?
    `).all(cursor, pageLimit + 1)
    const hasMore = rows.length > pageLimit
    const entries = Object.freeze(rows.slice(0, pageLimit).map((row) => mapStoredRow(row)))
    return Object.freeze({
      stream,
      entries,
      afterCursor: cursor,
      nextCursor: entries.at(-1)?.cursor ?? cursor,
      limit: pageLimit,
      hasMore,
    })
  }
  return db.inTransaction ? readPage() : db.transaction(readPage)()
}
