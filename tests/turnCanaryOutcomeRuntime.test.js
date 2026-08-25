import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnCanaryOutcomeRuntime } from '../server/services/turnCanaryOutcomeRuntime.js'

function baseContext() {
  return {
    canaryAssignment: { id: 'canary_1', variant: 'A', decisionReason: 'baseline' },
    userId: 'u1',
    sessionId: 's1',
    turnId: 't1',
    effectiveTurnStartedAt: 1000,
    turnModelUsage: { totalTokens: 42 },
    latestModelUsage: { totalTokens: 7 },
    modelProviderId: 'prov_1',
    modelName: 'model-a',
    modelConfigRevision: 3,
    evaluationInput: 'do the task',
    terminalState: 'completed',
    errorCode: null,
    completedAt: 1500,
    evaluationOutput: 'done',
  }
}

test('records canary outcome with derived duration and usage precedence', async () => {
  const calls = []
  const env = { GUGO_TEST_ENV: '1' }
  const runtime = createTurnCanaryOutcomeRuntime({
    deps: { recordCanaryOutcome: async (input) => { calls.push(input) }, env },
  })
  await runtime(baseContext())
  assert.equal(calls.length, 1)
  const recorded = calls[0]
  assert.equal(recorded.durationMs, 500)
  assert.equal(recorded.usage.totalTokens, 42)
  assert.equal(recorded.effectiveVariant, 'A')
  assert.equal(recorded.env, env)
  assert.equal(recorded.now, 1500)
})

test('falls back to latest usage when turn usage missing', async () => {
  const context = baseContext()
  delete context.turnModelUsage
  const calls = []
  const runtime = createTurnCanaryOutcomeRuntime({
    deps: { recordCanaryOutcome: async (input) => { calls.push(input) }, env: {} },
  })
  await runtime(context)
  assert.equal(calls[0].usage.totalTokens, 7)
})

test('no-op when no canary assignment', async () => {
  const context = baseContext()
  context.canaryAssignment = null
  const calls = []
  const runtime = createTurnCanaryOutcomeRuntime({
    deps: { recordCanaryOutcome: async (input) => { calls.push(input) }, env: {} },
  })
  await runtime(context)
  assert.deepEqual(calls, [])
})

test('recording failure never propagates into the turn', async () => {
  const runtime = createTurnCanaryOutcomeRuntime({
    deps: { recordCanaryOutcome: async () => { throw new Error('evolution store down') }, env: {} },
  })
  await assert.doesNotReject(() => runtime(baseContext()))
})
