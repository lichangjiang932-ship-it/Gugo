import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-clarification-tests', `${process.pid}-${Date.now()}`)

const { JobRuntime, recoverInterruptedJobs } = await import('../server/services/jobRuntime.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const resolveTestModelBinding = () => ({
  providerId: null,
  modelName: 'job-clarification-test-model',
  configRevision: null,
  env: {
    MODEL_BASE_URL: 'http://127.0.0.1:11434/v1',
    MODEL_NAME: 'job-clarification-test-model',
  },
})

test('clarification suspends a job and a steering answer resumes the same job', async () => {
  const { userId } = issueTestSession()
  let executions = 0
  const runtime = new JobRuntime({
    modelBindingResolver: resolveTestModelBinding,
    planner: (prompt) => ({
      title: 'Clarification job',
      prompt,
      steps: [{ id: 'execute', title: 'Execute', kind: 'execute', status: 'queued' }],
    }),
    executeStep: async () => {
      executions += 1
      if (executions === 1) {
        return {
          ok: false,
          truncated: true,
          paused: true,
          clarification: {
            question: 'CSV 还是 PDF？',
            why: '需要确认交付格式',
            options: ['CSV', 'PDF'],
          },
          output: { text: '' },
        }
      }
      return { ok: true, output: { text: 'CSV delivered' } }
    },
  })

  const created = await runtime.createJob('Prepare the report', { userId })
  assert.equal(await runtime.runOneTick(), true)
  const waiting = runtime.getJob(created.id, { userId })
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.steps[0].status, 'queued')
  assert.equal(waiting.events.at(-1).type, 'awaiting_user')
  assert.equal(waiting.events.at(-1).payload.clarification.question, 'CSV 还是 PDF？')

  // Suspended work remains durable but is not runnable until the user answers.
  assert.equal(await runtime.runOneTick(), false)
  assert.equal(executions, 1)
  assert.deepEqual(recoverInterruptedJobs([{ id: created.id, status: 'waiting' }]), [])

  const response = runtime.steerJob(created.id, { userId, content: 'CSV' })
  assert.equal(response.accepted, true)
  assert.equal(response.job.status, 'queued')
  await runtime.drain()
  const completed = runtime.getJob(created.id, { userId })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.steps[0].output.text, 'CSV delivered')
  assert.deepEqual(completed.steps.map((step) => step.kind), ['execute', 'verify', 'finalize'])
  assert.ok(completed.steps.every((step) => step.status === 'completed'))
})
