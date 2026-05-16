import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-runtime-tests', String(process.pid))

const {
  JobRuntime,
  createDefaultExecuteStep,
  recoverInterruptedJobs,
} = await import('../server/jobRuntime.js')

test('runtime completes queued child steps in order', async () => {
  const executed = []
  const runtime = new JobRuntime({
    executeStep: async ({ step }) => {
      executed.push(step.kind)
      return { ok: true, output: { text: step.title } }
    },
  })

  const job = await runtime.createJob('生成 2 份周报')
  await runtime.drain()
  const loaded = runtime.getJob(job.id)

  assert.equal(loaded.status, 'completed')
  assert.deepEqual(executed, ['plan', 'batch_item', 'batch_item', 'finalize'])
  assert.deepEqual(loaded.steps.map((step) => step.status), ['completed', 'completed', 'completed', 'completed'])
})

test('runtime honors cancellation before the next step starts', async () => {
  const executed = []
  const runtime = new JobRuntime({
    executeStep: async ({ step }) => {
      executed.push(step.kind)
      return { ok: true, output: { text: step.title } }
    },
  })

  const job = await runtime.createJob('生成 2 份周报')
  await runtime.runOneTick()
  runtime.requestCancel(job.id)
  await runtime.drain()

  assert.deepEqual(executed, ['plan'])
  assert.equal(runtime.getJob(job.id).status, 'cancelled')
})

test('recovery returns interrupted running work to queued', () => {
  const recovered = recoverInterruptedJobs([
    { id: 'job-1', status: 'running' },
    { id: 'job-2', status: 'completed' },
  ])
  assert.deepEqual(recovered, [{ id: 'job-1', status: 'queued' }])
})

test('default executor turns generated text into a downloadable artifact', async () => {
  const runtime = new JobRuntime({
    executeStep: createDefaultExecuteStep({
      runModel: async ({ userPrompt }) => `结果：${userPrompt}`,
      createDocxImpl: async () => ({
        id: 'artifact-1',
        type: 'docx',
        title: '任务结果',
        url: '/api/artifacts/result.docx',
        filename: 'result.docx',
      }),
    }),
  })

  const job = await runtime.createJob('整理会议纪要并导出')
  await runtime.drain()
  const loaded = runtime.getJob(job.id)

  assert.equal(loaded.artifacts.length, 1)
  assert.equal(loaded.artifacts[0].filename, 'result.docx')
  assert.equal(loaded.steps[1].output.text, '结果：整理会议纪要并导出')
})
