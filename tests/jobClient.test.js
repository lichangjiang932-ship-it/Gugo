import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cancelJob,
  createJob,
  getJob,
  listJobs,
  retryJob,
  retryStep,
  subscribeToJobEvents,
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

test('subscribeToJobEvents exchanges a one-time ticket and connects with ?ticket=', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return { ok: true, status: 201, json: async () => ({ ticket: 'st_abc', expiresIn: 60 }) }
  }
  let connectedUrl = null
  class FakeES {
    constructor(url) { connectedUrl = url }
    addEventListener() {}
    close() {}
  }

  const unsubscribe = subscribeToJobEvents(() => {}, { EventSourceImpl: FakeES, fetchImpl })
  // allow the async ticket exchange to resolve
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(calls[0].url, '/api/jobs/stream-ticket')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(connectedUrl, '/api/jobs/stream?ticket=st_abc')
  // never leaks a token in the query string
  assert.ok(!String(connectedUrl).includes('token='))
  unsubscribe()
})

