import assert from 'node:assert/strict'
import test from 'node:test'

import { createToolLoop, runToolLoop } from '../server/services/loop/index.js'
import { trustedInternalLoopPrincipal } from '../server/services/loop/internalExecutionPrincipal.js'
import { processModelResult } from '../server/services/loop/runtime-processModelResult.js'
import { SERVER_TOOL_SPECS } from '../server/services/toolLoopRuntime.js'
import {
  attachJobBudget,
  releaseJobBudget,
} from '../server/utils/jobBudget.js'

const ECHO_TOOL_SPEC = {
  type: 'function',
  function: {
    name: 'echo_tool',
    description: 'Echo a short value.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
}

test('a stale final-answer evidence review exits with a stable code and no server-localized text', async () => {
  let incompleteInput = null
  const state = {
    iteration: {
      modelResult: { content: 'Unsupported completion claim.', toolCalls: [] },
      finalAnswerEvidenceReviewDigest: 'stale-evidence-digest',
      steeringLeaseId: null,
    },
    d: {
      ARTIFACT_RECOVERY_PHASE_DIAGNOSE: 'diagnose',
      DIRECTORY_AUTHORIZATION_WAIT_CLAIM: /never-match/u,
    },
    modelInvocation: { id: 'model-call' },
    restoredModelInvocation: { id: 'restored-model-call' },
    hasVerifiedDirectoryResolution: false,
    hasRequiredArtifacts: () => true,
    hasRequiredExecutionEvidence: () => true,
    hasPendingMutationVerification: () => false,
    validateLocalHtmlDeliveries: async () => null,
    requiresPdfLayoutVerification: false,
    needsDeliverableSelection: () => false,
    requiresFinalAnswerEvidenceReview: () => true,
    hasCurrentFinalAnswerEvidenceReview: () => false,
    prepareFinalAnswerEvidenceReview: () => false,
    finishIncomplete: async (input) => {
      incompleteInput = input
      return { incomplete: true, reason: input.reason, text: input.text }
    },
  }

  const result = await processModelResult(state)

  assert.deepEqual(incompleteInput, {
    text: '',
    reason: 'final_answer_evidence_review_missing',
    steeringLeaseId: null,
  })
  assert.deepEqual(result, {
    kind: 'return',
    value: {
      incomplete: true,
      reason: 'final_answer_evidence_review_missing',
      text: '',
    },
  })
})

function baseOptions(overrides = {}) {
  return {
    job: { id: 'loop-index-test', userId: 'loop-runtime-test-user', origin: 'chat', prompt: 'Use echo_tool, then answer.' },
    step: { id: 'loop-index-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Use echo_tool, then answer.' }],
    toolSpecs: [ECHO_TOOL_SPEC],
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({
      proceed: true,
      args,
      approvalId: 'loop-runtime-approved',
    }),
    maxIters: 3,
    ...overrides,
  }
}

test('a historical directory resolution marker cannot suppress authorization after grant revocation', async () => {
  const requestDirectorySpec = SERVER_TOOL_SPECS.find((spec) => (
    spec?.function?.name === 'request_directory'
  ))
  let executionCalls = 0
  const result = await runToolLoop(baseOptions({
    messages: [
      {
        role: 'system',
        content: '[JOB_DIRECTORY_RESOLUTION:revoked-event] The requested local directory authorization is already persisted and verified.',
      },
      { role: 'user', content: 'Continue writing the requested output.' },
    ],
    toolSpecs: [requestDirectorySpec],
    maxIters: 1,
    runModel: async () => ({
      content: '',
      toolCalls: [{
        id: 'request-revoked-directory',
        type: 'function',
        function: {
          name: 'request_directory',
          arguments: JSON.stringify({
            purpose: 'Continue writing the requested output.',
            access_mode: 'read_write',
          }),
        },
      }],
    }),
    executeTool: async ({ name }) => {
      executionCalls += 1
      assert.equal(name, 'request_directory')
      return {
        ok: true,
        paused: true,
        clarification: {
          request_type: 'directory',
          access_mode: 'read_write',
          question: 'Choose the directory again.',
        },
      }
    },
  }))

  assert.equal(executionCalls, 1)
  assert.equal(result.paused, true)
  assert.equal(result.clarification?.request_type, 'directory')
})

