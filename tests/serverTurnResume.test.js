import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isRecoverableServerMessage,
  reduceResumedAssistantText,
  serverResumeAfterSequence,
  shouldKeepResumePending,
  terminalResumeText,
} from '../src/pages/ChatSplit/useServerTurnResume.js'
import { normalizeServerSessionSnapshot } from '../src/lib/turnClient/sessionSnapshot.js'

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

test('resume text tracking appends durable failure evidence without duplicating visible text', () => {
  const failed = { type: 'turn.failed', payload: { partialText: 'durable partial' } }
  assert.equal(reduceResumedAssistantText('', failed), 'durable partial')
  assert.equal(reduceResumedAssistantText('already visible', failed), 'already visible\n\ndurable partial')
  assert.equal(reduceResumedAssistantText('durable partial', failed), 'durable partial')
  const interrupted = { type: 'turn.interrupted', payload: { text: 'checkpoint output' } }
  assert.equal(reduceResumedAssistantText('', interrupted), 'checkpoint output')

  const budgetWrapUp = {
    type: 'turn.failed',
    payload: { partialText: '已完成检查。\n\n预算耗尽，尚待验证。' },
  }
  const withWrapUp = reduceResumedAssistantText('已完成检查。', budgetWrapUp)
  assert.equal(withWrapUp, '已完成检查。\n\n预算耗尽，尚待验证。')
  assert.equal(reduceResumedAssistantText(withWrapUp, budgetWrapUp), withWrapUp)
})

test('resume terminal fallback appends only the missing completed suffix', () => {
  const terminal = { type: 'turn.completed', payload: { text: 'partial and complete answer' } }

  assert.equal(terminalResumeText('partial', terminal), ' and complete answer')
  assert.equal(terminalResumeText('partial and complete answer', terminal), '')
  assert.equal(terminalResumeText('', terminal), 'partial and complete answer')
})

test('reconnecting, interrupted, and cancelling server messages remain resumable across views', () => {
  for (const serverConnectionState of ['reconnecting', 'interrupted', 'cancelling']) {
    assert.equal(isRecoverableServerMessage({ meta: { streaming: false, serverConnectionState } }), true)
  }
  assert.equal(isRecoverableServerMessage({ meta: { streaming: false, serverConnectionState: null } }), false)
})

test('an interrupted server snapshot remains automatically resumable after refresh', () => {
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'turn-refresh:assistant',
      role: 'assistant',
      content: 'checkpoint text',
      createdAt: 1,
      modelContext: {
        turnId: 'turn-refresh',
        turnEvidence: true,
        evidenceState: 'interrupted',
        turnCompletedAt: 999,
        latency: 998,
        serverLastSequence: 12,
        error: { code: 'PROCESS_RESTARTED', message: 'worker restarted', retryable: true },
      },
    }],
  })

  assert.equal(snapshot.messages[0].meta.serverConnectionState, 'interrupted')
  assert.equal(snapshot.messages[0].meta.streaming, true)
  assert.equal(snapshot.messages[0].meta.turnCompletedAt, null)
  assert.equal(snapshot.messages[0].meta.latency, null)
  assert.equal(snapshot.messages[0].meta.serverLastSequence, 12)
  assert.equal(serverResumeAfterSequence(snapshot.messages[0]), 12)
  assert.equal(isRecoverableServerMessage(snapshot.messages[0]), true)
})

test('legacy interrupted snapshots replay from the safe beginning when no durable cursor exists', () => {
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'legacy-interrupted:assistant',
      role: 'assistant',
      content: 'legacy checkpoint',
      createdAt: 10,
      modelContext: {
        turnId: 'legacy-interrupted',
        turnEvidence: true,
        evidenceState: 'interrupted',
      },
    }],
  })

  assert.equal(snapshot.messages[0].meta.serverLastSequence, -1)
  assert.equal(serverResumeAfterSequence(snapshot.messages[0]), -1)
  assert.equal(serverResumeAfterSequence({ meta: { serverLastSequence: 'invalid' } }), -1)
  assert.equal(serverResumeAfterSequence({ meta: { serverLastSequence: null } }), -1)
})

test('an accepted directory resume cannot fall back to a stale authorization card', () => {
  const resumeResolution = { type: 'directory_authorization', approved: true }
  assert.equal(shouldKeepResumePending({ resumeResolution, resumeAccepted: false, stopped: false }), true)
  assert.equal(shouldKeepResumePending({ resumeResolution, resumeAccepted: true, stopped: false }), false)
  assert.equal(shouldKeepResumePending({ resumeResolution, resumeAccepted: false, stopped: true }), false)
})
