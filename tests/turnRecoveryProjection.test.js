import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  checkpointMessagesForTurn,
  excludeVerifiedLocalFiles,
  failedRetryAttemptPayload,
  latestLegacyCheckpoint,
  latestRetainedLocalFiles,
  latestVerifiedLocalFiles,
  mergeLocalFileReceipts,
  normalizeResolutionPath,
  recoveryAttemptAfterCheckpoint,
  replayPersistedTurnEvents,
  storedCheckpointEvent,
} from '../server/services/turnRecoveryProjection.js'
import { checkpointStateForFailedRetry } from '../server/services/turnExecutionRuntime.js'

function replayFrom(events) {
  return ({ after, limit }) => events
    .filter((event) => event.sequence > after)
    .slice(0, limit)
}

test('persisted turn replay paginates monotonically without duplicating events', async () => {
  const events = Array.from({ length: 2001 }, (_, sequence) => ({ sequence, type: 'test' }))
  const replayed = await replayPersistedTurnEvents(replayFrom(events), {
    userId: 'user-a',
    sessionId: 'session-a',
    turnId: 'turn-a',
  })

  assert.equal(replayed.length, 2001)
  assert.equal(replayed[0].sequence, 0)
  assert.equal(replayed.at(-1).sequence, 2000)
})

test('recovery attempt preserves only the checkpointed stream prefix and stops after a terminal', async () => {
  const events = [
    { sequence: 0, type: 'turn.attempt', payload: { attempt: 1, resetStreaming: true, assistantText: 'base', reasoningText: 'why' } },
    { sequence: 1, type: 'assistant.delta', payload: { text: '-saved' } },
    { sequence: 2, type: 'turn.checkpoint', payload: { state: {} } },
    { sequence: 3, type: 'assistant.delta', payload: { text: '-unconfirmed' } },
  ]
  const checkpoint = { sequence: 2 }

  assert.deepEqual(await recoveryAttemptAfterCheckpoint(replayFrom(events), {}, checkpoint), {
    attempt: 2,
    reason: 'checkpoint_resume',
    resetStreaming: true,
    checkpointSequence: 2,
    previousStreamSequence: 3,
    assistantText: 'base-saved',
    reasoningText: 'why',
  })

  events.push({ sequence: 4, type: 'turn.failed', payload: {} })
  assert.equal(await recoveryAttemptAfterCheckpoint(replayFrom(events), {}, checkpoint), null)
})

test('manual failed retry is durable and resets only the verification repair budget', () => {
  const attempt = failedRetryAttemptPayload([
    { sequence: 1, type: 'assistant.delta', payload: { text: 'saved' } },
  ], {
    sequence: 2,
    type: 'turn.failed',
    payload: {
      partialText: '',
      error: { manualRetryable: true },
    },
  }, { eventSequence: 1 })
  assert.equal(attempt.manualRetry, true)

  const original = {
    final: { incomplete: true },
    completionGuards: {
      pendingMutationTargets: ['src/result.js'],
      taskVerificationRepair: {
        consecutiveFailures: 3,
        lastFailureBatchId: 'batch-3',
        pending: [{ kind: 'test', failures: 3, lastFailureBatchId: 'batch-3' }],
        candidates: [{ kind: 'lint', failures: 1 }],
      },
    },
  }
  const restored = checkpointStateForFailedRetry(original, { manualRetry: true })
  assert.equal(restored.final, null)
  assert.equal(restored.completionGuards.taskVerificationRepair.consecutiveFailures, 0)
  assert.equal(restored.completionGuards.taskVerificationRepair.pending[0].failures, 0)
  assert.equal(restored.completionGuards.taskVerificationRepair.pending[0].lastFailureBatchId, '')
  assert.deepEqual(restored.completionGuards.pendingMutationTargets, ['src/result.js'])
  assert.deepEqual(restored.completionGuards.taskVerificationRepair.candidates, [{ kind: 'lint', failures: 1 }])
  assert.equal(original.completionGuards.taskVerificationRepair.consecutiveFailures, 3)
})

