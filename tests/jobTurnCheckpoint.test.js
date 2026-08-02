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
  assert.equal(getSchemaVersion(), DB_SCHEMA_VERSION)
  createJob({ id: 'checkpoint-job', userId: alice, title: 'resume', prompt: 'resume' })
  appendJobSteps('checkpoint-job', [{ id: 'checkpoint-step', title: 'step', kind: 'execute' }])

  const saved = saveJobTurnCheckpoint({
    jobId: 'checkpoint-job',
    stepId: 'checkpoint-step',
    userId: alice,
    state: { messages: [{ role: 'user', content: 'verbatim' }], toolCalls: [] },
  })
  assert.equal(saved.state.version, 1)
  assert.equal(saved.state.messages[0].content, 'verbatim')
  assert.equal(getJobTurnCheckpoint({ jobId: 'checkpoint-job', stepId: 'checkpoint-step', userId: bob }), null)
  assert.equal(saveJobTurnCheckpoint({
    jobId: 'checkpoint-job',
    stepId: 'checkpoint-step',
    userId: bob,
    state: { messages: [] },
  }), null)
  assert.equal(deleteJobTurnCheckpoint({ jobId: 'checkpoint-job', stepId: 'checkpoint-step', userId: bob }), 0)
  assert.ok(getJobTurnCheckpoint({ jobId: 'checkpoint-job', stepId: 'checkpoint-step', userId: alice }))
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
    executeTool: async ({ args }) => {
      executed.push(args.path)
      return { ok: true, path: args.path }
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      toolResultIds = messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id)
      return { content: 'resumed', toolCalls: [] }
    },
  })

  assert.equal(result.text, 'resumed')
  assert.deepEqual(executed, ['pending.txt'])
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

  const result = await runToolsLoop({
    job: { id: 'resume-write-job', userId: alice },
    step: { id: 'resume-write-step' },
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
    runModel: async ({ messages }) => {
      toolResult = JSON.parse(messages.find((message) => message.role === 'tool').content)
      return { content: 'verify before continuing', toolCalls: [] }
    },
  })

  assert.equal(result.text, 'verify before continuing')
  assert.equal(executeCount, 0)
  assert.equal(toolResult.code, 'tool_execution_outcome_unknown')
  assert.equal(toolResult.requiresUserVerification, true)
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
