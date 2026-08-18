import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-turn-checkpoint-tests', String(process.pid))
process.env.APPROVAL_MODE = 'off'

const { DB_SCHEMA_VERSION, getSchemaVersion } = await import('../server/db.js')
const { appendJobSteps, createJob } = await import('../server/services/jobStore.js')
const {
  deleteJobTurnCheckpoint,
  getJobTurnCheckpoint,
  saveJobTurnCheckpoint,
} = await import('../server/services/jobTurnCheckpointStore.js')
const { runToolsLoop } = await import('../server/services/jobTools.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const alice = issueTestSession({ email: 'checkpoint-alice@example.com' }).userId
const bob = issueTestSession({ email: 'checkpoint-bob@example.com' }).userId

function call(id, name, args, checkpointStatus = 'pending') {
  return {
    id,
    name,
    args,
    argumentsText: JSON.stringify(args),
    parseError: null,
    checkpointStatus,
    checkpointApprovalId: null,
  }
}

test('v22 checkpoint store is durable and isolated by job, step, and user', () => {
  const jobId = `checkpoint-job-${process.pid}-${Date.now()}`
  const stepId = `checkpoint-step-${process.pid}-${Date.now()}`
  assert.equal(getSchemaVersion(), DB_SCHEMA_VERSION)
  createJob({ id: jobId, userId: alice, title: 'resume', prompt: 'resume' })
  appendJobSteps(jobId, [{ id: stepId, title: 'step', kind: 'execute' }])

  const saved = saveJobTurnCheckpoint({
    jobId,
    stepId,
    userId: alice,
    state: { messages: [{ role: 'user', content: 'verbatim' }], toolCalls: [] },
  })
  assert.equal(saved.state.version, 1)
  assert.equal(saved.state.messages[0].content, 'verbatim')
  assert.equal(getJobTurnCheckpoint({ jobId, stepId, userId: bob }), null)
  assert.equal(saveJobTurnCheckpoint({
    jobId,
    stepId,
    userId: bob,
    state: { messages: [] },
  }), null)
  assert.equal(deleteJobTurnCheckpoint({ jobId, stepId, userId: bob }), 0)
  assert.ok(getJobTurnCheckpoint({ jobId, stepId, userId: alice }))
})

test('new tool calls persist and receive a stable idempotency key', async () => {
  const savedStates = []
  const executions = []
  let modelCalls = 0

  const result = await runToolsLoop({
    job: { id: 'fresh-key-job', userId: alice },
    step: { id: 'fresh-key-step' },
    messages: [{ role: 'user', content: 'read once' }],
    saveCheckpoint: async (state) => {
      savedStates.push(structuredClone(state))
      return { state }
    },
    executeTool: async ({ toolCallId, idempotencyKey }) => {
      executions.push({ toolCallId, idempotencyKey })
      return { ok: true }
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'fresh-read',
            function: { name: 'read_file', arguments: '{"path":"README.md"}' },
          }],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  })

  const expectedKey = 'job:fresh-key-job:step:fresh-key-step:tool:fresh-read'
  assert.equal(result.text, 'done')
  assert.deepEqual(executions, [{ toolCallId: 'fresh-read', idempotencyKey: expectedKey }])
  assert.equal(savedStates.find((state) => state.toolCalls.length > 0).toolCalls[0].idempotencyKey, expectedKey)
})

test('resume executes only unanswered read calls and keeps canonical tool-result order', async () => {
  let checkpoint = {
    messages: [
      { role: 'user', content: 'read both' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'read-done', type: 'function', function: { name: 'read_file', arguments: '{"path":"done.txt"}' } },
          { id: 'read-pending', type: 'function', function: { name: 'read_file', arguments: '{"path":"pending.txt"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'read-done', name: 'read_file', content: '{"ok":true,"path":"done.txt"}' },
    ],
    toolCalls: [
      { ...call('read-done', 'read_file', { path: 'done.txt' }, 'completed'), checkpointResult: { ok: true, path: 'done.txt' } },
      call('read-pending', 'read_file', { path: 'pending.txt' }),
    ],
    artifactIds: [],
    iterations: 0,
  }
  const executed = []
  let modelCalls = 0
  let toolResultIds = []

  const result = await runToolsLoop({
    job: { id: 'resume-read-job', userId: alice },
    step: { id: 'resume-read-step' },
    messages: [{ role: 'user', content: 'must not replace checkpoint' }],
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return { state: checkpoint }
    },
    executeTool: async ({ args, toolCallId, idempotencyKey }) => {
      executed.push({ path: args.path, toolCallId, idempotencyKey })
      return { ok: true, path: args.path }
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      toolResultIds = messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id)
      return { content: 'resumed', toolCalls: [] }
    },
  })

  assert.equal(result.text, 'resumed')
  assert.deepEqual(executed, [{
    path: 'pending.txt',
    toolCallId: 'read-pending',
    idempotencyKey: 'job:resume-read-job:step:resume-read-step:tool:read-pending',
  }])
  assert.equal(modelCalls, 1, 'the persisted model turn must not be requested again')
  assert.deepEqual(toolResultIds, ['read-done', 'read-pending'])
  assert.equal(checkpoint.final.text, 'resumed')
})

