import assert from 'node:assert/strict'
import test from 'node:test'

import { formatLocalDateTime, parseLocalDateTime } from '../shared/localDateTime.js'

test('a local date or date-time parses to local midnight or the stated minute', () => {
  const midnight = parseLocalDateTime('2026-09-21')
  assert.equal(midnight.ok, true)
  assert.equal(new Date(midnight.ms).getHours(), 0)
  assert.equal(new Date(midnight.ms).getMinutes(), 0)

  const spaced = parseLocalDateTime('2026-09-21 18:30')
  const iso = parseLocalDateTime('2026-09-21T18:30')
  assert.equal(spaced.ok, true)
  assert.equal(spaced.ms, iso.ms, 'a space and a T must mean the same instant')
  assert.equal(spaced.ms - midnight.ms, (18 * 60 + 30) * 60_000)
})

test('an impossible or malformed date is rejected rather than rolled forward', () => {
  // `new Date(2026, 12, 45)` silently becomes 2027-02-14, which would move a
  // caller's window without saying so.
  for (const value of ['2026-13-01', '2026-02-30', '2026-00-10', '2026-09-21T25:00', '2026-09-21T18:60', 'yesterday', '2026/09/21', '2026-9-1', '']) {
    assert.equal(parseLocalDateTime(value).ok, false, JSON.stringify(value))
  }
  assert.equal(parseLocalDateTime(null).ok, false)
  assert.equal(parseLocalDateTime(undefined).ok, false)
})

test('epoch milliseconds are only accepted when the caller allows them', () => {
  assert.equal(parseLocalDateTime('1758400000000').ok, false)
  assert.deepEqual(parseLocalDateTime('1758400000000', { allowEpochMs: true }), { ok: true, ms: 1758400000000 })
  assert.equal(parseLocalDateTime('0', { allowEpochMs: true }).ok, false)
  assert.equal(parseLocalDateTime('-5', { allowEpochMs: true }).ok, false)
})

test('formatting echoes the local instant a caller typed', () => {
  const parsed = parseLocalDateTime('2026-09-21T18:05')
  assert.equal(formatLocalDateTime(parsed.ms), '2026-09-21 18:05')
  assert.equal(formatLocalDateTime(midnightOf('2026-01-02')), '2026-01-02 00:00')
})

function midnightOf(text) {
  return parseLocalDateTime(text).ms
}