test('chat loops ignore the shared id cache and restore budget only from their scoped checkpoint', async () => {
  const sharedTurnId = `loop-chat-budget-isolation-${Date.now()}`
  const legacyBudgetOwner = { id: sharedTurnId }
  const legacyCachedBudget = attachJobBudget(legacyBudgetOwner, {
    initialModelCalls: 40,
    maxModelCalls: 100,
  })
  const runScopedChat = async ({ userId, sessionId, restoredModelCalls }) => {
    let checkpoint = {
      messages: [{ role: 'user', content: 'Answer once.' }],
      toolCalls: [],
      artifactIds: [],
      iterations: 0,
      budget: {
        used: 0,
        maxTotalCalls: 80,
        elapsed: 0,
        maxWallMs: 60_000,
        modelMs: 0,
        modelCalls: restoredModelCalls,
        maxModelCalls: 100,
        modelTokens: 0,
        maxModelTokens: 0,
        costUsd: 0,
        // A pre-fix chat checkpoint could inherit the background Job cost
        // limit while carrying no trustworthy historical rate evidence.
        maxCostUsd: 1,
      },
    }
    const result = await runToolLoop(baseOptions({
      job: {
        id: sharedTurnId,
        userId,
        sessionId,
        origin: 'chat',
        prompt: 'Answer once.',
      },
      step: { id: sharedTurnId, kind: 'chat' },
      toolSpecs: [],
      loadCheckpoint: async () => ({ state: checkpoint }),
      saveCheckpoint: async (state) => {
        checkpoint = structuredClone(state)
        return { state: checkpoint }
      },
      runModel: async () => ({ content: 'done', toolCalls: [] }),
    }))
    return { result, checkpoint }
  }

  try {
    const [alice, bob] = await Promise.all([
      runScopedChat({ userId: 'budget-alice', sessionId: 'session-alice', restoredModelCalls: 2 }),
      runScopedChat({ userId: 'budget-bob', sessionId: 'session-bob', restoredModelCalls: 7 }),
    ])

    assert.equal(alice.result.text, 'done')
    assert.equal(bob.result.text, 'done')
    assert.equal(alice.checkpoint.budget.modelCalls, 3)
    assert.equal(bob.checkpoint.budget.modelCalls, 8)
    assert.equal(alice.checkpoint.budget.maxCostUsd, 0)
    assert.equal(bob.checkpoint.budget.maxCostUsd, 0)
    assert.equal(legacyCachedBudget.snapshot().modelCalls, 40)
  } finally {
    releaseJobBudget(legacyBudgetOwner, legacyCachedBudget)
  }
})

test('loop/index drives a complete extensible tool loop', async () => {
  const observed = []
  const requests = []
  let requestContext = null
  let modelCalls = 0
  const loop = createToolLoop(baseOptions({
    saveCheckpoint: async (_state, meta) => {
      observed.push(`checkpoint:${meta?.boundary}`)
      return true
    },
    runModel: async (request) => {
      requests.push(request)
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'echo-1',
            type: 'function',
            function: { name: 'echo_tool', arguments: '{"text":"before"}' },
          }],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
    executeTool: async ({ args }) => {
      observed.push(`execute:${args.text}`)
      return { ok: true, echoed: args.text }
    },
  }))

  loop.on('pre-step', (state, context) => {
    observed.push('pre-step')
    assert.equal(Object.isFrozen(state), true)
    assert.equal(Object.isFrozen(state.messages), true)
    assert.equal(Object.isFrozen(state.toolSpecs), true)
    assert.equal(Object.isFrozen(context), true)
    return {
      messages: [{ role: 'system', content: 'forged pre-step prompt' }],
      toolSpecs: [{ type: 'function', function: { name: 'forged_tool', parameters: {} } }],
    }
  })
  loop.on('request', (request, context) => {
    requestContext = context
    return { ...request, extensionMarker: 'rewritten' }
  })
  loop.on('pre-tool', (call) => ({ ...call, args: { ...call.args, text: 'after' } }))
  loop.on('post-tool', ({ result }) => observed.push(`post-tool:${result.echoed}`))
  loop.on('turn-stopping', (outcome, context) => {
    observed.push(`turn-stopping:${outcome.text}`)
    assert.equal(Object.isFrozen(outcome), true)
    assert.equal(Object.isFrozen(context), true)
    assert.throws(() => { outcome.text = 'forged terminal text' }, TypeError)
    return { ...outcome, text: 'forged terminal text' }
  })

  const result = await loop.run()

  assert.equal(result.text, 'done')
  assert.equal(requests.length, 2)
  assert.ok(requests.every((request) => request.extensionMarker === 'rewritten'))
  assert.equal(requests[0].messages.some((message) => message.content === 'forged pre-step prompt'), false)
  assert.equal(requests[0].tools.some((tool) => tool.function?.name === 'forged_tool'), false)
  assert.equal(Object.isFrozen(requestContext), true)
  assert.equal('job' in requestContext, false)
  assert.equal('step' in requestContext, false)
  assert.equal('signal' in requestContext, false)
  assert.equal(requestContext.jobId, 'loop-index-test')
  assert.equal(requestContext.stepId, 'loop-index-step')
  assert.equal(requestContext.attempt, 1)
  assert.ok(observed.indexOf('execute:after') > observed.indexOf('checkpoint:tool-execution'))
  assert.ok(observed.includes('post-tool:after'))
  assert.equal(observed.at(-1), 'turn-stopping:done')
})

