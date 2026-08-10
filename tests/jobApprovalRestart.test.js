import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-approval-restart-tests', String(process.pid))
process.env.APPROVAL_MODE = 'unattended'

const { JobRuntime } = await import('../server/services/jobRuntime.js')
const { appendJobSteps, createJob, getJobWithChildren, updateJob } = await import('../server/services/jobStore.js')
const { runToolsLoop } = await import('../server/services/jobTools.js')
const {
  createPendingApproval,
  decideApproval,
  listPendingApprovals,
} = await import('../server/services/approvalStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const userId = issueTestSession({ email: 'approval-restart@example.com' }).userId

function createAwaitingJob(id) {
  createJob({ id, userId, title: id, prompt: id, status: 'awaiting_approval' })
  appendJobSteps(id, [{ id: `${id}-step`, title: 'execute', kind: 'execute', status: 'running' }])
  return getJobWithChildren(id, { userId })
}

function createApproval(job) {
  return createPendingApproval({
    userId,
    origin: 'job',
    jobId: job.id,
    stepId: job.steps[0].id,
    toolName: 'bash_exec',
    args: { command: 'git status' },
    risk: 'medium',
    reason: 'shell',
    expiresAt: Date.now() + 60_000,
  })
}

test('startup recovery requeues an awaiting job whose durable approval is already decided', () => {
  const job = createAwaitingJob('approval-decided-before-restart')
  const approval = createApproval(job)
  assert.equal(decideApproval({ userId, id: approval.id, decision: 'approve' }).ok, true)

  const runtime = new JobRuntime({ executeStep: async () => ({ ok: true, output: { text: 'done' } }) })
  const recovered = runtime.getJob(job.id, { userId })
  assert.equal(recovered.status, 'queued')
  assert.equal(recovered.steps[0].status, 'queued')
  assert.ok(recovered.events.some((event) => event.type === 'approval_recovered'))

  // Keep this fixture out of subsequent recovery scans in the same process.
  updateJob(job.id, { status: 'completed', progress: 100, finishedAt: Date.now() })
})

test('a decision made after restart requeues the job when no in-memory waiter exists', () => {
  const job = createAwaitingJob('approval-decided-after-restart')
  const approval = createApproval(job)
  const runtime = new JobRuntime({ executeStep: async () => ({ ok: true, output: { text: 'done' } }) })
  assert.equal(runtime.getJob(job.id, { userId }).status, 'awaiting_approval')

  assert.equal(decideApproval({ userId, id: approval.id, decision: 'approve' }).ok, true)
  const resumed = runtime.resumeAfterApproval(job.id, { userId, stepId: job.steps[0].id })
  assert.equal(resumed.status, 'queued')
  assert.equal(resumed.steps[0].status, 'queued')
  assert.ok(resumed.events.some((event) => event.type === 'approval_recovered'))

  updateJob(job.id, { status: 'completed', progress: 100, finishedAt: Date.now() })
})

test('the resumed tool call consumes its original approval without creating another row', async () => {
  const job = createAwaitingJob('approval-resume-original')
  const approval = createApproval(job)
  assert.equal(decideApproval({ userId, id: approval.id, decision: 'approve' }).ok, true)
  let checkpoint = {
    messages: [
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'approved-call',
          type: 'function',
          function: { name: 'bash_exec', arguments: '{"command":"git status"}' },
        }],
      },
    ],
    toolCalls: [{
      id: 'approved-call',
      name: 'bash_exec',
      args: { command: 'git status' },
      argumentsText: '{"command":"git status"}',
      parseError: null,
      checkpointStatus: 'awaiting_approval',
      checkpointApprovalId: approval.id,
    }],
    artifactIds: [],
    iterations: 0,
  }
  let executeCount = 0
  const result = await runToolsLoop({
    job,
    step: job.steps[0],
    messages: [],
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return { state: checkpoint }
    },
    executeTool: async ({ args }) => {
      executeCount += 1
      assert.equal(args.command, 'git status')
      return { ok: true, stdout: 'clean' }
    },
    runModel: async () => ({ content: 'done', toolCalls: [] }),
  })

  assert.equal(result.text, 'done')
  assert.equal(executeCount, 1)
  const approvals = listPendingApprovals({ userId, status: 'all' })
    .filter((item) => item.jobId === job.id)
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].id, approval.id)
})

test('a resumed edited approval executes and verifies only the edited target', async () => {
  const job = createAwaitingJob('approval-resume-edited')
  const approval = createPendingApproval({
    userId,
    origin: 'job',
    jobId: job.id,
    stepId: job.steps[0].id,
    toolName: 'bash_exec',
    args: { command: 'rm -rf /' },
    risk: 'high',
    reason: 'shell',
    expiresAt: Date.now() + 60_000,
  })
  assert.equal(decideApproval({
    userId,
    id: approval.id,
    decision: 'edit',
    editedArgs: { command: 'echo safe > approval-safe.txt', cwd: '/tmp' },
  }).ok, true)

  let checkpoint = {
    messages: [
      { role: 'user', content: 'run the approved command' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'edited-call',
          type: 'function',
          function: { name: 'bash_exec', arguments: '{"command":"rm -rf /"}' },
        }],
      },
    ],
    toolCalls: [{
      id: 'edited-call',
      name: 'bash_exec',
      args: { command: 'rm -rf /' },
      argumentsText: '{"command":"rm -rf /"}',
      parseError: null,
      checkpointStatus: 'awaiting_approval',
      checkpointApprovalId: approval.id,
    }],
    artifactIds: [],
    iterations: 0,
  }
  const executed = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job,
    step: job.steps[0],
    messages: [],
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return { state: checkpoint }
    },
    executeTool: async ({ name, args }) => {
      executed.push({ name, args })
      return { ok: true, content: name === 'read_file' ? 'safe' : undefined }
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'verify-edited-target',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/tmp/approval-safe.txt"}' },
          }],
        }
      }
      return { content: 'edited command verified', toolCalls: [] }
    },
  })

  assert.equal(result.text, 'edited command verified')
  assert.deepEqual(executed, [
    { name: 'bash_exec', args: { command: 'echo safe > approval-safe.txt', cwd: '/tmp' } },
    { name: 'read_file', args: { path: '/tmp/approval-safe.txt', offset: 0, limit: 0 } },
  ])
  assert.equal(executed.some(({ args }) => args.command === 'rm -rf /'), false)
})
