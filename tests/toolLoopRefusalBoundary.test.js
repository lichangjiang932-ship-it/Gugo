import assert from 'node:assert/strict'
import test from 'node:test'
import { runToolLoop } from '../server/services/loop/index.js'

const spec = { type: 'function', function: { name: 'echo_tool', description: 'Isolated approval fixture.',
  parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } } }
const calls = [1, 2, 3].map((number) => ({ id: `call-${number}`, type: 'function',
  function: { name: 'echo_tool', arguments: JSON.stringify({ note: `fixture-${number}` }) } }))

async function fixture({ decision, resultForTool = null, restored = null, interruptAfterDenial = false, answerOnly = false }) {
  let modelCalls = 0
  let approvalRequests = 0
  const executions = []
  const completed = []
  const checkpoints = []
  let failure
  let result
  try {
    result = await runToolLoop({ job: { id: 'refusal-fixture', userId: 'refusal-user', origin: 'chat',
      prompt: 'Use echo_tool for three fixture notes.' }, step: { id: 'refusal-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Use echo_tool for three fixture notes.' }], toolSpecs: [spec],
    maxIters: 4, enableToolHooks: false,
    requestToolApproval: async ({ args }) => {
      approvalRequests += 1
      return approvalRequests === 1 || !decision ? { proceed: true, args, approvalId: 'fixture-approval' } : decision
    },
    onToolCompleted: async (outcome) => completed.push(outcome),
    loadCheckpoint: async () => restored,
    saveCheckpoint: async (value) => {
      const snapshot = structuredClone(value?.state || value)
      checkpoints.push(snapshot)
      if (interruptAfterDenial && snapshot.toolCalls?.some((call) => call.checkpointResult?.deniedByUser)) {
        throw new Error('Isolated interruption after durable refusal')
      }
    },
    runModel: async () => ++modelCalls === 1 && !answerOnly ? { content: '', toolCalls: calls }
      : { content: 'This must not be used to wrap up a refusal.', toolCalls: [] },
    executeTool: async ({ args }) => {
      executions.push(args.note)
      return resultForTool?.(executions.length) || { ok: true, receipt: args.note }
    },
    })
  } catch (error) {
    failure = error
  }
  return { result, failure, modelCalls, approvalRequests, executions, completed, checkpoints }
}

// Claude Code behaviour: a refusal the user made, or a permission rule made, is
// handed back to the model as the call's tool result and the turn continues.
// What stays fixed is the safety half — nothing refused runs, and the user is
// not asked again about calls planned before their answer.
for (const [name, decision, code] of [
  ['human refusal', { proceed: false, deniedByUser: true, reason: 'The user declined.' }, 'approval_denied'],
  ['policy refusal', { proceed: false, policyDenied: true, permissionMode: 'normal' }, 'policy_denied_permission_mode'],
]) {
  test(`${name} goes back to the model as a tool result, and the refused call never runs`, async () => {
    const outcome = await fixture({ decision })
    assert.ifError(outcome.failure)
    assert.equal(outcome.modelCalls, 2, 'the model gets a round to work around the refusal')
    assert.deepEqual(outcome.executions, ['fixture-1'])
    assert.notEqual(outcome.result.incomplete, true)
    assert.equal(outcome.result.noProgress, undefined, 'refusal is not a progress-convergence failure')
    assert.equal(outcome.completed[1].result.code, code)
    assert.equal(outcome.completed[1].result.executed === true, false)
    assert.ok(outcome.checkpoints.some((checkpoint) => checkpoint.toolCalls?.some((call) =>
      call.id === 'call-1' && call.checkpointResult?.receipt === 'fixture-1')))
  })
}

test('after a human refusal the rest of the batch is skipped, not re-asked', async () => {
  const outcome = await fixture({ decision: { proceed: false, deniedByUser: true, reason: 'The user declined.' } })
  assert.equal(outcome.approvalRequests, 2, 'call-3 was never put to the user')
  assert.equal(outcome.completed.length, 3, 'skipped proposals need observable completed outcomes')
  assert.equal(outcome.completed[2].result.code, 'tool_execution_skipped')
  assert.equal(outcome.completed[2].result.executed, false)
  assert.match(outcome.completed[2].result.error, /declined an earlier call|拒绝了本批中较早/)
})

test('a policy refusal checks each later call on its own instead of skipping the batch', async () => {
  const outcome = await fixture({ decision: { proceed: false, policyDenied: true, permissionMode: 'normal' } })
  assert.equal(outcome.approvalRequests, 3)
  assert.deepEqual(outcome.completed.map((entry) => entry.result.code ?? 'ok'),
    ['ok', 'policy_denied_permission_mode', 'policy_denied_permission_mode'])
})

test('a model that keeps proposing what the user keeps refusing stops after two refused rounds', async () => {
  let modelCalls = 0
  let approvals = 0
  const executions = []
  const result = await runToolLoop({ job: { id: 'refusal-repeat', userId: 'refusal-user', origin: 'chat',
    prompt: 'Use echo_tool.' }, step: { id: 'refusal-repeat-step', kind: 'chat' },
  messages: [{ role: 'user', content: 'Use echo_tool.' }], toolSpecs: [spec], maxIters: 10, enableToolHooks: false,
  requestToolApproval: async () => { approvals += 1; return { proceed: false, deniedByUser: true } },
  runModel: async () => { modelCalls += 1
    return { content: '', toolCalls: [{ id: `again-${modelCalls}`, type: 'function',
      function: { name: 'echo_tool', arguments: JSON.stringify({ note: `try-${modelCalls}` }) } }] } },
  executeTool: async ({ args }) => { executions.push(args.note); return { ok: true } },
  })
  assert.deepEqual(executions, [])
  assert.equal(approvals, 2)
  assert.equal(modelCalls, 2, 'no wrap-up model request after the last refusal')
  assert.equal(result.incomplete, true)
  assert.equal(result.code, 'approval_denied')
})

