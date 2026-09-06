import assert from 'node:assert/strict'
import test from 'node:test'
import { runToolLoop } from '../server/services/loop/index.js'
import { SERVER_TOOL_SPECS } from '../server/services/toolLoopRuntime.js'
import { snapshotModelResponse } from '../server/services/loop/modelInvocationCheckpoint.js'

function run(overrides = {}) {
  return runToolLoop({
    job: { id: 'output-continuation', userId: 'output-continuation-user', origin: 'chat', locale: 'en', prompt: 'Explain both parts fully.' },
    step: { id: 'output-continuation', kind: 'chat' },
    messages: [{ role: 'user', content: 'Explain both parts fully.' }],
    toolSpecs: [], intentMode: 'answer', maxIters: 8, enableToolHooks: false,
    ...overrides,
  })
}

test('a text response cut by the output limit continues and returns the complete answer', async () => {
  const requests = []
  let checkpoint
  const result = await run({
    saveCheckpoint: async (state) => { checkpoint = structuredClone(state); return true },
    runModel: async ({ messages }) => {
      requests.push(structuredClone(messages))
      return requests.length === 1
        ? { content: 'Part one. ', finishReason: 'length', toolCalls: [] }
        : { content: 'Part two.', finishReason: 'stop', toolCalls: [] }
    },
  })
  assert.equal(requests.length, 2)
  assert.ok(requests[1].some((message) => message.role === 'system' && message.content.includes('[BOUNDED OUTPUT CONTINUATION]')))
  assert.equal(result.text, 'Part one. Part two.')
  assert.equal(result.incomplete, undefined)
  assert.equal(checkpoint.final.text, result.text)
  assert.equal(checkpoint.completionGuards.outputContinuation.attempts, 1)
  assert.equal(checkpoint.completionGuards.outputContinuation.prefix, '')
})

test('output continuation is bounded and does not extend the iteration limit', async () => {
  for (const maxIters of [1, 8]) {
    let calls = 0
    const result = await run({ maxIters, runModel: async () => {
      calls += 1
      return { content: 'Unfinished chunk ' + calls, finishReason: 'length', toolCalls: [] }
    } })
    assert.equal(calls, maxIters === 1 ? 1 : 3)
    assert.equal(result.incomplete, true)
    assert.equal(result.code, 'MODEL_OUTPUT_TRUNCATED')
    assert.equal(result.reason, 'model_output_truncated')
  }
})

test('an untrusted stream ending cannot be treated as success or silently retried', async () => {
  let calls = 0
  const result = await run({ runModel: async () => {
    calls += 1
    return { content: 'Partial response', finishReason: 'stream_truncated', toolCalls: [] }
  } })
  assert.equal(calls, 1)
  assert.equal(result.incomplete, true)
  assert.equal(result.code, 'MODEL_OUTPUT_TRUNCATED')
})

test('continuation state survives a stop after its durable checkpoint and resumes without losing the prefix', async () => {
  const controller = new AbortController()
  let checkpoint
  let calls = 0
  await assert.rejects(() => run({
    signal: controller.signal,
    runModel: async () => { calls += 1; return { content: 'Saved prefix. ', finishReason: 'length', toolCalls: [] } },
    saveCheckpoint: async (state, metadata) => {
      checkpoint = structuredClone(state)
      if (metadata.boundary === 'model-output-continuation') controller.abort()
      return true
    },
  }), (error) => error.name === 'AbortError')
  assert.equal(calls, 1, 'manual stop must prevent the automatic next request')
  assert.equal(checkpoint.completionGuards.outputContinuation.attempts, 1)
  assert.equal(checkpoint.final, null)
  const result = await run({
    loadCheckpoint: async () => structuredClone(checkpoint),
    runModel: async () => { calls += 1; return { content: 'Remaining text.', toolCalls: [] } },
  })
  assert.equal(calls, 2)
  assert.equal(result.text, 'Saved prefix. Remaining text.')
})

