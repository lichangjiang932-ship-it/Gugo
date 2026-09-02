import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-routes-tests', String(process.pid))
process.env.MODEL_BASE_URL = 'http://127.0.0.1:11434/v1'
process.env.MODEL_NAME = 'test-model'

const { createAppServer } = await import('../server/appServer.js')
const { getJobRuntime, JobRuntime, setJobRuntimeForTesting } = await import('../server/services/jobRuntime.js')
const {
  recordModelProviderReadiness,
  upsertModelProvider,
} = await import('../server/services/modelProviderStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const AGENT_MODEL_ENV = Object.freeze({
  MODEL_BASE_URL: 'https://models.example.test/v1',
  MODEL_NAME: 'route-test-model',
})

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

  const server = createAppServer({ getEnv: () => AGENT_MODEL_ENV })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const createdResponse = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ prompt: '生成 2 份周报', requirePlanApproval: true, autoRetry: true }),
    })
    assert.equal(createdResponse.status, 201)
    const created = await createdResponse.json()
    assert.equal(created.job.title, '生成 2 份周报')
    assert.equal(created.job.steps.find((step) => step.kind === 'plan').input.requirePlanApproval, true)
    assert.deepEqual(created.job.autoRetry, {
      enabled: true,
      maxAttempts: 2,
      attempts: 0,
      baseDelayMs: 1_000,
    })

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

test('job routes persist the selected model for later execution and recovery', async () => {
  const { token } = issueTestSession()
  const server = createAppServer({ getEnv: () => AGENT_MODEL_ENV })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: 'model-specific job', modelName: ' long-context-model ' }),
    })
    assert.equal(response.status, 201)
    const { job } = await response.json()
    assert.equal(job.modelName, 'long-context-model')

    const detailResponse = await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(detailResponse.status, 200)
    assert.equal((await detailResponse.json()).job.modelName, 'long-context-model')
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

test('job creation rejects missing, unverified and chat-only models before persistence', async () => {
  const { token, userId } = issueTestSession()
  const runtime = getJobRuntime()
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  const before = runtime.listJobs({ userId }).length

  const missingServer = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => missingServer.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${missingServer.address().port}/api/jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: 'must not be created' }),
    })
    assert.equal(response.status, 503)
    const missingError = (await response.json()).error
    assert.match(missingError.message, /设置.*模型/)
    assert.deepEqual({ ...missingError, message: '<localized>' }, {
      code: 'MODEL_CONFIG_MISSING',
      message: '<localized>',
      action: 'configure_model',
      providerId: null,
      modelName: null,
      configRevision: null,
    })
    assert.equal(Object.hasOwn(missingError, 'details'), false)
    assert.doesNotMatch(JSON.stringify(missingError), /"missing"|MODEL_BASE_URL|MODEL_NAME/)
    assert.equal(runtime.listJobs({ userId }).length, before)
  } finally {
    await new Promise((resolve) => missingServer.close(resolve))
  }

  const provider = upsertModelProvider({
    userId,
    provider: {
      key: `job-gate-${Date.now()}`,
      label: 'Job readiness gate',
      baseUrl: 'https://models.example.test/v1',
      models: ['job-gate-model'],
      defaultModel: 'job-gate-model',
      enabled: true,
      isDefault: true,
    },
  })
  const providerServer = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${providerServer.address().port}/api/jobs`
  try {
    const unverified = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: 'unverified', providerId: provider.id }),
    })
    assert.equal(unverified.status, 409)
    assert.equal((await unverified.json()).error.code, 'MODEL_PROVIDER_UNVERIFIED')
    assert.equal(runtime.listJobs({ userId }).length, before)

    recordModelProviderReadiness({
      userId,
      id: provider.id,
      readiness: { chat: true, tools: false, agent: false, mode: 'chat_only' },
    })
    const chatOnly = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: 'chat only', providerId: provider.id }),
    })
    assert.equal(chatOnly.status, 409)
    assert.equal((await chatOnly.json()).error.code, 'MODEL_PROVIDER_CHAT_ONLY')
    assert.equal(runtime.listJobs({ userId }).length, before)

    recordModelProviderReadiness({
      userId,
      id: provider.id,
      readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
    })
    const statusResponse = await fetch(
      `http://127.0.0.1:${providerServer.address().port}/api/model/status`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    assert.equal(statusResponse.status, 200)
    const status = await statusResponse.json()
    const selected = status.models.find((model) => model.name === 'job-gate-model')
    assert.equal(selected.provider, provider.id)
    assert.equal(selected.providerKey, provider.key)

    const ready = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: 'agent ready',
        providerId: selected.provider,
        modelName: selected.name,
      }),
    })
    assert.equal(ready.status, 201)
    const { job } = await ready.json()
    assert.equal(job.modelName, 'job-gate-model')
    assert.equal(job.modelProviderId, provider.id)
    assert.equal(job.modelConfigRevision, provider.configRevision)
  } finally {
    await new Promise((resolve) => providerServer.close(resolve))
  }
})