test('resume never replays a side-effecting call left in executing state', async () => {
  let checkpoint = {
    messages: [
      { role: 'user', content: 'write once' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'write-uncertain',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"once.txt","content":"once"}' },
        }],
      },
    ],
    toolCalls: [call('write-uncertain', 'write_file', { path: 'once.txt', content: 'once' }, 'executing')],
    artifactIds: [],
    iterations: 0,
  }
  let executeCount = 0
  let toolResult = null
  const savedStates = []

  const result = await runToolsLoop({
    job: { id: 'resume-write-job', userId: alice },
    step: { id: 'resume-write-step' },
    messages: [],
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      savedStates.push(checkpoint)
      return { state: checkpoint }
    },
    executeTool: async () => {
      executeCount += 1
      return { ok: true }
    },
    runModel: async ({ messages }) => {
      toolResult = JSON.parse(messages.find((message) => message.role === 'tool').content)
      return { content: 'verify before continuing', toolCalls: [] }
    },
  })

  assert.equal(result.text, 'verify before continuing')
  assert.equal(executeCount, 0)
  assert.equal(toolResult.code, 'tool_execution_outcome_unknown')
  assert.equal(toolResult.requiresUserVerification, true)
  assert.equal(
    savedStates.find((state) => state.toolCalls.length > 0).toolCalls[0].idempotencyKey,
    'job:resume-write-job:step:resume-write-step:tool:write-uncertain',
  )
})

test('an explicitly idempotent executor safely resumes an executing call with the same key and args', async () => {
  const expectedKey = 'job:idempotent-job:step:idempotent-step:tool:write-retry'
  let checkpoint = {
    messages: [
      { role: 'user', content: 'write once' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'write-retry',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"original.txt","content":"once"}' },
        }],
      },
    ],
    toolCalls: [{
      ...call('write-retry', 'write_file', { path: 'original.txt', content: 'once' }, 'executing'),
      checkpointApprovalId: 'approval-resolved',
      checkpointExecutionArgs: { path: 'hook-rewritten.txt', content: 'once' },
      idempotencyKey: expectedKey,
    }],
    artifactIds: [],
    iterations: 0,
  }
  const executions = []
  let modelCalls = 0
  const executeTool = async ({ args, toolCallId, idempotencyKey }) => {
    executions.push({ args, toolCallId, idempotencyKey })
    return { ok: true, path: args.path }
  }
  executeTool.supportsIdempotentResume = ({ name, idempotencyKey }) => (
    name === 'write_file' && idempotencyKey === expectedKey
  )

  const result = await runToolsLoop({
    job: { id: 'idempotent-job', userId: alice },
    step: { id: 'idempotent-step' },
    messages: [],
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return { state: checkpoint }
    },
    executeTool,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'verify-write-retry',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"hook-rewritten.txt"}' },
          }],
        }
      }
      return { content: 'resumed safely', toolCalls: [] }
    },
  })

  assert.equal(result.text, 'resumed safely')
  assert.deepEqual(executions[0], {
    args: { path: 'hook-rewritten.txt', content: 'once' },
    toolCallId: 'write-retry',
    idempotencyKey: expectedKey,
  })
  assert.deepEqual(executions[1]?.args, {
    path: 'hook-rewritten.txt',
    offset: 0,
    limit: 0,
  })
  assert.equal(executions[1]?.toolCallId, 'verify-write-retry')
  assert.equal(checkpoint.final.text, 'resumed safely')
})

