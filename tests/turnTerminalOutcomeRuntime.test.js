import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnTerminalOutcomeRuntime } from '../server/services/turnTerminalOutcomeRuntime.js'
import { flushCheckpoint } from '../server/services/loop/checkpoint.js'

const scope = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1' }

function completedState() {
  return {
    checkpointMessages: [],
    baselineToolCallIds: new Set(),
    checkpointArtifactIds: ['artifact-old'],
    checkpointDeliveryArtifactIds: ['artifact-old'],
    checkpointRecovery: null,
    latestModelUsage: { totalTokens: 8 },
    turnModelUsage: { totalTokens: 13 },
    latestEstimatedPromptTokens: 21,
    effectiveTurnStartedAt: 1_000,
    promptContextSnapshot: { pluginPromptBlockIds: ['plugin:block'] },
    promptContext: { effectiveAgentId: 'agent-resolved' },
    historyMessages: [{ role: 'user', content: 'ship it' }],
    agentId: 'agent-fallback',
  }
}

function completedEvidence(order) {
  return {
    atomicTurnBoundary: false,
    verifiedLocalFilesAt: () => [{ id: 'verified-1' }],
    retainedLocalFilesAt: () => [{ id: 'retained-1' }],
    boundaryOptions: () => ({}),
    emitter: async (type, payload, options = {}) => {
      const event = { sequence: 3, type, payload }
      await options.beforeAppend?.(event)
      order.push(['event', type, payload])
      await options.afterAppend?.(event)
      return event
    },
  }
}

test('completed outcome dispatches a non-blocking notification hook with delivery evidence', async () => {
  const order = []
  const writtenMessages = []
  const hookCalls = []
  const memoryCalls = []
  const canaryCalls = []
  const pendingHook = new Promise(() => {})
  const runtime = createTurnTerminalOutcomeRuntime({
    now: () => 2_000,
    writeMessage: async (message) => {
      order.push(['message'])
      writtenMessages.push(message)
    },
    dispatchHooks: (input) => {
      order.push(['hook'])
      hookCalls.push(input)
      return pendingHook
    },
    scheduleMemoryExtraction: (input) => {
      order.push(['memory'])
      memoryCalls.push(input)
    },
    runMemoryModel: async () => ({ text: 'memory' }),
  })
  const text = 'x'.repeat(4_005)
  const settlement = runtime.settleResult({
    scope,
    signal: new AbortController().signal,
    result: {
      text,
      artifactIds: ['artifact-1', 'artifact-1'],
      deliveryArtifactIds: ['artifact-1'],
      iterations: 2,
    },
    state: completedState(),
    evidence: completedEvidence(order),
    recordCanaryTerminal: async (...args) => {
      order.push(['canary'])
      canaryCalls.push(args)
    },
  })

  const outcome = await Promise.race([
    settlement.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
  ])

  assert.equal(outcome, 'settled')
  assert.deepEqual(order.map(([kind]) => kind), ['event', 'message', 'canary', 'hook', 'memory'])
  assert.equal(hookCalls.length, 1)
  assert.deepEqual(hookCalls[0], {
    userId: scope.userId,
    event: 'notification',
    tool: null,
    args: {
      text: 'x'.repeat(4_000),
      artifactIds: ['artifact-1'],
      deliveryArtifactIds: ['artifact-1'],
      iterations: 2,
    },
    sessionId: scope.sessionId,
  })
  assert.equal(writtenMessages[0].content, text)
  assert.deepEqual(order[0][2].verifiedLocalFiles, [{ id: 'verified-1' }])
  assert.deepEqual(order[0][2].retainedLocalFiles, [{ id: 'retained-1' }])
  assert.deepEqual(canaryCalls, [['completed', null, 2_000, text]])
  assert.equal(memoryCalls[0].agentId, 'agent-resolved')
  assert.equal(memoryCalls[0].assistantText, text)
})

test('completed outcome contains an asynchronously rejected notification hook', async () => {
  const runtime = createTurnTerminalOutcomeRuntime({
    now: () => 2_000,
    writeMessage: async () => {},
    dispatchHooks: async () => { throw new Error('hook unavailable') },
    scheduleMemoryExtraction: () => {},
    runMemoryModel: async () => ({ text: 'memory' }),
  })

  await assert.doesNotReject(() => runtime.settleResult({
    scope,
    signal: new AbortController().signal,
    result: { text: 'done', artifactIds: [], iterations: 1 },
    state: completedState(),
    evidence: completedEvidence([]),
    recordCanaryTerminal: async () => {},
  }))
})

