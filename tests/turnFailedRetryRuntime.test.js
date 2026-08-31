import assert from 'node:assert/strict'
import test from 'node:test'

import { EventWriteBehindError } from '../server/services/eventWriteBehind.js'
import {
  failedRetryRejectionEvidenceMessage,
  permanentFailedRetryError,
} from '../server/services/turnFailedRetryRejection.js'
import { createTurnFailedRetryRuntime } from '../server/services/turnFailedRetryRuntime.js'

test('permanent failed-retry rejections expose only stable structured failure data', () => {
  const codes = [
    'TURN_FAILED_RETRY_LIMIT_REACHED',
    'TURN_FAILED_RETRY_UNSUPPORTED',
    'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED',
    'TURN_FAILED_RETRY_CHECKPOINT_CONFLICT',
    'TURN_FAILED_RETRY_EVENT_INVALID',
    'TURN_FAILED_RETRY_ATTEMPT_INVALID',
    'TURN_FAILED_RETRY_PROJECTION_INVALID',
  ]

  for (const code of codes) {
    const error = permanentFailedRetryError({
      code,
      message: '不应跨越服务端边界的诊断文案',
      hint: '不应跨越服务端边界的建议文案',
      status: 409,
    })
    assert.equal(error.code, code)
    assert.equal(error.message, code)
    assert.equal(error.retryable, false)
    assert.equal(Object.hasOwn(error, 'hint'), false)

    const message = failedRetryRejectionEvidenceMessage({
      existing: null,
      userId: 'failed-retry-user',
      sessionId: 'failed-retry-session',
      turnId: 'failed-retry-turn',
      failureEvent: {
        sequence: 7,
        createdAt: 10,
        payload: { partialText: 'durable partial result' },
      },
      error,
      writtenAt: 11,
    })
    assert.deepEqual(message.modelContext.error, { code, retryable: false, status: 409 })
    assert.deepEqual(message.modelContext.failedRetryRejection, {
      code,
      failureSequence: 7,
    })
    assert.equal(Object.hasOwn(message.modelContext.error, 'message'), false)
    assert.equal(Object.hasOwn(message.modelContext.error, 'hint'), false)
  }
})

test('failed retry seals a permanent commit conflict wrapped by the event emitter', async () => {
  const scope = {
    userId: 'failed-retry-user',
    sessionId: 'failed-retry-session',
    turnId: 'failed-retry-turn',
  }
  const started = {
    ...scope,
    id: 'failed-retry-started',
    type: 'turn.started',
    sequence: 0,
    payload: {},
    createdAt: 1,
  }
  const failure = {
    ...scope,
    id: 'failed-retry-failure',
    type: 'turn.failed',
    sequence: 2,
    payload: { error: { retryable: true }, partialText: 'partial result' },
    createdAt: 2,
  }
  const existingMessage = {
    id: `${scope.turnId}:assistant`,
    ...scope,
    role: 'assistant',
    content: 'partial result',
    modelContext: {},
    createdAt: 2,
  }
  let sealedMessage = null
  const emitter = async (_type, payload, { commitEvent }) => {
    const event = {
      ...scope,
      id: 'failed-retry-attempt',
      type: 'turn.attempt',
      sequence: 3,
      payload,
      createdAt: 3,
    }
    try {
      await commitEvent({ event })
    } catch (cause) {
      throw new EventWriteBehindError({ batch: [{ userId: scope.userId, event }], cause })
    }
  }
  emitter.close = async () => {}
  const runtime = createTurnFailedRetryRuntime({
    deps: {
      readSession: async () => ({ id: scope.sessionId }),
      lastEvent: async (input) => input.type === 'turn.started' ? started : failure,
      replayEvents: async ({ after }) => after < 0 ? [started, failure] : [],
      readMessages: async () => [existingMessage],
      runtimeCore: { checkpoint: { load: async () => ({ state: {}, eventSequence: 1 }) } },
      commitTurnFailedRetry: async () => {
        const conflict = new Error('checkpoint changed during retry')
        conflict.code = 'TURN_FAILED_RETRY_CHECKPOINT_CONFLICT'
        conflict.status = 409
        throw conflict
      },
      commitTurnFailedRetryRejection: async ({ message }) => {
        sealedMessage = message
      },
      clearRecoveryState: async () => {},
      now: () => 4,
    },
    recoverTurn: async () => assert.fail('a permanent retry conflict must not recover the turn'),
    createEmitter: () => emitter,
  })

  await assert.rejects(
    runtime.retryFailedTurn(scope),
    (error) => error?.code === 'TURN_FAILED_RETRY_CHECKPOINT_CONFLICT'
      && error?.retryable === false,
  )
  assert.equal(sealedMessage?.modelContext?.evidenceState, 'failed')
  assert.equal(
    sealedMessage?.modelContext?.failedRetryRejection?.code,
    'TURN_FAILED_RETRY_CHECKPOINT_CONFLICT',
  )
  assert.equal(sealedMessage?.modelContext?.failedRetryRejection?.failureSequence, 2)
  assert.deepEqual(sealedMessage?.modelContext?.error, {
    code: 'TURN_FAILED_RETRY_CHECKPOINT_CONFLICT',
    retryable: false,
    status: 409,
  })
  assert.equal(Object.hasOwn(sealedMessage?.modelContext?.error || {}, 'message'), false)
  assert.equal(Object.hasOwn(sealedMessage?.modelContext?.error || {}, 'hint'), false)
})