test('job creation returns a safe structured error when the planner model rejects authentication', async () => {
  const { token, userId } = issueTestSession()
  const previousRuntime = getJobRuntime()
  const secret = 'sk-planner-secret-must-not-leak'
  const runtime = new JobRuntime({
    planner: async () => {
      throw Object.assign(new Error(`upstream exposed ${secret} at https://private.example.test`), {
        status: 401,
      })
    },
  })
  setJobRuntimeForTesting(runtime)
  const server = createAppServer({ getEnv: () => AGENT_MODEL_ENV })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: 'planner authentication failure' }),
    })
    assert.equal(response.status, 502)
    const body = await response.json()
    assert.equal(body.error.code, 'MODEL_AUTH_FAILED')
    assert.equal(body.error.action, 'test_provider')
    assert.equal(body.error.modelName, AGENT_MODEL_ENV.MODEL_NAME)
    assert.doesNotMatch(JSON.stringify(body), new RegExp(secret))
    assert.doesNotMatch(JSON.stringify(body), /private\.example\.test/)
    assert.equal(runtime.listJobs({ userId }).length, 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    setJobRuntimeForTesting(previousRuntime)
  }
})

test('job creation does not trust a forged model failure error name', async () => {
  const { token } = issueTestSession()
  const previousRuntime = getJobRuntime()
  const secret = 'sk-forged-wrapper-must-not-leak'
  const runtime = new JobRuntime({
    planner: async () => {
      const error = Object.assign(
        new Error(`internal ${secret} at https://private.example.test`),
        {
          name: 'JobModelFailureError',
          code: 'MODEL_INTERNAL_INVARIANT',
          action: 'test_provider',
        },
      )
      throw error
    },
  })
  setJobRuntimeForTesting(runtime)
  const server = createAppServer({ getEnv: () => AGENT_MODEL_ENV })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: 'must keep internal planner errors private' }),
    })
    const body = await response.text()
    assert.equal(response.status, 500)
    assert.doesNotMatch(body, new RegExp(secret))
    assert.doesNotMatch(body, /private\.example\.test/)
    assert.doesNotMatch(body, /MODEL_INTERNAL_INVARIANT/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    setJobRuntimeForTesting(previousRuntime)
  }
})

