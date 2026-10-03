import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelProgressHarness, PROGRESS_TOOL_CALL_ID } from './helpers/modelProgressHarness.js'

test('real CLI disposes terminal and DONE response bodies even when the provider keeps sending trailing keepalives', { timeout: 45_000 }, async (t) => {
  const harness = await createModelProgressHarness(t, 'done_open')
  const run = await harness.run()
  const diagnosis = JSON.stringify({ status: run.status, timedOut: run.timedOut, stderr: run.stderr,
    failures: harness.provider.failures, terminalBodies: harness.provider.terminalBodies,
    events: run.events.map((event) => ({ type: event.type, phase: event.payload?.phase, code: event.payload?.code })) })
  assert.equal(run.status, 0, diagnosis)
  assert.equal(run.timedOut, false, diagnosis)
  assert.deepEqual(harness.provider.failures, [], diagnosis)
  assert.equal(harness.provider.mainRequests, 2, diagnosis)
  assert.equal(harness.provider.terminalBodies.length, 2, diagnosis)
  for (const body of harness.provider.terminalBodies) {
    assert.equal(body.forcedClose, false, 'the model client must close each body, not wait for the fixture safety guard')
    assert.ok(body.closedAt >= body.terminalAt, diagnosis)
    assert.ok(body.closedAt - body.terminalAt < 3000, diagnosis)
  }
  assert.equal(run.events.filter((event) => event.type === 'tool.completed'
    && event.payload.toolCallId === PROGRESS_TOOL_CALL_ID).length, 1, diagnosis)
  const completed = run.events.filter((event) => event.type === 'turn.completed')
  assert.equal(completed.length, 1, diagnosis)
  assert.equal(run.events.some((event) => ['turn.interrupted', 'turn.failed', 'turn.blocked'].includes(event.type)), false, diagnosis)
  assert.equal(harness.snapshot().events.filter((event) => event.type === 'turn.completed').length, 1)
  t.diagnostic(`both open SSE bodies were client-disposed after terminal in ${harness.provider.terminalBodies.map((body) => body.closedAt - body.terminalAt).join('/')}ms; one real read and one durable completion`)
})
