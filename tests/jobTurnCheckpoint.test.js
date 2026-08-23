import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-turn-checkpoint-tests', String(process.pid))
process.env.APPROVAL_MODE = 'off'

const { DB_SCHEMA_VERSION, getDb, getSchemaVersion } = await import('../server/db.js')
const { appendJobSteps, createJob } = await import('../server/services/jobStore.js')
const {
  deleteJobTurnCheckpoint,
  getJobTurnCheckpoint,
  saveJobTurnCheckpoint,
} = await import('../server/services/jobTurnCheckpointStore.js')
const { runToolsLoop } = await import('../server/services/jobTools.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const {
  createSideEffectExecutionLedger,
  createSideEffectScope,
} = await import('../server/services/sideEffectExecutionLedger.js')
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
  const idempotentUser = issueTestSession({
    email: `checkpoint-idempotent-${process.pid}@example.com`,
  }).userId
  setApprovalMode({ userId: idempotentUser, mode: 'bypass' })
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
    job: { id: 'idempotent-job', userId: idempotentUser },
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

test('job checkpoint store rejects a stale checkpoint write sequence', () => {
  const suffix = `${process.pid}-${Date.now()}`
  const jobId = `checkpoint-cas-job-${suffix}`
  const stepId = `checkpoint-cas-step-${suffix}`
  createJob({ id: jobId, userId: alice, title: 'checkpoint CAS', prompt: 'checkpoint CAS' })
  appendJobSteps(jobId, [{ id: stepId, title: 'step', kind: 'execute' }])

  const newest = saveJobTurnCheckpoint({
    jobId,
    stepId,
    userId: alice,
    state: { marker: 'newer', checkpointWriteSequence: 2 },
  })
  const staleAttempt = saveJobTurnCheckpoint({
    jobId,
    stepId,
    userId: alice,
    state: { marker: 'stale', checkpointWriteSequence: 1 },
  })

  assert.equal(staleAttempt.revision, newest.revision)
  assert.equal(staleAttempt.state.marker, 'newer')
  assert.equal(staleAttempt.state.checkpointWriteSequence, 2)
  assert.equal(getJobTurnCheckpoint({ jobId, stepId, userId: alice }).state.marker, 'newer')
})

test('job checkpoint store rejects conflicting content at the same write sequence', () => {
  const suffix = `${process.pid}-${Date.now()}-${Math.random()}`
  const jobId = `checkpoint-equal-cas-job-${suffix}`
  const stepId = `checkpoint-equal-cas-step-${suffix}`
  createJob({ id: jobId, userId: alice, title: 'checkpoint equal CAS', prompt: 'checkpoint equal CAS' })
  appendJobSteps(jobId, [{ id: stepId, title: 'step', kind: 'execute' }])

  const committed = saveJobTurnCheckpoint({
    jobId,
    stepId,
    userId: alice,
    state: { marker: 'committed', checkpointWriteSequence: 2 },
  })
  const conflicting = saveJobTurnCheckpoint({
    jobId,
    stepId,
    userId: alice,
    state: { marker: 'conflicting', checkpointWriteSequence: 2 },
  })

  assert.equal(conflicting.revision, committed.revision)
  assert.equal(conflicting.state.marker, 'committed')
  assert.equal(conflicting.state.checkpointWriteSequence, 2)
})

test('job checkpoint store does not downgrade a sequenced checkpoint with an unversioned write', () => {
  const suffix = `${process.pid}-${Date.now()}-${Math.random()}`
  const jobId = `checkpoint-unversioned-cas-job-${suffix}`
  const stepId = `checkpoint-unversioned-cas-step-${suffix}`
  createJob({ id: jobId, userId: alice, title: 'checkpoint unversioned CAS', prompt: 'checkpoint unversioned CAS' })
  appendJobSteps(jobId, [{ id: stepId, title: 'step', kind: 'execute' }])

  const committed = saveJobTurnCheckpoint({
    jobId,
    stepId,
    userId: alice,
    state: { marker: 'committed', checkpointWriteSequence: 2 },
  })
  const unversioned = saveJobTurnCheckpoint({
    jobId,
    stepId,
    userId: alice,
    state: { marker: 'legacy-late-write' },
  })

  assert.equal(unversioned.revision, committed.revision)
  assert.equal(unversioned.state.marker, 'committed')
  assert.equal(unversioned.state.checkpointWriteSequence, 2)
})

