import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { runToolLoop } from '../server/services/loop/index.js'
import { fingerprintModelRequest } from '../server/services/loop/modelInvocationCheckpoint.js'
import { assertMainRequestSettled, createCompactionRecoveryCheckpoint, restoreCompactionCheckpoint } from '../server/services/loop/compactionCheckpoint.js'
import { selectModelRequestRecoverySlot } from '../server/services/modelRequestInvocationSlots.js'

const MARKER = 'LEGACY_MAIN_RECOVERY_ORCHID_731'
const recoveredResponse = { content: `Recovered main answer: ${MARKER}`, toolCalls: [], usage: { promptTokens: 9, completionTokens: 1 } }
const autoPolicy = { mode: 'auto', timeoutMs: 500 }

function summaryResponse(request) {
  const content = String(request.messages[0]?.content || '').includes('exactly seven numbered Markdown sections')
    ? ['Objective and success criteria', 'Decisions and constraints', 'Completed work', 'Current working state', 'Files read or changed', 'Commands and tool outcomes', 'Open work, risks, and next actions']
      .map((title, index) => `## ${index + 2}. ${title}\n- ${index === 0 ? MARKER : 'No additional evidence.'}`).join('\n\n')
    : `Evidence digest: ${MARKER}`
  return { content, toolCalls: [] }
}

