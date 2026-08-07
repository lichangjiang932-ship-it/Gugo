import assert from 'node:assert/strict'
import test from 'node:test'

import { groupSessions, timestampOf } from '../src/components/leftRail/sessionListUtils.js'

test('session history uses calendar-week boundaries and newest-first ordering', () => {
  const now = new Date(2026, 7, 10, 12).getTime() // Monday
  const sessions = [
    { id: 'last-week', updatedAt: new Date(2026, 7, 9, 23).toISOString() },
    { id: 'today-old', updatedAt: new Date(2026, 7, 10, 8).toISOString() },
    { id: 'today-new', updatedAt: new Date(2026, 7, 10, 11).toISOString() },
  ]

  const grouped = groupSessions(sessions, now)
  assert.deepEqual(grouped.today.map(({ id }) => id), ['today-new', 'today-old'])
  assert.deepEqual(grouped.yesterday.map(({ id }) => id), ['last-week'])
  assert.deepEqual(grouped.week, [])
})

test('session history keeps earlier dates outside the current calendar week', () => {
  const now = new Date(2026, 7, 13, 12).getTime() // Thursday
  const grouped = groupSessions([
    { id: 'yesterday', updatedAt: new Date(2026, 7, 12, 9).toISOString() },
    { id: 'monday', updatedAt: new Date(2026, 7, 10, 9).toISOString() },
    { id: 'sunday', updatedAt: new Date(2026, 7, 9, 9).toISOString() },
  ], now)

  assert.deepEqual(grouped.yesterday.map(({ id }) => id), ['yesterday'])
  assert.deepEqual(grouped.week.map(({ id }) => id), ['monday'])
  assert.deepEqual(grouped.earlier.map(({ id }) => id), ['sunday'])
})

test('timestampOf accepts message timestamps and rejects invalid values', () => {
  assert.equal(timestampOf({ messages: [{ timestamp: '2026-08-07T08:00:00.000Z' }] }), Date.parse('2026-08-07T08:00:00.000Z'))
  assert.equal(timestampOf({ updatedAt: 'not-a-date' }), 0)
})
