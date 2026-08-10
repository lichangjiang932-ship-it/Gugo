import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeSteeringDraft, resolveSteeringTarget } from '../src/pages/ChatSplit/useTurnSteering.js'

test('resolveSteeringTarget prefers the visible streaming assistant and falls back to the run', () => {
  assert.deepEqual(resolveSteeringTarget({
    sessionId: ' session-1 ',
    messages: [{
      id: 'assistant-visible',
      role: 'assistant',
      meta: { streaming: true, serverTurnId: 'turn-visible' },
    }],
    run: { turnId: 'turn-run' },
  }), {
    sessionId: 'session-1',
    turnId: 'turn-visible',
    assistantMessageId: 'assistant-visible',
  })

  assert.deepEqual(resolveSteeringTarget({
    sessionId: 'session-1',
    messages: [],
    run: { turnId: 'turn-run' },
  }), {
    sessionId: 'session-1',
    turnId: 'turn-run',
    assistantMessageId: 'turn-run:assistant',
  })
  assert.equal(resolveSteeringTarget({ sessionId: '', run: { turnId: 'turn-run' } }), null)
})

test('mergeSteeringDraft restores a failed instruction without discarding newer typing', () => {
  assert.equal(mergeSteeringDraft('sent instruction', ''), 'sent instruction')
  assert.equal(mergeSteeringDraft('sent instruction', 'newer draft'), 'sent instruction\n\nnewer draft')
  assert.equal(mergeSteeringDraft('sent instruction', 'sent instruction'), 'sent instruction')
})
