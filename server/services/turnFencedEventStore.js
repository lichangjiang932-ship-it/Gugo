import { getDb } from '../db.js'
import {
  appendTurnEventsInTransaction,
  publishCommittedTurnEvents,
} from './turnEventStore.js'
import { assertLiveTurnExecutionLease } from './turnExecutionLeaseStore.js'

/**
 * Built-in SQLite event append that fences every execution-owned event, not
 * only checkpoints and terminal boundaries. Pre-execution lifecycle events do
 * not carry an executionLease and retain the ordinary append contract.
 */
export function appendFencedTurnEvents(entries = []) {
  if (!Array.isArray(entries)) throw new TypeError('turn event entries must be an array')
  if (entries.length === 0) return []
  const db = getDb()
  let committed
  db.transaction(() => {
    for (const entry of entries) {
      if (entry?.executionLease) {
        assertLiveTurnExecutionLease(db, {
          userId: entry.userId,
          event: entry.event,
          executionLease: entry.executionLease,
        })
      }
    }
    committed = appendTurnEventsInTransaction(entries, db)
  }).immediate()
  publishCommittedTurnEvents(committed.insertedEvents)
  return committed.stored
}

export function appendFencedTurnEvent(entry) {
  return appendFencedTurnEvents([entry])[0]
}
