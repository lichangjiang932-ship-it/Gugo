import assert from 'node:assert/strict'
import test from 'node:test'

import { buildModelProviderRequest } from '../server/adapters/modelRequestBuilder.js'
import { modelRequestOutcomeUnknown } from '../server/adapters/modelRequestOutcome.js'
import { streamModelProviderEvents } from '../server/adapters/modelStreamingTransport.js'
import { createTurnCancellationRuntime } from '../server/services/turnCancellationRuntime.js'
import { createTurnResumeRuntime } from '../server/services/turnResumeRuntime.js'
import { createTurnTerminalOutcomeRuntime } from '../server/services/turnTerminalOutcomeRuntime.js'
import {
  TURN_EVENT_PERSISTENCE_FAILURE_CODE,
  TURN_TERMINAL_PERSISTENCE_FAILURE_CODE,
} from '../server/services/turnEventEmitter.js'

const SCOPE = Object.freeze({ userId: 'cancel-user', sessionId: 'cancel-session', turnId: 'cancel-turn' })
const MODEL_REQUEST_ID = 'cancel-model-request'

function codedError(code, name = 'Error') {
  return Object.assign(new Error(code), { code, name })
}

function unknownRequest(cause = codedError('MODEL_TIMEOUT')) {
  return modelRequestOutcomeUnknown(cause, {
    modelRequestId: MODEL_REQUEST_ID,
    requestStarted: true,
    responseReceived: true,
    phase: 'response',
  })
}

function fixture() {
  const controller = new AbortController()
  const events = []
  const blocked = []
  const failed = []
  const boundaries = []
  const canaries = []
  const checkpoint = Object.freeze({
    modelInvocation: Object.freeze({
      id: MODEL_REQUEST_ID,
      status: 'in_flight',
      iteration: 0,
      attempt: 1,
      fingerprint: 'a'.repeat(64),
    }),
  })
  const state = {
    checkpointMessages: [],
    checkpointArtifactIds: [],
    checkpointDeliveryArtifactIds: [],
    checkpointIterations: 1,
    checkpointRecovery: checkpoint,
    streamedAssistantText: '',
    latestEstimatedPromptTokens: null,
  }
  const emit = async (type, payload) => {
    const event = { ...SCOPE, sequence: events.length + 1, type, payload, createdAt: 2_000 }
    events.push(event)
    return event
  }
  const noMemory = () => assert.fail('cancellation must not launch post-turn model work')
  const runtime = createTurnTerminalOutcomeRuntime({
    now: () => 2_000,
    writeMessage: async () => {},
    scheduleMemoryExtraction: noMemory,
    runMemoryModel: noMemory,
  })
  const evidence = {
    emitter: emit,
    emitBlocked: async (error) => {
      blocked.push(error)
      return emit('turn.blocked', { code: error.code })
    },
    emitFailed: async (error) => {
      failed.push(error)
      return emit('turn.failed', { code: error.code })
    },
    verifiedLocalFilesAt: () => [],
    retainedLocalFilesAt: () => [],
    boundaryOptions: (options) => { boundaries.push(options); return {} },
  }
  return {
    controller, runtime, checkpoint, state, evidence, events, blocked, failed, boundaries, canaries,
    settle: (error) => runtime.settleError({
      scope: SCOPE, signal: controller.signal, error, state, evidence,
      recordCanaryTerminal: async (...args) => { canaries.push(args) },
    }),
  }
}

