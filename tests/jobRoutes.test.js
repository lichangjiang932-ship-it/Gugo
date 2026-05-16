import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-routes-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

test('job routes create, fetch, and cancel jobs', async () => {
  const { token } = issueTestSession()
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const createdResponse = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ prompt: '生成 2 份周报' }),
    })
    assert.equal(createdResponse.status, 201)
    const created = await createdResponse.json()
    assert.equal(created.job.title, '生成 2 份周报')

    const detailResponse = await fetch(`http://127.0.0.1:${port}/api/jobs/${created.job.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(detailResponse.status, 200)
    const detail = await detailResponse.json()
    assert.equal(detail.job.id, created.job.id)

    const cancelResponse = await fetch(`http://127.0.0.1:${port}/api/jobs/${created.job.id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(cancelResponse.status, 200)
    const cancelled = await cancelResponse.json()
    assert.equal(cancelled.job.status, 'cancel_requested')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('job routes reject unauthenticated requests', async () => {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '未授权请求' }),
    })
    assert.equal(res.status, 401)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('one user cannot fetch another user\'s job', async () => {
  const alice = issueTestSession()
  const bob = issueTestSession()
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const aliceCreate = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ prompt: 'alice 的任务' }),
    })
    assert.equal(aliceCreate.status, 201)
    const { job } = await aliceCreate.json()

    // Bob 用自己的 token 拉 alice 的 jobId → 404 (不能区分「不存在」和「无权」)
    const bobFetch = await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    })
    assert.equal(bobFetch.status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
