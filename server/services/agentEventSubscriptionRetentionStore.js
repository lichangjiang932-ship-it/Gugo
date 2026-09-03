import { getDb } from '../db.js'
import {
  nonNegativeInteger,
  readStreamMetadata,
  subscriptionError,
} from './agentEventSubscriptionRegistryStore.js'

function retentionWatermarkInDb(db) {
  const stream = readStreamMetadata(db)
  const rows = db.prepare(`
    SELECT status, scanned_cursor, stream_epoch
    FROM agent_event_subscriptions
    ORDER BY subscription_key
  `).all()
  if (rows.some((row) => !['active', 'disabled'].includes(row.status)
    || !Number.isSafeInteger(row.scanned_cursor)
    || row.scanned_cursor < 0
    || !Number.isSafeInteger(row.stream_epoch)
    || row.stream_epoch < 1)) {
    return Object.freeze({ allowed: false, reason: 'state_unknown', stream, watermark: null })
  }
  const blockers = rows.filter((row) => row.status === 'active')
  if (blockers.length === 0) {
    const outboxWatermark = db.prepare(`
      SELECT MAX(cursor) AS watermark FROM agent_event_outbox
    `).get()?.watermark
    const watermark = outboxWatermark ?? stream.truncatedThrough
    if (!Number.isSafeInteger(watermark) || watermark < stream.truncatedThrough) {
      return Object.freeze({ allowed: false, reason: 'state_unknown', stream, watermark: null })
    }
    return Object.freeze({
      allowed: true,
      reason: null,
      stream,
      watermark,
      blockingSubscriptions: 0,
    })
  }
  if (blockers.some((row) => row.stream_epoch !== stream.epoch
    || row.scanned_cursor < stream.truncatedThrough)) {
    return Object.freeze({ allowed: false, reason: 'state_unknown', stream, watermark: null })
  }
  return Object.freeze({
    allowed: true,
    reason: null,
    stream,
    watermark: Math.min(...blockers.map((row) => row.scanned_cursor)),
    blockingSubscriptions: blockers.length,
  })
}

export function getAgentEventRetentionWatermark({ db = getDb() } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required')
  return db.inTransaction
    ? retentionWatermarkInDb(db)
    : db.transaction(() => retentionWatermarkInDb(db))()
}

export function truncateAgentEventOutboxToSafeWatermark({
  now = Date.now(),
  db = getDb(),
} = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required')
  if (db.inTransaction) {
    throw subscriptionError(
      'AGENT_EVENT_TRUNCATION_TRANSACTION_REQUIRED',
      'safe Agent Event truncation must own an IMMEDIATE transaction',
    )
  }
  const timestamp = nonNegativeInteger(now, 'now')
  return db.transaction(() => {
    const state = retentionWatermarkInDb(db)
    if (!state.allowed) {
      return Object.freeze({
        truncated: false,
        reason: state.reason,
        deleted: 0,
        stream: state.stream,
      })
    }
    if (state.watermark <= state.stream.truncatedThrough) {
      return Object.freeze({
        truncated: false,
        reason: 'at_watermark',
        deleted: 0,
        stream: state.stream,
      })
    }
    const nextEpoch = state.stream.epoch + 1
    if (!Number.isSafeInteger(nextEpoch)) {
      throw subscriptionError(
        'AGENT_EVENT_SUBSCRIPTION_STATE_UNKNOWN',
        'Agent Event stream epoch cannot advance safely',
      )
    }
    const metadata = db.prepare(`
      UPDATE agent_event_stream_metadata
      SET epoch = ?, truncated_through = ?
      WHERE stream_key = 'global' AND epoch = ? AND truncated_through = ?
    `).run(
      nextEpoch,
      state.watermark,
      state.stream.epoch,
      state.stream.truncatedThrough,
    )
    if (metadata.changes !== 1) {
      throw subscriptionError(
        'AGENT_EVENT_SUBSCRIPTION_STATE_UNKNOWN',
        'Agent Event stream metadata changed during truncation',
      )
    }
    const subscriptions = db.prepare(`
      UPDATE agent_event_subscriptions
      SET stream_epoch = ?, updated_at = ?
      WHERE status = 'active' AND stream_epoch = ? AND scanned_cursor >= ?
    `).run(nextEpoch, timestamp, state.stream.epoch, state.watermark)
    if (subscriptions.changes !== state.blockingSubscriptions) {
      throw subscriptionError(
        'AGENT_EVENT_SUBSCRIPTION_STATE_UNKNOWN',
        'durable subscription set changed during truncation',
      )
    }
    const deleted = db.prepare(`
      DELETE FROM agent_event_outbox WHERE cursor <= ?
    `).run(state.watermark).changes
    return Object.freeze({
      truncated: true,
      reason: null,
      deleted,
      watermark: state.watermark,
      stream: Object.freeze({ epoch: nextEpoch, truncatedThrough: state.watermark }),
    })
  }).immediate()
}
