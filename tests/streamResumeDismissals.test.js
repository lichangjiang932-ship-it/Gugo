import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_STREAM_RESUME_DISMISSALS,
  STREAM_RESUME_DISMISSALS_KEY,
  STREAM_RESUME_DISMISSAL_TTL_MS,
  pruneStreamResumeDismissals,
  readStreamResumeDismissals,
  streamResumeOwnerScope,
  writeStreamResumeDismissal,
} from '../src/lib/streamResumeDismissals.js'

function memoryStorage() {
  const values = new Map()
  return { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) }
}

test('resume dismissal scope requires server identity and authenticated user id, never email or tokens', () => {
  const state = { isLoggedIn: true, user: { id: 'a', email: 'same@example.test' }, sessionCatalogSource: { backendInstanceId: 'sqlite:1' } }
  const scope = streamResumeOwnerScope(state)
  assert.equal(scope, '["sqlite:1","a"]')
  assert.equal(streamResumeOwnerScope({ ...state, isLoggedIn: false }), null)
  assert.equal(streamResumeOwnerScope({ ...state, user: { email: 'same@example.test' } }), null)
  assert.equal(streamResumeOwnerScope({ ...state, sessionCatalogSource: null }), null)
  assert.notEqual(streamResumeOwnerScope({ ...state, user: { id: 'b' } }), scope)
})

test('persisted dismissals expire and retain a bounded newest set across all accounts', () => {
  const storage = memoryStorage()
  for (let index = 0; index < MAX_STREAM_RESUME_DISMISSALS + 3; index += 1) {
    assert.equal(writeStreamResumeDismissal(storage, { scope: `account-${index % 2}`, key: `failure-${index}` }, index), true)
  }
  const records = readStreamResumeDismissals(storage, 200)
  assert.equal(records.length, MAX_STREAM_RESUME_DISMISSALS)
  assert.equal(records[0].key, 'failure-3')
  assert.equal(readStreamResumeDismissals(storage, 200 + STREAM_RESUME_DISMISSAL_TTL_MS).length, 0)
  writeStreamResumeDismissal(storage, { scope: 'account-new', key: 'failure-new' }, 200 + STREAM_RESUME_DISMISSAL_TTL_MS)
  assert.equal(JSON.parse(storage.getItem(STREAM_RESUME_DISMISSALS_KEY)).entries.length, 1)
})

test('malformed, oversized, unversioned, immortal, and unavailable dismissal storage fails safely', () => {
  const storage = memoryStorage()
  for (const raw of ['{', JSON.stringify({ entries: [] }), ' '.repeat(129 * 1024)]) {
    storage.setItem(STREAM_RESUME_DISMISSALS_KEY, raw)
    assert.deepEqual(readStreamResumeDismissals(storage), [])
  }
  assert.deepEqual(pruneStreamResumeDismissals([
    { scope: 'a', key: 'k', expiresAt: Infinity },
    { scope: 'a', key: 'k', expiresAt: STREAM_RESUME_DISMISSAL_TTL_MS + 1 },
    { scope: '', key: 'k', expiresAt: 1 },
  ], 0), [])
  const denied = { getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') } }
  assert.deepEqual(readStreamResumeDismissals(denied), [])
  assert.equal(writeStreamResumeDismissal(denied, { scope: 'a', key: 'k' }), false)
})