test('a cached truncated response preserves provider aliases and is replayed before the fresh continuation', async () => {
  assert.equal(snapshotModelResponse({ content: 'Cut', finish_reason: 'length' }).finishReason, 'length')
  assert.equal(snapshotModelResponse({ content: 'Cut', truncated: true }).finishReason, 'truncated')
  const controller = new AbortController()
  let checkpoint
  let originalCalls = 0
  await assert.rejects(() => run({
    signal: controller.signal,
    runModel: async () => { originalCalls += 1; return { content: 'Cached prefix. ', finish_reason: 'length', toolCalls: [] } },
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      if (state.modelInvocation?.status === 'completed') controller.abort()
      return true
    },
  }), (error) => error.name === 'AbortError')
  assert.equal(checkpoint.modelInvocation.response.finishReason, 'length')
  let resumedCalls = 0
  const result = await run({
    loadCheckpoint: async () => structuredClone(checkpoint),
    runModel: async () => { resumedCalls += 1; return { content: 'Final suffix.', toolCalls: [] } },
  })
  assert.equal(originalCalls, 1)
  assert.equal(resumedCalls, 1, 'replaying a known cached chunk must not request that chunk twice')
  assert.equal(result.text, 'Cached prefix. Final suffix.')
})

test('persisted continuation counts cannot restart an exhausted automatic retry budget', async () => {
  let calls = 0
  const result = await run({
    loadCheckpoint: async () => ({
      messages: [{ role: 'user', content: 'Explain both parts fully.' }], iterations: 1,
      completionGuards: { outputContinuation: { version: 1, attempts: 2, prefix: 'Old partial. ' } },
    }),
    runModel: async () => { calls += 1; return { content: 'Still partial.', finishReason: 'length', toolCalls: [] } },
  })
  assert.equal(calls, 1)
  assert.equal(result.incomplete, true)
})

test('new steering discards obsolete partial prose but retains the bounded retry count', async () => {
  let calls = 0
  let pending = false
  let checkpoint
  const result = await run({
    claimSteering: async () => pending
      ? { leaseId: 'new-direction', messages: [{ id: 'steer-1', content: 'Replace the prior answer with one short sentence.' }] }
      : { leaseId: null, messages: [] },
    acknowledgeSteering: async () => { pending = false },
    saveCheckpoint: async (state) => { checkpoint = structuredClone(state); return true },
    runModel: async () => {
      calls += 1
      if (calls === 1) { pending = true; return { content: 'Obsolete unfinished prose.', finishReason: 'length', toolCalls: [] } }
      return { content: 'The revised answer.', toolCalls: [] }
    },
  })
  assert.equal(result.text, 'The revised answer.')
  assert.equal(checkpoint.completionGuards.outputContinuation.attempts, 1)
})

test('unknown in-flight writes are not replayed by a pending output continuation', async () => {
  const push = SERVER_TOOL_SPECS.find((spec) => spec.function?.name === 'git_push')
  const prompt = 'Push the explicitly approved change.'
  const unsupportedSuccess = 'The approved changes were pushed successfully.'
  let executions = 0
  const outcomes = []
  const result = await run({
    job: { id: 'unknown-output-write', userId: 'output-continuation-user', origin: 'chat', prompt, userPrompt: prompt },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: [push], intentMode: 'execute',
    requestToolApproval: async ({ args }) => ({ proceed: true, args, approvalId: 'test-only-approval' }),
    loadCheckpoint: async () => ({
      iterations: 1,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '', tool_calls: [{ id: 'unknown-push', function: { name: 'git_push', arguments: '{}' } }] },
      ],
      toolCalls: [{ id: 'unknown-push', name: 'git_push', args: {}, argumentsText: '{}', checkpointStatus: 'executing' }],
      completionGuards: { outputContinuation: { version: 1, attempts: 1, prefix: 'Earlier partial answer.' } },
    }),
    onToolCompleted: async (outcome) => outcomes.push(outcome.result),
    runModel: async () => ({ content: unsupportedSuccess, toolCalls: [] }),
    executeTool: async () => { executions += 1; return { ok: true } },
  })
  assert.equal(executions, 0)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].code, 'tool_execution_outcome_unknown')
  assert.equal(outcomes[0].retryable, false)
  assert.equal(outcomes[0].requiresUserVerification, true)
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'execution_evidence_missing')
  assert.ok(result.missingRequirements.includes('execution_evidence'))
  assert.notEqual(result.text, unsupportedSuccess)
})
