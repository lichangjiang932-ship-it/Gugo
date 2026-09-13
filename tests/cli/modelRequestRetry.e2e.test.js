import '../../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelRequestRetryHarness, retryDiagnosis, RETRY_FINAL_TEXT, RETRY_OUTPUT_TEXT,
  RETRY_PARTIAL_ID, RETRY_WRITE_ID, RETRY_IDLE_MS } from './helpers/modelRequestRetryHarness.js'

function assertCompletedOnce(run, harness) {
  const diagnosis = retryDiagnosis(run, harness)
  assert.equal(run.timedOut, false, diagnosis)
  assert.equal(run.status, 0, diagnosis)
  assert.deepEqual(harness.provider.failures, [], diagnosis)
  const completed = run.events.filter((event) => event.type === 'turn.completed')
  assert.equal(completed.length, 1, diagnosis)
  assert.ok(completed[0].payload.text.includes(RETRY_FINAL_TEXT), diagnosis)
  assert.equal(run.events.some((event) => ['turn.failed', 'turn.blocked', 'turn.cancelled', 'turn.interrupted'].includes(event.type)), false, diagnosis)
  const tools = run.events.filter((event) => event.type === 'tool.completed')
  assert.equal(tools.filter((event) => event.payload.toolCallId === RETRY_WRITE_ID).length, 1, diagnosis)
  assert.equal(tools.filter((event) => event.payload.name === 'write_file').length, 1, diagnosis)
  assert.ok(tools.some((event) => event.payload.name === 'read_file' && event.payload.result.ok === true
    && event.payload.result.content === RETRY_OUTPUT_TEXT), diagnosis)
  assert.equal(tools.some((event) => event.payload.toolCallId === RETRY_PARTIAL_ID), false, diagnosis)
  assert.equal(harness.output(), RETRY_OUTPUT_TEXT)
  assert.equal(harness.partialExists(), false)
  const durable = harness.snapshot()
  assert.equal(durable.events.filter((event) => event.type === 'turn.completed').length, 1)
  assert.equal(durable.effects.filter((entry) => entry.tool_name === 'write_file').length, 1)
  assert.equal(durable.effects.find((entry) => entry.tool_name === 'write_file').status, 'committed')
  assert.ok(durable.events.every((event) => event.turnId === completed[0].turnId && event.sessionId === completed[0].sessionId))
}

test('real CLI retry fixture healthy control completes through genuine file execution and readback', { timeout: 90_000 }, async (t) => {
  const harness = await createModelRequestRetryHarness(t, 'healthy')
  const run = await harness.run()
  assertCompletedOnce(run, harness)
})

test('real CLI recovers an explicit HTTP 429 rejection and completes a real write/read task once', { timeout: 90_000 }, async (t) => {
  const harness = await createModelRequestRetryHarness(t, 'http_429')
  const run = await harness.run()
  assertCompletedOnce(run, harness)
  assert.ok(harness.provider.mainRequests.length >= 3)
})

test('real CLI keeps one growing argument request alive across the old idle deadline then completes its task', { timeout: 90_000 }, async (t) => {
  const harness = await createModelRequestRetryHarness(t, 'grace')
  const run = await harness.run()
  assertCompletedOnce(run, harness)
  const grace = harness.provider.grace
  assert.ok(grace.terminalAt - grace.chunks.at(-1) > RETRY_IDLE_MS)
  assert.ok(grace.terminalAt - grace.chunks.at(-1) < RETRY_IDLE_MS * 3)
  assert.equal(grace.beforeTerminal.events.some((event) => ['tool.started', 'tool.completed'].includes(event.type)), false)
  assert.equal(harness.provider.mainRequests.filter(({ body }) => !body.messages.some((message) => message.role === 'tool')).length, 1,
    'the paused inference is not a second physical request')
})

for (const scenario of ['http_408', 'http_503', 'partial_rst', 'partial_idle', 'malformed_stream']) {
  test(`real CLI preserves uncertainty after ${scenario} with one physical request and no partial tool execution`, { timeout: 90_000 }, async (t) => {
    const harness = await createModelRequestRetryHarness(t, scenario)
    const run = await harness.run()
    const durable = harness.snapshot()
    const diagnosis = retryDiagnosis(run, harness) + '\ncheckpoint model status: ' + durable.checkpoint?.modelInvocation?.status
    assert.equal(run.timedOut, false, diagnosis)
    assert.equal(run.status, 1, diagnosis)
    assert.deepEqual(harness.provider.failures, [], diagnosis)
    assert.equal(harness.provider.mainRequests.length, 1, diagnosis)
    assert.equal(durable.checkpoint.modelInvocation.status, 'in_flight', diagnosis)
    const blocked = run.events.find((event) => event.type === 'turn.blocked')
    assert.equal(blocked?.payload.code, 'MODEL_REQUEST_OUTCOME_UNKNOWN', diagnosis)
    assert.equal(blocked.payload.requiresUserVerification, true)
    assert.equal(run.events.some((event) => ['turn.completed', 'turn.failed', 'tool.started', 'tool.completed'].includes(event.type)), false, diagnosis)
    assert.equal(harness.output(), null)
    assert.equal(harness.partialExists(), false)
    assert.equal(durable.checkpoint.modelInvocation.providerAttempts.length, 1)
    assert.equal(durable.events.filter((event) => event.type === 'turn.blocked').length, 1)
    if (harness.provider.faults.length) {
      const fault = harness.provider.faults[0]
      assert.equal(fault.partialFileExists, false)
      assert.ok(fault.closedAt && fault.closedAt <= run.closedAt)
    }
  })
}

test('real CLI controlled SIGINT cancels an active partial stream without retrying or executing its tool', { timeout: 90_000 }, async (t) => {
  const harness = await createModelRequestRetryHarness(t, 'cancel', { idleMs: 10000 })
  const run = await harness.run({ cancelOnPartial: true })
  const diagnosis = retryDiagnosis(run, harness)
  assert.equal(run.timedOut, false, diagnosis)
  assert.equal(run.status, 130, diagnosis)
  assert.equal(harness.provider.mainRequests.length, 1)
  assert.equal(run.events.filter((event) => event.type === 'turn.cancelled').length, 1, diagnosis)
  assert.equal(run.events.some((event) => ['turn.completed', 'tool.started', 'tool.completed'].includes(event.type)), false)
  assert.ok(Number.isFinite(harness.provider.faults[0].closedAt) && harness.provider.faults[0].closedAt <= run.closedAt)
  assert.equal(harness.output(), null)
  assert.equal(harness.partialExists(), false)
  const durable = harness.snapshot()
  assert.equal(durable.events.filter((event) => event.type === 'turn.cancelled').length, 1)
  assert.equal(durable.checkpoint.modelInvocation.status, 'in_flight', 'cancelling the task does not fabricate a known upstream outcome')
  assert.equal(durable.checkpoint.modelInvocation.providerAttempts.length, 1)
  assert.equal(durable.checkpoint.modelInvocation.response == null, true)
})
