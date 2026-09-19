import assert from 'node:assert/strict'
import test from 'node:test'
import { createLoopContext } from '../server/services/loop/context.js'
import { prepareToolsLoopRuntime, usePreparedToolsLoopRuntime as accessPreparedToolsLoopRuntime } from '../server/services/loop/runtime.js'
import { normalizeModelInvocation } from '../server/services/loop/modelInvocationCheckpoint.js'
import { callStreamingModelWithTools } from '../server/adapters/modelInvocationRuntime.js'

const contextFailure = { error: { code: 500, type: 'server_error', message: 'Context size has been exceeded.' } }
const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`

async function trackedFixture({ usage, partial = false, checkpoint = null, succeeds = false } = {}) {
  const checkpoints = []
  let requests = 0
  const context = createLoopContext({
    job: { id: 'context-boundary-turn', userId: 'context-boundary-owner', sessionId: 'context-boundary-session',
      origin: 'chat', prompt: 'Give a short answer.', modelName: 'overflow-fixture' },
    step: { id: 'context-boundary-turn', kind: 'chat' },
    messages: [{ role: 'system', content: 'fixed instructions '.repeat(900) }, { role: 'user', content: 'Give a short answer.' }],
    toolSpecs: [], maxIters: 1, contextWindow: 8192,
    ...(checkpoint ? { loadCheckpoint: async () => checkpoint } : {}),
    runModel: (request) => callStreamingModelWithTools({ ...request,
      env: { MODEL_NAME: 'overflow-fixture', MODEL_BASE_URL: 'http://127.0.0.1:1234/v1' },
      fetchImpl: async () => {
        requests++
        if (succeeds) return Response.json({ choices: [{ message: { content: 'Recovered.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })
        return new Response((partial ? frame({ choices: [{ delta: { content: 'Retain this partial answer.' } }] }) : '')
          + frame({ ...contextFailure, ...(usage ? { usage } : {}) }), { headers: { 'content-type': 'text/event-stream' } })
      },
    }),
    saveCheckpoint: async (state, meta) => { checkpoints.push({ state: structuredClone(state), boundary: meta?.boundary }); return true },
  })
  const prepared = await prepareToolsLoopRuntime(context)
  let state
  accessPreparedToolsLoopRuntime(prepared, (value) => { state = value })
  return { state, checkpoints, requests: () => requests,
    run: () => state.callTrackedModel({ messages: state.convo, tools: [], toolChoice: 'none', allowOverBudget: false }) }
}

test('known context failure becomes a durable failed invocation without a second identical physical request', async () => {
  const fixture = await trackedFixture()
  await assert.rejects(fixture.run(), { code: 'CONTEXT_UNRECOVERABLE', noProgress: true })
  assert.equal(fixture.requests(), 1)
  const failed = fixture.checkpoints.findLast((entry) => entry.boundary === 'model-request-failed')
  assert.ok(failed)
  assert.equal(failed.state.modelInvocation.status, 'failed')
  assert.equal(failed.state.modelInvocation.errorCode, 'MODEL_CONTEXT_LENGTH_EXCEEDED')
  assert.equal(failed.state.modelInvocation.providerAttempts.length, 1)
  assert.equal(failed.state.modelInvocation.callBudgetApplied, true)
  assert.equal(failed.state.budget.modelCalls, 1)
  assert.equal(Object.hasOwn(failed.state.modelInvocation, 'failureUsage'), false, 'unknown usage must not be fabricated')
})

test('reported failed-input usage survives the ledger and is counted once without invented output tokens', async () => {
  const fixture = await trackedFixture({ usage: { prompt_tokens: 17 } })
  await assert.rejects(fixture.run(), { code: 'CONTEXT_UNRECOVERABLE' })
  assert.equal(fixture.requests(), 1)
  const failed = fixture.checkpoints.findLast((entry) => entry.boundary === 'model-request-failed')
  assert.deepEqual(failed.state.modelInvocation.failureUsage, { promptTokens: 17 })
  assert.equal(failed.state.modelInvocation.failureUsageApplied, true)
  assert.equal(failed.state.budget.modelCalls, 1)
  assert.equal(failed.state.budget.modelTokens, 17)
  assert.equal(failed.state.budget.costEvidenceComplete, false)
  const restored = normalizeModelInvocation(failed.state.modelInvocation)
  assert.deepEqual(restored.failureUsage, { promptTokens: 17 })
  assert.equal(restored.failureUsageApplied, true)
  assert.equal(fixture.state.budget.snapshot().modelTokens, 17)
  assert.equal(normalizeModelInvocation({ ...failed.state.modelInvocation, failureUsageApplied: false }), null)
  assert.equal(normalizeModelInvocation({ ...failed.state.modelInvocation, failureUsage: {} }), null)
  const resumed = await trackedFixture({ checkpoint: failed.state, succeeds: true })
  const response = await resumed.run()
  assert.equal(response.response.content, 'Recovered.')
  assert.equal(resumed.requests(), 1)
  assert.equal(resumed.state.budget.snapshot().modelCalls, 2)
  assert.equal(resumed.state.budget.snapshot().modelTokens, 24, '17 recorded tokens plus 7 new tokens; do not count failure usage twice')
})

test('partial generation remains an in-flight diagnostic checkpoint instead of a failed/replayable invocation', async () => {
  const fixture = await trackedFixture({ usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 }, partial: true })
  await assert.rejects(fixture.run(), { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', unsafeToReplay: true })
  assert.equal(fixture.requests(), 1)
  assert.equal(fixture.checkpoints.some((entry) => entry.boundary === 'model-request-failed'), false)
  const retained = fixture.checkpoints.at(-1).state.modelInvocation
  assert.equal(retained.status, 'in_flight')
  assert.equal(retained.modelRequestDiagnostics.upstreamCode, 'MODEL_CONTEXT_LENGTH_EXCEEDED')
  assert.equal(retained.modelRequestDiagnostics.partialGeneration.content, 'Retain this partial answer.')
  assert.equal(retained.modelRequestDiagnostics.partialGeneration.usage.totalTokens, 20)
})
