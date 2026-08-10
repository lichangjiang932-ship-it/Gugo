import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'gugo-job-execution-lease-tests', String(process.pid))

const { issueTestSession } = await import('./helpers/testAuth.js')
const { createJob } = await import('../server/services/jobStore.js')
const {
  claimJobExecutionLease,
  releaseJobExecutionLease,
  renewJobExecutionLease,
} = await import('../server/services/jobExecutionLeaseStore.js')
const { createJobExecutionLeaseCoordinator } = await import(
  '../server/services/jobExecutionLeaseRuntime.js'
)

test('job execution lease is exclusive, renewable, and recoverable after expiry', () => {
  const { userId } = issueTestSession()
  createJob({ id: 'lease-job', userId, title: 'lease', prompt: 'lease' })
  assert.equal(claimJobExecutionLease({ jobId: 'lease-job', ownerId: 'worker-a', now: 1_000, leaseMs: 2_000 }), true)
  assert.equal(claimJobExecutionLease({ jobId: 'lease-job', ownerId: 'worker-b', now: 2_000, leaseMs: 2_000 }), false)
  assert.equal(renewJobExecutionLease({ jobId: 'lease-job', ownerId: 'worker-a', now: 2_000, leaseMs: 2_000 }), true)
  assert.equal(claimJobExecutionLease({ jobId: 'lease-job', ownerId: 'worker-b', now: 3_999, leaseMs: 2_000 }), false)
  assert.equal(claimJobExecutionLease({ jobId: 'lease-job', ownerId: 'worker-b', now: 4_000, leaseMs: 2_000 }), true)
  assert.equal(releaseJobExecutionLease({ jobId: 'lease-job', ownerId: 'worker-a' }), false)
  assert.equal(releaseJobExecutionLease({ jobId: 'lease-job', ownerId: 'worker-b' }), true)
})

test('a worker is aborted when another owner replaces its execution lease', async () => {
  const { userId } = issueTestSession()
  const jobId = `lease-loss-${process.pid}-${Date.now()}`
  createJob({ id: jobId, userId, title: 'lease loss', prompt: 'lease loss' })
  const first = createJobExecutionLeaseCoordinator({ ownerId: 'worker-loss-a', leaseMs: 1_000 })
  const second = createJobExecutionLeaseCoordinator({ ownerId: 'worker-loss-b', leaseMs: 1_000 })
  assert.equal(first.claim(jobId), true)
  const controller = new AbortController()
  const stopHolding = first.hold(jobId, controller)
  assert.equal(releaseJobExecutionLease({ jobId, ownerId: 'worker-loss-a' }), true)
  assert.equal(second.claim(jobId), true)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('lease loss did not abort the worker')), 1_500)
    controller.signal.addEventListener('abort', () => {
      clearTimeout(timeout)
      resolve()
    }, { once: true })
  })
  assert.equal(controller.signal.reason?.code, 'JOB_EXECUTION_LEASE_LOST')
  let oldOwnerCommitted = false
  assert.equal(first.runIfOwned(jobId, () => { oldOwnerCommitted = true }).owned, false)
  assert.equal(oldOwnerCommitted, false)
  assert.equal(second.runIfOwned(jobId, () => 'committed').value, 'committed')
  stopHolding()
  assert.equal(releaseJobExecutionLease({ jobId, ownerId: 'worker-loss-b' }), true)
})
