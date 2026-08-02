import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-steering-route-tests', `${process.pid}-${Date.now()}`)

const { createAppServer } = await import('../server/appServer.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

test('job steering route accepts active jobs and rejects cross-user access', async () => {
  const alice = issueTestSession()
  const bob = issueTestSession()
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const aliceHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` }

  try {
    const createdResponse = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers: aliceHeaders,
      body: JSON.stringify({ prompt: 'Create a long report' }),
    })
    assert.equal(createdResponse.status, 201)
    const { job } = await createdResponse.json()

    const steerResponse = await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}/steer`, {
      method: 'POST',
      headers: aliceHeaders,
      body: JSON.stringify({ content: 'Deliver CSV only.' }),
    })
    assert.equal(steerResponse.status, 202)
    const steered = await steerResponse.json()
    assert.equal(steered.accepted, true)
    assert.equal(steered.message.content, 'Deliver CSV only.')

    const denied = await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}/steer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ content: 'Hijack' }),
    })
    assert.equal(denied.status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