test('an executing connector checkpoint switched to plan is denied before idempotent resume', async () => {
  const toolCallId = 'connector-write-retry'
  const expectedKey = `job:connector-plan-job:step:connector-plan-step:tool:${toolCallId}`
  const originalArgs = { owner: 'octo', repo: 'demo', title: 'original' }
  const finalArgs = { owner: 'octo', repo: 'demo', title: 'approved title' }
  let checkpoint = {
    messages: [
      { role: 'user', content: 'create the issue' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: toolCallId,
          type: 'function',
          function: { name: 'github_create_issue', arguments: JSON.stringify(originalArgs) },
        }],
      },
    ],
    toolCalls: [{
      ...call(toolCallId, 'github_create_issue', originalArgs, 'executing'),
      checkpointApprovalId: 'connector-approved-before-restart',
      checkpointExecutionArgs: finalArgs,
      idempotencyKey: expectedKey,
    }],
    artifactIds: [],
    iterations: 0,
  }
  let executeCalls = 0
  let deniedResult = null
  const executeTool = async () => {
    executeCalls += 1
    return { ok: true }
  }
  executeTool.supportsIdempotentResume = ({ name, args, idempotencyKey }) => (
    name === 'github_create_issue'
      && args === checkpoint.toolCalls[0].checkpointExecutionArgs
      && idempotencyKey === expectedKey
  )

  setApprovalMode({ userId: alice, mode: 'plan' })
  try {
    const result = await runToolsLoop({
      job: { id: 'connector-plan-job', userId: alice },
      step: { id: 'connector-plan-step' },
      messages: [],
      loadCheckpoint: async () => ({ state: checkpoint }),
      saveCheckpoint: async (state) => {
        checkpoint = structuredClone(state)
        return { state: checkpoint }
      },
      executeTool,
      runModel: async ({ messages }) => {
        deniedResult = JSON.parse(messages.find((message) => (
          message.role === 'tool' && message.tool_call_id === toolCallId
        )).content)
        return { content: 'connector write remained blocked in plan mode', toolCalls: [] }
      },
    })

    assert.equal(result.text, 'connector write remained blocked in plan mode')
    assert.equal(executeCalls, 0)
    assert.equal(deniedResult.policyDenied, true)
    assert.equal(deniedResult.permissionMode, 'plan')
    assert.match(deniedResult.error, /工具存在/)
    assert.match(deniedResult.error, /自动接受编辑模式/)
  } finally {
    setApprovalMode({ userId: alice, mode: 'normal' })
  }
})

test('a final response checkpoint returns without another model request', async () => {
  let modelCalls = 0
  const result = await runToolsLoop({
    job: { id: 'resume-final-job', userId: alice },
    step: { id: 'resume-final-step' },
    messages: [],
    loadCheckpoint: async () => ({
      state: {
        messages: [{ role: 'assistant', content: 'already final' }],
        toolCalls: [],
        artifactIds: ['artifact-1'],
        iterations: 3,
        final: { text: 'already final', iterations: 3 },
      },
    }),
    runModel: async () => {
      modelCalls += 1
      return { content: 'duplicate', toolCalls: [] }
    },
  })
  assert.equal(result.text, 'already final')
  assert.deepEqual(result.artifactIds, ['artifact-1'])
  assert.equal(modelCalls, 0)
})

test('an explicit retry receives a fresh round window without resetting cumulative iterations', async () => {
  let modelCalls = 0
  let checkpoint = {
    messages: [{ role: 'user', content: 'Continue from the saved progress.' }],
    toolCalls: [],
    artifactIds: [],
    iterations: 2,
    iterationWindowStart: 2,
    final: null,
  }

  const result = await runToolsLoop({
    job: { id: 'retry-window-job', userId: alice },
    step: { id: 'retry-window-step', kind: 'chat' },
    messages: [],
    maxIters: 2,
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return { state: checkpoint }
    },
    runModel: async () => {
      modelCalls += 1
      return { content: 'continued after retry', toolCalls: [] }
    },
  })

  assert.equal(modelCalls, 1)
  assert.equal(result.text, 'continued after retry')
  assert.equal(result.iterations, 3)
  assert.equal(checkpoint.iterationWindowStart, 2)
})

