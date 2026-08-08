import assert from 'node:assert/strict'
import test from 'node:test'

import { sortSessions, timestampOf } from '../src/components/leftRail/sessionListUtils.js'

test('session history is one continuous newest-first list', () => {
  const sessions = [
    { id: 'last-week', updatedAt: new Date(2026, 7, 9, 23).toISOString() },
    { id: 'today-old', updatedAt: new Date(2026, 7, 10, 8).toISOString() },
    { id: 'today-new', updatedAt: new Date(2026, 7, 10, 11).toISOString() },
  ]

  assert.deepEqual(sortSessions(sessions).map(({ id }) => id), ['today-new', 'today-old', 'last-week'])
  assert.deepEqual(sortSessions([]), [])
})

test('timestampOf accepts message timestamps and rejects invalid values', () => {
  assert.equal(timestampOf({ messages: [{ timestamp: '2026-08-07T08:00:00.000Z' }] }), Date.parse('2026-08-07T08:00:00.000Z'))
  assert.equal(timestampOf({ updatedAt: 'not-a-date' }), 0)
})