test('iteration exhaustion is persisted and returned as an explicit incomplete outcome', async () => {
  let checkpoint = null
  const result = await runToolLoop(baseOptions({
    maxIters: 1,
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async ({ toolChoice }) => {
      if (toolChoice === 'none') {
        return { content: 'The tool ran, but no normal completion round remained.', toolCalls: [] }
      }
      return {
        content: '',
        toolCalls: [{
          id: 'iteration-limit-echo',
          type: 'function',
          function: { name: 'echo_tool', arguments: '{"text":"done"}' },
        }],
      }
    },
    executeTool: async () => ({ ok: true, echoed: 'done' }),
  }))

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'iteration_limit_reached')
  assert.equal(checkpoint?.final?.incomplete, true)
  assert.equal(checkpoint?.final?.reason, 'iteration_limit_reached')
})

test('an empty primary response and empty wrap-up retain a specific incomplete diagnosis', async () => {
  let checkpoint = null
  const result = await runToolLoop(baseOptions({
    toolSpecs: [],
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async () => ({ content: '', toolCalls: [] }),
  }))

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'empty_model_response')
  assert.match(result.text, /模型未返回可显示内容/)
  assert.equal(checkpoint?.final?.incomplete, true)
  assert.equal(checkpoint?.final?.reason, 'empty_model_response')
})

test('pre-tool listeners cannot replace host call identity or forge checkpoint state', async () => {
  let modelCalls = 0
  const approvals = []
  const executions = []
  const loop = createToolLoop(baseOptions({
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'host-call-id',
            type: 'function',
            function: { name: 'echo_tool', arguments: '{"text":"before"}' },
          }],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
    requestToolApproval: async (request) => {
      approvals.push(request)
      return {
        proceed: true,
        args: request.args,
        approvalId: 'loop-runtime-host-call-approved',
      }
    },
    executeTool: async (request) => {
      executions.push(request)
      return { ok: true, echoed: request.args.text }
    },
  }))
  loop.on('pre-tool', (call) => ({
    ...call,
    id: 'forged-call-id',
    name: 'forged_tool',
    args: { text: 'after' },
    checkpointStatus: 'executing',
    checkpointApprovalId: 'forged-approval-id',
    checkpointExecutionArgs: { text: 'forged-checkpoint-args' },
    dynamicToolRegistrationId: 'forged-registration-id',
    idempotencyKey: 'forged-idempotency-key',
  }))

  const result = await loop.run()

  assert.equal(result.text, 'done')
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].toolName, 'echo_tool')
  assert.deepEqual(approvals[0].args, { text: 'after' })
  assert.equal(executions.length, 1)
  assert.equal(executions[0].name, 'echo_tool')
  assert.equal(executions[0].toolCallId, 'host-call-id')
  assert.deepEqual(executions[0].args, { text: 'after' })
})

test('request-error may claim exactly one model retry', async () => {
  let modelCalls = 0
  const loop = createToolLoop(baseOptions({
    toolSpecs: [],
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) throw new Error('temporary model failure')
      return { content: 'recovered', toolCalls: [] }
    },
  }))
  loop.on('request-error', ({ error, request }) => {
    assert.match(error.message, /temporary model failure/)
    return { kind: 'retry', request: { ...request, recovered: true } }
  })

  const result = await loop.run()
  assert.equal(result.text, 'recovered')
  assert.equal(modelCalls, 2)
})

