import assert from 'node:assert/strict'
import test from 'node:test'

process.env.APPROVAL_MODE = 'off'

const { createDefaultExecuteStep, JobRuntime } = await import('../server/services/jobRuntime.js')
const { getJobTurnCheckpoint } = await import('../server/services/jobTurnCheckpointStore.js')
const { getJobWake } = await import('../server/services/jobWakeStore.js')
const { attachJobBudget, getJobBudget, releaseJobBudget, runWithModelBudget } = await import('../server/utils/jobBudget.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const SUSPENSION_MS = 24 * 60 * 60 * 1000
const usage = { promptTokens: 5, completionTokens: 2 }
const resolveTestModelBinding = () => ({
  providerId: null,
  modelName: 'suspension-budget-fixture',
  configRevision: null,
  env: { MODEL_NAME: 'suspension-budget-fixture' },
})

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function sleepCall(clock, id) {
  return toolCall(id, 'sleep_until', {
    wake_at: new Date(clock + SUSPENSION_MS).toISOString(),
    reason: 'continue this durable job after a scheduled wait',
  })
}

for (const coldRestore of [false, true]) {
  test(`scheduled suspension preserves consumed budgets on ${coldRestore ? 'cold restore' : 'same-runtime wake'}`, async (t) => {
    let clock = Date.now()
    t.mock.method(Date, 'now', () => clock)
    const userId = issueTestSession({ email: `budget-sleep-${coldRestore}@example.com` }).userId
    let providerCalls = 0
    let resumedBudget = null
    let resumedMessages = null
    const executeStep = createDefaultExecuteStep({
      preparePromptContext: () => ({}),
      runModelWithTools: async ({ messages }) => {
        providerCalls += 1
        if (providerCalls === 2) {
          resumedBudget = getJobBudget(job).snapshot()
          resumedMessages = messages
        }
        clock += 100
        // The resumed request really passes the next tool through budget.consume.
        // An unknown fixture tool has no external side effect or network access.
        const call = providerCalls === 2
          ? toolCall('after-wake', 'budget_fixture_unknown_tool', { attempt: 1 })
          : sleepCall(clock, `sleep-${providerCalls}`)
        return { content: '', toolCalls: [call], usage, costUsd: 0.125 }
      },
    })
    const firstRuntime = new JobRuntime({ executeStep, modelBindingResolver: resolveTestModelBinding })
    const job = await firstRuntime.createPlan({
      userId,
      title: 'scheduled budget fixture',
      prompt: 'Explain the previous result after the scheduled wait.',
      steps: [{ kind: 'execute', title: 'wait and resume' }],
    })
    const initialBudget = attachJobBudget(job, {
      maxTotalCalls: 3,
      maxWallMs: 500,
      maxModelCalls: 4,
      maxModelTokens: 28,
    })
    initialBudget.consume(2)
    await runWithModelBudget(initialBudget, async () => {
      clock += 20
      return { content: 'previous work', usage, costUsd: 0.125 }
    })
    clock += 40

    assert.equal(await firstRuntime.runOneTick(), true)
    const waiting = firstRuntime.getJob(job.id, { userId })
    assert.equal(waiting.status, 'waiting')
    const scope = { jobId: job.id, userId, stepId: waiting.steps[0].id }
    const saved = getJobTurnCheckpoint(scope).state
    assert.equal(saved.final, null, 'the real pause boundary must persist a resumable checkpoint')
    assert.equal(saved.budget.used, 2)
    assert.equal(saved.budget.elapsed, 40)
    assert.equal(saved.budget.modelCalls, 2)
    assert.equal(saved.budget.modelTokens, 14)
    assert.equal(saved.budget.modelMs, 120)

    // A new JobRuntime alone still shares module-local budgets. Explicitly
    // discard that process-local index to simulate a restart retaining only DB.
    if (coldRestore) releaseJobBudget(job, getJobBudget(job))
    const resumedRuntime = coldRestore
      ? new JobRuntime({ executeStep, modelBindingResolver: resolveTestModelBinding })
      : firstRuntime
    clock = getJobWake({ jobId: job.id, userId }).wakeAt + 1
    assert.equal(await resumedRuntime.runOneTick(), true)

    const pausedAgain = resumedRuntime.getJob(job.id, { userId })
    assert.equal(pausedAgain.status, 'waiting', `scheduled idle time must not exhaust work time on the next tool: ${pausedAgain.error || ''}`)
    assert.equal(providerCalls, 3)
    assert.equal(resumedBudget.elapsed, saved.budget.elapsed)
    assert.equal(resumedBudget.used, saved.budget.used)
    assert.equal(resumedBudget.modelCalls, saved.budget.modelCalls + 1, 'the new request is counted exactly once')
    assert.equal(resumedBudget.modelTokens, saved.budget.modelTokens)
    assert.ok(resumedMessages.some((message) => message.role === 'tool' && message.name === 'sleep_until'))
    const resumedSnapshot = getJobTurnCheckpoint(scope).state.budget
    assert.deepEqual(resumedSnapshot, {
      ...saved.budget,
      used: 3,
      modelCalls: 4,
      modelTokens: 28,
      modelMs: 320,
      costUsd: 0.5,
    })
    assert.equal(getJobBudget(job), null, 'durably suspended jobs release only their completed budget generation')
  })
}

test('a custom paused step without a durable budget snapshot keeps its accumulated budget', async () => {
  const userId = issueTestSession({ email: 'budget-sleep-no-checkpoint@example.com' }).userId
  const runtime = new JobRuntime({
    executeStep: async () => ({
      ok: false,
      paused: true,
      clarification: { question: 'Please clarify the fixture.', blocker_kind: 'missing_info' },
    }),
    modelBindingResolver: resolveTestModelBinding,
  })
  const job = await runtime.createPlan({
    userId,
    title: 'custom paused step',
    prompt: 'A fixture with no checkpoint adapter.',
    steps: [{ kind: 'execute', title: 'request input' }],
  })
  const budget = attachJobBudget(job, { initialUsed: 3, initialModelCalls: 2, initialModelTokens: 14 })
  try {
    assert.equal(await runtime.runOneTick(), true)
    assert.equal(runtime.getJob(job.id, { userId }).status, 'waiting')
    assert.equal(getJobBudget(job), budget, 'without a saved snapshot releasing the index would erase prior usage')
  } finally {
    releaseJobBudget(job, budget)
  }
})

test('paused cleanup cannot release a replacement budget generation in the same job', async () => {
  const userId = issueTestSession({ email: 'budget-sleep-generation@example.com' }).userId
  let replacementBudget = null
  const runtime = new JobRuntime({
    executeStep: async ({ job, step }) => {
      const budget = getJobBudget(job)
      runtime.runtimeCore.checkpoint.save({ jobId: job.id, stepId: step.id, userId }, {
        budget: budget.snapshot(), final: null,
      })
      assert.equal(releaseJobBudget(job, budget), true)
      replacementBudget = attachJobBudget(job, { initialUsed: 8, initialModelCalls: 7 })
      return { paused: true, clarification: { question: 'Pause the old generation.' } }
    },
    modelBindingResolver: resolveTestModelBinding,
  })
  const job = await runtime.createPlan({
    userId,
    title: 'pause generation fencing',
    prompt: 'Verify cleanup ownership.',
    steps: [{ kind: 'execute', title: 'pause' }],
  })
  attachJobBudget(job, { initialUsed: 3, initialModelCalls: 2 })
  try {
    assert.equal(await runtime.runOneTick(), true)
    assert.equal(runtime.getJob(job.id, { userId }).status, 'waiting')
    assert.equal(getJobBudget(job), replacementBudget)
    assert.equal(replacementBudget.snapshot().used, 8)
    assert.equal(replacementBudget.snapshot().modelCalls, 7)
  } finally {
    releaseJobBudget(job, getJobBudget(job))
  }
})

test('a cancelled waiting transition cannot release the active budget as if suspension had committed', async () => {
  const userId = issueTestSession({ email: 'budget-sleep-cancel-fence@example.com' }).userId
  const runtime = new JobRuntime({
    executeStep: async ({ job, step }) => {
      runtime.runtimeCore.checkpoint.save({ jobId: job.id, stepId: step.id, userId }, {
        budget: getJobBudget(job).snapshot(), final: null,
      })
      runtime.requestCancel(job.id, { userId })
      return { paused: true, clarification: { question: 'This pause must not commit.' } }
    },
    modelBindingResolver: resolveTestModelBinding,
  })
  const job = await runtime.createPlan({
    userId,
    title: 'pause commit fencing',
    prompt: 'Verify cancellation takes precedence over pause.',
    steps: [{ kind: 'execute', title: 'cancel before waiting' }],
  })
  const budget = attachJobBudget(job, { initialUsed: 3, initialModelCalls: 2 })
  try {
    assert.equal(await runtime.runOneTick(), true)
    assert.equal(runtime.getJob(job.id, { userId }).status, 'cancel_requested')
    assert.equal(getJobBudget(job), budget)
    assert.equal(await runtime.runOneTick(), true)
    assert.equal(runtime.getJob(job.id, { userId }).status, 'cancelled')
    assert.equal(getJobBudget(job), null)
  } finally {
    releaseJobBudget(job, budget)
  }
})

for (const coldRestore of [false, true]) {
  test(`verify needs_user retains cumulative usage and review work on ${coldRestore ? 'cold restore' : 'same-runtime continuation'}`, async (t) => {
    let clock = Date.now()
    t.mock.method(Date, 'now', () => clock)
    const userId = issueTestSession({ email: `budget-verify-input-${coldRestore}@example.com` }).userId
    const modelSnapshots = []
    const modelMessages = []
    const executeStep = createDefaultExecuteStep({
      preparePromptContext: () => ({}),
      runModelWithTools: async ({ messages }) => {
        modelSnapshots.push(getJobBudget(job).snapshot())
        modelMessages.push(messages)
        clock += 100
        return {
          content: 'The supplied explanation depends on the intended interpretation.',
          toolCalls: [], usage, costUsd: 0.125,
        }
      },
      taskEvaluator: async () => {
        // This review happens after the loop's terminal checkpoint. Its work
        // must be retained when that checkpoint becomes a resumable wait.
        clock += 25
        return { verdict: 'needs_user', summary: 'Choose the intended interpretation.', issues: [] }
      },
    })
    const firstRuntime = new JobRuntime({ executeStep, modelBindingResolver: resolveTestModelBinding })
    const job = await firstRuntime.createPlan({
      userId,
      title: 'verify input budget fixture',
      prompt: 'Explain the supplied short text.',
      steps: [{ kind: 'verify', title: 'review the interpretation' }],
    })
    const initialBudget = attachJobBudget(job, {
      maxTotalCalls: 8, maxWallMs: 500, maxModelCalls: 8, maxModelTokens: 56,
    })
    initialBudget.consume(3)
    await runWithModelBudget(initialBudget, async () => {
      clock += 20
      return { content: 'prior step', usage, costUsd: 0.125 }
    })
    clock += 40

    assert.equal(await firstRuntime.runOneTick(), true)
    const waiting = firstRuntime.getJob(job.id, { userId })
    assert.equal(waiting.status, 'waiting')
    const scope = { jobId: job.id, stepId: waiting.steps[0].id, userId }
    const saved = getJobTurnCheckpoint(scope).state
    assert.equal(saved.final, null)
    assert.equal(saved.budget.used, 3)
    assert.equal(saved.budget.modelCalls, 2)
    assert.equal(saved.budget.modelTokens, 14)
    assert.equal(saved.budget.modelMs, 120)
    assert.equal(saved.budget.elapsed, 65, 'active review work after the last loop checkpoint is retained')
    assert.equal(getJobBudget(job), null)

    if (coldRestore) releaseJobBudget(job, getJobBudget(job))
    const resumedRuntime = coldRestore
      ? new JobRuntime({ executeStep, modelBindingResolver: resolveTestModelBinding })
      : firstRuntime
    clock += SUSPENSION_MS
    assert.equal(resumedRuntime.steerJob(job.id, {
      userId, content: 'Interpretation A is the intended meaning. Continue reviewing the explanation.',
    }).accepted, true)
    assert.equal(await resumedRuntime.runOneTick(), true)
    assert.equal(resumedRuntime.getJob(job.id, { userId }).status, 'waiting')
    assert.equal(modelSnapshots.length, 2)
    assert.equal(modelSnapshots[1].elapsed, saved.budget.elapsed)
    assert.equal(modelSnapshots[1].used, saved.budget.used)
    assert.equal(modelSnapshots[1].modelCalls, saved.budget.modelCalls + 1)
    assert.equal(modelSnapshots[1].modelTokens, saved.budget.modelTokens)
    assert.ok(modelMessages[1].some((message) => String(message.content || '').includes('Interpretation A')))
    assert.deepEqual(getJobTurnCheckpoint(scope).state.budget, {
      ...saved.budget,
      elapsed: 90, modelCalls: 3, modelTokens: 21, modelMs: 220, costUsd: 0.375,
    })
    assert.equal(getJobBudget(job), null)
  })
}

for (const incompleteSnapshot of [false, true]) {
  test(`a custom paused step keeps live counters when its snapshot is ${incompleteSnapshot ? 'incomplete' : 'stale'}`, async () => {
    const userId = issueTestSession({ email: `budget-pause-stale-${incompleteSnapshot}@example.com` }).userId
    const runtime = new JobRuntime({
      executeStep: async ({ job, step }) => {
        const budget = getJobBudget(job)
        runtime.runtimeCore.checkpoint.save({ jobId: job.id, stepId: step.id, userId }, {
          budget: incompleteSnapshot ? {} : budget.snapshot(), final: null,
        })
        budget.consume(1)
        budget.consumeModelCall()
        budget.trackModelUsage(usage, 0.125)
        return { paused: true, clarification: { question: 'Custom executor did not save its latest counters.' } }
      },
      modelBindingResolver: resolveTestModelBinding,
    })
    const job = await runtime.createPlan({
      userId, title: 'stale pause budget fixture', prompt: 'Explain the supplied text.',
      steps: [{ kind: 'execute', title: 'request input' }],
    })
    const budget = attachJobBudget(job, { initialUsed: 3, initialModelCalls: 2, initialModelTokens: 14 })
    try {
      assert.equal(await runtime.runOneTick(), true)
      assert.equal(runtime.getJob(job.id, { userId }).status, 'waiting')
      assert.equal(getJobBudget(job), budget)
      assert.equal(budget.snapshot().used, 4)
      assert.equal(budget.snapshot().modelCalls, 3)
      assert.equal(budget.snapshot().modelTokens, 21)
    } finally {
      releaseJobBudget(job, budget)
    }
  })
}
