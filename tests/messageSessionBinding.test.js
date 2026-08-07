import assert from 'node:assert/strict'
import test from 'node:test'
import { reduceMessageState } from '../src/store/reducers/messageReducer.js'

test('SEND_MESSAGE remains bound to its originating session when active navigation changes', () => {
  const state = {
    activeSessionId: 'other',
    sessions: [
      { id: 'origin', messages: [] },
      { id: 'other', messages: [] },
    ],
  }
  const next = reduceMessageState(state, {
    type: 'SEND_MESSAGE',
    payload: { id: 'turn:user', sessionId: 'origin', content: 'hello' },
  })
  assert.deepEqual(next.sessions[0].messages.map((message) => message.id), ['turn:user'])
  assert.deepEqual(next.sessions[1].messages, [])
  assert.equal(next.sessions[0].messages[0].meta.pendingServerSync, true)
})
