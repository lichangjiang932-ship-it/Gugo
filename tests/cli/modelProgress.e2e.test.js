import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createModelProgressHarness, MODEL_PROGRESS_TIMEOUT_MS, PROGRESS_SOURCE_TEXT, PROGRESS_TOOL_CALL_ID,
} from './helpers/modelProgressHarness.js'

function diagnosis(run, provider) {
  return JSON.stringify({ status: run.status, signal: run.signal, timedOut: run.timedOut, stderr: run.stderr,
    events: run.events.map((event) => ({ type: event.type, phase: event.payload?.phase, code: event.payload?.code })),
    mainRequests: provider.mainRequests, failures: provider.failures })
}

test('real CLI durably exposes partial argument progress and executes one read only after the streamed batch finishes', { timeout: 45_000 }, async (t) => {
  const harness = await createModelProgressHarness(t, 'arguments')
  const run = await harness.run()
  const message = diagnosis(run, harness.provider)
  assert.equal(run.timedOut, false, message)
  assert.equal(run.status, 0, message)
  assert.deepEqual(harness.provider.failures, [], message)
  assert.equal(harness.provider.mainRequests, 2, message)
  assert.equal(run.argv.includes('--resume'), false)
  const elapsed = harness.provider.terminalSentAt - harness.provider.sentChunks[0].sentAt
  assert.ok(elapsed > MODEL_PROGRESS_TIMEOUT_MS, `the fixture must outlive the idle deadline (${elapsed}ms)`)
  const phases = run.events.filter((event) => event.type === 'model.phase' && event.payload.phase === 'tool_arguments')
  assert.ok(phases.length >= 3, message)
  assert.ok(phases.every((event) => event.payload.toolName === 'read_file' && event.payload.toolCallId === PROGRESS_TOOL_CALL_ID))
  assert.ok(phases[0].payload.toolArgumentsChars < harness.provider.sentChunks.at(-1).chars)
  assert.ok(phases.every((event) => Number.isSafeInteger(event.payload.elapsedMs) && event.payload.idleMs === 0))
  assert.equal(JSON.stringify(phases).includes('progress-source.txt'), false, 'partial arguments are not progress payloads')
  const beforeTerminal = harness.provider.beforeTerminal.events
  assert.ok(beforeTerminal.some((event) => event.type === 'model.phase' && event.payload.phase === 'tool_arguments'))
  assert.equal(beforeTerminal.some((event) => ['tool.call', 'tool.started', 'tool.completed'].includes(event.type)), false,
    'even valid-looking arguments cannot execute before the provider terminal')
  assert.equal(run.events.filter((event) => event.type === 'tool.started' && event.payload.toolCallId === PROGRESS_TOOL_CALL_ID).length, 1)
  const completedTools = run.events.filter((event) => event.type === 'tool.completed' && event.payload.toolCallId === PROGRESS_TOOL_CALL_ID)
  assert.equal(completedTools.length, 1, message)
  assert.equal(completedTools[0].payload.result.ok, true, message)
  assert.ok(JSON.stringify(completedTools[0].payload.result).includes(PROGRESS_SOURCE_TEXT), message)
  const successes = run.events.filter((event) => event.type === 'turn.completed')
  assert.equal(successes.length, 1, message)
  assert.equal(run.events.some((event) => ['turn.failed', 'turn.blocked', 'turn.resumed', 'approval.required'].includes(event.type)), false, message)
  assert.ok(successes[0].sequence > completedTools[0].sequence)
  const durable = harness.snapshot().events
  assert.ok(durable.every((event) => event.turnId === successes[0].turnId && event.sessionId === successes[0].sessionId))
  assert.deepEqual(durable.filter((event) => event.type === 'model.phase' && event.payload.phase === 'tool_arguments')
    .map((event) => event.payload), phases.map((event) => event.payload))
  t.diagnostic(`real SSE arguments lasted ${elapsed}ms across a ${MODEL_PROGRESS_TIMEOUT_MS}ms idle deadline; ${phases.length} durable progress events, one real read, one successful turn`)
})

test('real CLI exits a keepalive-only model stream with durable UNKNOWN and no blind replay or false completion', { timeout: 45_000 }, async (t) => {
  const harness = await createModelProgressHarness(t, 'keepalive')
  const run = await harness.run()
  const message = diagnosis(run, harness.provider)
  assert.equal(run.timedOut, false, message)
  assert.equal(run.status, 1, message)
  assert.deepEqual(harness.provider.failures, [], message)
  assert.equal(harness.provider.requests.length, 1, message)
  assert.ok(harness.provider.keepalives >= 5, message)
  assert.ok(run.closedAt - harness.provider.requests[0].receivedAt < 15_000, message)
  const blocked = run.events.find((event) => event.type === 'turn.blocked')
  assert.equal(blocked?.payload.code, 'MODEL_REQUEST_OUTCOME_UNKNOWN', message)
  assert.equal(blocked?.payload.requiresUserVerification, true, message)
  assert.equal(blocked?.payload.recoveryKind, 'model_request_outcome_unknown', message)
  assert.equal(run.events.some((event) => ['turn.completed', 'turn.resumed', 'tool.call', 'tool.started', 'tool.completed'].includes(event.type)), false, message)
  assert.equal(run.events.some((event) => event.type === 'model.phase' && ['tool_arguments', 'streaming'].includes(event.payload.phase)), false, message)
  const durable = harness.snapshot()
  assert.equal(durable.events.filter((event) => event.type === 'turn.blocked' && event.payload.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN').length, 1)
  assert.equal(durable.events.some((event) => event.type === 'turn.completed'), false)
  assert.equal(durable.checkpoint.modelInvocation.status, 'in_flight')
  assert.equal(durable.checkpoint.modelInvocation.providerAttempts.length, 1)
  t.diagnostic(`real SSE sent ${harness.provider.keepalives} keepalives; CLI exited after ${run.closedAt - harness.provider.requests[0].receivedAt}ms with one unreplayed UNKNOWN request`)
})
