import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'gugo-job-runtime-shutdown-tests', String(process.pid))

const { gracefulShutdown } = await import('../server/core/lifecycle.js')
const { registerPlugin } = await import('../server/plugins/pluginRegistry.js')
const {
  JobRuntime,
  closeJobRuntime,
  setJobRuntimeForTesting,
} = await import('../server/services/jobRuntime.js')
const { createJobRuntimeScheduler } = await import('../server/services/jobRuntimeScheduler.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const TEST_USER = issueTestSession().userId
const TEST_MODEL_BINDING = Object.freeze({
  providerId: null,
  modelName: 'shutdown-test-model',
  configRevision: null,
  env: Object.freeze({
    MODEL_BASE_URL: 'http://127.0.0.1:11434/v1',
    MODEL_NAME: 'shutdown-test-model',
  }),
})
const resolveTestModelBinding = () => TEST_MODEL_BINDING

async function waitFor(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for runtime condition')
}

test('shutdown waits for an in-flight job step and rejects later ticks', async () => {
  let releaseStep
  let stepStarted = false
  const runtime = new JobRuntime({
    tickMs: 5,
    maxConcurrency: 1,
    planner: (prompt) => ({
      title: prompt,
      steps: [{ kind: 'execute', title: 'in-flight step' }],
    }),
    executeStep: async () => {
      stepStarted = true
      await new Promise((resolve) => { releaseStep = resolve })
      return { ok: true, output: { text: 'done' } }
    },
    modelBindingResolver: resolveTestModelBinding,
  })
  const job = await runtime.createJob('graceful shutdown', { userId: TEST_USER })
  runtime.start()
  await waitFor(() => stepStarted)

  let shutdownFinished = false
  const firstShutdown = runtime.shutdown()
  const secondShutdown = runtime.shutdown()
  firstShutdown.then(() => { shutdownFinished = true })

  assert.strictEqual(secondShutdown, firstShutdown)
  assert.equal(await runtime.runOneTick(), false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(shutdownFinished, false)

  releaseStep()
  await firstShutdown
  assert.equal(shutdownFinished, true)
  assert.equal(runtime.activeJobIds.size, 0)
  assert.equal(runtime.activeControllers.size, 0)
  const stoppedJob = runtime.getJob(job.id, { userId: TEST_USER })
  assert.equal(stoppedJob.status, 'running')
  assert.equal(stoppedJob.steps[0].status, 'completed')
  assert.equal(runtime.start(), false)
})

test('scheduler shutdown stops dispatch and waits for every in-flight tick', async () => {
  const releases = []
  let started = 0
  const scheduler = createJobRuntimeScheduler({
    tickMs: 5,
    maxConcurrency: 2,
    runOneTick: async () => {
      started += 1
      await new Promise((resolve) => releases.push(resolve))
      return true
    },
  })
  scheduler.start()
  await waitFor(() => started === 2)

  let idle = false
  const firstShutdown = scheduler.shutdown()
  const secondShutdown = scheduler.shutdown()
  firstShutdown.then(() => { idle = true })

  assert.strictEqual(secondShutdown, firstShutdown)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(idle, false)
  assert.equal(scheduler.start(), false)

  releases.shift()()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(idle, false)
  releases.shift()()
  await firstShutdown
  assert.equal(idle, true)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(started, 2)
  await scheduler.waitForIdle()
})

test('closeJobRuntime returns the coalesced awaitable shutdown promise', async () => {
  const runtime = new JobRuntime()
  setJobRuntimeForTesting(runtime)

  const firstClose = closeJobRuntime()
  const secondClose = closeJobRuntime()

  assert.equal(typeof firstClose?.then, 'function')
  assert.strictEqual(secondClose, firstClose)
  await firstClose
  assert.equal(runtime.shutdownRequested, true)
})

test('process shutdown drains the active job before unloading runtime plugins', async () => {
  const order = []
  let releaseStep
  const runtime = new JobRuntime({
    tickMs: 5,
    maxConcurrency: 1,
    planner: (prompt) => ({
      title: prompt,
      steps: [{ kind: 'execute', title: 'lifecycle step' }],
    }),
    executeStep: async () => {
      order.push('job:start')
      await new Promise((resolve) => { releaseStep = resolve })
      order.push('job:end')
      return { ok: true, output: { text: 'done' } }
    },
    modelBindingResolver: resolveTestModelBinding,
  })
  setJobRuntimeForTesting(runtime)
  await runtime.createJob('lifecycle ordering', { userId: TEST_USER })
  runtime.start()
  await waitFor(() => order.includes('job:start'))

  await registerPlugin({
    id: 'job-shutdown-order-plugin',
    name: 'Job Shutdown Order Plugin',
    version: '1.0.0',
  }, () => () => { order.push('plugin:dispose') })

  const shutdown = gracefulShutdown({
    close(callback) {
      order.push('http:closed')
      callback()
    },
  }, { silent: true, exit: false })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(order, ['job:start', 'http:closed'])
  releaseStep()
  assert.equal(await shutdown, 0)
  assert.deepEqual(order, ['job:start', 'http:closed', 'job:end', 'plugin:dispose'])
})
