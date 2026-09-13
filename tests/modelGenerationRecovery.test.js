import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mergeGenerationText, publicModelRequestDiagnostics, snapshotInterruptedModelRequest, snapshotPartialGeneration,
} from '../server/services/loop/modelGenerationRecovery.js'
import { normalizeModelInvocation } from '../server/services/loop/modelInvocationCheckpoint.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { normalizeTurnFailure } from '../server/services/turnTerminalProjection.js'
import { createTurnEvent } from '../shared/turnEvents.js'
import { projectTurnEventForClient } from '../shared/turnEventProjection.js'

test('interruption diagnostics retain unknown billing but grant no replay authority', () => {
  const invocation = { id: 'mr_diagnostic_fixture', fingerprint: 'a'.repeat(64), status: 'in_flight' }
  const error = { transportPhase: 'stream', timeoutPhase: 'idle', timeoutMs: 60_000, upstreamCode: 'MODEL_TIMEOUT',
    safeToRetryGeneration: true, modelRequestOutcome: 'not_sent', retryable: true,
    message: 'Sensitive provider response', rawArguments: 'Unfinished tool parameters' }
  const before = structuredClone({ invocation, error })
  assert.deepEqual(snapshotInterruptedModelRequest(invocation, error), {
    version: 1, code: 'MODEL_REQUEST_OUTCOME_UNKNOWN',
    modelRequestId: invocation.id, fingerprint: invocation.fingerprint, billingUnknown: true,
    transportPhase: 'stream', timeoutPhase: 'idle', timeoutMs: 60_000, upstreamCode: 'MODEL_TIMEOUT',
  })
  assert.deepEqual({ invocation, error }, before)
  assert.equal(snapshotInterruptedModelRequest({ ...invocation, id: 'bad\nidentity' }, error), null)
  assert.equal(snapshotInterruptedModelRequest(invocation, { upstreamCode: 'Bearer private token' }).upstreamCode, undefined)
})

test('partial text snapshots cannot smuggle tool calls or a completed-response claim', () => {
  const partial = { content: 'Received text only', streamed: true, finishReason: 'stop',
    toolCalls: [{ id: 'unfinished', name: 'write_file', args: { content: 'must not execute' } }],
    providerReplay: { untrusted: true }, argumentsText: 'incomplete request' }
  const before = structuredClone(partial)
  assert.deepEqual(snapshotPartialGeneration(partial), { content: partial.content, streamed: true })
  assert.deepEqual(partial, before)
  assert.equal(snapshotPartialGeneration({ content: 'x'.repeat(128_001) }), null)
  assert.equal(snapshotPartialGeneration({ content: { html: 'not text' } }), null)
})

test('text merging handles repeated prefixes and boundary overlap without executing anything', () => {
  assert.equal(mergeGenerationText('First. ', 'Second.'), 'First. Second.')
  assert.equal(mergeGenerationText('First. ', 'First. Second.'), 'First. Second.')
  assert.equal(mergeGenerationText('First. Second.', 'Second. Third.'), 'First. Second. Third.')
  assert.equal(mergeGenerationText('Already received.', 'Already'), 'Already received.')
})

let fixtureIndex = 0
function loopFixture() {
  const id = `request-diagnostics-${++fixtureIndex}`
  return {
    job: { id, userId: 'request-diagnostics-user', sessionId: 'request-diagnostics-session',
      origin: 'chat', prompt: 'Answer the current request once.', modelName: 'fixture-model',
      modelProviderId: 'fixture-provider', modelConfigRevision: 1 },
    step: { id, kind: 'chat' }, messages: [{ role: 'user', content: 'Answer the current request once.' }],
    toolSpecs: [], intentMode: 'answer', maxIters: 2, enableToolHooks: false,
  }
}