test('job checkpoint store treats an identical equal-sequence retry as idempotent', () => {
  const suffix = `${process.pid}-${Date.now()}-${Math.random()}`
  const jobId = `checkpoint-idempotent-cas-job-${suffix}`
  const stepId = `checkpoint-idempotent-cas-step-${suffix}`
  createJob({ id: jobId, userId: alice, title: 'checkpoint idempotent CAS', prompt: 'checkpoint idempotent CAS' })
  appendJobSteps(jobId, [{ id: stepId, title: 'step', kind: 'execute' }])

  const state = {
    marker: 'committed',
    nested: { alpha: 1, beta: 2 },
    checkpointWriteSequence: 2,
  }
  const committed = saveJobTurnCheckpoint({ jobId, stepId, userId: alice, state })
  const retried = saveJobTurnCheckpoint({
    jobId,
    stepId,
    userId: alice,
    state: {
      checkpointWriteSequence: 2,
      nested: { beta: 2, alpha: 1 },
      marker: 'committed',
    },
  })

  assert.equal(retried.revision, committed.revision)
  assert.deepEqual(retried.state, committed.state)
})

test('job checkpoint store keeps legacy unversioned updates compatible', () => {
  const suffix = `${process.pid}-${Date.now()}-${Math.random()}`
  const jobId = `checkpoint-legacy-cas-job-${suffix}`
  const stepId = `checkpoint-legacy-cas-step-${suffix}`
  createJob({ id: jobId, userId: alice, title: 'checkpoint legacy CAS', prompt: 'checkpoint legacy CAS' })
  appendJobSteps(jobId, [{ id: stepId, title: 'step', kind: 'execute' }])

  const initial = saveJobTurnCheckpoint({
    jobId,
    stepId,
    userId: alice,
    state: { marker: 'legacy-initial' },
  })
  const updated = saveJobTurnCheckpoint({
    jobId,
    stepId,
    userId: alice,
    state: { marker: 'legacy-updated' },
  })

  assert.equal(updated.revision, initial.revision + 1)
  assert.equal(updated.state.marker, 'legacy-updated')
  assert.equal(updated.state.checkpointWriteSequence, undefined)
})

