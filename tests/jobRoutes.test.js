import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppServer } from '../server/appServer.js'

test('job routes create, fetch, and cancel jobs', async () => {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const createdResponse = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '生成 2 份周报' }),
    })
    assert.equal(createdResponse.status, 201)
    const created = await createdResponse.json()
    assert.equal(created.job.title, '生成 2 份周报')

    const detailResponse = await fetch(`http://127.0.0.1:${port}/api/jobs/${created.job.id}`)
    assert.equal(detailResponse.status, 200)
    const detail = await detailResponse.json()
    assert.equal(detail.job.id, created.job.id)

    const cancelResponse = await fetch(`http://127.0.0.1:${port}/api/jobs/${created.job.id}/cancel`, {
      method: 'POST',
    })
    assert.equal(cancelResponse.status, 200)
    const cancelled = await cancelResponse.json()
    assert.equal(cancelled.job.status, 'cancel_requested')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

