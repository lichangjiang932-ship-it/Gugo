import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatRelativeSessionTime,
  groupSessionsByProject,
  pinnedTimestampOf,
  sessionProjectLabel,
  sessionSummaryLabel,
  sortSessions,
  timestampOf,
} from '../src/components/leftRail/sessionListUtils.js'

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

test('path-like session titles collapse to a project label without exposing the full path', () => {
  const session = {
    title: 'E:\\果\\gallery.html',
    updatedAt: '2026-08-19T00:00:00.000Z',
  }
  assert.equal(sessionProjectLabel(session), 'gallery')
  assert.equal(sessionSummaryLabel(session), 'gallery.html')
  assert.doesNotMatch(sessionProjectLabel(session), /E:|\\/)
  assert.deepEqual(groupSessionsByProject([session]), [{ project: 'gallery', sessions: [session] }])
})

test('session time uses localized relative labels before falling back to a short date', () => {
  const now = Date.parse('2026-08-19T00:10:00.000Z')
  assert.match(formatRelativeSessionTime({ updatedAt: now - 5 * 60_000 }, { now, locale: 'zh-CN' }), /5\s*分钟/)
  assert.match(formatRelativeSessionTime({ updatedAt: now - 10 * 86_400_000 }, { now, locale: 'zh-CN' }), /8.*9|08.*09/)
})

test('pinned sessions stay above recent sessions with stable pin ordering', () => {
  const sessions = [
    { id: 'recent', updatedAt: 9000 },
    { id: 'pin-older', pinnedAt: 4000, updatedAt: 2000 },
    { id: 'pin-newer', pinnedAt: 5000, updatedAt: 1000 },
    { id: 'older', updatedAt: 3000 },
  ]

  assert.equal(pinnedTimestampOf(sessions[2]), 5000)
  assert.deepEqual(sortSessions(sessions).map(({ id }) => id), [
    'pin-newer', 'pin-older', 'recent', 'older',
  ])

  const tied = [
    { id: 'pin-b', pinnedAt: 6000, updatedAt: 9000 },
    { id: 'pin-a', pinnedAt: 6000, updatedAt: 1000 },
  ]
  assert.deepEqual(sortSessions(tied).map(({ id }) => id), ['pin-a', 'pin-b'])
})