test('a ledger-backed idempotent executor resumes an executing record with the same key and commits it', async () => {
  const suffix = `${process.pid}-${Date.now()}-${Math.random()}`
  const ledgerUser = issueTestSession({
    email: `checkpoint-ledger-idempotent-${process.pid}-${Date.now()}@example.com`,
  }).userId
  setApprovalMode({ userId: ledgerUser, mode: 'bypass' })
  const job = { id: `ledger-idempotent-job-${suffix}`, userId: ledgerUser }
  const step = { id: `ledger-idempotent-step-${suffix}` }
  const toolCallId = `ledger-idempotent-write-${suffix}`
  const verificationCallId = `ledger-idempotent-read-${suffix}`
  const executionArgs = { path: 'ledger-idempotent.txt', content: 'once' }
  const expectedKey = `job:${job.id}:step:${step.id}:tool:${toolCallId}`
  let checkpoint = {
    messages: [
      { role: 'user', content: 'write once' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: toolCallId,
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify(executionArgs) },
        }],
      },
    ],
    toolCalls: [{
      ...call(toolCallId, 'write_file', executionArgs, 'executing'),
      checkpointExecutionArgs: executionArgs,
      checkpointReadOnly: false,
      idempotencyKey: expectedKey,
    }],
    artifactIds: [],
    iterations: 0,
  }
  const ledger = createSideEffectExecutionLedger({ db: getDb() })
  const ledgerInput = {
    scope: createSideEffectScope({ job, step, approvalOrigin: 'job' }),
    toolCallId,
    idempotencyKey: expectedKey,
    toolName: 'write_file',
    args: executionArgs,
  }
  ledger.prepare(ledgerInput)
  ledger.claimExecution(ledgerInput)

  const executions = []
  const executeTool = async ({ name, args, toolCallId: receivedCallId, idempotencyKey }) => {
    executions.push({ name, args, toolCallId: receivedCallId, idempotencyKey })
    return name === 'read_file'
      ? { ok: true, path: args.path, content: 'once' }
      : { ok: true, path: args.path, changedPaths: [args.path] }
  }
  executeTool.supportsIdempotentResume = ({ name, idempotencyKey }) => (
    name === 'write_file' && idempotencyKey === expectedKey
  )
  let modelCalls = 0

  const result = await runToolsLoop({
    job,
    step,
    messages: [],
    sideEffectLedger: ledger,
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
            id: verificationCallId,
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"ledger-idempotent.txt"}' },
          }],
        }
      }
      return { content: 'ledger-backed resume completed', toolCalls: [] }
    },
  })

  assert.equal(result.text, 'ledger-backed resume completed')
  assert.equal(executions.filter((entry) => entry.name === 'write_file').length, 1)
  assert.deepEqual(executions[0], {
    name: 'write_file',
    args: executionArgs,
    toolCallId,
    idempotencyKey: expectedKey,
  })
  const committed = ledger.read(ledgerInput)
  assert.equal(committed.status, 'committed')
  assert.deepEqual(ledger.parseOutcome(committed), {
    ok: true,
    path: executionArgs.path,
    changedPaths: [executionArgs.path],
    sideEffectLedgerReplay: true,
  })
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

test('resume reuses a durably completed model response without another provider request', async () => {
  let checkpoint = null
  let modelCalls = 0
  const modelRequestIds = []
  let interruptAfterResponse = true
  const saveCheckpoint = async (state) => {
    checkpoint = structuredClone(state)
    return { state: checkpoint }
  }

  await assert.rejects(runToolsLoop({
    job: { id: 'resume-model-response-job', userId: alice },
    step: { id: 'resume-model-response-step' },
    messages: [{ role: 'user', content: 'answer once' }],
    saveCheckpoint,
    onModelPhase: async ({ phase }) => {
      if (phase === 'completed' && interruptAfterResponse) {
        throw Object.assign(new Error('process stopped after the response checkpoint'), { code: 'PROCESS_STOPPED' })
      }
    },
    runModel: async ({ modelRequestId }) => {
      modelCalls += 1
      modelRequestIds.push(modelRequestId)
      assert.equal(checkpoint.modelInvocation.status, 'in_flight')
      assert.equal(modelRequestId, checkpoint.modelInvocation.id)
      return {
        content: 'durable answer',
        toolCalls: [],
        modelName: 'test-model',
        providerId: 'test-provider',
      }
    },
  }), /process stopped after the response checkpoint/)

  assert.equal(checkpoint.modelInvocation.status, 'completed')
  assert.equal(checkpoint.modelInvocation.response.content, 'durable answer')
  assert.equal(checkpoint.modelInvocation.response.providerId, 'test-provider')
  assert.match(checkpoint.modelInvocation.id, /^mr_[a-f0-9]{48}$/u)
  const durableModelRequestId = checkpoint.modelInvocation.id
  assert.equal(modelCalls, 1)

  interruptAfterResponse = false
  const resumed = await runToolsLoop({
    job: { id: 'resume-model-response-job', userId: alice },
    step: { id: 'resume-model-response-step' },
    messages: [],
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint,
    runModel: async () => {
      modelCalls += 1
      return { content: 'duplicate answer', toolCalls: [] }
    },
  })

  assert.equal(resumed.text, 'durable answer')
  assert.equal(modelCalls, 1, 'the provider response must be replayed from the checkpoint')
  assert.deepEqual(modelRequestIds, [durableModelRequestId])
})