function unknownRequest(request, content = 'Incomplete received prose.') {
  return Object.assign(new Error('Generic request outcome unknown', {
    cause: Object.assign(new Error('Must not publish raw provider response'), { code: 'MODEL_TIMEOUT' }),
  }), {
    code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', retryable: false, unsafeToReplay: true, requiresUserVerification: true,
    modelRequestId: request.modelRequestId, transportPhase: 'stream', timeoutPhase: 'idle', timeoutMs: 60_000,
    upstreamCode: 'MODEL_TIMEOUT', partialGeneration: { content, streamed: true,
      toolCalls: [{ id: 'must-not-replay', name: 'write_file', args: { content: 'unfinished-secret-args' } }],
      headers: { authorization: 'Bearer forbidden-header' } },
    headers: { authorization: 'Bearer forbidden-header' }, body: 'forbidden-raw-body',
  })
}

function providerCompletion(invocation) {
  return { contractVersion: 1, source: 'provider', outcome: 'completed', authoritative: true,
    receipt: { lookupId: 'fixture-confirmed-completion' },
    verification: { modelRequestId: invocation.id, idempotencyKey: invocation.idempotencyKey,
      requestFingerprint: invocation.fingerprint, providerId: invocation.providerId, modelName: invocation.modelName,
      configFingerprint: '', physicalAttemptSequence: 0, providerCapability: null },
    response: { content: 'The complete verified answer.', toolCalls: [], finishReason: 'stop' },
  }
}

