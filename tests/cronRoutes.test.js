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

const MODEL_ENV_KEYS = ['MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_NAMES', 'MODEL_PROVIDERS']

function snapshotModelEnv() {
  return Object.fromEntries(MODEL_ENV_KEYS.map((key) => [key, process.env[key]]))
}

function restoreModelEnv(previous) {
  for (const key of MODEL_ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
}

function clearModelEnv() {
  for (const key of MODEL_ENV_KEYS) delete process.env[key]
}

function configureLocalModelEnv() {
  clearModelEnv()
  process.env.MODEL_BASE_URL = 'http://127.0.0.1:11434/v1'
  process.env.MODEL_NAME = 'test-model'
}

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

test('agent-session cron creation fails before persistence when no model is configured', async () => {
  const previous = snapshotModelEnv()
  clearModelEnv()
  const { token } = issueTestSession()
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/cron-jobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Must not persist',
          kind: 'cron',
          scheduleType: 'every',
          scheduleValue: '60000',
          execType: 'agent_session',
          execPayload: { prompt: 'Run with a model' },
        }),
      })
      assert.equal(response.status, 503)
      const body = await response.json()
      assert.equal(body.error.code, 'MODEL_CONFIG_MISSING')
      assert.equal(body.error.action, 'configure_model')
      assert.match(body.error.message, /设置.*模型/)

      const listResponse = await fetch(`${baseUrl}/api/cron-jobs`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const listed = await listResponse.json()
      assert.equal(listed.jobs.some((job) => job.title === 'Must not persist'), false)
    })
  } finally {
    restoreModelEnv(previous)
  }
})

test('agent-session cron PATCH allows unrelated edits but fails closed before re-enabling', async () => {
  const previous = snapshotModelEnv()
  configureLocalModelEnv()
  const { token } = issueTestSession()
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  try {
    await withServer(async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/cron-jobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Paused agent task',
          kind: 'cron',
          scheduleType: 'every',
          scheduleValue: '60000',
          execType: 'agent_session',
          execPayload: { prompt: 'Run later' },
          enabled: false,
        }),
      })
      assert.equal(createResponse.status, 201)
      const created = await createResponse.json()

      clearModelEnv()
      const titleResponse = await fetch(`${baseUrl}/api/cron-jobs/${created.job.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ title: 'Renamed while paused' }),
      })
      assert.equal(titleResponse.status, 200)
      const renamed = await titleResponse.json()
      assert.equal(renamed.job.title, 'Renamed while paused')
      assert.equal(renamed.job.enabled, false)

      const enableResponse = await fetch(`${baseUrl}/api/cron-jobs/${created.job.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled: true }),
      })
      assert.equal(enableResponse.status, 503)
      const failure = await enableResponse.json()
      assert.equal(failure.error.code, 'MODEL_CONFIG_MISSING')
      assert.equal(failure.error.action, 'configure_model')

      const listResponse = await fetch(`${baseUrl}/api/cron-jobs`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const listed = await listResponse.json()
      const persisted = listed.jobs.find((job) => job.id === created.job.id)
      assert.equal(persisted.title, 'Renamed while paused')
      assert.equal(persisted.enabled, false)
      assert.equal(persisted.nextRunAt, null)
    })
  } finally {
    restoreModelEnv(previous)
  }
})

test('agent-session cron PATCH validates changed model bindings before persistence', async () => {
  const previous = snapshotModelEnv()
  configureLocalModelEnv()
  const { token } = issueTestSession()
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  try {
    await withServer(async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/cron-jobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Bound agent task',
          kind: 'cron',
          scheduleType: 'every',
          scheduleValue: '60000',
          execType: 'agent_session',
          execPayload: { prompt: 'Keep the original model' },
          enabled: false,
        }),
      })
      assert.equal(createResponse.status, 201)
      const created = await createResponse.json()

      const patchResponse = await fetch(`${baseUrl}/api/cron-jobs/${created.job.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          execPayload: {
            prompt: 'Must not persist',
            providerId: 'missing-provider',
            modelName: 'missing-model',
          },
        }),
      })
      assert.equal(patchResponse.status, 404)
      const failure = await patchResponse.json()
      assert.equal(failure.error.code, 'MODEL_PROVIDER_NOT_FOUND')

      const listResponse = await fetch(`${baseUrl}/api/cron-jobs`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const listed = await listResponse.json()
      const persisted = listed.jobs.find((job) => job.id === created.job.id)
      assert.deepEqual(persisted.execPayload, { prompt: 'Keep the original model' })
    })
  } finally {
    restoreModelEnv(previous)
  }
})

test('cron PATCH validates a runnable switch from notification to agent execution', async () => {
  const previous = snapshotModelEnv()
  clearModelEnv()
  const { token } = issueTestSession()
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  try {
    await withServer(async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/cron-jobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Notification task',
          kind: 'cron',
          scheduleType: 'every',
          scheduleValue: '60000',
          execType: 'direct_notify',
          execPayload: { title: 'Still a notification' },
          enabled: true,
        }),
      })
      assert.equal(createResponse.status, 201)
      const created = await createResponse.json()

      const patchResponse = await fetch(`${baseUrl}/api/cron-jobs/${created.job.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          execType: 'agent_session',
          execPayload: { prompt: 'Needs a model' },
        }),
      })
      assert.equal(patchResponse.status, 503)
      const failure = await patchResponse.json()
      assert.equal(failure.error.code, 'MODEL_CONFIG_MISSING')

      const listResponse = await fetch(`${baseUrl}/api/cron-jobs`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const listed = await listResponse.json()
      const persisted = listed.jobs.find((job) => job.id === created.job.id)
      assert.equal(persisted.execType, 'direct_notify')
      assert.deepEqual(persisted.execPayload, { title: 'Still a notification' })
    })
  } finally {
    restoreModelEnv(previous)
  }
})

test('cron PATCH can prepare a disabled agent task without a configured model', async () => {
  const previous = snapshotModelEnv()
  clearModelEnv()
  const { token } = issueTestSession()
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  try {
    await withServer(async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/cron-jobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Disabled draft',
          kind: 'cron',
          scheduleType: 'every',
          scheduleValue: '60000',
          execType: 'direct_notify',
          execPayload: { title: 'Draft' },
          enabled: false,
        }),
      })
      assert.equal(createResponse.status, 201)
      const created = await createResponse.json()

      const patchResponse = await fetch(`${baseUrl}/api/cron-jobs/${created.job.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          execType: 'agent_session',
          execPayload: { prompt: 'Configure a model before enabling me' },
        }),
      })
      assert.equal(patchResponse.status, 200)
      const patched = await patchResponse.json()
      assert.equal(patched.job.execType, 'agent_session')
      assert.equal(patched.job.enabled, false)
      assert.equal(patched.job.nextRunAt, null)
    })
  } finally {
    restoreModelEnv(previous)
  }
})