test('resume blocks an in-flight model request whose upstream outcome is unknown', async () => {
  let checkpoint = null
  let modelCalls = 0
  let failResponseCheckpoint = true
  const saveCheckpoint = async (state, meta = {}) => {
    if (failResponseCheckpoint && meta.boundary === 'model-response') {
      throw new Error('checkpoint storage unavailable after provider response')
    }
    checkpoint = structuredClone(state)
    return { state: checkpoint }
  }

  await assert.rejects(runToolsLoop({
    job: { id: 'unknown-model-outcome-job', userId: alice },
    step: { id: 'unknown-model-outcome-step' },
    messages: [{ role: 'user', content: 'do not bill twice' }],
    saveCheckpoint,
    runModel: async () => {
      modelCalls += 1
      return { content: 'provider accepted this request', toolCalls: [] }
    },
  }), (error) => error?.code === 'CHECKPOINT_FLUSH_FAILED')

  assert.equal(checkpoint.modelInvocation.status, 'in_flight')
  assert.equal(modelCalls, 1)

  failResponseCheckpoint = false
  await assert.rejects(runToolsLoop({
    job: { id: 'unknown-model-outcome-job', userId: alice },
    step: { id: 'unknown-model-outcome-step' },
    messages: [],
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint,
    runModel: async () => {
      modelCalls += 1
      return { content: 'duplicate charge', toolCalls: [] }
    },
  }), (error) => error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN' && error?.unsafeToReplay === true)

  assert.equal(modelCalls, 1, 'an unknown upstream outcome must not be replayed automatically')
})

test('a tracked ambiguous transport failure preserves the in-flight invocation for reconciliation', async () => {
  let checkpoint = null
  let modelCalls = 0
  const job = { id: 'transport-unknown-job', userId: alice }
  const step = { id: 'transport-unknown-step' }
  const saveCheckpoint = async (state) => {
    checkpoint = structuredClone(state)
    return { state: checkpoint }
  }

  await assert.rejects(runToolsLoop({
    job,
    step,
    messages: [{ role: 'user', content: 'send exactly once' }],
    saveCheckpoint,
    runModel: async ({ modelRequestId }) => {
      modelCalls += 1
      throw Object.assign(new Error('provider outcome is ambiguous'), {
        code: 'MODEL_REQUEST_OUTCOME_UNKNOWN',
        modelRequestId,
        unsafeToReplay: true,
        retryable: false,
      })
    },
  }), (error) => error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN')

  assert.equal(modelCalls, 1)
  assert.equal(checkpoint.modelInvocation.status, 'in_flight')
  const durableRequestId = checkpoint.modelInvocation.id

  await assert.rejects(runToolsLoop({
    job,
    step,
    messages: [],
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint,
    runModel: async () => {
      modelCalls += 1
      return { content: 'must not be sent', toolCalls: [] }
    },
  }), (error) => error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
    && error?.modelRequestId === durableRequestId)
  assert.equal(modelCalls, 1)
})

test('resume fails closed before calling the provider when a model invocation checkpoint is malformed', async () => {
  let modelCalls = 0
  const malformedInvocation = {
    version: 2,
    id: `mr_${'a'.repeat(48)}`,
    idempotencyKey: `mr_${'b'.repeat(48)}`,
    fingerprint: 'c'.repeat(64),
    providerId: null,
    modelName: null,
    configRevision: null,
    iteration: 0,
    attempt: 1,
    status: 'in_flight',
  }

  await assert.rejects(runToolsLoop({
    job: { id: 'malformed-model-checkpoint-job', userId: alice },
    step: { id: 'malformed-model-checkpoint-step' },
    messages: [],
    loadCheckpoint: async () => ({
      state: {
        messages: [{ role: 'user', content: 'do not replay this request' }],
        iterations: 0,
        modelInvocation: malformedInvocation,
      },
    }),
    saveCheckpoint: async (state) => ({ state }),
    runModel: async () => {
      modelCalls += 1
      return { content: 'duplicate request', toolCalls: [] }
    },
  }), (error) => error?.code === 'MODEL_REQUEST_CONTEXT_DRIFT'
    && error?.checkpointInvalid === true
    && error?.unsafeToReplay === true)

  assert.equal(modelCalls, 0)
})