test('the real loop flushes bounded diagnostics but keeps unknown requests non-replayable', async () => {
  const options = loopFixture()
  const checkpoints = []
  let calls = 0
  let failure
  await assert.rejects(() => runToolLoop({ ...options,
    runModel: async (request) => { calls += 1; failure = unknownRequest(request); throw failure },
    saveCheckpoint: async (state, meta) => { checkpoints.push({ state: structuredClone(state), meta }); return true },
  }), (error) => error === failure && error.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN')
  const checkpoint = checkpoints.find((entry) => entry.meta.boundary === 'model-request-diagnostics')?.state
  assert.ok(checkpoint)
  const invocation = checkpoint.modelInvocation
  assert.equal(invocation.status, 'in_flight')
  assert.equal(invocation.response, undefined)
  assert.equal(invocation.modelRequestDiagnostics.partialGeneration.content, 'Incomplete received prose.')
  assert.deepEqual(Object.keys(invocation.modelRequestDiagnostics.partialGeneration).sort(), ['content', 'streamed'])
  assert.equal(invocation.modelRequestDiagnostics.billingUnknown, true)
  assert.equal(failure.modelRequestDiagnostics.contentRetained, true)
  assert.equal(failure.modelRequestDiagnostics.partialContentChars, 'Incomplete received prose.'.length)
  assert.equal(failure.modelRequestDiagnostics.timeoutMs, 60_000)
  assert.doesNotMatch(JSON.stringify(failure.modelRequestDiagnostics), /prose|forbidden|toolCalls|partialGeneration|fingerprint/)
  assert.equal(normalizeModelInvocation(invocation).status, 'in_flight')
  assert.deepEqual(normalizeModelInvocation(invocation).modelRequestDiagnostics, invocation.modelRequestDiagnostics)
  let resumedError
  await assert.rejects(() => runToolLoop({ ...options,
    loadCheckpoint: async () => structuredClone(checkpoint),
    runModel: async () => { calls += 1; return { content: 'must not run', toolCalls: [] } },
  }), (error) => { resumedError = error; return error.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN' })
  assert.equal(calls, 1)
  assert.deepEqual(resumedError.modelRequestDiagnostics, failure.modelRequestDiagnostics)
})

test('a diagnosed unknown request still finishes from an authoritative complete response without a new RPC', async () => {
  const options = loopFixture()
  let checkpoint
  let completedInvocation
  let calls = 0
  await assert.rejects(() => runToolLoop({ ...options,
    runModel: async (request) => { calls += 1; throw unknownRequest(request) },
    saveCheckpoint: async (state) => { checkpoint = structuredClone(state); return true },
  }), { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN' })
  const result = await runToolLoop({ ...options,
    loadCheckpoint: async () => structuredClone(checkpoint),
    reconcileModelRequest: async (invocation) => providerCompletion(invocation),
    runModel: async () => { calls += 1; return { content: 'must not be requested', toolCalls: [] } },
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      if (checkpoint.modelInvocation?.status === 'completed') completedInvocation = checkpoint.modelInvocation
      return true
    },
  })
  assert.equal(result.text, 'The complete verified answer.')
  assert.equal(calls, 1)
  assert.equal(completedInvocation.status, 'completed')
  assert.equal(completedInvocation.response.content, result.text)
  assert.equal(completedInvocation.modelRequestDiagnostics.partialGeneration.content, 'Incomplete received prose.')
})

test('diagnostic checkpoint failure prevents any follow-up request or claimed persisted content', async () => {
  let calls = 0
  let failure
  await assert.rejects(() => runToolLoop({ ...loopFixture(),
    runModel: async (request) => { calls += 1; failure = unknownRequest(request); throw failure },
    saveCheckpoint: async (_state, metadata) => {
      if (metadata.boundary === 'model-request-diagnostics') throw new Error('fixture diagnostic write failure')
      return true
    },
  }), { code: 'CHECKPOINT_FLUSH_FAILED' })
  assert.equal(calls, 1)
  assert.equal(failure.modelRequestDiagnostics, undefined)
})

test('external cancellation does not trigger a late diagnostic write', async () => {
  const controller = new AbortController()
  const boundaries = []
  let calls = 0
  await assert.rejects(() => runToolLoop({ ...loopFixture(), signal: controller.signal,
    runModel: async (request) => { calls += 1; controller.abort(); throw unknownRequest(request) },
    saveCheckpoint: async (_state, metadata) => { boundaries.push(metadata.boundary); return true },
  }), { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN' })
  assert.equal(calls, 1)
  assert.equal(boundaries.includes('model-request-diagnostics'), false)
})

test('failure protocol exposes reason metadata without the private prose or transport payload', () => {
  const invocation = { id: 'mr_public_fixture', fingerprint: 'b'.repeat(64), status: 'in_flight' }
  const privateDiagnostics = snapshotInterruptedModelRequest(invocation, unknownRequest({ modelRequestId: invocation.id }))
  const diagnostics = publicModelRequestDiagnostics(privateDiagnostics)
  const failure = normalizeTurnFailure({ code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', retryable: false,
    modelRequestDiagnostics: { ...diagnostics, headers: { secret: true }, body: 'forbidden-body', partialGeneration: privateDiagnostics.partialGeneration } })
  assert.deepEqual(failure.modelRequestDiagnostics, diagnostics)
  const event = createTurnEvent({ id: 'diagnostic-event', sessionId: 'diagnostic-session', turnId: 'diagnostic-turn', sequence: 0,
    type: 'turn.blocked', payload: { code: failure.code, error: failure, retryable: false,
      manualRetryable: true, recoveryStatus: 'dead_letter', recoveryKind: 'model_request_outcome_unknown',
      turnId: 'diagnostic-turn', modelRequestId: invocation.id, requiresUserVerification: true,
      recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' } },
  })
  const client = projectTurnEventForClient(event)
  assert.deepEqual(client.payload.error.modelRequestDiagnostics, diagnostics)
  assert.doesNotMatch(JSON.stringify(client), /Incomplete received prose|partialGeneration|forbidden|headers|fingerprint/)
  const mismatched = normalizeModelInvocation({ version: 1, id: invocation.id, fingerprint: invocation.fingerprint,
    status: 'in_flight', iteration: 0, attempt: 1,
    modelRequestDiagnostics: { ...privateDiagnostics, modelRequestId: 'mr_wrong_request' } })
  assert.equal(mismatched.status, 'in_flight')
  assert.equal(mismatched.modelRequestDiagnostics, undefined)
})