test('job creation rejects an ambiguous model name and accepts an explicit Provider UUID', async () => {
  const { token, userId } = issueTestSession()
  const runtime = getJobRuntime()
  const before = runtime.listJobs({ userId }).length
  const modelName = `job-ambiguous-model-${Date.now()}`
  const providers = ['job-ambiguous-a', 'job-ambiguous-b'].map((key) => upsertModelProvider({
    userId,
    provider: {
      key,
      label: key,
      baseUrl: `https://${key}.example.test/v1`,
      models: [modelName],
      defaultModel: modelName,
      enabled: true,
    },
  }))
  for (const provider of providers) {
    recordModelProviderReadiness({
      userId,
      id: provider.id,
      readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
    })
  }
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/api/jobs`
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  try {
    const ambiguous = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: 'do not choose silently', modelName }),
    })
    assert.equal(ambiguous.status, 409)
    const ambiguousBody = await ambiguous.json()
    assert.equal(ambiguousBody.error.code, 'MODEL_PROVIDER_AMBIGUOUS')
    assert.equal(ambiguousBody.error.action, 'choose_agent_provider')
    assert.equal(ambiguousBody.error.modelName, modelName)
    assert.equal(runtime.listJobs({ userId }).length, before)

    const explicit = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: 'use the selected provider',
        modelName,
        providerId: providers[1].id,
      }),
    })
    assert.equal(explicit.status, 201)
    const explicitBody = await explicit.json()
    assert.equal(explicitBody.job.modelProviderId, providers[1].id)
    assert.equal(explicitBody.job.modelName, modelName)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('one user cannot fetch another user\'s job', async () => {
  const alice = issueTestSession()
  const bob = issueTestSession()
  const server = createAppServer({ getEnv: () => AGENT_MODEL_ENV })
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

test('plan approval cannot be bypassed through retry or manual completion routes', async () => {
  const { token, userId } = issueTestSession()
  const previousRuntime = getJobRuntime()
  const runtime = new JobRuntime({
    planner: (prompt) => ({
      title: prompt,
      steps: [
        { kind: 'plan', title: 'Plan work' },
        { kind: 'execute', title: 'Execute work' },
      ],
    }),
    executeStep: async ({ step }) => ({ ok: true, output: { text: step.title } }),
  })
  setJobRuntimeForTesting(runtime)
  let server = null

  try {
    const job = await runtime.createJob('approval route gate', {
      userId,
      requirePlanApproval: true,
    })
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (runtime.getJob(job.id, { userId })?.status === 'waiting') break
      if (!await runtime.runOneTick()) break
    }
    const waiting = runtime.getJob(job.id, { userId })
    const executeStep = waiting.steps.find((step) => step.kind === 'execute')
    assert.equal(waiting.status, 'waiting')

    server = createAppServer({ getEnv: () => ({}) })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    const requests = [
      [`/api/jobs/${job.id}/retry`, {}],
      [`/api/jobs/${job.id}/steps/${encodeURIComponent(executeStep.id)}/retry`, {}],
      [`/api/jobs/${job.id}/steps/${encodeURIComponent(executeStep.id)}/complete`, {
        evidence: [{ type: 'tool_result', summary: 'forged completion', toolCallId: 'forged', ok: true }],
      }],
    ]

    for (const [pathname, body] of requests) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 409)
      assert.equal((await response.json()).code, 'JOB_PLAN_APPROVAL_REQUIRED')
    }
    assert.equal(runtime.getJob(job.id, { userId }).status, 'waiting')
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    setJobRuntimeForTesting(previousRuntime)
  }
})

test('job and step retry routes preserve structured model-request recovery conflicts', async () => {
  const { token } = issueTestSession()
  const previousRuntime = getJobRuntime()
  const runtime = new JobRuntime({
    planner: (prompt) => ({
      title: prompt,
      steps: [{ kind: 'execute', title: 'Execute work' }],
    }),
  })
  const recoveryError = (code, overrides = {}) => Object.assign(
    new Error(code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
      ? 'The upstream request may already have been accepted.'
      : 'The saved request belongs to a different model configuration.'),
    {
      code,
      requiresUserVerification: code === 'MODEL_REQUEST_OUTCOME_UNKNOWN',
      recoveryKind: code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
        ? 'model_request_outcome_unknown'
        : 'model_request_context_drift',
      modelRequestId: 'mr_route-recovery',
      stepId: 'step/with spaces',
      providerId: 'provider-old',
      modelName: 'model-old',
      configRevision: 7,
      targetProviderId: 'provider-new',
      targetModelName: 'model-new',
      targetConfigRevision: 8,
      action: code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
        ? 'verify_model_request'
        : 'recreate_job',
      ...overrides,
    },
  )
  runtime.retryJob = () => {
    throw recoveryError('MODEL_REQUEST_OUTCOME_UNKNOWN')
  }
  runtime.retryStep = (_jobId, stepId) => {
    assert.equal(stepId, 'step/with spaces')
    throw recoveryError('MODEL_REQUEST_CONTEXT_DRIFT', {
      modelRequestId: null,
      requiresUserVerification: false,
    })
  }
  setJobRuntimeForTesting(runtime)
  const server = createAppServer({ getEnv: () => AGENT_MODEL_ENV })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const requests = [
      {
        pathname: '/api/jobs/job-route-recovery/retry',
        expected: {
          code: 'MODEL_REQUEST_OUTCOME_UNKNOWN',
          message: 'The upstream request may already have been accepted.',
          retryable: false,
          unsafeToReplay: true,
          requiresUserVerification: true,
          recoveryKind: 'model_request_outcome_unknown',
          modelRequestId: 'mr_route-recovery',
          stepId: 'step/with spaces',
          providerId: 'provider-old',
          modelName: 'model-old',
          configRevision: 7,
          targetProviderId: 'provider-new',
          targetModelName: 'model-new',
          targetConfigRevision: 8,
          action: 'verify_model_request',
        },
      },
      {
        pathname: '/api/jobs/job-route-recovery/steps/step%2Fwith%20spaces/retry',
        expected: {
          code: 'MODEL_REQUEST_CONTEXT_DRIFT',
          message: 'The saved request belongs to a different model configuration.',
          retryable: false,
          unsafeToReplay: true,
          requiresUserVerification: false,
          recoveryKind: 'model_request_context_drift',
          modelRequestId: null,
          stepId: 'step/with spaces',
          providerId: 'provider-old',
          modelName: 'model-old',
          configRevision: 7,
          targetProviderId: 'provider-new',
          targetModelName: 'model-new',
          targetConfigRevision: 8,
          action: 'recreate_job',
        },
      },
    ]

    for (const { pathname, expected } of requests) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(response.status, 409)
      assert.deepEqual(await response.json(), { error: expected })
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
    setJobRuntimeForTesting(previousRuntime)
  }
})

test('manual completion route rejects empty evidence for execution steps', async () => {
  const { token, userId } = issueTestSession()
  const runtime = getJobRuntime()
  const job = await runtime.createPlan({
    userId,
    title: 'Route evidence gate',
    prompt: 'Execute route work',
    steps: [{ id: 'work', title: 'Execute work', kind: 'execute' }],
  })
  const step = job.steps.find((item) => item.kind === 'execute')
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const url = `http://127.0.0.1:${port}/api/jobs/${job.id}/steps/${encodeURIComponent(step.id)}/complete`
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  try {
    const missing = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ evidence: [] }),
    })
    assert.equal(missing.status, 422)
    assert.equal((await missing.json()).code, 'JOB_COMPLETION_EVIDENCE_REQUIRED')

    const unstructured = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ evidence: ['done'] }),
    })
    assert.equal(unstructured.status, 422)
    assert.equal((await unstructured.json()).code, 'JOB_COMPLETION_EVIDENCE_INVALID')
    assert.equal(runtime.getJob(job.id, { userId }).steps.find((item) => item.id === step.id).status, 'queued')

    const accepted = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        evidence: [{
          type: 'tool_result',
          summary: 'Execution completed successfully',
          toolCallId: 'route-tool-call',
          ok: true,
        }],
      }),
    })
    assert.equal(accepted.status, 200)
    assert.equal(runtime.getJob(job.id, { userId }).steps.find((item) => item.id === step.id).status, 'completed')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
