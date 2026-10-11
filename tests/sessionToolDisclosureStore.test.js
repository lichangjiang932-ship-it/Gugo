import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-tool-disclosures-'))

const { getDb } = await import('../server/db.js')
const {
  clearSessionToolDisclosures,
  readSessionToolDisclosures,
  unionDisclosedToolNames,
  writeSessionToolDisclosures,
} = await import('../server/services/sessionToolDisclosureStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const DAY_MS = 24 * 60 * 60 * 1000

function seed() {
  return {
    alice: issueTestSession({ email: 'disclosures-alice@example.com' }).userId,
    bob: issueTestSession({ email: 'disclosures-bob@example.com' }).userId,
  }
}

test('a disclosed set round-trips, sorted and de-duplicated', () => {
  const { alice } = seed()
  writeSessionToolDisclosures({ userId: alice, sessionId: 's-1', names: ['write_file', 'read_file', 'read_file'] })
  assert.deepEqual(readSessionToolDisclosures({ userId: alice, sessionId: 's-1' }), ['read_file', 'write_file'])
})

test('disclosures are scoped to one conversation and one user', () => {
  const { alice, bob } = seed()
  writeSessionToolDisclosures({ userId: alice, sessionId: 's-2', names: ['a'] })
  writeSessionToolDisclosures({ userId: alice, sessionId: 's-3', names: ['b'] })
  assert.deepEqual(readSessionToolDisclosures({ userId: alice, sessionId: 's-2' }), ['a'])
  assert.deepEqual(readSessionToolDisclosures({ userId: alice, sessionId: 's-3' }), ['b'])
  assert.deepEqual(readSessionToolDisclosures({ userId: bob, sessionId: 's-2' }), [])
})

test('a later write replaces the set rather than appending to it', () => {
  const { alice } = seed()
  writeSessionToolDisclosures({ userId: alice, sessionId: 's-4', names: ['a', 'b'] })
  writeSessionToolDisclosures({ userId: alice, sessionId: 's-4', names: ['c'] })
  assert.deepEqual(readSessionToolDisclosures({ userId: alice, sessionId: 's-4' }), ['c'])
})

test('unreadable or absent state degrades to an empty set instead of throwing', () => {
  const { alice } = seed()
  assert.deepEqual(readSessionToolDisclosures({ userId: alice, sessionId: 'never-written' }), [])
  assert.deepEqual(readSessionToolDisclosures({ userId: '', sessionId: 's' }), [])
  assert.deepEqual(readSessionToolDisclosures({}), [])
  getDb().prepare(`
    INSERT INTO session_tool_disclosures (user_id, session_id, tool_names, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(alice, 's-broken', '{not json', Date.now())
  assert.deepEqual(readSessionToolDisclosures({ userId: alice, sessionId: 's-broken' }), [])
})

test('the union only grows, and stays sorted', () => {
  assert.deepEqual(unionDisclosedToolNames({ disclosed: ['b'], selected: ['a', 'c'] }), ['a', 'b', 'c'])
  assert.deepEqual(unionDisclosedToolNames({ disclosed: [], selected: [] }), [])
  // Re-selecting a subset must not shrink what was already shown — that is the
  // whole point: the prefix stops being rewritten when the set swings back.
  assert.deepEqual(unionDisclosedToolNames({ disclosed: ['a', 'b', 'c'], selected: ['a'] }), ['a', 'b', 'c'])
})

test('clearing removes only the named conversation', () => {
  const { alice } = seed()
  writeSessionToolDisclosures({ userId: alice, sessionId: 's-5', names: ['a'] })
  writeSessionToolDisclosures({ userId: alice, sessionId: 's-6', names: ['b'] })
  assert.equal(clearSessionToolDisclosures({ userId: alice, sessionId: 's-5' }), 1)
  assert.deepEqual(readSessionToolDisclosures({ userId: alice, sessionId: 's-5' }), [])
  assert.deepEqual(readSessionToolDisclosures({ userId: alice, sessionId: 's-6' }), ['b'])
})

test('a conversation untouched past the retention window is pruned on the next write', () => {
  const { alice } = seed()
  const stale = Date.now() - 40 * DAY_MS
  getDb().prepare(`
    INSERT INTO session_tool_disclosures (user_id, session_id, tool_names, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(alice, 's-stale', JSON.stringify(['old']), stale)

  writeSessionToolDisclosures({ userId: alice, sessionId: 's-fresh', names: ['new'] })
  assert.deepEqual(readSessionToolDisclosures({ userId: alice, sessionId: 's-stale' }), [])
  assert.deepEqual(readSessionToolDisclosures({ userId: alice, sessionId: 's-fresh' }), ['new'])
})
