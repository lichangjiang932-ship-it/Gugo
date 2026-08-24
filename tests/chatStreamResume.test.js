import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { StreamTruncatedError } from '../src/lib/modelClient.js'
import { normalizeServerSessionSnapshot } from '../src/lib/turnClient/sessionSnapshot.js'
import {
  buildStreamResumeState,
  buildStreamResumeStateFromMessages,
  getStreamResumeStateForSession,
  isStreamResumeStateForSession,
  updateStreamResumeStates,
  updateStreamResumeStatesFromTurnResult,
} from '../src/pages/ChatSplit/streamResumeState.js'

test('client truncation with real partial text enables resume for the originating session', () => {
  const error = new StreamTruncatedError('truncated', {
    partialText: ' durable partial answer\n',
    reason: 'length',
  })
  const state = buildStreamResumeState(error, { sessionId: 'session-a', turnId: 'turn-a' })

  assert.deepEqual(state, {
    sessionId: 'session-a',
    turnId: 'turn-a',
    code: 'STREAM_TRUNCATED',
    reason: 'length',
    partialText: ' durable partial answer\n',
  })
  assert.equal(isStreamResumeStateForSession(state, 'session-a'), true)
  assert.equal(isStreamResumeStateForSession(state, 'session-b'), false)
})

test('durable TURN_INCOMPLETE output enables resume without treating transport recovery as a new send', () => {
  assert.deepEqual(buildStreamResumeState({
    failed: true,
    error: { code: 'TURN_INCOMPLETE', partialText: 'saved server output', retryable: true },
  }, { sessionId: 'session-a', turnId: 'turn-a' }), {
    sessionId: 'session-a',
    turnId: 'turn-a',
    code: 'TURN_INCOMPLETE',
    reason: null,
    partialText: 'saved server output',
  })

  assert.equal(buildStreamResumeState({
    failed: true,
    error: { code: 'TURN_STREAM_TRUNCATED', partialText: 'recoverable transport output' },
  }, { sessionId: 'session-a', turnId: 'turn-a' }), null)

  assert.equal(buildStreamResumeState({
    failed: true,
    error: { code: 'TURN_INCOMPLETE', partialText: 'deterministic blocker', retryable: false },
  }, { sessionId: 'session-a', turnId: 'turn-a' }), null)
})

test('success, user cancellation, and empty truncation output clear resume state', () => {
  assert.equal(buildStreamResumeState({ terminal: { type: 'turn.completed' } }, { sessionId: 'session-a' }), null)
  assert.equal(buildStreamResumeState({
    failed: true,
    error: { name: 'AbortError', code: 'USER_STOPPED', partialText: 'stopped output' },
  }, { sessionId: 'session-a' }), null)
  assert.equal(buildStreamResumeState({
    failed: true,
    error: { code: 'STREAM_TRUNCATED', partialText: '   ' },
  }, { sessionId: 'session-a' }), null)
})

test('a persisted TURN_INCOMPLETE assistant message rebuilds the original turn retry after refresh', () => {
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'turn-refresh:assistant',
      role: 'assistant',
      content: 'durable partial answer',
      createdAt: 2,
      modelContext: {
        turnId: 'turn-refresh',
        turnEvidence: true,
        evidenceState: 'failed',
        error: {
          code: 'TURN_INCOMPLETE',
          message: 'The model response ended before completion.',
          reason: 'length',
          retryable: true,
        },
      },
    }],
  })

  assert.deepEqual(buildStreamResumeStateFromMessages(snapshot.messages, { sessionId: 'session-refresh' }), {
    sessionId: 'session-refresh',
    turnId: 'turn-refresh',
    code: 'TURN_INCOMPLETE',
    reason: 'length',
    partialText: 'durable partial answer',
  })
})

test('resume state updates are isolated per session', () => {
  const stateA = buildStreamResumeState({
    failed: true,
    error: { code: 'TURN_INCOMPLETE', partialText: 'answer a', retryable: true },
  }, { sessionId: 'session-a', turnId: 'turn-a' })
  const stateB = buildStreamResumeState({
    failed: true,
    error: { code: 'TURN_INCOMPLETE', partialText: 'answer b', retryable: true },
  }, { sessionId: 'session-b', turnId: 'turn-b' })

  let states = updateStreamResumeStates({}, 'session-a', stateA)
  states = updateStreamResumeStates(states, 'session-b', stateB)
  states = updateStreamResumeStates(states, 'session-a', null)

  assert.equal(getStreamResumeStateForSession(states, 'session-a'), null)
  assert.deepEqual(getStreamResumeStateForSession(states, 'session-b'), stateB)
})

test('a failed retry republishes continue-generation only for the retried session', () => {
  const untouched = buildStreamResumeState({
    failed: true,
    error: { code: 'TURN_INCOMPLETE', partialText: 'answer b', retryable: true },
  }, { sessionId: 'session-b', turnId: 'turn-b' })
  let states = updateStreamResumeStates({}, 'session-b', untouched)

  states = updateStreamResumeStatesFromTurnResult(states, {
    sessionId: 'session-a',
    turnId: 'turn-a',
    result: {
      failed: true,
      error: { code: 'TURN_INCOMPLETE', partialText: 'retry partial', retryable: true },
    },
  })

  assert.deepEqual(getStreamResumeStateForSession(states, 'session-a'), {
    sessionId: 'session-a',
    turnId: 'turn-a',
    code: 'TURN_INCOMPLETE',
    reason: null,
    partialText: 'retry partial',
  })
  assert.deepEqual(getStreamResumeStateForSession(states, 'session-b'), untouched)
})

test('the continue-generation button signals a failed turn retry instead of sending a new prompt', () => {
  const source = readFileSync(
    new URL('../src/pages/ChatSplit/useChatTurnRecovery.js', import.meta.url),
    'utf8',
  ).replace(/\r\n/g, '\n')
  const start = source.indexOf('const handleResume = useCallback(() => {')
  const end = source.indexOf('\n\n  return', start)
  assert.ok(start >= 0 && end > start)
  const handler = source.slice(start, end)

  assert.match(handler, /setFailedTurnRetry/u)
  assert.doesNotMatch(handler, /triggerSendFlow|SEND_MESSAGE|attachments/u)
})
