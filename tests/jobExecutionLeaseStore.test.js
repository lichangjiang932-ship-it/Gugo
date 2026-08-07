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