// Nobody decided these: the user was away or the authorization system failed.
// Continuing would only ask again into the void, so they still end the turn.
for (const [name, decision, code] of [
  ['missing per-call approval', { proceed: false, approvalRequired: true }, 'approval_required'],
  ['approval expiry', { proceed: false, expired: true, reason: 'Approval expired.' }, 'approval_expired'],
  ['non-retryable authorization failure', { proceed: false, systemFailure: true, retryable: false,
    code: 'approval_user_identity_missing', reason: 'The authorization identity is unavailable.' }, 'approval_user_identity_missing'],
]) {
  test(`${name} stops remaining tools and model wrap-up while retaining confirmed progress`, async () => {
    const outcome = await fixture({ decision })
    assert.ifError(outcome.failure)
    assert.equal(outcome.modelCalls, 1)
    assert.equal(outcome.approvalRequests, 2)
    assert.deepEqual(outcome.executions, ['fixture-1'])
    assert.equal(outcome.result.incomplete, true)
    assert.equal(outcome.result.code, code)
    assert.equal(outcome.result.noProgress, undefined, 'refusal is not a progress-convergence failure')
    assert.equal(outcome.completed.length, 3, 'skipped proposals need observable completed outcomes')
    assert.equal(outcome.completed[2].result.code, 'tool_execution_skipped')
    assert.equal(outcome.completed[2].result.executed, false)
    assert.ok(outcome.checkpoints.some((checkpoint) => checkpoint.toolCalls?.some((call) =>
      call.id === 'call-1' && call.checkpointResult?.receipt === 'fixture-1')))
  })
}

test('approval cancellation cannot start another tool or a wrap-up model', async () => {
  const outcome = await fixture({ decision: { proceed: false, cancelled: true, reason: 'Cancelled by the owner.' } })
  assert.equal(outcome.modelCalls, 1)
  assert.equal(outcome.approvalRequests, 2)
  assert.deepEqual(outcome.executions, ['fixture-1'])
  assert.equal(outcome.failure?.name, 'AbortError')
})

test('an outcome requiring verification stops instead of performing more tools or model requests', async () => {
  const outcome = await fixture({ resultForTool: (attempt) => attempt === 1 ? {
    ok: false, code: 'SIDE_EFFECT_OUTCOME_UNKNOWN', requiresUserVerification: true,
    error: 'Verify the previous effect before continuing.', retryable: false,
  } : null })
  assert.equal(outcome.modelCalls, 1)
  assert.equal(outcome.approvalRequests, 1)
  assert.deepEqual(outcome.executions, ['fixture-1'])
  assert.equal(outcome.failure?.code, 'SIDE_EFFECT_OUTCOME_UNKNOWN')
  assert.equal(outcome.failure?.unsafeToReplay, true)
})

test('a checkpoint captured just after refusal does not reopen the remaining tools on resume', async () => {
  const interrupted = await fixture({ decision: { proceed: false, deniedByUser: true }, interruptAfterDenial: true })
  assert.ok(interrupted.failure)
  const checkpoint = interrupted.checkpoints.at(-1)
  assert.ok(checkpoint.toolCalls.some((call) => call.checkpointStatus !== 'completed'))
  const resumed = await fixture({ restored: checkpoint, answerOnly: true })
  assert.ifError(resumed.failure)
  // Nothing from the refused batch is asked again or run on resume; the model
  // then reads the refusal, exactly as it would have without the interruption.
  assert.equal(resumed.approvalRequests, 0)
  assert.deepEqual(resumed.executions, [])
  assert.equal(resumed.completed.at(-1).result.code, 'tool_execution_skipped')
  assert.equal(resumed.modelCalls, 1)
})

test('an unresolved outcome remains blocked when its completed batch checkpoint is resumed', async () => {
  const blocked = await fixture({ resultForTool: () => ({ ok: false, code: 'SIDE_EFFECT_OUTCOME_UNKNOWN',
    requiresUserVerification: true, error: 'Needs independent verification.', retryable: false }) })
  const resumed = await fixture({ restored: blocked.checkpoints.at(-1) })
  assert.equal(resumed.failure?.code, 'SIDE_EFFECT_OUTCOME_UNKNOWN')
  assert.equal(resumed.modelCalls, 0)
  assert.equal(resumed.approvalRequests, 0)
  assert.deepEqual(resumed.executions, [])
})

test('a successful-looking tool response cannot override its explicit unknown-outcome flag', async () => {
  const outcome = await fixture({ resultForTool: () => ({ ok: true, requiresUserVerification: true,
    receipt: 'not-yet-verified', error: 'The receipt has not been confirmed.' }) })
  assert.equal(outcome.failure?.code, 'SIDE_EFFECT_OUTCOME_UNKNOWN')
  assert.equal(outcome.modelCalls, 1)
  assert.deepEqual(outcome.executions, ['fixture-1'])
  assert.equal(outcome.completed[0].result.ok, false)
})

test('an unavailable verification toolchain is not an authorization refusal and can choose another check', async () => {
  const outcome = await fixture({ resultForTool: (attempt) => attempt === 1 ? {
    ok: false, code: 'VERIFICATION_TOOLCHAIN_UNAVAILABLE', systemFailure: true, failureKind: 'infrastructure',
    error: 'The optional lint script is not configured.', retryable: false,
  } : null })
  assert.ifError(outcome.failure)
  assert.equal(outcome.modelCalls, 2)
  assert.equal(outcome.executions.length, 3)
  assert.notEqual(outcome.result.reason, 'tool_authorization_unavailable')
})