test('checkpoint projection isolates the current turn and keeps protocol-only checkpoints', () => {
  const fallback = [{ role: 'assistant', content: 'fallback' }]
  const state = {
    messages: [
      { role: 'user', content: 'older' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'current' },
      { role: 'assistant', content: 'new answer' },
      { role: 'tool', content: 'receipt' },
    ],
  }
  assert.deepEqual(checkpointMessagesForTurn(state, { content: 'current', fallback }), state.messages.slice(3))
  assert.deepEqual(checkpointMessagesForTurn({ messages: [{ role: 'tool', content: 'only' }] }, { fallback }), [
    { role: 'tool', content: 'only' },
  ])
  assert.deepEqual(checkpointMessagesForTurn(state, { content: 'missing', fallback }), fallback)
})

test('checkpoint projection rematch survives whitespace drift between event and snapshot', () => {
  const fallback = [{ role: 'assistant', content: 'fallback' }]
  const state = {
    messages: [
      { role: 'user', content: 'older question' },
      { role: 'assistant', content: 'old answer' },
      // snapshot stored the user text with line breaks / extra spaces that the
      // turn.started payload does not carry
      { role: 'user', content: 'current  \n question' },
      { role: 'assistant', content: 'new answer' },
    ],
  }
  assert.deepEqual(
    checkpointMessagesForTurn(state, { content: 'current\nquestion', fallback }),
    state.messages.slice(3),
  )
  // a genuinely different objective still falls back instead of guessing
  assert.deepEqual(checkpointMessagesForTurn(state, { content: 'unrelated', fallback }), fallback)
})

test('local file projections retain the latest durable lists and remove verified duplicates', async () => {
  const firstPath = path.resolve('tmp', 'first.txt')
  const secondPath = path.resolve('tmp', 'second.txt')
  const events = [
    { sequence: 0, payload: { verifiedLocalFiles: [{ id: 'old', path: firstPath }] } },
    { sequence: 1, payload: { verifiedLocalFiles: [{ id: 'verified', path: firstPath }] } },
    { sequence: 2, payload: { retainedLocalFiles: [{ id: 'pending', path: secondPath }] } },
  ]
  assert.deepEqual(await latestVerifiedLocalFiles(replayFrom(events), {}), [{ id: 'verified', path: firstPath }])
  assert.deepEqual(await latestRetainedLocalFiles(replayFrom(events), {}), [{ id: 'pending', path: secondPath }])

  const merged = mergeLocalFileReceipts(
    [{ id: 'verified', path: firstPath }],
    [{ id: 'duplicate', path: `${firstPath}${path.sep}` }, { id: 'pending', path: secondPath }],
  )
  assert.deepEqual(merged.map((entry) => entry.id), ['verified', 'pending'])
  assert.deepEqual(excludeVerifiedLocalFiles(merged, [{ id: 'verified', path: firstPath }]), [
    { id: 'pending', path: secondPath },
  ])
  assert.equal(normalizeResolutionPath(`${firstPath}${path.sep}`), normalizeResolutionPath(firstPath))
})

test('checkpoint adapters preserve durable event identity and reject malformed legacy state', async () => {
  const checkpoint = {
    sessionId: 'session-a',
    turnId: 'turn-a',
    eventSequence: 7,
    state: { iterations: 2 },
    updatedAt: '2026-08-21T00:00:00.000Z',
  }
  assert.deepEqual(storedCheckpointEvent(checkpoint), {
    sessionId: 'session-a',
    turnId: 'turn-a',
    sequence: 7,
    type: 'turn.checkpoint',
    payload: { state: { iterations: 2 } },
    createdAt: '2026-08-21T00:00:00.000Z',
  })

  const events = [
    { sequence: 3, type: 'turn.checkpoint', payload: { state: { iterations: 1 } } },
    { sequence: 4, type: 'turn.checkpoint', payload: { state: null } },
    { sequence: 5, type: 'turn.checkpoint', payload: { state: { iterations: 2 } } },
  ]
  assert.deepEqual(await latestLegacyCheckpoint(replayFrom(events), {}), events[2])
  assert.equal(storedCheckpointEvent({ eventSequence: 1, state: null }), null)
})
