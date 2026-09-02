import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-store-tests', String(process.pid))

const {
  appendJobArtifact,
  appendJobEvent,
  appendJobSteps,
  completeJobStep,
  createJob,
  getJobStep,
  getJobWithChildren,
  listJobArtifacts,
  listJobEvents,
  listJobs,
  updateJob,
} = await import('../server/services/jobStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

test('job store persists parent job, child steps, events, and artifacts', () => {
  const { userId } = issueTestSession()
  const suffix = `${process.pid}-${Date.now()}`
  const jobId = `job-${suffix}`
  const firstStepId = `step-plan-${suffix}`
  const secondStepId = `step-batch-${suffix}`
  const job = createJob({
    id: jobId,
    userId,
    title: '生成 3 份周报',
    prompt: '生成 3 份周报',
    status: 'queued',
  })
  appendJobSteps(jobId, [
    { id: firstStepId, title: '规划任务', kind: 'plan' },
    { id: secondStepId, title: '生成周报', kind: 'batch_item' },
  ])
  appendJobEvent({
    jobId,
    type: 'created',
    code: 'JOB_CREATED',
    params: { title: '生成 3 份周报' },
  })
  appendJobArtifact({
    id: `artifact-${suffix}`,
    jobId,
    userId,
    stepId: secondStepId,
    type: 'docx',
    title: '周报',
    url: '/api/artifacts/report.docx',
    filename: 'report.docx',
  })
  updateJob(jobId, { status: 'running', progress: 50 })

  const loaded = getJobWithChildren(jobId, { userId })
  assert.equal(job.id, jobId)
  assert.equal(listJobs({ userId })[0].status, 'running')
  assert.equal(loaded.steps.length, 2)
  assert.deepEqual(listJobEvents(jobId)[0], {
    id: listJobEvents(jobId)[0].id,
    jobId,
    stepId: null,
    type: 'created',
    code: 'JOB_CREATED',
    params: { title: '生成 3 份周报' },
    payload: null,
    createdAt: listJobEvents(jobId)[0].createdAt,
  })
  assert.equal(listJobArtifacts(jobId)[0].filename, 'report.docx')

  // 另一个用户看不到这个 job
  const other = issueTestSession()
  assert.equal(listJobs({ userId: other.userId }).length, 0)
  assert.equal(getJobWithChildren(jobId, { userId: other.userId }), null)
})

test('job store requires structured evidence for manually completed execution steps', () => {
  const { userId } = issueTestSession()
  const suffix = `evidence-${process.pid}-${Date.now()}`
  const jobId = `job-${suffix}`
  const executeStepId = `step-execute-${suffix}`
  const batchStepId = `step-batch-${suffix}`
  const verifyStepId = `step-verify-${suffix}`
  const planStepId = `step-plan-${suffix}`
  createJob({ id: jobId, userId, title: 'Evidence gate', prompt: 'Complete work', status: 'queued' })
  appendJobSteps(jobId, [
    { id: executeStepId, title: 'Execute work', kind: 'execute' },
    { id: batchStepId, title: 'Execute batch item', kind: 'batch_item' },
    { id: verifyStepId, title: 'Verify work', kind: 'verify' },
    { id: planStepId, title: 'Plan work', kind: 'plan' },
  ])

  for (const stepId of [executeStepId, batchStepId, verifyStepId]) {
    assert.throws(
      () => completeJobStep(stepId),
      (error) => error?.code === 'JOB_COMPLETION_EVIDENCE_REQUIRED' && error?.statusCode === 422,
    )
    assert.equal(getJobStep(stepId).status, 'queued')
  }

  assert.throws(
    () => completeJobStep(executeStepId, { evidence: ['npm test passed'] }),
    (error) => error?.code === 'JOB_COMPLETION_EVIDENCE_INVALID',
  )
  assert.equal(getJobStep(executeStepId).status, 'queued')

  const completed = completeJobStep(executeStepId, {
    evidence: [{
      type: 'check',
      summary: 'Targeted tests passed',
      command: 'npm test -- target',
      exitCode: 0,
    }],
  })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.output.evidence, [{
    type: 'check',
    summary: 'Targeted tests passed',
    command: 'npm test -- target',
    ok: true,
    exitCode: 0,
  }])

  const plan = completeJobStep(planStepId)
  assert.equal(plan.status, 'completed')
  assert.deepEqual(plan.output.evidence, [])
})