async function fixture({ long = true, semanticSummary = false } = {}) {
  const messages = long ? [
    { role: 'user', content: 'Analyze the source.\n' + 'Background evidence\n'.repeat(3600) + `\nRequired marker: ${MARKER}` },
    { role: 'assistant', content: 'Work remains.' },
    { role: 'user', content: 'Return the required marker.' },
  ] : [{ role: 'user', content: `Return the required marker: ${MARKER}` }]
  const options = {
    job: { id: 'legacy-main-fixture', userId: null, origin: 'chat', prompt: messages.at(-1).content, userPrompt: messages.at(-1).content },
    step: { id: 'legacy-main-step', kind: 'chat' },
    messages, toolSpecs: [], fallbackToolSpecs: [], contextWindow: 8192,
    intentMode: 'answer', maxIters: 2, enableToolHooks: false,
  }
  let currentFormat
  const initialRequests = []
  await assert.rejects(() => runToolLoop({
    ...options, semanticSummary,
    saveCheckpoint: async (state) => { currentFormat = structuredClone(state); return true },
    runModel: async (request) => {
      initialRequests.push(request)
      if (request.requestPurpose === 'context_summary') return summaryResponse(request)
      throw Object.assign(new Error('Synthetic unknown main outcome'), {
        code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', retryable: false, unsafeToReplay: true,
      })
    },
  }), (error) => error.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN')
  assert.equal(currentFormat.modelInvocation.status, 'in_flight')
  assert.equal(currentFormat.compactionCheckpoint.recipes[0].meta.compacted, long)
  const legacy = structuredClone(currentFormat)
  delete legacy.compactionCheckpoint
  return { options, currentFormat, legacy, initialRequests }
}

function materialize(checkpoint, status) {
  checkpoint.modelInvocation.status = status
  checkpoint.modelInvocation.reconciliation = { contractVersion: 1, source: 'manual', outcome: status, reconciledAt: 1 }
  if (status === 'completed') {
    checkpoint.modelInvocation.usageApplied = false
    checkpoint.modelInvocation.response = structuredClone(recoveredResponse)
  }
}

function resume(f, { checkpoint = f.legacy, writes = [], requests = [], ...overrides } = {}) {
  return runToolLoop({
    ...f.options, semanticSummary: autoPolicy,
    loadCheckpoint: async () => structuredClone(checkpoint),
    saveCheckpoint: async (state) => { writes.push(structuredClone(state)); return true },
    runModel: async (request) => {
      requests.push({ ...request, messages: structuredClone(request.messages), tools: structuredClone(request.tools) })
      return request.requestPurpose === 'context_summary' ? summaryResponse(request) : { content: `Fresh main answer: ${MARKER}`, toolCalls: [] }
    },
    ...overrides,
  })
}

for (const long of [false, true]) {
  test(`legacy ${long ? 'long' : 'short'} unknown main stays recoverable without creating an unknown summary slot`, async () => {
    const f = await fixture({ long })
    const writes = []
    let calls = 0
    await assert.rejects(() => resume(f, {
      writes, semanticSummary: { mode: 'auto', timeoutMs: 25 },
      runModel: async () => { calls += 1; return new Promise(() => {}) },
    }), (error) => error.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN' && error.modelRequestId === f.legacy.modelInvocation.id)
    assert.equal(calls, 0, 'recovery must not start another model request before reconciling the main request')
    const persisted = writes.at(-1) || f.legacy
    assert.deepEqual(persisted.modelInvocation, f.legacy.modelInvocation)
    assert.equal(persisted.compactionCheckpoint?.modelInvocation ?? null, null)
    assert.equal(selectModelRequestRecoverySlot(persisted).slot, 'main')
    await assert.rejects(() => resume(f, {
      checkpoint: persisted, semanticSummary: { mode: 'auto', timeoutMs: 25 },
      runModel: async () => { calls += 1; assert.fail('unknown main must remain fenced on a second resume') },
    }), (error) => error.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN')
    assert.equal(calls, 0)
  })

  test(`legacy ${long ? 'long' : 'short'} completed main is replayed and its manual usage is applied exactly once`, async () => {
    const f = await fixture({ long })
    materialize(f.legacy, 'completed')
    const original = structuredClone(f.legacy)
    const requests = []
    const writes = []
    const result = await resume(f, { requests, writes })
    assert.equal(result.text, recoveredResponse.content)
    assert.equal(requests.length, 0)
    const accounted = writes.find((state) => state.modelInvocation?.usageApplied === true)
    assert.ok(accounted)
    assert.equal(accounted.modelInvocation.id, original.modelInvocation.id)
    assert.equal(accounted.budget.modelTokens, original.budget.modelTokens + 10)
    assert.equal(accounted.budget.modelCalls, original.budget.modelCalls + (original.modelInvocation.callBudgetApplied === true ? 0 : 1))
    const secondWrites = []
    assert.equal((await resume(f, { checkpoint: accounted, requests, writes: secondWrites })).text, recoveredResponse.content)
    assert.equal(requests.length, 0, 'replaying the accounted checkpoint cannot send the paid request again')
    assert.equal(secondWrites.at(-1).budget.modelTokens, accounted.budget.modelTokens)
    assert.equal(secondWrites.at(-1).budget.modelCalls, accounted.budget.modelCalls)
    assert.deepEqual(f.legacy, original)
  })

  test(`legacy ${long ? 'long' : 'short'} not-sent main sends only its verified original request`, async () => {
    const f = await fixture({ long })
    materialize(f.legacy, 'not_sent')
    const requests = []
    const result = await resume(f, { requests })
    assert.equal(result.text, `Fresh main answer: ${MARKER}`)
    assert.equal(requests.length, 1)
    assert.notEqual(requests[0].requestPurpose, 'context_summary')
    assert.notEqual(requests[0].modelRequestId, f.legacy.modelInvocation.id)
    assert.equal(fingerprintModelRequest(requests[0], {
      jobId: f.options.job.id, stepId: f.options.step.id, iteration: f.legacy.modelInvocation.iteration,
    }), f.legacy.modelInvocation.fingerprint)
  })
}

for (const status of ['in_flight', 'completed', 'not_sent']) {
  test(`an unreconstructible legacy ${status} request fails closed before any semantic or main RPC`, async () => {
    const f = await fixture({ semanticSummary: autoPolicy })
    assert.ok(f.initialRequests.some((request) => request.requestPurpose === 'context_summary'))
    if (status !== 'in_flight') materialize(f.legacy, status)
    const requests = []
    const writes = []
    await assert.rejects(() => resume(f, { requests, writes }), (error) => error.code === 'MODEL_REQUEST_CONTEXT_DRIFT')
    assert.equal(requests.length, 0)
    const persisted = writes.at(-1) || f.legacy
    assert.deepEqual(persisted.modelInvocation, f.legacy.modelInvocation)
    assert.equal(selectModelRequestRecoverySlot(persisted, { includeMaterialized: true }).slot, 'main')
  })
}

test('a current-format checkpoint missing its main recipe cannot launch fresh summaries', async () => {
  const f = await fixture({ semanticSummary: autoPolicy })
  const checkpoint = structuredClone(f.currentFormat)
  checkpoint.compactionCheckpoint.recipes = []
  const requests = []
  const writes = []
  await assert.rejects(() => resume(f, { checkpoint, requests, writes }), (error) => error.code === 'MODEL_REQUEST_CONTEXT_DRIFT')
  assert.equal(requests.length, 0)
  assert.deepEqual((writes.at(-1) || checkpoint).modelInvocation, checkpoint.modelInvocation)
})

test('legacy main reconciliation runs against the original fingerprint before any new model request', async () => {
  const f = await fixture()
  const requests = []
  let reconciliations = 0
  const result = await resume(f, {
    requests,
    reconcileModelRequest: async (invocation) => {
      reconciliations += 1
      assert.equal(invocation.fingerprint, f.legacy.modelInvocation.fingerprint)
      assert.equal(requests.length, 0)
      return { contractVersion: 1, source: 'manual', outcome: 'completed', response: recoveredResponse, reconciledAt: 1 }
    },
  })
  assert.equal(result.text, recoveredResponse.content)
  assert.equal(reconciliations, 1)
  assert.equal(requests.length, 0)
})

test('compaction drift distinguishes failed and consumed requests from unconsumed completed or unknown main slots', async () => {
  const f = await fixture({ long: false })
  const input = { messages: [{ role: 'user', content: 'Changed request' }], tools: [], contextWindow: 8192, semanticSummary: autoPolicy }
  for (const [status, older, usageApplied, canReset] of [
    ['failed', false, true, true],
    ['completed', true, true, true],
    ['completed', false, true, false],
    ['completed', false, false, false],
    ['completed', true, false, false],
    ['in_flight', false, false, false],
    ['in_flight', true, false, false],
  ]) {
    const invocation = { ...f.currentFormat.modelInvocation, status, usageApplied }
    const state = {
      job: f.options.job, step: f.options.step, iter: invocation.iteration + (older ? 1 : 0),
      modelInvocation: invocation, restoredModelInvocation: invocation,
      compactionCheckpoint: restoreCompactionCheckpoint(f.currentFormat.compactionCheckpoint),
    }
    const checkpoint = createCompactionRecoveryCheckpoint(state)
    if (canReset) {
      assert.equal(checkpoint.begin(input), 0)
      assert.equal(state.compactionCheckpoint.recipes.length, 0)
    } else {
      assert.throws(() => checkpoint.begin(input), (error) => error.code === 'MODEL_REQUEST_CONTEXT_DRIFT')
      assert.equal(state.modelInvocation, invocation)
      assert.equal(state.restoredModelInvocation, invocation)
    }
  }
})

test('the summary RPC fence retains an unknown main slot even when no restored recipe is involved', async () => {
  const f = await fixture({ long: false })
  const state = { modelInvocation: f.legacy.modelInvocation }
  assert.throws(() => assertMainRequestSettled(state), (error) => error.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
    && error.modelRequestId === f.legacy.modelInvocation.id && error.unsafeToReplay === true)
  assert.throws(() => createCompactionRecoveryCheckpoint(state).begin({}), (error) => error.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN')
  assert.equal(state.modelInvocation, f.legacy.modelInvocation)
})