async function assertCancelledTurnCannotResume(f) {
  const forbidden = () => assert.fail('a cancelled turn must not acquire or replay its unknown model invocation')
  const started = { ...SCOPE, sequence: 0, type: 'turn.started', payload: {} }
  const runtime = createTurnResumeRuntime({
    deps: {
      readSession: async () => ({ id: SCOPE.sessionId }),
      lastEvent: async ({ type }) => type === 'turn.started' ? started : f.events.at(-1),
      readRecoveryState: forbidden,
      readFileAccessStatus: forbidden,
      runtimeCore: { checkpoint: { load: forbidden } },
    },
    claimLegacySession: forbidden,
    getTurn: async () => ({ ...SCOPE, status: 'cancelled', lastEvent: f.events.at(-1) }),
    resolveModelBinding: forbidden,
    active: new Map(),
    createEmitter: forbidden,
    schedule: forbidden,
  })
  for (const retryRecovery of [false, true]) {
    const result = await runtime.resumeTurn({ ...SCOPE, retryRecovery })
    assert.equal(result.terminal, true)
    assert.equal(result.scheduled, false)
    assert.equal(result.locallyActive, false)
    assert.equal(result.turn.status, 'cancelled')
  }
  assert.equal(f.checkpoint.modelInvocation.status, 'in_flight')
  assert.equal(Object.hasOwn(f.checkpoint.modelInvocation, 'response'), false)
}

for (const code of ['TURN_CANCEL_REQUESTED', 'USER_STOPPED']) {
  test(`${code} cancels the task without settling or replaying its unknown provider request`, async () => {
    const f = fixture()
    f.controller.abort(codedError(code, 'AbortError'))
    const error = Object.freeze(unknownRequest(f.controller.signal.reason))
    const checkpointBefore = JSON.stringify(f.checkpoint)
    f.state.streamedAssistantText = 'Retained partial output.'
    await f.settle(error)

    assert.deepEqual(f.events.map((event) => event.type), ['turn.cancelled'])
    assert.equal(f.events[0].payload.code, 'TURN_CANCELLED')
    assert.equal(f.events[0].payload.partialText, 'Retained partial output.')
    assert.equal(f.boundaries[0].state, 'cancelled')
    assert.equal(f.blocked.length, 0)
    assert.equal(f.failed.length, 0)
    assert.equal(error.code, 'MODEL_REQUEST_OUTCOME_UNKNOWN')
    assert.equal(error.unsafeToReplay, true)
    assert.equal(error.retryable, false)
    assert.equal(error.requiresUserVerification, true)
    assert.equal(error.modelRequestId, MODEL_REQUEST_ID)
    assert.equal(JSON.stringify(f.checkpoint), checkpointBefore)
    await assertCancelledTurnCannotResume(f)
  })
}

