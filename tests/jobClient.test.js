import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cancelJob,
  createJob,
  getJob,
  listJobs,
  retryJob,
  retryStep,
} from '../src/lib/jobClient.js'

test('job client uses expected endpoints', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      json: async () => ({ job: { id: 'job-1' }, jobs: [] }),
    }
  }

  await createJob('生成周报', { fetchImpl })
  await listJobs({ fetchImpl })
  await getJob('job-1', { fetchImpl })
  await cancelJob('job-1', { fetchImpl })
  await retryJob('job-1', { fetchImpl })
  await retryStep('job-1', 'step-1', { fetchImpl })

  assert.deepEqual(calls.map((call) => call.url), [
    '/api/jobs',
    '/api/jobs',
    '/api/jobs/job-1',
    '/api/jobs/job-1/cancel',
    '/api/jobs/job-1/retry',
    '/api/jobs/job-1/steps/step-1/retry',
  ])
})

