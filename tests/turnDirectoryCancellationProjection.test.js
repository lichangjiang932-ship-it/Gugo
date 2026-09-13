import assert from 'node:assert/strict'
import test from 'node:test'
import { createTurnEvent } from '../shared/turnEvents.js'
import { dispatchTurnEvent } from '../src/lib/turnClient/turnEventDispatch.js'
import { reduceMessageState } from '../src/store/reducers/messageReducer.js'
import { resolvePendingDirectorySend } from '../src/pages/ChatSplit/pausedTurnResume.js'

test('canonical cancellation releases the pending directory UI while retaining existing text and file evidence', async () => {
  const file = { path: 'D:\\fixture\\retained.txt', name: 'retained.txt', verifiedAt: 1 }
  let state = { activeSessionId: 'session', sessions: [{ id: 'session', messages: [{
    id: 'assistant', role: 'assistant', content: 'Already finished local work.', meta: {
      serverTurnId: 'turn', serverLastSequence: 4, paused: true, cancelled: false,
      streaming: false, serverConnectionState: 'paused',
      serverClarification: { request_type: 'directory', access_mode: 'read_only' },
      serverResumeResolution: { type: 'directory_authorization', paused_sequence: 4 },
      directoryAuthorizationPending: true, directoryAuthorizationError: 'stale error',
      verifiedLocalFiles: [file],
    },
  }] }] }
  assert.ok(resolvePendingDirectorySend(state.sessions[0].messages))
  const dispatch = action => { state = reduceMessageState(state, action) || state }
  await dispatchTurnEvent(createTurnEvent({ id: 'cancelled', sessionId: 'session', turnId: 'turn',
    sequence: 5, type: 'turn.cancelled', payload: { code: 'TURN_CANCELLED' }, createdAt: 6,
  }), { dispatch, taskId: 'cancel-directory', messageTarget: { sessionId: 'session', messageId: 'assistant' } })
  const message = state.sessions[0].messages[0]
  assert.equal(message.content, 'Already finished local work.')
  assert.deepEqual(message.meta.verifiedLocalFiles, [file])
  assert.equal(message.meta.cancelled, true)
  assert.equal(message.meta.paused, false)
  assert.equal(message.meta.serverClarification, null)
  assert.equal(message.meta.serverResumeResolution, null)
  assert.equal(message.meta.directoryAuthorizationPending, false)
  assert.equal(message.meta.directoryAuthorizationError, null)
  assert.equal(resolvePendingDirectorySend(state.sessions[0].messages), null)
})
