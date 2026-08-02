import test from 'node:test'
import assert from 'node:assert/strict'

import {
  backfillMessageTimestamps,
  formatMessageDateTime,
  formatMessageTime,
  formatSessionGroupDate,
  groupSessionsByDay,
  normalizeMessageTimestamp,
} from '../src/lib/messageTime.js'

test('backfillMessageTimestamps preserves valid timestamps and fills missing ones stably', () => {
  const existing = 1_800_000_000_000
  const createdAt = 1_700_000_000_000
  const sessions = [{
    id: 'session-1',
    createdAt,
    messages: [
      { id: 'a', timestamp: existing },
      { id: 'b' },
      { id: 'c', timestamp: 'invalid' },
    ],
  }]

  const result = backfillMessageTimestamps(sessions, 1_900_000_000_000)

  assert.equal(result[0].messages[0], sessions[0].messages[0])
  assert.equal(result[0].messages[0].timestamp, existing)
  assert.equal(result[0].messages[1].timestamp, createdAt + 1)
  assert.equal(result[0].messages[2].timestamp, createdAt + 2)
})

test('backfillMessageTimestamps returns existing references when nothing changes', () => {
  const sessions = [{ messages: [{ timestamp: 1_700_000_000_000 }] }]
  const result = backfillMessageTimestamps(sessions)

  assert.equal(result[0], sessions[0])
  assert.equal(result[0].messages[0], sessions[0].messages[0])
})

test('message time formatters handle supported languages and invalid values', () => {
  const timestamp = Date.UTC(2026, 7, 2, 12, 34, 56)

  assert.equal(normalizeMessageTimestamp('2026-08-02T12:34:56.000Z'), timestamp)
  assert.equal(normalizeMessageTimestamp('invalid'), null)
  assert.equal(formatMessageTime('invalid', 'zh'), '')
  assert.match(formatMessageTime(timestamp, 'en'), /\d{2}:\d{2}/)
  assert.match(formatMessageDateTime(timestamp, 'ja'), /2026/)
})

test('sidebar sessions group by latest activity date and sort newest first', () => {
  const groups = groupSessionsByDay([
    { id: 'old', createdAt: '2026-08-01T08:00:00+08:00', updatedAt: '2026-08-01T09:00:00+08:00' },
    { id: 'newer', createdAt: '2026-08-02T08:00:00+08:00', updatedAt: '2026-08-02T10:00:00+08:00' },
    { id: 'newest', createdAt: '2026-08-02T07:00:00+08:00', updatedAt: '2026-08-02T11:00:00+08:00' },
  ])

  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].items.map((session) => session.id), ['newest', 'newer'])
  assert.deepEqual(groups[1].items.map((session) => session.id), ['old'])
  assert.match(formatSessionGroupDate(groups[1].dayStart, 'zh', Date.parse('2026-08-02T12:00:00+08:00')), /8/)
})
