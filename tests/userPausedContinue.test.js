import assert from 'node:assert/strict'
import test from 'node:test'

import {
  USER_PAUSED_TURN_CODE,
  isRecoverableServerMessage,
  isUserPausedMessage,
  latestUserPausedTurn,
  matchesFailedTurnRetryResume,
} from '../src/pages/ChatSplit/serverTurnResumePolicy.js'

function pausedMessage(meta = {}) {
  return {
    id: 'turn-paused:assistant',
    role: 'assistant',
    content: '已暂停。',
    meta: {
      paused: true,
      failed: false,
      streaming: false,
      serverConnectionState: 'paused',
      serverTurnId: 'turn-paused',
      serverClarification: { reason_code: 'user_paused' },
      ...meta,
    },
  }
}

test('a hand-paused turn is recognised and never auto-resumed', () => {
  const message = pausedMessage()
  assert.equal(isUserPausedMessage(message), true)
  // The whole point of a pause is that it waits for the user: nothing in the
  // automatic recovery path may pick it up.
  assert.equal(isRecoverableServerMessage(message), false)
  // A genuine clarification is not a pause.
  assert.equal(isUserPausedMessage(pausedMessage({
    serverClarification: { reason_code: 'clarification_required', question: 'Which file?' },
  })), false)
  assert.equal(isUserPausedMessage({ meta: { paused: true } }), false)
})

test('only the latest assistant turn can offer "continue the same task"', () => {
  const paused = pausedMessage()
  assert.deepEqual(latestUserPausedTurn([{ role: 'user', content: 'hi' }, paused]), {
    turnId: 'turn-paused', messageId: 'turn-paused:assistant', code: USER_PAUSED_TURN_CODE,
  })
  // Newer work supersedes the pause: the button must not resurrect an old turn.
  assert.equal(latestUserPausedTurn([paused, { role: 'assistant', content: 'newer answer', meta: {} }]), null)
  assert.equal(latestUserPausedTurn([pausedMessage({ serverTurnId: '' })]), null)
  assert.equal(latestUserPausedTurn([]), null)
})

test('an explicit continue matches a paused turn without a failure payload', () => {
  const session = { id: 'session-1' }
  const message = pausedMessage()
  // A pause has no serverFailure, so the ordinary retry matcher would reject it;
  // the pause intent must not be gated on failure fields.
  assert.equal(matchesFailedTurnRetryResume(session, message, {
    sessionId: 'session-1', turnId: 'turn-paused', code: USER_PAUSED_TURN_CODE,
  }), true)
  assert.equal(matchesFailedTurnRetryResume(session, message, {
    sessionId: 'session-1', turnId: 'turn-other', code: USER_PAUSED_TURN_CODE,
  }), false)
  assert.equal(matchesFailedTurnRetryResume(session, { ...message, meta: { ...message.meta, paused: false } }, {
    sessionId: 'session-1', turnId: 'turn-paused', code: USER_PAUSED_TURN_CODE,
  }), false)
  // An ordinary retry intent still requires real failure evidence.
  assert.equal(matchesFailedTurnRetryResume(session, message, {
    sessionId: 'session-1', turnId: 'turn-paused', code: 'TURN_INCOMPLETE', manualRetryable: true,
  }), false)
})