test('an internal steering deferral is rejected as a completed loop result by the host', async () => {
  const events = []
  const canaries = []
  let memoryCalls = 0
  const runtime = createTurnTerminalOutcomeRuntime({
    now: () => 2_000,
    writeMessage: async () => {},
    scheduleMemoryExtraction: () => { memoryCalls += 1 },
    runMemoryModel: async () => ({ text: 'memory' }),
  })
  await runtime.settleResult({
    scope,
    signal: new AbortController().signal,
    result: { deferredForSteering: true },
    state: { ...completedState(), checkpointIterations: 1 },
    evidence: completedEvidence(events),
    recordCanaryTerminal: async (...args) => { canaries.push(args) },
  })

  assert.equal(events.length, 1)
  assert.equal(events[0][1], 'turn.failed')
  assert.equal(events[0][2].code, 'TURN_INCOMPLETE')
  assert.equal(events[0][2].incompleteReason, 'turn_incomplete')
  assert.equal(canaries[0][0], 'failed')
  assert.equal(memoryCalls, 0)
})

function noWriteTerminalRuntime() {
  const unexpectedWrite = () => assert.fail('a fenced execution must not project a terminal outcome')
  return {
    runtime: createTurnTerminalOutcomeRuntime({
      now: unexpectedWrite,
      writeMessage: unexpectedWrite,
      commitTurnBoundary: unexpectedWrite,
      scheduleMemoryExtraction: unexpectedWrite,
      runMemoryModel: unexpectedWrite,
    }),
    context: {
      scope,
      emitter: unexpectedWrite,
      evidence: {
        emitter: unexpectedWrite,
        emitFailed: unexpectedWrite,
        emitBlocked: unexpectedWrite,
        verifiedLocalFilesAt: unexpectedWrite,
        retainedLocalFilesAt: unexpectedWrite,
        boundaryOptions: unexpectedWrite,
      },
      state: completedState(),
      recordCanaryTerminal: unexpectedWrite,
    },
  }
}

test('a checkpoint stale-owner fence is propagated without writing a failed terminal', async () => {
  const fence = Object.assign(new Error('execution lease expired'), {
    code: 'TURN_EXECUTION_LEASE_STALE',
  })
  let checkpointError
  await assert.rejects(flushCheckpoint({
    saveCheckpoint: async () => { throw fence },
    state: { toolCallStates: [{ status: 'completed' }] },
  }), (error) => {
    checkpointError = error
    return error.code === 'CHECKPOINT_FLUSH_FAILED' && error.cause === fence
  })
  const { runtime, context } = noWriteTerminalRuntime()
  await assert.rejects(runtime.settleError({
    ...context,
    signal: new AbortController().signal,
    error: checkpointError,
  }), (error) => error === checkpointError && error.cause === fence)
})

for (const code of ['TURN_LEASE_LOST', 'TURN_EXECUTION_LEASE_STALE', 'TURN_ENGINE_SHUTDOWN', 'TURN_ALREADY_TERMINAL']) {
  test(`a ${code} abort remains observable at every terminal entry point`, async () => {
    const reason = Object.assign(new Error(code), { code })
    const controller = new AbortController()
    controller.abort(reason)
    const { runtime, context } = noWriteTerminalRuntime()

    await assert.rejects(runtime.cancelBeforeExecution({
      ...context, signal: controller.signal, turnStartedAt: 1_000,
    }), (error) => error === reason)
    await assert.rejects(runtime.settleResult({
      ...context, signal: controller.signal, result: { text: 'must not complete' },
    }), (error) => error === reason)
    await assert.rejects(runtime.settleError({
      ...context, signal: controller.signal, error: new Error('tool aborted'),
    }), (error) => error === reason)
  })
}

test('explicit user cancellation still persists a cancelled boundary', async () => {
  const events = []
  const controller = new AbortController()
  controller.abort(Object.assign(new Error('user stopped'), { code: 'TURN_CANCEL_REQUESTED' }))
  const runtime = createTurnTerminalOutcomeRuntime({
    now: () => 2_000,
    writeMessage: async () => {},
    scheduleMemoryExtraction: () => {},
    runMemoryModel: async () => ({}),
  })
  await runtime.settleError({
    scope,
    signal: controller.signal,
    error: controller.signal.reason,
    state: { ...completedState(), checkpointIterations: 1, streamedAssistantText: 'partial' },
    evidence: completedEvidence(events),
    recordCanaryTerminal: async () => {},
  })
  assert.equal(events.length, 1)
  assert.equal(events[0][1], 'turn.cancelled')
  assert.equal(events[0][2].code, 'TURN_CANCELLED')
})
