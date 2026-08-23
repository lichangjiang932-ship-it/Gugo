import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeServerSessionSnapshot } from '../src/lib/turnClient/sessionSnapshot.js'
import { buildModelFailureRetryRequest } from '../src/pages/ChatSplit/modelFailureRetry.js'

function modelFailure(overrides = {}) {
  const { serverFailure = { code: 'MODEL_CONFIG_MISSING' }, ...meta } = overrides
  return {
    id: 'assistant-failure',
    role: 'assistant',
    content: 'The model service is not configured.',
    meta: {
      failed: true,
      ...meta,
      serverFailure,
    },
  }
}

test('model pre-execution retry reuses the preceding user input and excludes the failed pair from history', () => {
  const failed = modelFailure()
  const messages = [
    { id: 'user-old', role: 'user', content: 'Earlier context' },
    { id: 'assistant-old', role: 'assistant', content: 'Earlier reply' },
    {
      id: 'user-failed',
      role: 'user',
      content: 'Please inspect this file',
      attachments: [{
        id: 'attachment-1',
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 2048,
        sha256: 'abc123',
        downloadUrl: '/api/attachments/attachment-1',
      }],
    },
    failed,
  ]

  assert.deepEqual(buildModelFailureRetryRequest(messages, failed), {
    content: 'Please inspect this file',
    attachments: [{
      id: 'attachment-1',
      name: 'notes.txt',
      mimeType: 'text/plain',
      type: 'text/plain',
      size: 2048,
      sizeKB: '2.0',
      sha256: 'abc123',
      downloadUrl: '/api/attachments/attachment-1',
      uploadStatus: 'ready',
    }],
    historyLimit: 2,
  })
})

test('model retry resolves a restored failure by id and ignores unrelated assistant records between the pair', () => {
  const failed = modelFailure()
  const restoredReference = { ...failed, meta: { ...failed.meta } }
  const messages = [
    { id: 'user-1', role: 'user', content: 'Try once more' },
    { id: 'assistant-status', role: 'assistant', content: '', meta: { type: 'status' } },
    restoredReference,
  ]

  assert.deepEqual(buildModelFailureRetryRequest(messages, failed), {
    content: 'Try once more',
    attachments: [],
    historyLimit: 0,
  })
})

test('model retry fails closed after partial output, tools, files, or for ordinary failures', () => {
  const user = { id: 'user-1', role: 'user', content: 'Do the work' }
  const unsafeEvidence = [
    { serverPartialText: 'partial answer' },
    { toolCalls: [{ id: 'call-1', name: 'write_file' }] },
    { serverArtifacts: [{ id: 'artifact-1' }] },
    { serverArtifactIds: ['artifact-1'] },
    { serverDeliveryArtifactIds: ['artifact-1'] },
    { verifiedLocalFiles: [{ path: 'done.txt' }] },
    { retainedLocalFiles: [{ path: 'partial.txt' }] },
    { serverRecoveryBlocked: true },
    { serverRecoveryKind: 'model_request_outcome_unknown' },
    { serverRecoveryModelRequestId: 'mr_recovery' },
    { modelRequestId: 'mr_dispatched' },
    { modelInvocation: { id: 'mr_checkpoint', status: 'in_flight' } },
  ]
  for (const evidence of unsafeEvidence) {
    const failed = modelFailure(evidence)
    assert.equal(buildModelFailureRetryRequest([user, failed], failed), null)
  }

  const ordinary = modelFailure({ serverFailure: { code: 'TURN_FAILED' } })
  assert.equal(buildModelFailureRetryRequest([user, ordinary], ordinary), null)
  const displayKeyOnly = modelFailure({
    serverFailure: null,
    serverFailureDisplayKey: 'turn-1:MODEL_CONFIG_MISSING',
  })
  assert.equal(buildModelFailureRetryRequest([user, displayKeyOnly], displayKeyOnly), null)
  const notFailed = modelFailure({ failed: false })
  assert.equal(buildModelFailureRetryRequest([user, notFailed], notFailed), null)
  for (const code of [
    'MODEL_AUTH_FAILED',
    'MODEL_ENDPOINT_TIMEOUT',
    'MODEL_ENDPOINT_UNREACHABLE',
    'MODEL_ENDPOINT_HTTP_ERROR',
    'MODEL_TIMEOUT',
    'MODEL_UPSTREAM_ERROR',
    'MODEL_REQUEST_OUTCOME_UNKNOWN',
    'MODEL_REQUEST_CONTEXT_DRIFT',
    'STREAM_TRUNCATED',
    'TURN_STREAM_TRUNCATED',
    'TURN_RECONNECT_EXHAUSTED',
  ]) {
    const ambiguousOutcome = modelFailure({ serverFailure: { code } })
    assert.equal(
      buildModelFailureRetryRequest([user, ambiguousOutcome], ambiguousOutcome),
      null,
      code,
    )
  }
  assert.equal(buildModelFailureRetryRequest([user], modelFailure()), null)
  assert.equal(buildModelFailureRetryRequest([modelFailure()], modelFailure()), null)
})

test('model retry drops unusable attachment records and refuses an empty resend', () => {
  const failed = modelFailure()
  const messages = [
    { role: 'user', content: '', attachments: [{ name: 'missing-id.txt' }] },
    failed,
  ]
  assert.equal(buildModelFailureRetryRequest(messages, failed), null)
})

test('snapshot restore preserves safe preflight retry but blocks persisted partial model output', () => {
  const restore = (assistantContent) => normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'user-before-preflight',
      role: 'user',
      content: 'Retry after I configure the model',
      createdAt: 1,
    }, {
      id: 'turn-preflight:assistant',
      role: 'assistant',
      content: assistantContent,
      createdAt: 2,
      modelContext: {
        turnId: 'turn-preflight',
        turnEvidence: true,
        evidenceState: 'failed',
        error: {
          code: 'MODEL_CONFIG_MISSING',
          message: 'Configure a model before sending.',
          retryable: false,
        },
      },
    }],
  }).messages

  const safeMessages = restore('')
  assert.deepEqual(buildModelFailureRetryRequest(safeMessages, safeMessages[1]), {
    content: 'Retry after I configure the model',
    attachments: [],
    historyLimit: 0,
  })

  const partialMessages = restore('The provider already started this answer.')
  assert.equal(buildModelFailureRetryRequest(partialMessages, partialMessages[1]), null)
})
