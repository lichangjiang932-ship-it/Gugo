import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnTerminalOutcomeRuntime } from '../server/services/turnTerminalOutcomeRuntime.js'

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
    emitter: async (type, payload, options = {}) => {
      await options.beforeAppend?.({ sequence: 3, type, payload })
      order.push(['event', type, payload])
      return { sequence: 3, type, payload }
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
  assert.deepEqual(order.map(([kind]) => kind), ['message', 'event', 'canary', 'hook', 'memory'])
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
  assert.deepEqual(order[1][2].verifiedLocalFiles, [{ id: 'verified-1' }])
  assert.deepEqual(order[1][2].retainedLocalFiles, [{ id: 'retained-1' }])
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
