import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const testDataDir = path.join(os.tmpdir(), 'yma-job-plan-contract-tests', `${process.pid}-${Date.now()}`)
process.env.APP_DATA_DIR = testDataDir
process.env.APP_DB_PATH = path.join(testDataDir, 'app.db')

const { JobRuntime } = await import('../server/services/jobRuntime.js')
const { getApprovalMode, setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

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
  assert.equal(approval.mode, 'normal')
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
