import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-abort-tests', String(process.pid))
process.env.MODEL_BASE_URL = 'http://127.0.0.1:11434/v1'
process.env.MODEL_NAME = 'test-model'

const { abortJob, getJobRuntime, closeJobRuntime } = await import('../server/services/jobRuntime.js')
const { createAppServer } = await import('../server/appServer.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const TEST_USER = issueTestSession().userId
const TEST_MODEL_ENV = {
  MODEL_BASE_URL: 'http://127.0.0.1:11434/v1',
  MODEL_NAME: 'test-model',
}

test('abortJob terminates an in-flight job via AbortController signal', async () => {
  // 不能用 new JobRuntime() —— abortJob 走 singleton。用 singleton。
  closeJobRuntime()
  // monkey-patch singleton 工厂走我们自己的 executeStep
  const runtime = getJobRuntime()
  runtime.stop() // 停 timer,改成手动 drain
  runtime.planner = (prompt) => ({
    title: prompt,
    steps: [{ kind: 'execute', title: '执行' }],
  })
  // 替换 executeStep 让它 hang 在 signal 上
  let sawAbort = false
  runtime.executeStep = async ({ signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) {
      sawAbort = true
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      return
    }
    signal.addEventListener('abort', () => {
      sawAbort = true
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }, { once: true })
  })

  try {
    const job = await runtime.createJob('生成长文', { userId: TEST_USER })
    const tick = runtime.runOneTick()
    // 让 tick 进到 await executeStep
    await new Promise((resolve) => setTimeout(resolve, 0))

    const result = abortJob(job.id, { userId: TEST_USER })
    assert.ok(result?.ok, 'abortJob 应返回 ok')

    await tick
    const loaded = runtime.getJob(job.id, { userId: TEST_USER })
    assert.equal(sawAbort, true, 'signal 应被触发')
    assert.equal(loaded.status, 'cancelled')
    assert.equal(loaded.steps[0].status, 'cancelled')
  } finally {
    closeJobRuntime()
  }
})

test('abortJob returns null for unknown job id and 404 over HTTP', async () => {
  closeJobRuntime()
  const { token } = issueTestSession()
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    // 模块级直接调用 → null
    const result = abortJob('job-does-not-exist', { userId: TEST_USER })
    assert.equal(result, null)

    // HTTP 路由 → 404
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs/job-not-here/abort`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    closeJobRuntime()
  }
})

test('POST /api/jobs/:id/abort returns {ok:true} and cancels owner job', async () => {
  closeJobRuntime()
  const { token, userId } = issueTestSession()
  const server = createAppServer({ getEnv: () => TEST_MODEL_ENV })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: '生成 2 份周报' }),
    })
    assert.equal(createRes.status, 201)
    const { job } = await createRes.json()

    const abortRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}/abort`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(abortRes.status, 200)
    const body = await abortRes.json()
    assert.deepEqual(body, { ok: true })

    // 其他用户不能 abort
    const other = issueTestSession()
    const denyRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}/abort`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${other.token}` },
    })
    assert.equal(denyRes.status, 404)

    // 未登录 → 401
    const noAuth = await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}/abort`, {
      method: 'POST',
    })
    assert.equal(noAuth.status, 401)

    void userId
  } finally {
    await new Promise((resolve) => server.close(resolve))
    closeJobRuntime()
  }
})
