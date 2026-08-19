import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-self-wake-tests', String(process.pid))
process.env.APPROVAL_MODE = 'off'

const { createDefaultExecuteStep, JobRuntime } = await import('../server/services/jobRuntime.js')
const { getJobWake, scheduleJobWake } = await import('../server/services/jobWakeStore.js')
const { sleepUntilTool } = await import('../server/utils/agenticTools.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const userId = issueTestSession({ email: 'self-wake@example.com' }).userId

function oneStepPlanner(prompt) {
  return {
    title: prompt,
    prompt,
    steps: [{ id: 'execute', title: 'wait and continue', kind: 'execute' }],
  }
}

function sleepCall(wakeAt) {
  return {
    id: 'sleep-call',
    type: 'function',
    function: {
      name: 'sleep_until',
      arguments: JSON.stringify({ wake_at: new Date(wakeAt).toISOString(), reason: 'continue the same work' }),
    },
  }
}

test('sleep_until validates future times and produces a loop pause', () => {
  const now = Date.now()
  const result = sleepUntilTool({ wake_at: new Date(now + 60_000).toISOString(), reason: 'follow up' }, { now })
  assert.equal(result.paused, true)
  assert.equal(result.clarification.blocker_kind, 'scheduled_wake')
  assert.equal(result.clarification.wakeAt, now + 60_000)
  assert.throws(() => sleepUntilTool({ wake_at: new Date(now - 1).toISOString() }, { now }), /future/)
  assert.throws(() => sleepUntilTool({ wake_at: 'not-a-date' }, { now }), /valid ISO/)
})

test('a sleeping job survives runtime reconstruction and resumes the same checkpoint at wake time', async () => {
  let modelCalls = 0
  let resumedMessages = null
  // Keep the initial wake far enough in the future that a saturated CI worker
  // cannot consume it during the first drain. The test explicitly reschedules
  // the durable wake below, so it never depends on wall-clock sleeping.
  const wakeAt = Date.now() + 60_000
  const executeStep = createDefaultExecuteStep({
    runModelWithTools: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) return { content: '', toolCalls: [sleepCall(wakeAt)] }
      if (modelCalls === 2) resumedMessages = messages
      return { content: 'awake in the same job', toolCalls: [] }
    },
  })
  const firstRuntime = new JobRuntime({ planner: oneStepPlanner, executeStep })
  const created = await firstRuntime.createJob('durable sleep', { userId })
  await firstRuntime.drain()

  const sleeping = firstRuntime.getJob(created.id, { userId })
  assert.equal(sleeping.status, 'waiting')
  assert.ok(sleeping.events.some((event) => event.type === 'sleeping'))
  const scheduledWake = getJobWake({ jobId: created.id, userId })
  assert.equal(scheduledWake.status, 'scheduled')

  scheduleJobWake({
    jobId: created.id,
    stepId: scheduledWake.stepId,
    userId,
    wakeAt: Date.now() - 1,
    reason: scheduledWake.reason,
  })

  // A new runtime instance represents a process restart: only SQLite state is shared.
  const secondRuntime = new JobRuntime({ planner: oneStepPlanner, executeStep })
  await secondRuntime.drain()

  const completed = secondRuntime.getJob(created.id, { userId })
  assert.equal(completed.status, 'completed')
  assert.equal(modelCalls, 3)
  assert.ok(completed.events.some((event) => event.type === 'wake_fired'))
  assert.equal(getJobWake({ jobId: created.id, userId }).status, 'fired')
  assert.ok(resumedMessages.some((message) => message.role === 'tool' && message.name === 'sleep_until'))
})

test('user steering wakes a sleeping job early and cancels the old timer', async () => {
  let modelCalls = 0
  let sawSteering = false
  const executeStep = createDefaultExecuteStep({
    runModelWithTools: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) return { content: '', toolCalls: [sleepCall(Date.now() + 60_000)] }
      if (messages.some((message) => message.role === 'user' && message.content === 'wake now and change direction')) {
        sawSteering = true
      }
      return { content: 'changed direction', toolCalls: [] }
    },
  })
  const runtime = new JobRuntime({ planner: oneStepPlanner, executeStep })
  const created = await runtime.createJob('interruptible sleep', { userId })
  await runtime.drain()
  assert.equal(runtime.getJob(created.id, { userId }).status, 'waiting')

  const steered = runtime.steerJob(created.id, { userId, content: 'wake now and change direction' })
  assert.equal(steered.accepted, true)
  assert.equal(getJobWake({ jobId: created.id, userId }).status, 'cancelled')
  await runtime.drain()

  assert.equal(runtime.getJob(created.id, { userId }).status, 'completed')
  assert.equal(sawSteering, true)
})
