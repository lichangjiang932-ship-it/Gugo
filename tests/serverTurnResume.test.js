import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isRecoverableServerMessage,
  reduceResumedAssistantText,
  shouldKeepResumePending,
  terminalResumeText,
} from '../src/pages/ChatSplit/useServerTurnResume.js'

test('resume text tracking preserves confirmed text and accumulates fresh deltas', () => {
  let text = 'old unconfirmed suffix'
  text = reduceResumedAssistantText(text, {
    type: 'turn.attempt',
    payload: { resetStreaming: true, assistantText: 'confirmed prefix' },
  })
  text = reduceResumedAssistantText(text, {
    type: 'assistant.delta',
    payload: { text: ' and fresh output' },
  })

  assert.equal(text, 'confirmed prefix and fresh output')
})

test('resume text tracking adopts failure evidence only when no text is already visible', () => {
  const failed = { type: 'turn.failed', payload: { partialText: 'durable partial' } }
  assert.equal(reduceResumedAssistantText('', failed), 'durable partial')
  assert.equal(reduceResumedAssistantText('already visible', failed), 'already visible')
  const interrupted = { type: 'turn.interrupted', payload: { text: 'checkpoint output' } }
  assert.equal(reduceResumedAssistantText('', interrupted), 'checkpoint output')
})

test('resume terminal fallback never duplicates text already visible before reconnect', () => {
  const terminal = { type: 'turn.completed', payload: { text: 'partial and complete answer' } }

  assert.equal(terminalResumeText('partial', terminal), '')
  assert.equal(terminalResumeText('', terminal), 'partial and complete answer')
})

test('reconnecting, interrupted, and cancelling server messages remain resumable across views', () => {
  for (const serverConnectionState of ['reconnecting', 'interrupted', 'cancelling']) {
    assert.equal(isRecoverableServerMessage({ meta: { streaming: false, serverConnectionState } }), true)
  }
  assert.equal(isRecoverableServerMessage({ meta: { streaming: false, serverConnectionState: null } }), false)
})

test('an accepted directory resume cannot fall back to a stale authorization card', () => {
  const resumeResolution = { type: 'directory_authorization', approved: true }
  assert.equal(shouldKeepResumePending({ resumeResolution, resumeAccepted: false, stopped: false }), true)
  assert.equal(shouldKeepResumePending({ resumeResolution, resumeAccepted: true, stopped: false }), false)
  assert.equal(shouldKeepResumePending({ resumeResolution, resumeAccepted: false, stopped: true }), false)
})