test('a failed terminal checkpoint restores its exact outcome without rerunning the model', async () => {
  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'resume-incomplete-job',
      userId: alice,
      prompt: 'Fix the project and verify it.',
    },
    step: { id: 'resume-incomplete-step', kind: 'execute' },
    messages: [],
    loadCheckpoint: async () => ({
      state: {
        messages: [{ role: 'assistant', content: 'Budget exhausted after partial work.' }],
        toolCalls: [],
        artifactIds: ['artifact-partial'],
        iterations: 4,
        completionGuards: { executionEvidenceObserved: false },
        final: {
          text: 'Budget exhausted after partial work.',
          iterations: 4,
          incomplete: true,
          budgetExceeded: true,
          reason: 'tool call budget exceeded',
        },
      },
    }),
    runModel: async () => {
      modelCalls += 1
      return { content: 'duplicate', toolCalls: [] }
    },
  })

  assert.equal(result.text, 'Budget exhausted after partial work.')
  assert.equal(result.incomplete, true)
  assert.equal(result.budgetExceeded, true)
  assert.equal(result.reason, 'tool call budget exceeded')
  assert.deepEqual(result.artifactIds, ['artifact-partial'])
  assert.equal(result.resumed, true)
  assert.equal(modelCalls, 0)
})

test('resume restores the tool budget instead of resetting it', async () => {
  let checkpoint = {
    messages: [
      { role: 'user', content: 'read' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'budget-read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"blocked.txt"}' },
        }],
      },
    ],
    toolCalls: [call('budget-read', 'read_file', { path: 'blocked.txt' })],
    artifactIds: [],
    iterations: 0,
    budget: { used: 3, maxTotalCalls: 3, elapsed: 100, maxWallMs: 60_000 },
  }
  let executeCount = 0
  const result = await runToolsLoop({
    job: { id: 'resume-budget-job', userId: alice },
    step: { id: 'resume-budget-step' },
    messages: [],
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return { state: checkpoint }
    },
    executeTool: async () => {
      executeCount += 1
      return { ok: true }
    },
    runModel: async () => ({ content: 'should not be needed', toolCalls: [] }),
  })
  assert.equal(result.budgetExceeded, true)
  assert.equal(executeCount, 0)
  assert.ok(checkpoint.budget.used > 3)
})

test('resume restores the repeated-call fuse and blocks the third identical call before execution', async () => {
  let checkpoint = null
  let executions = 0
  let firstRunModelCalls = 0
  const repeatedCall = {
    id: 'same-read',
    function: { name: 'read_file', arguments: '{"path":"missing.txt"}' },
  }
  const saveCheckpoint = async (state) => {
    checkpoint = structuredClone(state)
    return { state: checkpoint }
  }
  const executeTool = async () => {
    executions += 1
    return { ok: false, code: 'ENOENT', error: 'missing', retryable: false }
  }

  const interrupted = await runToolsLoop({
    job: { id: 'resume-loop-guard-job', userId: alice },
    step: { id: 'resume-loop-guard-step' },
    messages: [{ role: 'user', content: 'read missing.txt' }],
    saveCheckpoint,
    executeTool,
    toolRetryBaseDelayMs: 0,
    runModel: async () => {
      firstRunModelCalls += 1
      if (firstRunModelCalls <= 2) return { content: '', toolCalls: [repeatedCall] }
      throw Object.assign(new Error('provider restarted'), { code: 'MODEL_RESTARTED' })
    },
  })

  assert.equal(interrupted.interrupted, true)
  assert.equal(executions, 2)
  assert.equal(checkpoint.loopGuard.repeatedCallStreak, 2)
  assert.match(checkpoint.loopGuard.lastSignature, /^[a-f0-9]{64}$/u)

  let resumedModelCalls = 0
  const result = await runToolsLoop({
    job: { id: 'resume-loop-guard-job', userId: alice },
    step: { id: 'resume-loop-guard-step' },
    messages: [],
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint,
    executeTool,
    toolRetryBaseDelayMs: 0,
    runModel: async ({ toolChoice }) => {
      resumedModelCalls += 1
      if (toolChoice === 'none') return { content: 'Stopped after the durable repeated-call fuse.', toolCalls: [] }
      return { content: '', toolCalls: [repeatedCall] }
    },
  })

  assert.equal(result.noProgress, true)
  assert.equal(result.text, 'Stopped after the durable repeated-call fuse.')
  assert.equal(executions, 2, 'the third identical call must be rejected before the executor runs')
  assert.equal(resumedModelCalls, 2)
})
