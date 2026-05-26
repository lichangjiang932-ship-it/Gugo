import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-cron-routes-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { closeCronScheduler } = await import('../server/services/cronScheduler.js')
const { closeJobRuntime } = await import('../server/services/jobRuntime.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

async function withServer(fn) {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test.after(() => {
  closeCronScheduler()
  closeJobRuntime()
  closeDb()
})

test('cron routes CRUD return 200/201 for authenticated users', async () => {
  const { token } = issueTestSession()
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/cron-jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'Route digest',
        kind: 'cron',
        scheduleType: 'every',
        scheduleValue: '60000',
        execType: 'direct_notify',
        execPayload: { title: 'Route digest', body: 'Created from route' },
      }),
    })
    assert.equal(createResponse.status, 201)
    const created = await createResponse.json()
    assert.ok(created.job.id)

    const listResponse = await fetch(`${baseUrl}/api/cron-jobs`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(listResponse.status, 200)
    const listed = await listResponse.json()
    assert.ok(listed.jobs.some((job) => job.id === created.job.id))
    assert.equal(typeof listed.activeCount, 'number')

    const patchResponse = await fetch(`${baseUrl}/api/cron-jobs/${created.job.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: false }),
    })
    assert.equal(patchResponse.status, 200)
    const patched = await patchResponse.json()
    assert.equal(patched.job.enabled, false)

    const runResponse = await fetch(`${baseUrl}/api/cron-jobs/${created.job.id}/run-now`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(runResponse.status, 200)
    const run = await runResponse.json()
    assert.equal(run.status, 'success')

    const deleteResponse = await fetch(`${baseUrl}/api/cron-jobs/${created.job.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(deleteResponse.status, 200)
  })
})

test('cron routes reject unauthenticated requests', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/cron-jobs`, {
      method: 'GET',
    })
    assert.equal(response.status, 401)
  })
})
