import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(
  os.tmpdir(),
  'gugo-job-execution-recovery-tests',
  `${process.pid}-${Date.now()}`,
)
process.env.MODEL_BASE_URL = 'http://127.0.0.1:11434/v1'
process.env.MODEL_NAME = 'test-model'

const { issueTestSession } = await import('./helpers/testAuth.js')
const { JobRuntime } = await import('../server/services/jobRuntime.js')
const { createJobExecutionLeaseCoordinator } = await import(
  '../server/services/jobExecutionLeaseRuntime.js'
)
const { releaseJobExecutionLease } = await import('../server/services/jobExecutionLeaseStore.js')
const {
  appendJobSteps,
  createJob,
  getJobWithChildren,
  listJobEvents,
  updateJob,
  updateJobStep,
} = await import('../server/services/jobStore.js')

const { userId } = issueTestSession({ email: `job-recovery-${process.pid}@example.com` })

test('startup recovery leaves work owned by another live process untouched', () => {
  const jobId = `live-recovery-${process.pid}`
  const stepId = `${jobId}-step`
  createJob({ id: jobId, userId, title: jobId, prompt: jobId, status: 'running', modelName: 'test-model' })
  appendJobSteps(jobId, [{ id: stepId, title: 'execute', kind: 'execute', status: 'running' }])
  const liveOwner = createJobExecutionLeaseCoordinator({ ownerId: 'live-owner', leaseMs: 10_000 })
  assert.equal(liveOwner.claim(jobId), true)

  const observer = new JobRuntime({
    executionLeases: createJobExecutionLeaseCoordinator({ ownerId: 'observer', leaseMs: 10_000 }),
  })
  const untouched = getJobWithChildren(jobId, { userId })
  assert.equal(untouched.status, 'running')
  assert.equal(untouched.steps[0].status, 'running')
  assert.equal(untouched.events.some((event) => event.type === 'recovered'), false)

  assert.equal(releaseJobExecutionLease({ jobId, ownerId: 'live-owner' }), true)
  const recovered = observer.recover()
  assert.equal(recovered.some((job) => job.id === jobId), true)
  assert.equal(getJobWithChildren(jobId, { userId }).status, 'queued')
  updateJob(jobId, { status: 'completed', progress: 100, finishedAt: Date.now() })
  updateJobStep(stepId, { status: 'completed', finishedAt: Date.now() })
})

test('replacement owner resumes once while the stale owner cannot write a terminal result', async () => {
  const jobId = `takeover-${process.pid}`
  const stepId = `${jobId}-step`
  createJob({ id: jobId, userId, title: jobId, prompt: jobId, status: 'queued', modelName: 'test-model' })
  appendJobSteps(jobId, [{ id: stepId, title: 'execute', kind: 'execute', status: 'queued' }])

  const firstLease = createJobExecutionLeaseCoordinator({ ownerId: 'takeover-a', leaseMs: 1_000 })
  const secondLease = createJobExecutionLeaseCoordinator({ ownerId: 'takeover-b', leaseMs: 1_000 })
  let firstSignal
  const firstStarted = new Promise((resolve) => {
    firstSignal = resolve
  })
  const firstRuntime = new JobRuntime({
    executionLeases: firstLease,
    executeStep: async ({ signal }) => new Promise((resolve, reject) => {
      firstSignal(signal)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })
  const firstTick = firstRuntime.runOneTick()
  const staleSignal = await firstStarted
  assert.equal(releaseJobExecutionLease({ jobId, ownerId: 'takeover-a' }), true)
  assert.equal(secondLease.claim(jobId), true)
  let takeoverTimeout
  try {
    await Promise.race([
      firstTick,
      new Promise((resolve, reject) => {
        takeoverTimeout = setTimeout(
          () => reject(new Error('stale runtime was not aborted after lease replacement')),
          1_500,
        )
      }),
    ])
  } finally {
    clearTimeout(takeoverTimeout)
  }
  assert.equal(staleSignal.aborted, true)
  assert.equal(staleSignal.reason?.code, 'JOB_EXECUTION_LEASE_LOST')
  const afterLoss = getJobWithChildren(jobId, { userId })
  assert.equal(afterLoss.status, 'running')
  assert.equal(afterLoss.steps[0].status, 'running')
  assert.equal(
    listJobEvents(jobId).some((event) => ['completed', 'failed', 'cancelled'].includes(event.type)),
    false,
  )

  let replacementExecutions = 0
  const secondRuntime = new JobRuntime({
    executionLeases: secondLease,
    executeStep: async () => {
      replacementExecutions += 1
      return { ok: true, output: { text: 'done' } }
    },
  })
  assert.equal(await secondRuntime.runOneTick(), true)
  assert.equal(await secondRuntime.runOneTick(), true)
  assert.equal(replacementExecutions, 1)
  const completed = getJobWithChildren(jobId, { userId })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.steps[0].status, 'completed')
  assert.equal(completed.events.filter((event) => event.type === 'completed').length, 1)
})

test('a durable cancel from another runtime aborts the lease owner', async () => {
  const firstLease = createJobExecutionLeaseCoordinator({ ownerId: 'cancel-owner-a', leaseMs: 1_000 })
  const secondLease = createJobExecutionLeaseCoordinator({ ownerId: 'cancel-owner-b', leaseMs: 1_000 })
  let signalStarted
  const started = new Promise((resolve) => { signalStarted = resolve })
  const firstRuntime = new JobRuntime({
    executionLeases: firstLease,
    planner: (prompt) => ({ title: prompt, steps: [{ kind: 'execute', title: 'execute' }] }),
    executeStep: async ({ signal }) => new Promise((resolve, reject) => {
      signalStarted(signal)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })
  const job = await firstRuntime.createJob('cross runtime cancellation', { userId })
  const firstTick = firstRuntime.runOneTick()
  const ownerSignal = await started
  const secondRuntime = new JobRuntime({ executionLeases: secondLease })
  const requested = secondRuntime.requestCancel(job.id, { userId })
  assert.equal(requested.status, 'cancel_requested')

  await Promise.race([
    firstTick,
    new Promise((_, reject) => setTimeout(() => reject(new Error('lease owner did not observe durable cancel')), 2_000)),
  ])
  assert.equal(ownerSignal.aborted, true)
  assert.equal(ownerSignal.reason?.code, 'JOB_CANCEL_REQUESTED')
  const cancelled = firstRuntime.getJob(job.id, { userId })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.steps[0].status, 'cancelled')
})