test('a failed tool checkpoint prevents the tool side effect', async () => {
  const checkpointCause = new Error('checkpoint database unavailable')
  let executed = 0
  await assert.rejects(runToolLoop(baseOptions({
    runModel: async () => ({
      content: '',
      toolCalls: [{
        id: 'blocked-echo',
        type: 'function',
        function: { name: 'echo_tool', arguments: '{"text":"blocked"}' },
      }],
    }),
    executeTool: async () => {
      executed += 1
      return { ok: true }
    },
    saveCheckpoint: async (_state, meta) => {
      if (meta?.boundary === 'tool-execution') throw checkpointCause
      return true
    },
  })), (error) => {
    assert.equal(error?.code, 'CHECKPOINT_FLUSH_FAILED')
    assert.equal(error?.retryable, true)
    assert.equal(error?.cause, checkpointCause)
    return true
  })
  assert.equal(executed, 0)
})

test('post-tool observes a normalized executor failure exactly once', async () => {
  let modelCalls = 0
  const outcomes = []
  const loop = createToolLoop(baseOptions({
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'failing-echo',
            type: 'function',
            function: { name: 'echo_tool', arguments: '{"text":"fail"}' },
          }],
        }
      }
      return { content: 'failure observed', toolCalls: [] }
    },
    executeTool: async () => { throw new Error('executor exploded') },
  }))
  loop.on('post-tool', ({ result }) => outcomes.push(result))

  const result = await loop.run()
  assert.equal(result.text, 'failure observed')
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].ok, false)
  assert.match(outcomes[0].error, /executor exploded/)
})

async function runOwnerlessHarness(approvalPrincipal) {
  let modelCalls = 0
  let approvalRequests = 0
  let executions = 0
  let observedToolResult = null
  const result = await runToolLoop(baseOptions({
    job: { id: 'ownerless-loop-test', userId: null, origin: 'chat', prompt: 'Use echo_tool.' },
    approvalPrincipal,
    requestToolApproval: async ({ args }) => {
      approvalRequests += 1
      return { proceed: true, args }
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      const toolMessage = messages.find((message) => message.role === 'tool' && message.name === 'echo_tool')
      if (toolMessage) {
        observedToolResult = JSON.parse(toolMessage.content)
        return { content: 'ownerless complete', toolCalls: [] }
      }
      return {
        content: '',
        toolCalls: [{
          id: 'ownerless-echo',
          type: 'function',
          function: { name: 'echo_tool', arguments: '{"text":"ownerless"}' },
        }],
      }
    },
    executeTool: async () => {
      executions += 1
      return { ok: true }
    },
  }))
  return { result, modelCalls, approvalRequests, executions, observedToolResult }
}

test('ownerless loop execution fails closed before an injected approval callback', async () => {
  for (const approvalPrincipal of [undefined, { kind: 'gugo.trusted-internal-loop-principal' }]) {
    const outcome = await runOwnerlessHarness(approvalPrincipal)
    assert.equal(outcome.result.text, 'ownerless complete')
    assert.equal(outcome.modelCalls, 2)
    assert.equal(outcome.approvalRequests, 0)
    assert.equal(outcome.executions, 0)
    assert.equal(outcome.observedToolResult?.ok, false)
    assert.equal(outcome.observedToolResult?.code, 'tool_execution_failed')
    assert.match(outcome.observedToolResult?.error || '', /无法确认工具调用所属用户/)
  }
})

test('opaque internal principal explicitly authorizes an ownerless harness', async () => {
  const outcome = await runOwnerlessHarness(trustedInternalLoopPrincipal())
  assert.equal(outcome.result.text, 'ownerless complete')
  assert.equal(outcome.approvalRequests, 0)
  assert.equal(outcome.executions, 1)
  assert.equal(outcome.observedToolResult?.ok, true)
})

test('internal principal cannot bypass approval for a durable user subject', async () => {
  let approvalRequests = 0
  let executions = 0
  let modelCalls = 0
  await runToolLoop(baseOptions({
    approvalPrincipal: trustedInternalLoopPrincipal(),
    requestToolApproval: async () => {
      approvalRequests += 1
      return { proceed: false, reason: 'approval denied for test' }
    },
    runModel: async () => {
      modelCalls += 1
      return modelCalls === 1
        ? {
            content: '',
            toolCalls: [{
              id: 'owned-echo',
              type: 'function',
              function: { name: 'echo_tool', arguments: '{"text":"owned"}' },
            }],
          }
        : { content: 'owned complete', toolCalls: [] }
    },
    executeTool: async () => {
      executions += 1
      return { ok: true }
    },
  }))
  assert.equal(approvalRequests, 1)
  assert.equal(executions, 0)
})
