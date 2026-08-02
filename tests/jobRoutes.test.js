import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-routes-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { getJobRuntime, JobRuntime, setJobRuntimeForTesting } = await import('../server/services/jobRuntime.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

// ★ 用 stub planner 替换真 planner。
//
// 这个用例测的是「路由的 CRUD 对不对」,不是「模型会怎么起标题」。
// 原来走真 planner 意味着每次跑测试都要真打上游 API:单个用例 119 秒、
// 需要配 key、而且断言会因为模型今天用中文明天用英文起标题而随机变红。
setJobRuntimeForTesting(new JobRuntime({
  planner: (prompt) => ({
    title: String(prompt || '').slice(0, 200),
    steps: [{ kind: 'execute', title: '执行', prompt }],
  }),
}))

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

test('job event stream sends proxy-safe SSE headers and releases its subscription on disconnect', async () => {
  const { token } = issueTestSession()
  const runtime = getJobRuntime()
  const listenersBefore = runtime.listeners.size
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const controller = new AbortController()

  try {
    const ticketResponse = await fetch(`http://127.0.0.1:${port}/api/jobs/stream-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(ticketResponse.status, 201)
    const { ticket } = await ticketResponse.json()

    const streamResponse = await fetch(
      `http://127.0.0.1:${port}/api/jobs/stream?ticket=${encodeURIComponent(ticket)}`,
      { signal: controller.signal },
    )
    assert.equal(streamResponse.status, 200)
    assert.match(streamResponse.headers.get('content-type') || '', /text\/event-stream/)
    assert.equal(streamResponse.headers.get('cache-control'), 'no-cache, no-transform')
    assert.equal(streamResponse.headers.get('x-accel-buffering'), 'no')

    const reader = streamResponse.body.getReader()
    const firstChunk = await reader.read()
    assert.match(new TextDecoder().decode(firstChunk.value), /event: ready[\s\S]*data: \{"ok":true\}/)
    assert.equal(runtime.listeners.size, listenersBefore + 1)

    controller.abort()
    await reader.cancel().catch(() => {})
    for (let attempt = 0; attempt < 20 && runtime.listeners.size !== listenersBefore; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(runtime.listeners.size, listenersBefore)
  } finally {
    controller.abort()
    await new Promise((resolve) => server.close(resolve))
  }
})
