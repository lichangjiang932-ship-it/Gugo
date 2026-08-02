import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-steering-tests', `${process.pid}-${Date.now()}`)

const { closeDb, createUser, DB_SCHEMA_VERSION, getSchemaVersion } = await import('../server/db.js')
const { createJob } = await import('../server/services/jobStore.js')
const {
  acknowledgeJobSteering,
  claimJobSteering,
  enqueueJobSteering,
  listJobSteering,
  releaseAllJobSteeringLeases,
  releaseJobSteeringLease,
} = await import('../server/services/jobSteeringStore.js')

const alice = `steering-alice-${process.pid}`
const bob = `steering-bob-${process.pid}`
createUser({ id: alice, email: `${alice}@example.com` })
createUser({ id: bob, email: `${bob}@example.com` })
createJob({ id: 'job-steering-store', userId: alice, title: 'Steering', prompt: 'Initial', status: 'running' })

test('v21 steering queue leases, releases, and acknowledges without losing text', () => {
  assert.equal(getSchemaVersion(), DB_SCHEMA_VERSION)
  const original = '改成只输出 CSV；不要生成 PDF。'
  const queued = enqueueJobSteering({ jobId: 'job-steering-store', userId: alice, content: original })
  assert.equal(queued.content, original)

  const firstLease = claimJobSteering({ jobId: 'job-steering-store', userId: alice })
  assert.equal(firstLease.messages.length, 1)
  assert.equal(firstLease.messages[0].content, original)
  assert.equal(listJobSteering({ jobId: 'job-steering-store', userId: alice, status: 'leased' }).length, 1)

  assert.equal(releaseJobSteeringLease({
    jobId: 'job-steering-store',
    userId: alice,
    leaseId: firstLease.leaseId,
  }), 1)
  const secondLease = claimJobSteering({ jobId: 'job-steering-store', userId: alice })
  assert.equal(secondLease.messages[0].content, original)
  assert.equal(acknowledgeJobSteering({
    jobId: 'job-steering-store',
    userId: alice,
    leaseId: secondLease.leaseId,
  }), 1)
  assert.equal(listJobSteering({ jobId: 'job-steering-store', userId: alice, status: 'consumed' }).length, 1)
})

test('startup recovery requeues leases and user isolation is enforced', () => {
  enqueueJobSteering({ jobId: 'job-steering-store', userId: alice, content: '第二条插话' })
  const lease = claimJobSteering({ jobId: 'job-steering-store', userId: alice })
  assert.ok(lease.leaseId)
  assert.equal(releaseAllJobSteeringLeases(), 1)
  assert.equal(listJobSteering({ jobId: 'job-steering-store', userId: alice, status: 'queued' }).length, 1)
  assert.equal(enqueueJobSteering({ jobId: 'job-steering-store', userId: bob, content: '越权' }), null)
  assert.deepEqual(listJobSteering({ jobId: 'job-steering-store', userId: bob }), [])
})

test.after(() => closeDb())
