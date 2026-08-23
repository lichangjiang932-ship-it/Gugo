import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const testDataDir = path.join(os.tmpdir(), 'yma-job-plan-contract-tests', `${process.pid}-${Date.now()}`)
process.env.APP_DATA_DIR = testDataDir
process.env.APP_DB_PATH = path.join(testDataDir, 'app.db')

const { JobRuntime } = await import('../server/services/jobRuntime.js')
const { getApprovalMode, setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { approveJobPlan, replacePendingJobSteps } = await import('../server/services/jobStore.js')
const {
  computeJobPlanDigest,
  JOB_PLAN_APPROVAL_CONTRACT,
  JOB_PLAN_APPROVAL_VERSION,
} = await import('../server/services/jobPlanPolicyRuntime.js')
const { getDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const resolveTestModelBinding = () => ({
  providerId: null,
  modelName: 'job-plan-test-model',
  configRevision: null,
  env: {
    MODEL_BASE_URL: 'http://127.0.0.1:11434/v1',
    MODEL_NAME: 'job-plan-test-model',
  },
})

async function runUntilJobStatus(runtime, jobId, userId, expectedStatus, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let job = runtime.getJob(jobId, { userId })

  while (job?.status !== expectedStatus && Date.now() < deadline) {
    await runtime.runOneTick()
    job = runtime.getJob(jobId, { userId })
    if (job?.status !== expectedStatus) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  assert.equal(
    job?.status,
    expectedStatus,
    `job ${jobId} did not reach ${expectedStatus} within ${timeoutMs}ms (last status: ${job?.status || 'missing'})`,
  )
  return job
}

test('plan mode pauses at a durable proposal and explicit approval resumes the same job', async () => {
  const { userId } = issueTestSession()
  setApprovalMode({ userId, mode: 'plan' })
  const executed = []
  const runtime = new JobRuntime({
    planner: (prompt) => ({
      title: 'Plan contract',
      prompt,
      steps: [
        { id: 'plan', title: 'Propose plan', kind: 'plan', status: 'queued' },
        { id: 'execute', title: 'Write files', kind: 'execute', status: 'queued' },
      ],
    }),
    executeStep: async ({ step }) => {
      executed.push(step.kind)
      return { ok: true, output: { text: `${step.kind} done` } }
    },
    modelBindingResolver: resolveTestModelBinding,
  })

  const created = await runtime.createJob('Implement safely', { userId })
  const proposed = await runUntilJobStatus(runtime, created.id, userId, 'waiting')
  assert.deepEqual(executed, ['plan'])
  assert.equal(proposed.events.at(-1).type, 'plan_proposed')
  assert.equal(proposed.events.at(-1).payload.plan.steps[0].title, 'Write files')
  assert.equal(await runtime.runOneTick(), false)

  const blockedSteering = runtime.steerJob(created.id, { userId, content: 'run it anyway' })
  assert.equal(blockedSteering.accepted, false)
  assert.equal(getApprovalMode({ userId }), 'plan')

  const approval = runtime.approvePlan(created.id, { userId })
  assert.equal(approval.approved, true)
  assert.equal(approval.previousMode, 'plan')
  assert.equal(approval.mode, 'plan')
  assert.equal(getApprovalMode({ userId }), 'plan')
  assert.equal(approval.job.status, 'queued')
  await runtime.drain()
  assert.deepEqual(executed, ['plan', 'execute', 'verify', 'finalize'])
  assert.equal(runtime.getJob(created.id, { userId }).status, 'completed')
})

test('plan approval replaces queued steps with the user-edited order', async () => {
  const { userId } = issueTestSession()
  setApprovalMode({ userId, mode: 'plan' })
  const executed = []
  const runtime = new JobRuntime({
    planner: (prompt) => ({
      title: 'Editable plan',
      prompt,
      steps: [
        { id: 'plan', title: 'Propose plan', kind: 'plan', status: 'queued' },
        { id: 'old', title: 'Old step', kind: 'execute', status: 'queued' },
      ],
    }),
    executeStep: async ({ step }) => {
      executed.push(step.title)
      return { ok: true, output: { text: step.title } }
    },
    modelBindingResolver: resolveTestModelBinding,
  })

  const created = await runtime.createJob('Edit before execution', { userId })
  await runUntilJobStatus(runtime, created.id, userId, 'waiting')
  const originalStep = runtime.getJob(created.id, { userId }).steps.find((step) => step.kind === 'execute')
  const approval = runtime.approvePlan(created.id, {
    userId,
    steps: [
      {
        id: originalStep.id,
        title: 'First edited step',
        description: 'Keep the existing stable id',
        kind: 'execute',
        input: { action: 'write files' },
      },
      {
        id: 'draft-client-only',
        title: 'Second edited step',
        description: 'Persist a newly added step',
        kind: 'verify',
      },
    ],
  })
  assert.equal(approval.approved, true)
  assert.equal(approval.edited, true)
  assert.deepEqual(
    approval.job.steps.filter((step) => step.kind !== 'plan').map((step) => step.title),
    ['First edited step', 'Second edited step', '整理并交付结果'],
  )
  const editedSteps = approval.job.steps.filter((step) => step.kind !== 'plan')
  assert.equal(editedSteps[0].id, originalStep.id)
  assert.notEqual(editedSteps[1].id, 'draft-client-only')
  assert.match(editedSteps[1].id, /^step-/)
  assert.equal(editedSteps[0].input.description, 'Keep the existing stable id')
  assert.equal(editedSteps[0].input.action, 'write files')
  assert.equal(editedSteps[1].input.description, 'Persist a newly added step')
  await runtime.drain()
  assert.deepEqual(executed, ['Propose plan', 'First edited step', 'Second edited step', '整理并交付结果'])
  assert.equal(runtime.getJob(created.id, { userId }).status, 'completed')
})

test('plan approval counts required verification and delivery steps toward the 50-step limit', async () => {
  const { userId } = issueTestSession()
  setApprovalMode({ userId, mode: 'plan' })
  const runtime = new JobRuntime({
    planner: (prompt) => ({
      title: 'Bounded plan',
      prompt,
      steps: [
        { id: 'plan', title: 'Propose plan', kind: 'plan', status: 'queued' },
        { id: 'execute', title: 'Initial work', kind: 'execute', status: 'queued' },
      ],
    }),
    executeStep: async ({ step }) => ({ ok: true, output: { text: step.title } }),
    modelBindingResolver: resolveTestModelBinding,
  })

  const created = await runtime.createJob('Keep the plan bounded', { userId })
  await runUntilJobStatus(runtime, created.id, userId, 'waiting')
  const tooManyWorkSteps = Array.from({ length: 49 }, (_, index) => ({
    id: `work-${index + 1}`,
    title: `Work ${index + 1}`,
    kind: 'execute',
  }))
  const approval = runtime.approvePlan(created.id, { userId, steps: tooManyWorkSteps })

  assert.equal(approval.approved, false)
  assert.match(approval.error, /at most 50 steps/)
  assert.equal(runtime.getJob(created.id, { userId }).status, 'waiting')
})

test('approving one job keeps plan mode and other jobs isolated', async () => {
  const { userId } = issueTestSession()
  setApprovalMode({ userId, mode: 'plan' })
  const runtime = new JobRuntime({
    planner: (prompt) => ({
      title: prompt,
      prompt,
      steps: [
        { id: 'plan', title: `Plan ${prompt}`, kind: 'plan' },
        { id: 'execute', title: `Execute ${prompt}`, kind: 'execute' },
      ],
    }),
    executeStep: async ({ step }) => ({ ok: true, output: { text: step.title } }),
    modelBindingResolver: resolveTestModelBinding,
  })

  const first = await runtime.createJob('first', { userId })
  const second = await runtime.createJob('second', { userId })
  await runUntilJobStatus(runtime, first.id, userId, 'waiting')
  await runUntilJobStatus(runtime, second.id, userId, 'waiting')

  const approval = runtime.approvePlan(first.id, { userId })
  assert.equal(approval.approved, true)
  assert.equal(getApprovalMode({ userId }), 'plan')
  assert.equal(runtime.getJob(second.id, { userId }).status, 'waiting')
  assert.equal(
    runtime.getJob(second.id, { userId }).events.some((event) => event.type === 'plan_approved'),
    false,
  )
  await runtime.drain()
})

test('the same proposal and semantic edit are approved idempotently', async () => {
  const { userId } = issueTestSession()
  setApprovalMode({ userId, mode: 'plan' })
  const runtime = new JobRuntime({
    planner: (prompt) => ({
      title: 'Idempotent plan',
      prompt,
      steps: [
        { id: 'plan', title: 'Propose plan', kind: 'plan' },
        { id: 'execute', title: 'Initial work', kind: 'execute' },
      ],
    }),
    executeStep: async ({ step }) => ({ ok: true, output: { text: step.title } }),
    modelBindingResolver: resolveTestModelBinding,
  })
  const created = await runtime.createJob('Approve once', { userId })
  const waiting = await runUntilJobStatus(runtime, created.id, userId, 'waiting')
  const proposal = waiting.events.find((event) => event.type === 'plan_proposed')
  const editedSteps = [{ id: 'client-draft', title: 'Edited work', kind: 'execute' }]

  const first = runtime.approvePlan(created.id, {
    userId,
    steps: editedSteps,
    proposalEventId: proposal.id,
    planDigest: proposal.payload.planDigest,
  })
  const repeated = runtime.approvePlan(created.id, {
    userId,
    steps: editedSteps,
    proposalEventId: proposal.id,
    planDigest: proposal.payload.planDigest,
  })

  assert.equal(first.approved, true)
  assert.equal(first.idempotent, false)
  assert.equal(repeated.approved, true)
  assert.equal(repeated.idempotent, true)
  assert.equal(
    runtime.getJob(created.id, { userId }).events.filter((event) => event.type === 'plan_approved').length,
    1,
  )
  await runtime.drain()
})

test('a new runtime replays the durable job-scoped approval after restart', async () => {
  const { userId } = issueTestSession()
  setApprovalMode({ userId, mode: 'plan' })
  const executed = []
  const runtime = new JobRuntime({
    planner: (prompt) => ({
      title: 'Restart plan',
      prompt,
      steps: [
        { id: 'plan', title: 'Propose plan', kind: 'plan' },
        { id: 'execute', title: 'Execute after restart', kind: 'execute' },
      ],
    }),
    executeStep: async ({ step }) => {
      executed.push(step.kind)
      return { ok: true, output: { text: step.title } }
    },
    modelBindingResolver: resolveTestModelBinding,
  })
  const created = await runtime.createJob('Restart safely', { userId })
  await runUntilJobStatus(runtime, created.id, userId, 'waiting')
  assert.equal(runtime.approvePlan(created.id, { userId }).approved, true)

  const restarted = new JobRuntime({
    executeStep: async ({ step }) => {
      executed.push(step.kind)
      return { ok: true, output: { text: step.title } }
    },
    modelBindingResolver: resolveTestModelBinding,
  })
  await restarted.drain()

  assert.deepEqual(executed, ['plan', 'execute', 'verify', 'finalize'])
  assert.equal(restarted.getJob(created.id, { userId }).status, 'completed')
  assert.equal(getApprovalMode({ userId }), 'plan')
})

test('plan drift invalidates approval and emits a fresh proposal before execution', async () => {
  const { userId } = issueTestSession()
  setApprovalMode({ userId, mode: 'plan' })
  const executed = []
  const runtime = new JobRuntime({
    planner: (prompt) => ({
      title: 'Drift plan',
      prompt,
      steps: [
        { id: 'plan', title: 'Propose plan', kind: 'plan' },
        { id: 'execute', title: 'Original work', kind: 'execute' },
      ],
    }),
    executeStep: async ({ step }) => {
      executed.push(step.title)
      return { ok: true, output: { text: step.title } }
    },
    modelBindingResolver: resolveTestModelBinding,
  })
  const created = await runtime.createJob('Detect drift', { userId })
  const waiting = await runUntilJobStatus(runtime, created.id, userId, 'waiting')
  const originalProposal = waiting.events.find((event) => event.type === 'plan_proposed')
  assert.equal(runtime.approvePlan(created.id, { userId }).approved, true)

  const approved = runtime.getJob(created.id, { userId })
  const changedSteps = approved.steps
    .filter((step) => step.kind !== 'plan')
    .map((step) => ({
      ...step,
      title: step.kind === 'execute' ? 'Changed after approval' : step.title,
      status: 'queued',
    }))
  replacePendingJobSteps(created.id, changedSteps)
  await runtime.runOneTick()

  const refreshed = runtime.getJob(created.id, { userId })
  const proposals = refreshed.events.filter((event) => event.type === 'plan_proposed')
  assert.equal(refreshed.status, 'waiting')
  assert.equal(proposals.length, 2)
  assert.notEqual(proposals[1].payload.planDigest, originalProposal.payload.planDigest)
  assert.equal(proposals[1].payload.supersedesProposalEventId, originalProposal.id)
  assert.deepEqual(executed, ['Propose plan'])
  assert.equal(runtime.approvePlan(created.id, {
    userId,
    proposalEventId: originalProposal.id,
    planDigest: originalProposal.payload.planDigest,
  }).approved, false)
  assert.equal(runtime.approvePlan(created.id, {
    userId,
    proposalEventId: proposals[1].id,
    planDigest: proposals[1].payload.planDigest,
  }).approved, true)
  await runtime.drain()
})

test('legacy approval records without a digest fail closed until reapproved', async () => {
  const { userId } = issueTestSession()
  setApprovalMode({ userId, mode: 'plan' })
  const executed = []
  const runtime = new JobRuntime({
    planner: (prompt) => ({
      title: 'Legacy approval',
      prompt,
      steps: [
        { id: 'plan', title: 'Propose plan', kind: 'plan' },
        { id: 'execute', title: 'Protected work', kind: 'execute' },
      ],
    }),
    executeStep: async ({ step }) => {
      executed.push(step.kind)
      return { ok: true, output: { text: step.title } }
    },
    modelBindingResolver: resolveTestModelBinding,
  })
  const created = await runtime.createJob('Reject legacy approval', { userId })
  await runUntilJobStatus(runtime, created.id, userId, 'waiting')
  const approval = runtime.approvePlan(created.id, { userId })
  assert.equal(approval.approved, true)
  const approvalEvent = approval.job.events.find((event) => event.type === 'plan_approved')
  getDb().prepare('UPDATE job_events SET payload_json = ? WHERE id = ?')
    .run(JSON.stringify({ previousMode: 'plan', mode: 'normal' }), approvalEvent.id)

  await runtime.runOneTick()
  const blocked = runtime.getJob(created.id, { userId })
  assert.equal(blocked.status, 'waiting')
  assert.deepEqual(executed, ['plan'])
  assert.equal(blocked.events.at(-1).type, 'plan_approval_required')
  assert.equal(runtime.approvePlan(created.id, { userId }).approved, true)
})

test('a failed approval transaction rolls back edited steps, status, and event together', async () => {
  const { userId } = issueTestSession()
  setApprovalMode({ userId, mode: 'plan' })
  const runtime = new JobRuntime({
    planner: (prompt) => ({
      title: 'Atomic approval',
      prompt,
      steps: [
        { id: 'plan', title: 'Propose plan', kind: 'plan' },
        { id: 'execute', title: 'Original atomic step', kind: 'execute' },
      ],
    }),
    executeStep: async ({ step }) => ({ ok: true, output: { text: step.title } }),
    modelBindingResolver: resolveTestModelBinding,
  })
  const created = await runtime.createJob('Approve atomically', { userId })
  const waiting = await runUntilJobStatus(runtime, created.id, userId, 'waiting')
  const proposal = waiting.events.find((event) => event.type === 'plan_proposed')
  const replacementSteps = waiting.steps
    .filter((step) => step.kind !== 'plan')
    .map((step, index) => ({
      ...step,
      title: index === 0 ? 'Should be rolled back' : step.title,
      status: 'queued',
    }))

  assert.throws(
    () => approveJobPlan({
      jobId: created.id,
      userId,
      proposalEventId: proposal.id,
      proposalPlanDigest: proposal.payload.planDigest,
      approvedPlanDigest: '0'.repeat(64),
      replacementSteps,
      edited: true,
      previousMode: 'plan',
      contract: JOB_PLAN_APPROVAL_CONTRACT,
      version: JOB_PLAN_APPROVAL_VERSION,
      computePlanDigest: computeJobPlanDigest,
    }),
    (error) => error?.code === 'JOB_PLAN_APPROVAL_DIGEST_MISMATCH',
  )
  const unchanged = runtime.getJob(created.id, { userId })
  assert.equal(unchanged.status, 'waiting')
  assert.equal(unchanged.steps.find((step) => step.kind === 'execute').title, 'Original atomic step')
  assert.equal(unchanged.events.some((event) => event.type === 'plan_approved'), false)
})
