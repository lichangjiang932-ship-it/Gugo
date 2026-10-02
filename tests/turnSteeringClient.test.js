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

test('a refusal with a note steers first, then denies; without a note it denies directly', async () => {
  const { createRefusalWithFeedback } = await import('../src/pages/ChatSplit/useTurnSteering.js')
  const calls = []
  const handler = createRefusalWithFeedback({
    resolveToolApproval: (decision) => { calls.push(['resolve', decision]); return true },
    steerActiveTurn: async (content, options) => { calls.push(['steer', content, options]); return true },
  })
  handler({ approved: true })
  handler({ approved: false })
  assert.deepEqual(calls, [['resolve', { approved: true }], ['resolve', { approved: false }]])
  calls.length = 0
  handler({ approved: false, feedback: '  write it to notes/ instead  ' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  // The composer draft is not the note, so steering must leave it alone.
  assert.deepEqual(calls, [
    ['steer', 'write it to notes/ instead', { keepDraft: true }],
    ['resolve', { approved: false }],
  ])
  // A failed steer still records the refusal: the user's "no" is never lost.
  calls.length = 0
  createRefusalWithFeedback({
    resolveToolApproval: (decision) => { calls.push(['resolve', decision]); return true },
    steerActiveTurn: async () => { throw new Error('offline') },
  })({ approved: false, feedback: 'x' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls, [['resolve', { approved: false }]])
})