test('production cancellation and streaming transport retain UNKNOWN while the host emits cancelled', async () => {
  const f = fixture()
  const running = { controller: f.controller }
  const noInactiveWork = () => assert.fail('active cancellation must not acquire a new execution lease')
  const cancellation = createTurnCancellationRuntime({
    readSession: async () => ({ id: SCOPE.sessionId, userId: SCOPE.userId }),
    claimLegacySession: noInactiveWork,
    readActiveTurn: () => running,
    getTurn: async () => ({ ...SCOPE, status: 'running' }),
    requestCancellation: async () => true,
    abortActiveTurn: (active, error) => active.controller.abort(error),
    releaseApproval: () => {},
    lastEvent: async () => ({ ...SCOPE, sequence: 0, type: 'turn.started' }),
    acquireLease: noInactiveWork,
    closeSteeringInbox: async () => {},
    replayEvents: noInactiveWork,
    loadCheckpoint: noInactiveWork,
    now: () => 1_000,
    createEmitter: noInactiveWork,
    writeMessage: noInactiveWork,
  })
  let fetchCalls = 0
  let transportAborted = false
  let canonicalToolCalls = 0
  let requestError
  const frame = { choices: [{ delta: { tool_calls: [{
    index: 0, id: 'incomplete-write', type: 'function',
    function: { name: 'write_file', arguments: '{"path":"unused.txt","content":"' },
  }] } }] }
  try {
    for await (const event of streamModelProviderEvents({
      config: { baseUrl: 'https://cancel.example.invalid/v1', modelName: 'mock-inference' },
      messages: [{ role: 'user', content: 'Wait for explicit cancellation.' }],
      tools: [{ type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } }],
      buildRequest: buildModelProviderRequest,
      externalSignal: f.controller.signal,
      modelRequestId: MODEL_REQUEST_ID,
      env: {},
      fetchImpl: async (_url, init) => {
        fetchCalls += 1
        return new Response(new ReadableStream({
          start(controller) {
            init.signal.addEventListener('abort', () => {
              transportAborted = true
              controller.error(codedError('ABORT_ERR', 'AbortError'))
            }, { once: true })
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`))
          },
        }), { headers: { 'content-type': 'text/event-stream' } })
      },
    })) {
      if (event.type === 'tool_calls') canonicalToolCalls += event.toolCalls.length
      if (event.type === 'tool_call_progress') await cancellation.cancel(SCOPE)
    }
  } catch (error) { requestError = error }
  assert.equal(f.controller.signal.reason.code, 'TURN_CANCEL_REQUESTED')
  assert.equal(transportAborted, true)
  assert.equal(requestError?.code, 'MODEL_REQUEST_OUTCOME_UNKNOWN')
  assert.equal(requestError.unsafeToReplay, true)
  assert.equal(fetchCalls, 1)
  assert.equal(canonicalToolCalls, 0)
  await f.settle(requestError)
  assert.deepEqual(f.events.map((event) => event.type), ['turn.cancelled'])
  await assertCancelledTurnCannotResume(f)
  assert.equal(fetchCalls, 1)
})

for (const scenario of ['not-aborted', 'internal-timeout', 'unattributed-abort', 'upstream-cancel-code']) {
  test(`${scenario} cannot turn an unknown model request into a user cancellation`, async () => {
    const f = fixture()
    if (scenario === 'internal-timeout') f.controller.abort(codedError('MODEL_TIMEOUT'))
    if (scenario === 'unattributed-abort') f.controller.abort()
    const error = unknownRequest(scenario === 'upstream-cancel-code'
      ? codedError('TURN_CANCEL_REQUESTED', 'AbortError') : codedError('MODEL_TIMEOUT'))
    await f.settle(error)
    assert.deepEqual(f.events.map((event) => event.type), ['turn.blocked'])
    assert.equal(f.blocked[0], error)
    assert.equal(f.checkpoint.modelInvocation.status, 'in_flight')
  })
}

test('a model-local timeout without an aborted host signal remains failed rather than cancelled', async () => {
  const f = fixture()
  const error = codedError('MODEL_TIMEOUT')
  await f.settle(error)
  assert.deepEqual(f.events.map((event) => event.type), ['turn.failed'])
  assert.equal(f.failed[0], error)
})

test('explicit cancellation does not mask a deferred event persistence failure', async () => {
  const f = fixture()
  f.controller.abort(codedError('TURN_CANCEL_REQUESTED', 'AbortError'))
  const failure = codedError(TURN_EVENT_PERSISTENCE_FAILURE_CODE)
  await f.settle(unknownRequest(failure))
  assert.deepEqual(f.events.map((event) => event.type), ['turn.failed'])
  assert.equal(f.failed[0], failure)
})

test('explicit cancellation does not mask a terminal persistence failure', async () => {
  const f = fixture()
  f.controller.abort(codedError('TURN_CANCEL_REQUESTED', 'AbortError'))
  const failure = codedError(TURN_TERMINAL_PERSISTENCE_FAILURE_CODE)
  await assert.rejects(f.settle(failure), (error) => error === failure)
  assert.deepEqual(f.events, [])
})

test('lease loss still fences a terminal write even when the user has cancelled', async () => {
  const f = fixture()
  f.controller.abort(codedError('TURN_CANCEL_REQUESTED', 'AbortError'))
  const error = unknownRequest(codedError('TURN_EXECUTION_LEASE_STALE'))
  await assert.rejects(f.settle(error), (received) => received === error)
  assert.deepEqual(f.events, [])
})

test('the model cancellation exception does not broaden other manual recovery boundaries', async () => {
  const f = fixture()
  f.controller.abort(codedError('TURN_CANCEL_REQUESTED', 'AbortError'))
  const error = Object.assign(codedError('SIDE_EFFECT_OUTCOME_UNKNOWN'), {
    unsafeToReplay: true, retryable: false, requiresUserVerification: true,
  })
  await f.settle(error)
  assert.deepEqual(f.events.map((event) => event.type), ['turn.blocked'])
  assert.equal(f.blocked[0], error)
})
