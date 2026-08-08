import assert from 'node:assert/strict'
import test from 'node:test'

import { reduceServerSessionState } from '../src/store/reducers/serverSessionReducer.js'
import { reduceSessionLifecycleState } from '../src/store/reducers/sessionLifecycleReducer.js'

test('session pin state supports optimistic updates and authoritative rollback metadata', () => {
  const state = {
    sessions: [{ id: 's1', messages: [], pinnedAt: null, serverRevision: 3, updatedAt: 10 }],
  }
  const optimistic = reduceSessionLifecycleState(state, {
    type: 'SET_SESSION_PIN',
    payload: { sessionId: 's1', pinnedAt: 100 },
  })
  assert.equal(optimistic.sessions[0].pinnedAt, 100)

  const authoritative = reduceServerSessionState(optimistic, {
    type: 'APPLY_SERVER_SESSION_METADATA',
    payload: { sessionId: 's1', session: { pinnedAt: 120, revision: 4, updatedAt: 10 } },
  })
  assert.equal(authoritative.sessions[0].pinnedAt, 120)
  assert.equal(authoritative.sessions[0].serverRevision, 4)

  const rollback = reduceSessionLifecycleState(authoritative, {
    type: 'SET_SESSION_PIN',
    payload: { sessionId: 's1', pinnedAt: null },
  })
  assert.equal(rollback.sessions[0].pinnedAt, null)
})
